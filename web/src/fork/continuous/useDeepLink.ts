/**
 * fork/continuous — the alert deep-link handler (§2A / D11), for the seam in
 * `pages/Events.tsx`.
 *
 * It replaces upstream's `useSearchEffect("id", …)`, whose mechanism is the one D1 removes:
 * resolve the id → **set the review filter to that review's calendar day** → open the
 * scrubber. Under a continuous window that either collapses the window back to one day (so
 * the user cannot scroll out of where the link dropped them) or is ignored (so the link
 * lands at "now" showing the wrong moment). Both failures are silent.
 *
 * What happens instead (§2A.3): resolve the id → open the scrubber at
 * `start_time - REVIEW_PADDING` → hand `navigateToTime` a TIMESTAMP, which is
 * timezone-free, so the browser-local `getBeginningOfDayTimestamp` bug in the old path
 * (§2A.6) disappears rather than being inherited.
 *
 * Every §2A.5 failure mode ends in a STATED outcome, because a link is a stored reference
 * and outlives the thing it points at:
 *   deleted review     → "this alert no longer exists", not a silent landing at now
 *   older than retention → land on it anyway; the player's D21 blackout says why there is
 *                        no video, and the notice says the link is older than we keep
 *   unknown `tab=`     → fall back to `timeline` AND say so (upstream keeps the last tab,
 *                        which on a fresh load is indistinguishable from the link working)
 *   nonsense `t=`      → ignored, and said so (see `parseMoment` for ms-vs-s)
 *
 * D19: reaching the target may require relaxing the Review page's own view — the severity
 * tab it is on, and `showReviewed` — and the UI says so. Landing silently nowhere is the
 * D11 failure mode, so a filter that hides the target is treated as something to fix, not
 * as a reason to give up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import axios from "axios";
import { REVIEW_PADDING, ReviewSegment, ReviewSeverity } from "@/types/review";
import { TimelineType } from "@/types/timeline";
import {
  DEFAULT_TAB,
  DeepLinkProblem,
  DeepLinkRequest,
  parseDeepLink,
} from "./deepLink";
import { DeepLinkNav, SurfaceName } from "./ContinuousProvider";

export type DeepLinkOpen = {
  camera: string;
  startTime: number;
  severity: ReviewSeverity;
  tab: TimelineType;
};

export type DeepLinkResult = {
  /** Pass to `<ContinuousProvider initialNav={…}>`; it runs once, after the toggle loads. */
  nav?: DeepLinkNav;
  /** The validated `?tab=` (§2A.4) — `timeline` unless the link named a real one. */
  tab: TimelineType;
  /** What the user is told about the link, if anything. */
  problem?: DeepLinkProblem;
  dismissProblem: () => void;
};

type Params = {
  /** False until the continuous toggle has loaded — nothing may be consumed before then. */
  ready: boolean;
  /** Open the History scrubber (`pages/Events.tsx`'s `setRecording`). */
  openRecording: (open: DeepLinkOpen) => void;
  /** D19: relax the Review page's view so the target is visible. */
  revealOnReviewPage?: (review: ReviewSegment) => boolean;
  /** Apply a validated `?tab=` (§2A.4) — it is contract even without an `id`. */
  onTab?: (tab: TimelineType) => void;
  /** For a bare `?t=` on History, which camera to open. */
  cameraForMoment?: string;
  /** Oldest retained recording, for the "older than retention" case (§2A.5). */
  oldestRecording?: number;
};

/** Which registered surface a `?surface=` value means (§2A.4). */
function surfaceFor(
  view: DeepLinkRequest["view"],
  tab: TimelineType,
): SurfaceName | undefined {
  // The Review page gets NO named surface, so the provider broadcasts to every mounted one.
  // That is its own rule (see `scrollToTop`): the grid AND the strip are on screen together,
  // and naming only the grid left the strip showing a different day beside a card the link
  // had just landed on. Each surface then does the D14-correct thing with the same request.
  if (view === "review") return undefined;
  // On History the three tabs ARE the three surfaces (S4/S5/S6) and only one is mounted, so
  // naming it means the navigation WAITS for that surface instead of firing at whichever
  // registered first — which matters because the panel mounts after the link resolves.
  return tab as SurfaceName;
}

