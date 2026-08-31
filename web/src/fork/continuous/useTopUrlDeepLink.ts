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
 *  - consume ONCE per boot. `consumed` is module-level, not a ref: the user navigating
 *    inside the app (or a page remount) must never be re-hijacked by a URL that has not
 *    changed since the tap. The parent's location is stale from the first navigation onward.
 *  - never write to the parent. `navigate(..., { replace: true })` acts on the IFRAME's own
 *    history; `window.top.history` is not touched, so HA's panel is left exactly as it was.
 */
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { deepLinkFromTop, TopDeepLink } from "./deepLink";

/** Once per boot — see the header. Exported only for the tests to reset. */
let consumed = false;

/** Test seam: the module flag is deliberately not observable any other way. */
export function resetTopDeepLinkForTests() {
  consumed = false;
}

/**
 * Read the parent frame's URL and decide whether it carries a link for us.
 *
 * The cross-origin case is a THROW, not a comparison: `window.top.location.href` raises a
 * SecurityError when the embedder is another origin, and treating that as "no link" (rather
 * than letting it escape) is what keeps Frigate embeddable anywhere.
 */
export function readTopDeepLink(ownSearch: string): TopDeepLink | null {
  if (typeof window === "undefined") return null;
  if (!window.top || window.top === window.self) return null;
  let topHref: string | null = null;
  let sameOrigin = true;
  try {
    topHref = window.top.location.href;
  } catch {
    sameOrigin = false;
  }
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
    const link = readTopDeepLink(location.search);
    if (!link) return;
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
