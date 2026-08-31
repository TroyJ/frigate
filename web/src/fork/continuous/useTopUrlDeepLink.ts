/**
 * fork/continuous — §2A.8: recover a notification deep link that HA's ingress dropped.
 *
 * What was measured on the box (2026-08-31, iOS 18.7 Simulator against real HA, running
 * `0.17.1-troy.21`). The push carries `504b4bcb_frigate-fa/ingress/review?id=<review_id>`,
 * so the phone opens `https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review?id=<id>`.
 * That URL is HOME ASSISTANT's panel, not Frigate. HA keeps it in the outer location and
 * builds the add-on iframe as `https://bali.jezcf.com/api/hassio_ingress/<token>//` — the
 * `review?id=` sub-path is dropped on the way in. Frigate boots with an in-frame path of
 * `//`, i.e. Live, with no params: the tap appears to do nothing. `/hassio/ingress/<slug>/…`
 * renders no iframe at all, and no HA route forwards a sub-path, so there is no fix on the
 * link side. The parent frame is same-origin, so the app can read the URL the user actually
 * opened — that is the whole recovery.
 *
 * Why this lives at the ROUTER's root and not in `useDeepLink`: the handler in
 * `useContinuousDeepLink` only exists once `pages/Events.tsx` is mounted, and the whole
 * point of this defect is that the app is on LIVE. Nothing on the Review page can run. So
 * this bridge sits inside `<BrowserRouter>`, turns the parent's URL into a normal in-app
 * navigation to `/review?…`, and then the existing handler runs on the app's OWN URL with
 * every §2A.5 / D19 behaviour identical — there is no second copy of the link logic.
 *
 * **The boot-only read was not enough (`.24`, measured 2026-08-31 on the iOS Simulator
 * against real HA).** With the Frigate panel ALREADY OPEN, tapping a notification does not
 * reload anything: the companion app asks HA's frontend to navigate in page —
 * `history.pushState(null, "", "/<slug>/ingress/review?id=…&camera=…")` followed by a
 * `location-changed` event — and HA keeps the SAME iframe element (a probe mark on it
 * survives), with the same `src` of `…/hassio_ingress/<token>//`. Nothing in the frame
 * reloads, so a bridge that only runs at mount never sees the new href: the link is
 * silently ignored for exactly the user who is most likely to tap it, the one who was just
 * looking at Frigate. It "worked" in testing only when HA happened to be on another panel,
 * because that is what creates the iframe.
 *
 * So the bridge also SUBSCRIBES to the parent's navigations while it is mounted —
 * `location-changed` (HA's own event, fired on every in-app navigation) and `popstate`,
 * plus cheap re-reads on `pageshow` / `visibilitychange` for the iOS case where the webview
 * comes back without either. Every one of them funnels into the same guarded read, so an
 * unchanged href costs one string comparison and a new one behaves exactly like a boot.
 *
 * Two hard rules:
 *  - **`.25` trade-off, stated because it is not obvious:** the href key is bypassed for a
 *    deliberate `location-changed` and for nothing else. That is what makes a re-tap of the
 *    SAME notification work — the bridge never writes the parent, so HA's panel URL stays
 *    at `…/review?id=A` all session and a second tap on A produces a byte-identical href.
 *    The cost is that a `location-changed` burst could re-seek; a 500 ms window bounds it.
 *  - consume ONCE PER LINK — per LINK, not per boot, which is why the key is the href and
 *    not a boolean. A module-level flag was not enough (`.23` reviewer finding, MAJOR): it
 *    covers a remount, but anything that REBOOTS the app inside the frame —
 *    RestartDialog's `window.location.href = baseUrl`, the language provider's `reload()`,
 *    AuthForm after login, iOS reclaiming the WKWebView — starts a fresh module instance,
 *    re-reads the UNCHANGED outer `…/ingress/review?id=` and yanks the user back to a
 *    notification they dealt with an hour ago. So the guard is keyed on the parent's href
 *    in `sessionStorage`: same origin, survives an in-frame reload, and dies with the panel
 *    session (a NEW tap on a NEW review is a new href and still fires).
 *  - never write to the parent. `navigate(..., { replace: true })` acts on the IFRAME's own
 *    history; `window.top.history` is not touched, so HA's panel is left exactly as it was.
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { deepLinkFromTop, TopDeepLink } from "./deepLink";

/**
 * The last href this module acted on, in memory.
 *
 * `.23` had a boolean here and asked the question once per boot. `.24` removes that: the
 * parent's URL CAN change without a reload (see the header), so "have we already asked" is
 * the wrong question and "have we already acted on THIS href" is the right one. It is also
 * the whole guard when `sessionStorage` is unavailable, and it is what stops a burst of
 * `location-changed` / `visibilitychange` events doing anything more than a comparison.
 */
