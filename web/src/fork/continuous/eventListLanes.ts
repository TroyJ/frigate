/**
 * fork/continuous — how many LANES the History `events` list runs in (List A #17).
 *
 * The defect this exists to prevent, measured on an iPhone 17 Simulator (iOS 18.7) through
 * the real HA ingress on `0.17.1-troy.21`
 * (`frigate-fork/testing/evidence/ios-sim-history-events-two-lanes-2026-08-31.png`): two
 * cards on every virtual row in portrait, the second one shifted 50 % and clipped at the
 * right edge. Two independent decisions disagreed —
 *
 *   - the VIRTUALIZER was told `lanes: isMobile ? 2 : 1`, i.e. two lanes on every phone and
 *     tablet, in every orientation;
 *   - the item's WIDTH came from a Tailwind class, `isMobile && "sm:portrait:w-1/2"`, which
 *     only halves an item at a viewport ≥ 640 px;
 *   - the lane OFFSET was `left: v.lane ? "50%" : 0`, unconditionally.
 *
 * So on a 402 px phone the virtualizer packed two items per row while each stayed full
 * width, and the second was pushed half a screen off the edge.
 *
 * Upstream's rule for the same list is `grid-cols-1` + `isMobile && "sm:portrait:grid-cols-2"`
 * (`views/recording/RecordingView.tsx`): two columns ONLY on a mobile device that is both
 * portrait and at least `sm` wide — a tablet in portrait — and one everywhere else,
 * including phones in portrait and mobiles in landscape. This function is that rule, once,
 * and the component feeds its answer to BOTH the virtualizer and the geometry so the two
 * cannot drift apart again.
 *
 * `mobile` is `react-device-detect`'s `isMobile` — true for phones AND tablets, matching
 * upstream's class. `width` is the CSS viewport width (`documentElement.clientWidth`), which
 * is the same quantity a `min-width` media query evaluates, and `portrait` comes from
 * `matchMedia("(orientation: portrait)")` rather than from comparing two numbers.
 */
export type EventListLanesInput = {
  /** `react-device-detect`'s `isMobile`: phone or tablet */
  mobile: boolean;
  /** CSS viewport width in px — `document.documentElement.clientWidth` */
  width: number;
  /** `matchMedia("(orientation: portrait)").matches` */
  portrait: boolean;
};

/** Tailwind's `sm` breakpoint (tailwind.config.cjs) — the `sm:` in `sm:portrait:*`. */
export const SM_BREAKPOINT = 640;

export function lanesFor({
  mobile,
  width,
  portrait,
}: EventListLanesInput): number {
  return mobile && portrait && width >= SM_BREAKPOINT ? 2 : 1;
}
