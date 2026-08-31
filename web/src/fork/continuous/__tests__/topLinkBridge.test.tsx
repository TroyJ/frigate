/**
 * fork/continuous — L1 for the §2A.8 ingress bridge (`useTopUrlDeepLink`).
 *
 * The pure half of the decision is covered by `deepLinkFromTop`'s matrix in
 * `deepLink.test.ts`. This file covers the half that only exists at runtime and that the
 * browser gate cannot reach until the release is on the box: does the bridge actually
 * NAVIGATE the app, does it leave an ordinary top-level load alone, and does it fire only
 * once per boot.
 *
 * `window.top` is redefined rather than mocked through a wrapper: the production code reads
 * it directly (that is the point — a wrapper would make the test pass while the real read
 * still threw), and the cross-origin case is reproduced as what actually happens, a getter
 * that throws.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  BrowserRouter,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  ContinuousTopLinkBridge,
  resetTopDeepLinkForTests,
} from "../useTopUrlDeepLink";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const PANEL =
  "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review?id=1788166705.391357-3rk76l";
/** A SECOND notification — a different review, so a different outer href. */
const PANEL2 =
  "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review?id=1788200000.111111-zz99xx";

function Probe() {
  const location = useLocation();
  return (
    <div data-testid="where">{`${location.pathname}${location.search}`}</div>
  );
}

let container: HTMLDivElement;
let root: Root;

function mount(entry = "/") {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <ContinuousTopLinkBridge />
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container.querySelector("[data-testid=where]")?.textContent;
}

/**
 * The REAL boot shape (`.22` L1 gap): `App.tsx` mounts a `<BrowserRouter basename=…>` —
 * `window.baseUrl` is HA's per-session ingress prefix — and the evidence from the
 * emulated-transport gate records the in-frame path at boot as `//`, not `/`.
 * `MemoryRouter` at `/` cannot see either.
 */
function mountBrowser(basename: string, inFramePath: string) {
  window.history.replaceState(null, "", inFramePath);
  act(() => {
    root.render(
      <BrowserRouter basename={basename}>
        <ContinuousTopLinkBridge />
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </BrowserRouter>,
    );
  });
  return container.querySelector("[data-testid=where]")?.textContent;
}

/** Unmount and mount again with the module state a fresh boot would have. */
function reboot(entry = "/") {
  act(() => root.unmount());
  root = createRoot(container);
  // `keepSession`: a reload inside the frame is a new module instance, NOT a new session
  resetTopDeepLinkForTests({ keepSession: true });
  return mount(entry);
}

/**
 * Pretend this document is framed by `href` — or, with `throws`, by another origin.
 *
 * The fake is a STABLE object with a real `EventTarget` behind it, because `.24`'s bridge
 * subscribes to the parent: a getter that minted a new object per access would hand the
 * production code a listener registry nobody could ever dispatch on, and every subscription
 * test would pass by doing nothing. `addEventListener` is counted so a test can assert that
 * a cross-origin embedder gets NO listener at all.
 */
function fakeTop(href: string | null, throws = false) {
  const bus = new EventTarget();
  let current = href;
  let added = 0;
  const fake = {
    addEventListener: (type: string, fn: EventListener) => {
      added += 1;
      bus.addEventListener(type, fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      added -= 1;
      bus.removeEventListener(type, fn);
    },
    get location() {
      if (throws) throw new Error("SecurityError: cross-origin");
      return { href: current };
    },
  };
  Object.defineProperty(window, "top", {
    configurable: true,
    get: () => fake,
  });
  return {
    /** HA's in-page navigation: the outer URL changes, the iframe is NOT recreated. */
    navigateTop(next: string, type = "location-changed") {
      current = next;
      act(() => {
        bus.dispatchEvent(new Event(type));
      });
      return where();
    },
    /** Fire the event WITHOUT changing the href — the "already handled" case. */
    fire(type = "location-changed") {
      act(() => {
        bus.dispatchEvent(new Event(type));
      });
      return where();
    },
    listenerCount: () => added,
  };
}

/** What the router is showing right now. */
function where() {
  return container.querySelector("[data-testid=where]")?.textContent;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  resetTopDeepLinkForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // `mountBrowser` drives the real history; leave the URL as the suite found it
  window.history.replaceState(null, "", "/");
  Object.defineProperty(window, "top", {
    configurable: true,
    get: () => window,
  });
});

