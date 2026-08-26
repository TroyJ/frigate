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
import { fromZonedTime, toZonedTime } from "date-fns-tz";

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
 * Split [after, before) into hour-aligned pages of at most `spanHours` hours, aligned to
 * whole hours in `tz`. Page boundaries are deterministic functions of the timestamp
 * (a fixed grid anchored at the epoch-hour in tz), so the same page is requested with the
 * same `after` no matter how the user scrolled there — that is what keeps the per-hour
 * normalisation identical across requests (§5.3).
 */
export function pagesFor(
  after: number,
  before: number,
  spanHours: number,
  tz: string,
): Page[] {
  const span = spanHours * HOUR;
  const out: Page[] = [];
  // grid origin: the hour floor of `after`, snapped to the span grid relative to a tz day
  const dayStart = startOfDayInTz(after, tz);
  let cursor = dayStart + Math.floor((floorHourInTz(after, tz) - dayStart) / span) * span;
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
