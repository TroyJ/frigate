/**
 * fork/continuous — the two decisions inside `navigateToTime` that are worth testing on
 * their own (§2A.3 / D11 / D14).
 *
 * Both live here rather than inline in the provider and the strips because both are rules
 * that were got WRONG once already in this build, in a place where nothing could see it:
 * scrolling before the page's commit (so the surface's closure still held the old items),
 * and treating a day-jump and a moment-jump as the same scroll on a dense strip.
 */
import { startOfDayInTz } from "./timeAlign";
import { NavIntent } from "./ContinuousProvider";

export type NavStep =
  /** No surface of that name is mounted — park the request for `registerSurface`. */
  | "defer"
  /** The target item has not arrived yet; re-check when a page lands, or on the timer. */
  | "wait"
  /** Scroll now. */
  | "go";

/**
 * What a parked navigation should do on this commit.
 *
 * The `wait` state is the whole point. `ensureLoaded` resolves when the PAGE has landed in
 * provider state, which is one commit before the surface that has to scroll has re-rendered
 * with it — call `scrollToTime` there and it scrolls to an index computed from the OLD
 * items array, which for a deep link means reliably the wrong card. Waiting for the item to
 * be present in the merged list is the observable form of "the surface can see it now".
 *
 * It is bounded, and the bound matters as much as the wait: an id that is genuinely not in
 * the window (deleted between the push and the tap, or hidden by a filter the user has
 * since applied) must still scroll to the TIME rather than be dropped in silence — that is
 * the §2A.5 "lands at now with no explanation" failure, in a different costume.
 */
export function planNavigation(params: {
  hasSurface: boolean;
  selectId?: string;
  itemLoaded: boolean;
  now: number;
  deadline: number;
}): NavStep {
  if (!params.hasSurface) return "defer";
  if (!params.selectId) return "go";
  if (params.itemLoaded) return "go";
  return params.now < params.deadline ? "wait" : "go";
}

/**
 * Where a DENSE strip (S2/S3/S4) scrolls for a navigation — D14.
 *
 * A calendar day-jump lands on the day's oldest edge, 00:00 in the display timezone, which
 * the caller then places at the top of the viewport so the user scrolls UP through the day.
 * Anything else — a deep link, a segment click — lands on the moment itself; sending those
 * to midnight would put a 03:14 alert three hours off screen, which is precisely the D11
 * failure ("lands somewhere near it" is not "lands on it").
 */
export function denseStripTarget(
  t: number,
  intent: NavIntent | undefined,
  tz: string,
): number {
  return intent === "day" ? startOfDayInTz(t, tz) : t;
}
