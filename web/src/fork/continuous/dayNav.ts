/**
 * fork/continuous — the time→index primitive the sparse surfaces (S1, S5, S6) scroll by,
 * and the day math behind D14/D15.
 *
 * Day boundaries are computed in the DISPLAY timezone (`timeAlign.startOfDayInTz`), never
 * with `setHours(0,0,0,0)`, and "previous day" is a calendar decrement, never `t - 86400`
 * (§13 / D3). Getting that wrong is invisible at home and off by the zone difference from
 * anywhere else — 2 h between `Asia/Makassar` and an Australian laptop.
 *
 * `indexAtOrAfter` is deliberately ONE primitive for two callers, because building them
 * separately is exactly how they diverge (§2A / D11):
 *
 *  - a calendar day-jump passes `startOfDayInTz(t)` → "the first item at or after 00:00",
 *    which *is* D14's "the day's earliest review" for a sparse list;
 *  - a deep link or a strip-segment click passes the time of a SPECIFIC review, alongside
 *    that review's id — the id is what actually selects the card, and this scan is only
 *    the fallback for when the current filters hide it.
 *
 * Note what this is NOT: it is not how a strip click picks its target. Upstream resolves a
 * segment click through `getEvent` — the event OVERLAPPING that segment whose severity
 * matches the displayed tab — and `ContinuousEventStrip` reproduces that before calling
 * `navigateToTime`. Using "the next item at or after the segment time" as the primary
 * resolution would target the wrong review for every row of a band except its first.
 *
 * The earlier version of this scan searched for `start_time < nextDayStart` from the
 * oldest end. That matches the OLDEST loaded item on the first comparison, so every
 * day-jump landed at the bottom of the list instead of on the requested day. Keep the
 * comparison `>= t`, and keep the scan running oldest → newest.
 */
import { ReviewSegment } from "@/types/review";

/**
 * Index of the OLDEST item whose `start_time >= t`, for a list sorted newest-first (D23).
 * Returns 0 (the newest item) when everything loaded is older than `t`, and -1 only for an
 * empty list — callers may treat -1 as "nothing to scroll to".
 */
export function indexAtOrAfter(
  items: Pick<ReviewSegment, "start_time">[],
  t: number,
): number {
  if (!items.length) return -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].start_time >= t) return i;
  }
  return 0;
}
