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
 *  - a strip segment click passes the segment's own time → "the first item at or after
 *    this moment", which is what upstream's DOM-query behaviour did;
 *  - a calendar day-jump passes `startOfDayInTz(t)` → "the first item at or after 00:00",
 *    which *is* D14's "the day's earliest review" for a sparse list.
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
