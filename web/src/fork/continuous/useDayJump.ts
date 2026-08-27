/**
 * fork/continuous — the calendar as a NAVIGATOR (D1/D14/D15), for the seam in
 * `components/filter/ReviewFilterGroup.tsx` and `overlay/MobileReviewSettingsDrawer.tsx`.
 *
 * Upstream's calendar is a FILTER: picking a day sets `{after, before}` on the review
 * filter, which collapses the view to that single day. D1 removes that — the window is
 * continuous and a day pick is a jump within it, so this replaces the filter write with one
 * `navigateToTime(00:00 box time, {intent: "day"})` (§2A.3: the SAME primitive the alert
 * deep-link uses; built separately they diverge).
 *
 * Two things it deliberately does NOT do:
 *  - it does not touch `{after, before}` at all. Setting them would discard every loaded
 *    page (§14.4) and re-cap the view at that day, which is the D1 path we are removing —
 *    the user would land on the day and then be unable to scroll out of it.
 *  - it does not decide what "the day" looks like per surface. That is D14, and it lives in
 *    each surface's `scrollToTime` (sparse → the day's earliest item; dense → 00:00 at the
 *    top of the viewport). The intent flag is all this passes down.
 *
 * `jump()` returns FALSE when the continuous window is off, and the caller must then run
 * upstream's filter path unchanged — that is what keeps the toggle a real rollback.
 */
import { useCallback, useMemo } from "react";
import { useContinuous } from "./ContinuousProvider";
import { dayStartFromPickedDate } from "./dayNav";

export type DayJump = {
  /**
   * The day the active surface is looking at, for the calendar's own selected-day marker
   * and button label — undefined while the surface is on today, which is when upstream's
   * calendar reads "Last 24 hours".
   */
  day?: Date;
  /** Handle a calendar pick. `false` → the caller falls back to upstream's day filter. */
  jump: (day?: Date) => boolean;
};

export function useContinuousDayJump(): DayJump {
  const ctx = useContinuous();

  const jump = useCallback(
    (day?: Date) => {
      if (!ctx.enabled) return false;
      if (!day) {
        // "Reset" means "back to now" here, not "clear the filter" — there is no filter.
        ctx.scrollToTop();
        return true;
      }
      // D14/D15/§2A.6: the day the USER clicked, resolved to midnight in the BOX's zone.
      // Never `day.getTime()`, which is midnight wherever the picker's Date was built.
      ctx.navigateToTime(dayStartFromPickedDate(day, ctx.tz), {
        intent: "day",
      });
      return true;
    },
    [ctx],
  );

  const day = useMemo(
    () =>
      ctx.enabled && ctx.calendarDay
        ? new Date(ctx.calendarDay * 1000)
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx.enabled, ctx.enabled && ctx.calendarDay],
  );

  return { day, jump };
}