let lastHandledHref: string | null = null;
/**
 * When we last acted, for the burst window below.
 *
 * `.25`: a deliberate `location-changed` may repeat an href we have already handled (see
 * `attempt`), so the href key alone stops being the whole guard for that source. What must
 * NOT happen is a burst of events on one navigation re-seeking the player several times, so
 * the key is joined by a short time window.
 */
let lastHandledAt = 0;
/** Long enough to swallow one navigation's event burst, short enough that a human re-tap wins. */
const BURST_WINDOW_MS = 500;

/**
 * Where the href of the link we have already acted on is remembered.
 *
 * `sessionStorage`, not `localStorage`: the guard must die when the panel session does, so
 * that tomorrow's tap on the same review still works.
 */
const CONSUMED_KEY = "frigate.fork.topDeepLink.consumed";

/**
 * Has this exact parent URL already been consumed in this session?
 *
 * A throw is answered NO. Storage can be disabled (Safari private mode, a locked-down
 * embedder, an over-full quota), and in that case this file behaves exactly as `.22` did:
 * the module flag alone, so the link fires once per boot and an in-frame reload replays it.
 * That is the old defect, not a new one, and it is strictly better than a link that never
 * fires at all.
 */
function alreadyConsumed(href: string): boolean {
  if (lastHandledHref === href) return true;
  try {
    return window.sessionStorage.getItem(CONSUMED_KEY) === href;
  } catch {
    return false;
  }
}

function markConsumed(href: string) {
  lastHandledHref = href;
  lastHandledAt = Date.now();
  try {
    window.sessionStorage.setItem(CONSUMED_KEY, href);
  } catch {
    // see `alreadyConsumed` — the in-memory key still holds for this boot
  }
}

/**
 * Test seam: neither the module flag nor the session key is observable any other way.
 *
 * `keepSession` is how a test spells "the app rebooted inside the frame" — that is exactly
 * what a reload does to this module's state, and it is the case the whole `.23` change is
 * about, so it has to be reachable.
 */
export function resetTopDeepLinkForTests({ keepSession = false } = {}) {
  lastHandledHref = null;
  lastHandledAt = 0;
  if (keepSession) return;
  try {
    window.sessionStorage.removeItem(CONSUMED_KEY);
  } catch {
    // nothing to clear
  }
}

/**
 * Read the parent frame's URL and decide whether it carries a link for us.
 *
 * The cross-origin case is a THROW, not a comparison: `window.top.location.href` raises a
 * SecurityError when the embedder is another origin, and treating that as "no link" (rather
 * than letting it escape) is what keeps Frigate embeddable anywhere.
 */
export function readTopLocation(): {
  topHref: string | null;
  sameOrigin: boolean;
} {
  if (typeof window === "undefined") return { topHref: null, sameOrigin: true };
  if (!window.top || window.top === window.self)
    return { topHref: null, sameOrigin: true };
  try {
    return { topHref: window.top.location.href, sameOrigin: true };
  } catch {
    return { topHref: null, sameOrigin: false };
  }
}

export function readTopDeepLink(ownSearch: string): TopDeepLink | null {
  const { topHref, sameOrigin } = readTopLocation();
  return deepLinkFromTop({ ownSearch, topHref, sameOrigin });
}

/**
 * Where an attempt came from. The three are NOT interchangeable — see `attempt` (`.25`).
 *
 *  - `boot`       the effect's first run, once per module instance
 *  - `navigation` HA deliberately navigated its panel (`location-changed`)
 *  - `recheck`    something MAY have changed while we were not looking (`popstate`,
 *                 `pageshow`, `visibilitychange`)
 */
type AttemptSource = "boot" | "navigation" | "recheck";

/**
 * The parent window, or null if there isn't one we may touch.
 *
 * The cross-origin case is established by TOUCHING `location` — the getter is what throws,
 * and a bridge that registered listeners on an embedder it cannot read would be both
 * useless and rude.
 */
function readableParent(): Window | null {
  try {
    if (typeof window === "undefined") return null;
    const top = window.top;
    if (!top || top === window.self) return null;
    void top.location.href; // throws on a cross-origin embedder
    return top;
  } catch {
    return null;
  }
}

