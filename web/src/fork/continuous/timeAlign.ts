/**
 * fork/continuous — time alignment helpers (pure, no React).
 *
 * Encodes three constraints from docs/work/frigate-infinite-timeline-handover.md:
 *
 *  - §5.3 / F2: `/review/activity/motion` min-max normalises motion per ONE-HOUR chunk
 *    counted from index 0 of the response. Two requests whose `after` differ by anything
 *    other than a whole number of hours therefore return different bar heights for the
 *    same timestamp. Every paged request MUST start on a whole hour — in the DISPLAY
 *    timezone (§13 point 5), which for Asia/Makassar coincides with UTC hours but for a
 *    +05:45 zone does not.
 *  - §13 / D3: day boundaries are computed in the display timezone, never with
 *    `setHours(0,0,0,0)`; "previous day" is a calendar decrement, never `t - 86400`.
 *  - §3.4: segment pitch is a multiple of every zoom level (5/10/15/30/60 s), so window
 *    edges are aligned to 60 s and stay valid across zoom changes.
 */
import { fromZonedTime, getTimezoneOffset, toZonedTime } from "date-fns-tz";

export const HOUR = 3600;
export const DAY = 86400;
/** LCM of every segmentDuration the two pages use (60/30/10 and 30/15/5). */
export const EDGE_ALIGN = 60;

export function alignDown(t: number, step: number): number {
  return Math.floor(t / step) * step;
}

export function alignUp(t: number, step: number): number {
  return Math.ceil(t / step) * step;
}

/** Floor an epoch-seconds timestamp to the start of its hour in `tz`. */
/**
 * Do two moments fall in the same wall-clock hour? Playback chunks ARE hours (§9.5), so
 * this is the granularity at which "the player got where it was asked to go" is decided —
 * a seek lands on real footage, which the hour's gaps can move by seconds.
 */
export function sameHour(a: number, b: number): boolean {
  return Math.floor(a / HOUR) === Math.floor(b / HOUR);
}

export function floorHourInTz(t: number, tz: string): number {
  const zoned = toZonedTime(t * 1000, tz);
  zoned.setMinutes(0, 0, 0);
  return fromZonedTime(zoned, tz).getTime() / 1000;
}

/** Ceil an epoch-seconds timestamp to the end of its hour in `tz` (exclusive). */
export function ceilHourInTz(t: number, tz: string): number {
  const floored = floorHourInTz(t, tz);
  return floored === t ? t : floorHourInTz(floored + HOUR + 1, tz);
}

/** Start of the calendar day containing `t`, in `tz`. */
export function startOfDayInTz(t: number, tz: string): number {
  const zoned = toZonedTime(t * 1000, tz);
  zoned.setHours(0, 0, 0, 0);
  return fromZonedTime(zoned, tz).getTime() / 1000;
}

/** Start of the next calendar day after the one containing `t`, in `tz` (DST-safe). */
export function startOfNextDayInTz(t: number, tz: string): number {
  const zoned = toZonedTime(t * 1000, tz);
  zoned.setHours(0, 0, 0, 0);
  zoned.setDate(zoned.getDate() + 1);
  return fromZonedTime(zoned, tz).getTime() / 1000;
}

/** Start of the previous calendar day, in `tz` (a calendar decrement, not t - 86400). */
export function startOfPrevDayInTz(t: number, tz: string): number {
  const zoned = toZonedTime(t * 1000, tz);
  zoned.setHours(0, 0, 0, 0);
  zoned.setDate(zoned.getDate() - 1);
  return fromZonedTime(zoned, tz).getTime() / 1000;
}

/** `YYYY-MM-DD` key for `t` in `tz` — the key shape `/review/summary` uses. */
export function dayKeyInTz(t: number, tz: string): string {
  const z = toZonedTime(t * 1000, tz);
  const mm = `0${z.getMonth() + 1}`.slice(-2);
  const dd = `0${z.getDate()}`.slice(-2);
  return `${z.getFullYear()}-${mm}-${dd}`;
}

/** Epoch seconds for the start of a `YYYY-MM-DD` day key in `tz`. */
export function dayKeyToStartInTz(key: string, tz: string): number {
  const [y, m, d] = key.split("-").map((v) => parseInt(v, 10));
  return fromZonedTime(new Date(y, m - 1, d, 0, 0, 0, 0), tz).getTime() / 1000;
}

export type Page = { after: number; before: number };

/**
 * Floor `t` onto a FIXED grid of `span`-second cells anchored at the local epoch in `tz`.
 *
 * The grid must not depend on where the query started. The first version anchored each
 * call on `startOfDayInTz(after)`, which makes the lattice a function of the day `after`
 * happens to fall in: with a 72 h span, `pagesFor(oldest, …)` and `pagesFor(t, t+1)`
 * produced different `after` values two times out of three. That is not cosmetic —
 * `ContinuousProvider.ensureLoaded` looks the page up BY `after`, so a `navigateToTime`
 * into an already-loaded region waited out its whole 10 s timeout and then scrolled, and
 * the same window could be fetched twice under two keys. Keep this anchored at a fixed
 * point, not at the caller's position.
 *
 * DST: the offset is resolved at `t` and then re-resolved at the snapped instant, so a
 * snap that crosses a transition lands on the boundary computed with the offset that
 * actually applies there.
 */
export function snapToSpanGrid(t: number, span: number, tz: string): number {
  const off1 = getTimezoneOffset(tz, new Date(t * 1000)) / 1000;
  const snapped = Math.floor((t + off1) / span) * span - off1;
  const off2 = getTimezoneOffset(tz, new Date(snapped * 1000)) / 1000;
  if (off2 === off1) return snapped;
  return Math.floor((t + off2) / span) * span - off2;
}

/**
 * Split [after, before) into pages of `spanHours` hours on the fixed grid above, so every
 * boundary is a whole hour in `tz` (F2/§5.3: the backend min-max normalises motion per
 * one-hour chunk counted from index 0 of the response, so two requests whose `after`
 * differ by a fraction of an hour return different bar heights for the same timestamp)
 * and the same page is always requested with the same `after` no matter how the user got
 * there (see `snapToSpanGrid`).
 */
export function pagesFor(
  after: number,
  before: number,
  spanHours: number,
  tz: string,
): Page[] {
  const span = spanHours * HOUR;
  const out: Page[] = [];
  let cursor = snapToSpanGrid(after, span, tz);
  while (cursor < before) {
    out.push({ after: cursor, before: cursor + span });
    cursor += span;
  }
  return out;
}

/** Page key for a page start — pages are identified purely by their `after`. */
export function pageKey(prefix: string, after: number): string {
  return `${prefix}:${after}`;
}