describe("ContinuousTopLinkBridge", () => {
  it("navigates to the review the parent frame's URL names", () => {
    fakeTop(PANEL);
    expect(mount()).toBe("/review?id=1788166705.391357-3rk76l");
  });

  it("leaves an ordinary top-level load alone", () => {
    // not framed at all: `window.top === window.self`
    Object.defineProperty(window, "top", {
      configurable: true,
      get: () => window,
    });
    expect(mount()).toBe("/");
  });

  it("leaves a cross-origin embedder alone instead of throwing", () => {
    fakeTop(null, true);
    expect(mount()).toBe("/");
  });

  it("leaves the app alone when the parent is the plain ingress frame", () => {
    fakeTop("https://bali.jezcf.com/api/hassio_ingress/abc123//");
    expect(mount()).toBe("/");
  });

  it("fires once per boot, so later mounts are not re-hijacked", () => {
    fakeTop(PANEL);
    expect(mount()).toBe("/review?id=1788166705.391357-3rk76l");
    // the user navigates away and the page remounts — the parent's URL has not changed and
    // must NOT drag them back to the notification
    act(() => root.unmount());
    root = createRoot(container);
    expect(mount()).toBe("/");
  });

  it("navigates at the REAL boot shape: BrowserRouter basename, in-frame path `//`", () => {
    // `.22` L1 gap. Measured in-frame at boot through HA's panel:
    // `window.baseUrl = /api/hassio_ingress/<token>/`, path `//`.
    fakeTop(PANEL);
    expect(
      mountBrowser(
        "/api/hassio_ingress/abc123/",
        "/api/hassio_ingress/abc123//",
      ),
    ).toBe("/review?id=1788166705.391357-3rk76l");
  });

  it("passes its OWN search to the recovery, so an in-app link still wins", () => {
    // `.22` L1 gap: rule 2 (our own params win) is only reachable if the bridge hands over
    // `location.search` — pass "" instead and this navigates to the STALE panel link.
    fakeTop(PANEL);
    expect(mount("/review?id=already-here")).toBe("/review?id=already-here");
  });
});

/**
 * The `.23` MAJOR: the guard has to survive a reload INSIDE the frame.
 *
 * A module flag is per boot, and anything that reboots the app in place — RestartDialog's
 * `window.location.href = baseUrl`, the language provider's `reload()`, AuthForm after
 * login, iOS reclaiming the WKWebView — gets a fresh one, re-reads the UNCHANGED outer
 * `…/ingress/review?id=` and yanks the user back to a notification they already dealt
 * with. `reboot()` is exactly that: new module state, same session storage.
 */
describe("the once-only guard survives an in-frame reload", () => {
  it("does not replay an unchanged panel URL after a reload", () => {
    fakeTop(PANEL);
    expect(mount()).toBe("/review?id=1788166705.391357-3rk76l");
    expect(reboot()).toBe("/");
    // and it stays dead, however many times the app reboots
    expect(reboot()).toBe("/");
  });

  it("still fires for a NEW notification in the same session", () => {
    fakeTop(PANEL);
    expect(mount()).toBe("/review?id=1788166705.391357-3rk76l");
    // the user taps a second push: HA's panel URL changes, the frame reloads
    fakeTop(PANEL2);
    expect(reboot()).toBe("/review?id=1788200000.111111-zz99xx");
  });

  it("without sessionStorage it behaves exactly as `.22` did — once per boot", () => {
    // storage disabled (private mode, a locked-down embedder, a full quota). Degrading to
    // the old defect is the right trade: a link that replays after a reload beats a link
    // that never fires.
    const real = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: storage is disabled");
      },
    });
    try {
      fakeTop(PANEL);
      expect(mount()).toBe("/review?id=1788166705.391357-3rk76l");
      // a remount inside the same boot is still blocked by the module flag
      act(() => root.unmount());
      root = createRoot(container);
      expect(mount()).toBe("/");
      // …and a reload replays it, which is `.22`'s behaviour, not a new failure
      expect(reboot()).toBe("/review?id=1788166705.391357-3rk76l");
    } finally {
      if (real) Object.defineProperty(window, "sessionStorage", real);
    }
  });
});

/**
 * The `.23` MINOR: a bare modifier param is not a destination. The handler treats
 * `tab`/`surface`/`camera` without an `id`/`t` as inert (it returns before it moves
 * anything), so recovering one would take the user off Live for nothing and consume it
 * nowhere.
 */
describe("a bare modifier param does not navigate", () => {
  const base = "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review";
  it.each([
    ["tab", `${base}?tab=detail`],
    ["surface", `${base}?surface=review`],
    ["camera", `${base}?camera=entrance_tele`],
    ["all three", `${base}?tab=detail&surface=review&camera=entrance_tele`],
  ])("%s alone leaves the app on Live", (_name, href) => {
    fakeTop(href);
    expect(mount()).toBe("/");
  });

  it("but a camera WITH an id is carried through", () => {
    fakeTop(`${PANEL}&camera=entrance_tele`);
    expect(mount()).toBe(
      "/review?id=1788166705.391357-3rk76l&camera=entrance_tele",
    );
  });
});