export function useTopUrlDeepLink() {
  const location = useLocation();
  const navigate = useNavigate();
  // The app's OWN search string, read at the moment of each attempt rather than closed over:
  // rule 2 in `deepLinkFromTop` is "our own params win", and by the time HA navigates the
  // panel again the SPA is somewhere else entirely.
  const search = useRef(location.search);
  search.current = location.search;

  useEffect(() => {
    /**
     * One guarded read of the parent's URL. Safe to call as often as we like: an href that
     * has already been acted on costs a string comparison, and an href with no link costs
     * a URL parse. Nothing here writes to the parent.
     */
    const attempt = (source: AttemptSource) => {
      const { topHref, sameOrigin } = readTopLocation();
      if (!sameOrigin || !topHref) return;
      // `.25` — WHICH sources the href key applies to, and why it is not all of them.
      //
      // A `location-changed` is a DELIBERATE `navigate()` in Home Assistant's frontend, and
      // HA's own `navigate()` has no same-URL short-circuit: it always pushes and always
      // fires the event (`_external-repos/ha-frontend/src/common/navigate.ts`). Since this
      // bridge never writes the parent, the panel URL stays at `…/review?id=A` for the rest
      // of the session — so tapping the SAME notification again (or the "end" rewrite of the
      // same push) produces a byte-identical href, and keying it would drop the tap in
      // silence. That is the exact symptom `.24` was cut to remove, so `navigation` bypasses
      // the key and is bounded by the burst window instead.
      //
      // Every other source keeps the key, and each for a concrete reason:
      //   boot        — an in-frame reload must not replay a notification already dealt with
      //   popstate    — HA closes dialogs with `history.back()` (`ensureDialogsClosed`, same
      //                 file), which arrives here as a popstate on an UNCHANGED href
      //   recheck     — `pageshow`/`visibilitychange` are "we may have missed something"
      //                 polls, not user intent; re-firing on them would yank the user back
      //                 every time they switch apps
      if (source !== "navigation" && alreadyConsumed(topHref)) return;
      if (
        source === "navigation" &&
        lastHandledHref === topHref &&
        Date.now() - lastHandledAt < BURST_WINDOW_MS
      ) {
        return; // one navigation, several events — act once
      }
      // Rule 2 ("our own params win") does NOT apply to a parent navigation. At boot, and on
      // a recheck, the parent's URL may be arbitrarily old, so a link the app already carries
      // is the more specific intent. A navigation is the opposite case: the user just tapped
      // something, so the parent's href is by definition the newer intent — and applying
      // rule 2 there dropped the second notification of a session, because the app's own URL
      // still carries the first one until the handler consumes it. Caught by the L1 test
      // "fires again for a DIFFERENT notification without any reload".
      const link = deepLinkFromTop({
        ownSearch: source === "navigation" ? "" : search.current,
        topHref,
        sameOrigin,
      });
      // Not marked when there is no link: an ordinary visit must not poison the key for a
      // notification that arrives later on the same href.
      if (!link) return;
      markConsumed(topHref);
      navigate(`/review?${link.search}`, { replace: true });
    };

    attempt("boot"); // the `.22`/`.23` path, unchanged in behaviour

    // …and while we are mounted, whenever the PARENT navigates. `location-changed` is Home
    // Assistant's own event (its frontend fires it on every in-app navigation, which is how
    // the companion app opens a notification when HA is already running); `popstate` covers
    // a back/forward in the panel. See the header for what was measured.
    const parent = readableParent();
    const onNavigation = () => attempt("navigation");
    const onRecheck = () => attempt("recheck");
    if (parent) {
      try {
        parent.addEventListener("location-changed", onNavigation);
        // NOT `navigation`: a popstate is as likely to be HA closing a dialog with
        // `history.back()` as it is a real back/forward, and it carries no new intent.
        parent.addEventListener("popstate", onRecheck);
      } catch {
        // an embedder that refuses listeners is simply "no link", as ever
      }
    }
    // iOS brings a webview back without either of the above; both are cheap, and both keep
    // the href key because neither is a user asking for anything.
    window.addEventListener("pageshow", onRecheck);
    document.addEventListener("visibilitychange", onRecheck);

    return () => {
      if (parent) {
        try {
          parent.removeEventListener("location-changed", onNavigation);
          parent.removeEventListener("popstate", onRecheck);
        } catch {
          // nothing to remove
        }
      }
      window.removeEventListener("pageshow", onRecheck);
      document.removeEventListener("visibilitychange", onRecheck);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Mounted once inside `<BrowserRouter>` (see `App.tsx`). Renders nothing — it exists so the
 * hook has a router context to navigate with.
 */
export function ContinuousTopLinkBridge() {
  useTopUrlDeepLink();
  return null;
}
