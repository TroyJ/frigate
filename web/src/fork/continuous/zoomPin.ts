/**
 * fork/continuous — D24: zoom pinning past a depth threshold.
 *
 * Two costs grow when you zoom IN on a continuous strip, and only one of them is obvious.
 *
 *  1. **Rows.** `segmentDuration` 30 → 5 is six times as many rows for the same span. At
 *     the top of the window that is nothing; 30 days deep it is 518,400 rows and upstream's
 *     `segments: number[]` prop is materialised for the whole loaded span (F3).
 *  2. **Request cost, which is the one that reaches the box.** The dense strips ask for
 *     `/review/activity/motion?scale=segmentDuration/2` and
 *     `/recordings/unavailable?scale=segmentDuration`. `scale` is the STEP the backend
 *     walks the range in, so halving it doubles the work and the payload for the same
 *     window — against a single-worker API whose starvation makes the Supervisor recreate
 *     the add-on (F12/F21). Zooming in at depth is exactly the gesture that produces the
 *     most rows AND the finest scale at once.
 *
 * So past the pin depth the fork does two things:
 *   - the finer zoom LEVELS are offered as disabled, with a reason (`pinnedZoomLevels`);
 *   - and — the half that actually protects the box — the requested `scale` is COARSENED
 *     back to the pinned pitch even if the strip is still drawing at a finer one
 *     (`effectiveScaleDuration`). The bars get blockier at depth. They do not get expensive.
 *
 * The threshold is a depth FROM THE NEWEST LOADED EDGE, not a wall-clock "3 days": what
 * makes a request expensive is how far from now the viewport is, and `newest` moves.
 */

/** Past this far back from `newest`, zoom stops getting finer (D24). */
export const PIN_ZOOM_BEYOND_S = 3 * 86400;

/** The pitch everything is pinned to past the threshold — upstream's default zoom. */
export const PINNED_SEGMENT_DURATION = 30;

export const ZOOM_PINNED_TEXT =
  "Zoom is pinned past 3 days — scroll back towards now for finer detail";

/** How deep, in seconds, the given viewport time is from the newest loaded edge. */
export function depthFromNewest(viewportTime: number, newest: number): number {
  return Math.max(0, newest - viewportTime);
}

export function isZoomPinned(viewportTime: number, newest: number): boolean {
  return depthFromNewest(viewportTime, newest) > PIN_ZOOM_BEYOND_S;
}

/**
 * The `segmentDuration` the heavy pages should be REQUESTED at.
 *
 * Never finer than the pinned pitch once the viewport is past the threshold. Returned as a
 * duration rather than a scale so both callers (`motionScale` is half of it,
 * `unavailScale` is all of it) derive from one number.
 */
export function effectiveScaleDuration(
  segmentDuration: number,
  viewportTime: number,
  newest: number,
): number {
  if (!isZoomPinned(viewportTime, newest)) return segmentDuration;
  return Math.max(segmentDuration, PINNED_SEGMENT_DURATION);
}

export type ZoomLevelLike = { segmentDuration: number };

/**
 * The levels the zoom control should OFFER, and whether a requested one is allowed.
 *
 * Both live here rather than inline in the panel so the rule is testable and there is one
 * statement of it. Two things it has to get right, and the second was a real defect:
 *
 *  - past the pin, only the pinned pitch and coarser are offered. Upstream disables its own
 *    zoom-in button at the end of `possibleZoomLevels`, so truncating the list IS the
 *    "renders disabled" half of D24, with no upstream change.
 *  - a user who was ALREADY finer than the pin when they scrolled deep must keep the full
 *    list, or their current level falls off it, `currentZoomLevel` goes to −1 and upstream
 *    hides the control entirely.
 */
export function offeredZoomLevels<T extends ZoomLevelLike>(
  levels: T[],
  currentSegmentDuration: number,
  pinned: boolean,
): T[] {
  if (!pinned) return levels;
  const allowed = levels.filter(
    (l) => l.segmentDuration >= PINNED_SEGMENT_DURATION,
  );
  return allowed.some((l) => l.segmentDuration === currentSegmentDuration)
    ? allowed
    : levels;
}

/**
 * May the strip move to `next` from `current`?
 *
 * Past the pin the answer is no for anything FINER than the pin — but only when it is also
 * finer than where the user already is. Rejecting every level below the pin traps someone
 * who was at 5 s when they scrolled deep: the zoom-OUT button is enabled (they are not at
 * index 0) and silently does nothing, which is worse than not offering it. Coarsening is
 * always allowed; it is the direction the pin wants.
 */
export function zoomChangeAllowed(
  currentSegmentDuration: number,
  nextSegmentDuration: number,
  pinned: boolean,
): boolean {
  if (!pinned) return true;
  const finer = nextSegmentDuration < currentSegmentDuration;
  return !(finer && nextSegmentDuration < PINNED_SEGMENT_DURATION);
}

/**
 * There is deliberately no `disabledZoomLevels()` helper here.
 *
 * D24 asks for the finer zoom buttons to "render disabled", and upstream's `ReviewTimeline`
 * already disables its zoom-in button when the current index is the last of
 * `possibleZoomLevels`. So the fork simply passes a TRUNCATED level list past the pin and
 * gets the disabled state for free, with no upstream change and no second source of truth
 * about which levels are allowed — see `ContinuousTimelinePanel`, which also carries the one
 * case that must not truncate (a user who was already zoomed in when they scrolled deep).
 */
