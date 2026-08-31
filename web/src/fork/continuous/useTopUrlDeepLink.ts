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
 * Two hard rules:
 *  - consume ONCE PER LINK. A module-level flag is not enough (`.23` reviewer finding,
 *    MAJOR): it covers a remount, but anything that REBOOTS the app inside the frame —
 *    RestartDialog's `window.location.href = baseUrl`, the language provider's `reload()`,
 *    AuthForm after login, iOS reclaiming the WKWebView — starts a fresh module instance,
 *    re-reads the UNCHANGED outer `…/ingress/review?id=` and yanks the user back to a
 *    notification they dealt with an hour ago. So the guard is keyed on the parent's href
 *    in `sessionStorage`: same origin, survives an in-frame reload, and dies with the panel
 *    session (a NEW tap on a NEW review is a new href and still fires).
 *  - never write to the parent. `navigate(..., { replace: true })` acts on the IFRAME's own
 *    history; `window.top.history` is not touched, so HA's panel is left exactly as it was.
 */
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { deepLinkFromTop, TopDeepLink } from "./deepLink";

/**
 * Per-boot flag. Still here, and still first: within one boot the parent's URL cannot
 * change (a navigation in HA's panel reloads this frame), so re-asking after the app has
 * navigated can only produce a stale yes. It is also the whole guard when `sessionStorage`
 * is unavailable — see `alreadyConsumed`.
 */
let consumed = false;

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
  try {
    return window.sessionStorage.getItem(CONSUMED_KEY) === href;
  } catch {
    return false;
  }
}

function markConsumed(href: string) {
  try {
    window.sessionStorage.setItem(CONSUMED_KEY, href);
  } catch {
    // see `alreadyConsumed` — degrade to `.22` behaviour rather than refuse to navigate
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
  consumed = false;
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

export function useTopUrlDeepLink() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (consumed) return;
    // Marked consumed on the FIRST run whatever the answer, including "no link at all":
    // this is a boot-time question, and re-asking it later can only produce a stale yes.
    consumed = true;
    const { topHref, sameOrigin } = readTopLocation();
    // The app's OWN search string, not the parent's and not "" — rule 2 in
    // `deepLinkFromTop` is "our own params win", and it can only apply if it is given them.
    const link = deepLinkFromTop({
      ownSearch: location.search,
      topHref,
      sameOrigin,
    });
    if (!link || !topHref) return;
    // The `.23` guard: this exact outer URL has already been turned into a navigation in
    // this panel session, so an in-frame reload must NOT replay it. Checked after the link
    // is resolved, so an ordinary visit never writes the key.
    if (alreadyConsumed(topHref)) return;
    markConsumed(topHref);
    navigate(`/review?${link.search}`, { replace: true });
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
