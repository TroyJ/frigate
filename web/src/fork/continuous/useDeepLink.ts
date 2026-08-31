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
 * What happens instead (§2A.3): resolve the id → open the scrubber AT the review's
 * `start_time` (`.23`: no lead-in — see `seekTarget.ts` for what was measured on a real
 * phone) → hand `navigateToTime` a TIMESTAMP, which is timezone-free, so the browser-local
 * `getBeginningOfDayTimestamp` bug in the old path (§2A.6) disappears rather than being
 * inherited.
 *
 * `.23` also adds `?camera=`: WHICH camera to open the moment on. Detection runs on one
 * camera and `review.alerts.mirror_from` mirrors the review onto the other lens, so the
 * push carries the wide camera's review id while the useful picture is the telephoto's.
 * It is not a filter — it never touches `cameras=`/`reviewFilter`, because a filter change
 * discards the loaded window (§2A.4 / F14.4).
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
import { ReviewSegment, ReviewSeverity } from "@/types/review";
import { TimelineType } from "@/types/timeline";
import {
  DeepLinkProblem,
  DeepLinkRequest,
  parseDeepLink,
  preferResolveProblem,
} from "./deepLink";
import { reviewSeekTarget } from "./seekTarget";
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
  /** For a bare `?t=` on History, which camera to open. */
  cameraForMoment?: string;
  /**
   * Every camera in the loaded config, for `?camera=` (`.23`).
   *
   * `undefined` means "not known yet" — the config is an SWR call — and is NOT the same as
   * "no cameras": a link that names a camera while the config is still in flight is trusted
   * rather than second-guessed, because the alternative is silently ignoring the one thing
   * the link asked for. A camera that genuinely is not there degrades rather than crashing
   * (F15), so trusting it is bounded.
   */
  knownCameras?: string[];
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
  cameraForMoment,
  knownCameras,
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
  /**
   * The problem the user dismissed, BY VALUE rather than a boolean latch.
   *
   * A latch swallowed everything that came later: dismiss "that view no longer exists" while
   * the id is still resolving and the "this alert no longer exists" that follows never
   * appears — which is the §2A.5 silent failure, reintroduced by the mechanism meant to make
   * the notice polite.
   */
  const [dismissedProblem, setDismissedProblem] = useState<DeepLinkProblem>();
  const candidate = resolveProblem ?? parseProblem;
  const problem = candidate === dismissedProblem ? undefined : candidate;
  const dismissProblem = useCallback(
    () => setDismissedProblem(candidate),
    [candidate],
  );
  /** The moment the link navigated to, for the late footage-expired check below. */
  const [navigatedStart, setNavigatedStart] = useState<number>();

  const request = useMemo(
    () =>
      parseDeepLink({
        id: searchParams.get("id"),
        t: searchParams.get("t"),
        tab: searchParams.get("tab"),
        surface: searchParams.get("surface"),
        camera: searchParams.get("camera"),
      }),
    [searchParams],
  );

  // Everything below is kept out of the deps and read through refs: this effect must run
  // exactly ONCE per link, and `openRecording` / `revealOnReviewPage` are inline closures
  // in `pages/Events.tsx` with a new identity on every render.
  const latest = useRef({
    openRecording,
    revealOnReviewPage,
    cameraForMoment,
    knownCameras,
  });
  latest.current = {
    openRecording,
    revealOnReviewPage,
    cameraForMoment,
    knownCameras,
  };

  /**
   * `?camera=` → the camera to open the moment on, or the fallback plus a notice (`.23`).
   *
   * Three rules, in order:
   *  1. no `camera=` → the fallback (the review's own camera, or `cameraForMoment`), i.e.
   *     exactly `.22`'s behaviour for every link already sitting on a phone.
   *  2. a camera the config HAS → that one. This is the whole point: the push carries the
   *     wide lens's review id, and `&camera=entrance_tele` opens the telephoto at the same
   *     moment. It is a view choice, not a filter — nothing here touches `reviewFilter`.
   *  3. a camera the config does NOT have → the fallback, AND say so. A link is a stored
   *     reference (§2A.5): cameras get renamed and removed, and silently opening a
   *     different camera than the link named is the "landed somewhere with no explanation"
   *     failure D11 exists to remove.
   *
   * When the camera list is not loaded yet the link is trusted (rule 2), see `knownCameras`.
   */
  const resolveCamera = useCallback(
    // Generic in the FALLBACK so the caller keeps what it knows: the `?id=` path passes the
    // review's own camera (a string, so the result is a string), the `?t=` path passes a
    // camera that may not exist yet.
    <T extends string | undefined>(named: string | undefined, fallback: T) => {
      if (!named) return fallback;
      const known = latest.current.knownCameras;
      if (!known || known.includes(named)) return named as string | T;
      setResolveProblem((prev) => preferResolveProblem(prev, "camera-missing"));
      return fallback as string | T;
    },
    [],
  );

  // React 18 StrictMode mounts every effect twice in dev, and this one fires an HTTP GET
  // and opens a page. Key the guard on the LINK, not on a boolean, so a second link in the
  // same session still works.
  const handled = useRef<string>();

  useEffect(() => {
    if (!ready || !request) return;
    const key = `${request.id ?? ""}|${request.t ?? ""}|${request.tab}|${request.view}|${request.camera ?? ""}`;
    if (handled.current === key) return;
    handled.current = key;
    // The token every continuation below checks before it writes anything. Link 1's lookup
    // can still be in flight when link 2 arrives (the user taps a second notification, or
    // the app navigates), and without this its `.then` lands on link 2's state: a `nav` to
    // the wrong moment, a `navigatedStart` that makes the wrong expiry check, a problem for
    // an alert nobody asked about. Not solved by cancellation — StrictMode's immediate
    // cleanup would cancel the ONLY lookup (see below).
    const token = key;

    // A link is a fresh start. Without this, a SECOND link in the same session inherits the
    // first one's problem — which `preferResolveProblem` then refuses to replace with
    // anything of lower rank — and inherits its dismissal, so its own notice never shows.
    setParseProblem(undefined);
    setResolveProblem(undefined);
    setDismissedProblem(undefined);
    setNavigatedStart(undefined);
    setNav(undefined);

    if (request.problems.length) setParseProblem(request.problems[0]);

    // A bare `?tab=` / `?surface=` is INERT, exactly as it is upstream: `notificationTab` is
    // only ever read by the handler that opens a recording from the same link, so a `tab`
    // with no `id`/`t` has nothing to act on there either. It is parsed (so an invalid value
    // is still reported rather than silently ignored) and then left alone — including the
    // URL, because stripping the whole search string for a param we did not act on would
    // take `?group=` and the other filter params down with it.
    if (!request.id && request.t === undefined) return;

    // The params ARE consumed once the link navigates, exactly as upstream's
    // `useSearchEffect` does it — otherwise every later navigation re-runs the link.
    // Upstream's OTHER handlers (`cameras`, `labels`, `zones`, `group`) memoise their value
    // during render, so they still see it and still apply; those filters must be applied
    // BEFORE the window loads (§2A.4 / F14.4), which is exactly what happens on this commit.
    navigate(location.pathname + location.hash, {
      state: location.state,
      replace: true,
    });

    if (!request.id) {
      // Narrowed by the bare-param early return above: with no `id`, a request that reaches
      // here has a moment.
      const moment = request.t as number;
      if (request.view === "history") {
        // `.23`: `camera=` overrides the default choice for a bare moment. On
        // `surface=review` there is no player and no camera to choose, so it is inert
        // there — see the note on the `?id=` branch below.
        const camera = resolveCamera(
          request.camera,
          latest.current.cameraForMoment,
        );
        // No camera to open — the History scrubber is per-camera. Say so rather than
        // opening an arbitrary one.
        if (!camera) {
          // Reachable: `cameraForMoment` falls back to the first configured camera, so this
          // is the genuinely camera-less install (or config not loaded when the link fired).
          setResolveProblem((prev) =>
            preferResolveProblem(prev, "review-unavailable"),
          );
          return;
        }
        latest.current.openRecording({
          camera,
          startTime: moment,
          severity: "alert",
          tab: request.tab,
        });
      }
      setNav({ t: moment, surface: surfaceFor(request.view, request.tab) });
      setNavigatedStart(moment);
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
        if (handled.current !== token) return; // a newer link owns the page now
        // No `resp.status !== 200` branch: axios REJECTS a non-2xx, so it would be dead
        // code. An empty body is the only success-shaped failure left.
        const review = resp.data;
        if (!review) {
          setResolveProblem((prev) =>
            preferResolveProblem(prev, "review-missing"),
          );
          return;
        }
        // `.23`: AT the detection, not 4 s before it (`seekTarget.ts`).
        const startTime = reviewSeekTarget(review.start_time);
        // The footage-expired check does NOT happen here: `oldestRecording` comes from an
        // SWR call that is usually still in flight on a cold load, so sampling it once at
        // this instant meant §2A.5's "older than retention" reason simply never appeared for
        // the links most likely to need it. It is an effect below, keyed on the horizon
        // becoming known.
        setNavigatedStart(review.start_time);
        if (request.view === "history") {
          // `.23`: open the moment on the camera the link named, falling back to the
          // review's own. The review is still resolved exactly as before — the id decides
          // WHEN and whether the link is alive at all, `camera=` only decides WHICH lens.
          latest.current.openRecording({
            camera: resolveCamera(request.camera, review.camera),
            startTime,
            severity: review.severity,
            tab: request.tab,
          });
        } else {
          // `surface=review`: `camera=` is deliberately IGNORED (`.23`). The Review grid
          // shows CARDS, and the card this link selects is the wide camera's review — the
          // one whose id the push carries. Honouring `camera=` here could only mean either
          // filtering the grid (which discards the loaded window, §2A.4 / F14.4) or
          // selecting a different review than the link named. Neither is what the param
          // says. It stays inert, and no notice is raised for an unknown camera on this
          // surface, because nothing was overridden.

          // `withReviewedFlag` is a SECOND round-trip, so the token has to be re-checked
          // after it — and at STATEMENT level, so the whole continuation stops. Suppressing
          // only the reveal let execution fall through to `setNav` below, which is the one
          // line that actually moves the page: a slow link-1 lookup landing after link 2 had
          // navigated would have sent the user to link 1's moment.
          const full = await withReviewedFlag(review);
          if (handled.current !== token) return;
          if (latest.current.revealOnReviewPage?.(full)) {
            // D19: we changed what the page shows in order to reach the target — say so.
            setResolveProblem((prev) =>
              preferResolveProblem(prev, "filters-adjusted"),
            );
          }
        }
        setNav({
          t: startTime,
          selectId: review.id,
          surface: surfaceFor(request.view, request.tab),
        });
      })
      .catch((err) => {
        if (handled.current !== token) return; // a newer link owns the page now
        // D9: a stored link routinely points at something that is gone. 404 is the normal
        // case and gets the specific wording; anything else is "could not be loaded".
        setResolveProblem((prev) =>
          preferResolveProblem(
            prev,
            err?.response?.status === 404
              ? "review-missing"
              : "review-unavailable",
          ),
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
    setResolveProblem((prev) => preferResolveProblem(prev, "footage-expired"));
  }, [navigatedStart, oldestRecording]);

  return { nav, problem, dismissProblem };
}
