/**
 * fork/continuous — where playback starts when a REVIEW is opened (`.23`).
 *
 * Upstream opens every review at `start_time - REVIEW_PADDING` (4 s). Measured by Troy on
 * 2026-08-31 on real iOS through HA, tapping a notification: the link lands 4 s before the
 * detection, HLS then starts decoding from the previous keyframe (~2 s more), so the video
 * visibly begins ~6 s before the thing the alert is about. On a 5 s walk-past that is most
 * of the clip spent on an empty driveway, and the person the alert is about arrives after
 * the viewer has already decided nothing is happening.
 *
 * So for every path that answers "show me THIS alert" the lead-in is ZERO — seek to
 * `start_time` exactly and let the keyframe snap be the only lead-in there is. There are
 * three of them, and they must agree, because a link lands on one and the user's next tap
 * is often another:
 *   - the deep link's `?id=` handler (`useDeepLink.ts`)
 *   - a card click on the continuous Review grid (`EventView.tsx`'s `onSelectReview`)
 *   - a card click in History's events list, beside the player
 *     (`ContinuousTimelinePanel.tsx` → `ContinuousEventList` `onSelect`) — added in `.24`
 *     after a review found the playhead jumping 4 s BACK from where a link had put it.
 *
 * What this deliberately does NOT change (REVIEW_PADDING stays exactly as upstream has it):
 *   - preview scrubbing (`PREVIEW_PADDING`) and thumbnails
 *   - export bounds (`ReviewCard`, `EventView`'s export, `exportClamp`)
 *   - the "is the playhead inside this review" predicates (`ContinuousTimelinePanel`,
 *     `RecordingView`, `DetailStream`) — those are TOLERANCES, not seek targets, and
 *     tightening them would make a review stop being "current" 4 s early
 *   - `RecordingView.tsx:1352` — a real seek, still `start_time - REVIEW_PADDING`, and
 *     deliberately left alone: it belongs to upstream's `Timeline`, which the fork replaces
 *     with `ContinuousTimelinePanel` whenever `continuous.enabled`. Unreachable on the
 *     continuous path; if the toggle is ever retired, this one comes with it
 *   - upstream's own non-continuous `useSearchEffect("id")` path in `pages/Events.tsx`
 *   - the timeline panel's review-band click and `AnimatedEventCard` — different gestures,
 *     not the notification path, and out of scope
 */
import { REVIEW_PADDING } from "@/types/review";

/**
 * Seconds of footage shown BEFORE a review's start when the review itself is the target.
 *
 * Named rather than inlined so the decision has one home and one negative control: set it
 * back to `REVIEW_PADDING` and every gate that asserts the landing goes red.
 */
export const CONTINUOUS_LEAD_IN = 0;

/** Where the player opens for a review whose start is `startTime`. */
export function reviewSeekTarget(startTime: number): number {
  return startTime - CONTINUOUS_LEAD_IN;
}

/**
 * Where a click on a Review-grid card opens the player.
 *
 * The non-continuous branch is upstream's, unchanged and still padded: it clamps to the
 * calendar day filter's `after` (the 24 h `selectedTimeRange`), which only means anything
 * while the calendar IS a filter — the continuous window replaces that (D1), and applying
 * the clamp there opened every card older than 24 h at "24 hours ago" (the `.14` defect).
 */
export function cardOpenStartTime({
  continuous,
  reviewStart,
  timeRangeAfter,
}: {
  continuous: boolean;
  reviewStart: number;
  timeRangeAfter: number;
}): number {
  if (continuous) return reviewSeekTarget(reviewStart);
  const effective = timeRangeAfter > reviewStart ? timeRangeAfter : reviewStart;
  return effective - REVIEW_PADDING;
}
