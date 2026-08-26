/**
 * fork/continuous — the Review page's item selection, kept OUT of upstream (§8.4).
 *
 * `pages/Events.tsx` derives `currentItems` from its 24-hour `reviewItems` bundle:
 * severity bucket (or `all` when `showAll`), then `has_been_reviewed` filtering. The
 * continuous surfaces need the same derivation over the PROVIDER's list instead, and the
 * seam must not grow a copy of that logic — so it lives here and `EventView` calls it.
 *
 * D23: results are sorted `start_time DESC` explicitly. Upstream's `/review` sorts
 * `severity ASC, start_time DESC`, which does not survive concatenating time-window pages
 * (F9) — the provider's `mergeReviews` already sorts, but a caller that re-buckets must
 * not reintroduce severity-major order.
 *
 * D18: the array this returns is what "select all" means on a virtualized grid — every
 * LOADED item, not the DOM rows and not a 24-hour page. The bulk endpoints take ids.
 */
import { ReviewSegment, ReviewSeverity } from "@/types/review";

export function selectReviewItems(
  reviews: ReviewSegment[],
  severity: ReviewSeverity | undefined,
  showAll: boolean | undefined,
  showReviewed: boolean,
): ReviewSegment[] {
  const bySeverity =
    showAll || !severity
      ? reviews
      : reviews.filter((r) => r.severity === severity);
  const visible = showReviewed
    ? bySeverity
    : bySeverity.filter((r) => !r.has_been_reviewed);
  // already newest-first from the provider; sort defensively, it is O(n) on a sorted array
  return visible.slice().sort((a, b) => b.start_time - a.start_time);
}