/**
 * Fill in `has_been_reviewed`, which `/api/review/{id}` does not return.
 *
 * Measured on the box: the single-item endpoint's response is
 * `{id, camera, start_time, end_time, severity, thumb_path, data}` — no `has_been_reviewed`,
 * while the LIST endpoint carries it. The Review grid hides reviewed items by default, so
 * without the field the D19 reveal can never fire and a link to an already-reviewed alert
 * lands on an empty view with nothing said. One list call bounded to the item's own second
 * is the cheapest way to learn it, and it only happens for `?surface=review`.
 *
 * Failure is not fatal: the link still navigates, it just cannot know it needed a reveal.
 */
async function withReviewedFlag(review: ReviewSegment): Promise<ReviewSegment> {
  if (review.has_been_reviewed !== undefined) return review;
  try {
    const res = await axios.get<ReviewSegment[]>("review", {
      params: {
        after: Math.floor(review.start_time) - 1,
        before: Math.ceil(review.start_time) + 1,
        reviewed: 1,
        limit: 50,
      },
    });
    return res.data?.find((r) => r.id === review.id) ?? review;
  } catch {
    return review;
  }
}

export function useContinuousDeepLink({
  ready,
  openRecording,
  revealOnReviewPage,
  onTab,
  cameraForMoment,
  oldestRecording,
}: Params): DeepLinkResult {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [nav, setNav] = useState<DeepLinkNav>();
  /**
   * TWO slots, one precedence rule: a problem found while RESOLVING the link (it is gone,
   * its footage expired, the view had to be relaxed) always outranks one found while
   * PARSING it (a bad `tab`, a nonsense `t`). Mixing "overwrite" and "keep the first" across
   * call sites made the message depend on which async step happened to finish last — the
   * user could be told their `tab` was invalid instead of that the alert no longer exists.
   */
  const [parseProblem, setParseProblem] = useState<DeepLinkProblem>();
  const [resolveProblem, setResolveProblem] = useState<DeepLinkProblem>();
  const [dismissed, setDismissed] = useState(false);
  const problem = dismissed ? undefined : (resolveProblem ?? parseProblem);
  const dismissProblem = useCallback(() => setDismissed(true), []);
  /** The moment the link navigated to, for the late footage-expired check below. */
  const [navigatedStart, setNavigatedStart] = useState<number>();

  const request = useMemo(
    () =>
      parseDeepLink({
        id: searchParams.get("id"),
        t: searchParams.get("t"),
        tab: searchParams.get("tab"),
        surface: searchParams.get("surface"),
      }),
    [searchParams],
  );

  // Everything below is kept out of the deps and read through refs: this effect must run
  // exactly ONCE per link, and `openRecording` / `revealOnReviewPage` are inline closures
  // in `pages/Events.tsx` with a new identity on every render.
  const latest = useRef({
    openRecording,
    revealOnReviewPage,
    onTab,
    cameraForMoment,
  });
  latest.current = {
    openRecording,
    revealOnReviewPage,
    onTab,
    cameraForMoment,
  };

  // React 18 StrictMode mounts every effect twice in dev, and this one fires an HTTP GET
  // and opens a page. Key the guard on the LINK, not on a boolean, so a second link in the
  // same session still works.
  const handled = useRef<string>();

  useEffect(() => {
    if (!ready || !request) return;
    const key = `${request.id ?? ""}|${request.t ?? ""}|${request.tab}|${request.view}`;
    if (handled.current === key) return;
    handled.current = key;

    // The params are consumed here, exactly as upstream's `useSearchEffect` does it —
    // otherwise every later navigation re-runs the link. Upstream's OTHER handlers
    // (`cameras`, `labels`, `zones`, `group`) memoise their value during render, so they
    // still see it and still apply; those filters must be applied BEFORE the window loads
    // (§2A.4 / F14.4), which is exactly what happens on this same commit.
    navigate(location.pathname + location.hash, {
      state: location.state,
      replace: true,
    });

    if (request.problems.length) setParseProblem(request.problems[0]);
    // §2A.4's MUST-NOT-REGRESS table: `tab` is part of the contract on its own, not only
    // alongside `id`. Upstream consumed `?tab=` unconditionally; handing ownership to this
    // handler and then ignoring the bare case would silently drop it.
    latest.current.onTab?.(request.tab);

    if (!request.id) {
      if (request.t === undefined) return;
      if (request.view === "history") {
        const camera = latest.current.cameraForMoment;
        // No camera to open — the History scrubber is per-camera. Say so rather than
        // opening an arbitrary one.
        if (!camera) {
          // Reachable: `cameraForMoment` falls back to the first configured camera, so this
          // is the genuinely camera-less install (or config not loaded when the link fired).
          setResolveProblem("review-unavailable");
          return;
        }
        latest.current.openRecording({
          camera,
          startTime: request.t,
          severity: "alert",
          tab: request.tab,
        });
      }
      setNav({ t: request.t, surface: surfaceFor(request.view, request.tab) });
      return;
    }

    // NO cancellation flag here, and no cleanup function, deliberately.
    //
    // StrictMode runs the effect, tears it down, and runs it again — and the second run is
    // stopped by the `handled` guard above, because the lookup must not be fired twice. So a
    // cleanup that cancelled the in-flight request would cancel the ONLY one, and the link
    // would resolve to nothing at all: measured as a deep link that silently did nothing in
    // dev while `?t=` (no request) worked. This effect fires once per link for the life of
    // the page; there is nothing to cancel.
    axios
      .get<ReviewSegment>(`review/${request.id}`)
      .then(async (resp) => {
        // No `resp.status !== 200` branch: axios REJECTS a non-2xx, so it would be dead
        // code. An empty body is the only success-shaped failure left.
        const review = resp.data;
        if (!review) {
          setResolveProblem("review-missing");
          return;
        }
        const startTime = review.start_time - REVIEW_PADDING;
        // The footage-expired check does NOT happen here: `oldestRecording` comes from an
        // SWR call that is usually still in flight on a cold load, so sampling it once at
        // this instant meant §2A.5's "older than retention" reason simply never appeared for
        // the links most likely to need it. It is an effect below, keyed on the horizon
        // becoming known.
        setNavigatedStart(review.start_time);
        if (request.view === "history") {
          latest.current.openRecording({
            camera: review.camera,
            startTime,
            severity: review.severity,
            tab: request.tab,
          });
        } else if (
          latest.current.revealOnReviewPage?.(await withReviewedFlag(review))
        ) {
          // D19: we changed what the page shows in order to reach the target — say so.
          setResolveProblem((prev) => prev ?? "filters-adjusted");
        }
        setNav({
          t: startTime,
          selectId: review.id,
          surface: surfaceFor(request.view, request.tab),
        });
      })
      .catch((err) => {
        // D9: a stored link routinely points at something that is gone. 404 is the normal
        // case and gets the specific wording; anything else is "could not be loaded".
        setResolveProblem(
          err?.response?.status === 404
            ? "review-missing"
            : "review-unavailable",
        );
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, request]);

  /**
   * §2A.5 row 2 — "older than retention": land on it, and say why there is no video.
   *
   * Keyed on the horizon rather than evaluated inline, because `recordingsSummary` is an SWR
   * call that has usually not resolved when a cold-loaded link finishes resolving its id.
   * Evaluated once per navigation, and never over a problem that outranks it.
   */
  useEffect(() => {
    if (navigatedStart === undefined || oldestRecording === undefined) return;
    if (navigatedStart >= oldestRecording) return;
    setResolveProblem((prev) => prev ?? "footage-expired");
  }, [navigatedStart, oldestRecording]);

  return { nav, tab: request?.tab ?? DEFAULT_TAB, problem, dismissProblem };
}