/**
 * `.24` — the case that made `.23` look like it had changed nothing.
 *
 * Measured on the iOS Simulator against real HA: with the Frigate panel ALREADY OPEN, the
 * companion app opens a notification by asking HA's frontend to navigate IN PAGE
 * (`history.pushState` + a `location-changed` event). HA keeps the same iframe element and
 * the same `src`, so nothing in the frame reloads and a boot-only bridge never sees the
 * link. These tests dispatch exactly that event on the fake parent.
 */
describe("the bridge follows the parent's in-page navigations (`.24`)", () => {
  const FRAME = "https://bali.jezcf.com/api/hassio_ingress/abc123//";

  it("navigates when HA pushes a notification URL into the panel", () => {
    // the user is already inside Frigate: the panel is on the plain ingress URL and the
    // app is on Live — no reload happens at any point in this test
    const top = fakeTop(FRAME);
    expect(mount()).toBe("/");
    expect(top.navigateTop(PANEL)).toBe("/review?id=1788166705.391357-3rk76l");
  });

  it("carries the camera the push named", () => {
    const top = fakeTop(FRAME);
    mount();
    expect(top.navigateTop(`${PANEL}&camera=entrance_tele`)).toBe(
      "/review?id=1788166705.391357-3rk76l&camera=entrance_tele",
    );
  });

  it("acts once per href, however many events HA fires", () => {
    // HA fires `location-changed` liberally, and iOS adds `pageshow`/`visibilitychange` on
    // top; the href key is what makes the repeats free
    const top = fakeTop(FRAME);
    mount();
    expect(top.navigateTop(PANEL)).toBe("/review?id=1788166705.391357-3rk76l");
    expect(top.fire()).toBe("/review?id=1788166705.391357-3rk76l");
    expect(top.fire("popstate")).toBe("/review?id=1788166705.391357-3rk76l");
  });

  it("fires again for a DIFFERENT notification without any reload", () => {
    const top = fakeTop(FRAME);
    mount();
    top.navigateTop(PANEL);
    expect(top.navigateTop(PANEL2)).toBe("/review?id=1788200000.111111-zz99xx");
  });

  it("follows a back/forward in the panel (`popstate`)", () => {
    const top = fakeTop(FRAME);
    mount();
    expect(top.navigateTop(PANEL, "popstate")).toBe(
      "/review?id=1788166705.391357-3rk76l",
    );
  });

  it("ignores a parent navigation that carries no destination", () => {
    // the user clicking around HA must never move the app
    const top = fakeTop(FRAME);
    mount();
    expect(top.navigateTop("https://bali.jezcf.com/lovelace/0")).toBe("/");
    expect(
      top.navigateTop(
        "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review?tab=detail",
      ),
    ).toBe("/");
  });

  it("stops listening when the bridge unmounts", () => {
    const top = fakeTop(FRAME);
    mount();
    expect(top.listenerCount()).toBeGreaterThan(0);
    act(() => root.unmount());
    root = createRoot(container);
    expect(top.listenerCount()).toBe(0);
    // dispatching now must not throw, and must not queue a navigation for the next mount
    top.fire();
    resetTopDeepLinkForTests({ keepSession: true });
    expect(mount()).toBe("/");
  });

  it("registers no listener at all on a cross-origin embedder", () => {
    // Frigate may legitimately be embedded elsewhere; we must neither read nor subscribe
    const top = fakeTop(null, true);
    expect(mount()).toBe("/");
    expect(top.listenerCount()).toBe(0);
  });
});

/**
 * The bridge is inert unless it is MOUNTED, and the only place that can be true is
 * `App.tsx`, inside `<BrowserRouter>` (it navigates). Nothing else at L1 can see that, and
 * deleting the one line is exactly how this fix would be lost in a future upstream merge —
 * so the wiring is asserted as a source fact rather than left to the box-only gate in
 * `frigate-fork/testing/specs/ingress-deep-link.spec.js`.
 */
describe("the bridge is wired into the app", () => {
  /**
   * Comments are STRIPPED before matching. Without that the check passes on
   * `{/* <ContinuousTopLinkBridge /> *\/}` — which is precisely how the mount would be
   * disabled, and it was: the first run of this test's own negative control stayed green
   * with the line commented out.
   */
  const app = readFileSync(resolve(__dirname, "../../../App.tsx"), "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("imports and mounts ContinuousTopLinkBridge", () => {
    expect(app).toContain(
      'import { ContinuousTopLinkBridge } from "@/fork/continuous/useTopUrlDeepLink"',
    );
    expect(app).toMatch(/<ContinuousTopLinkBridge\s*\/>/);
  });

  it("mounts it inside the router, which is what it navigates with", () => {
    const router = app.indexOf("<BrowserRouter");
    const mount = app.indexOf("<ContinuousTopLinkBridge");
    expect(router).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(router);
  });
});
