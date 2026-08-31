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
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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

function Probe() {
  const location = useLocation();
  return (
    <div data-testid="where">{`${location.pathname}${location.search}`}</div>
  );
}

let container: HTMLDivElement;
let root: Root;

function mount() {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <ContinuousTopLinkBridge />
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container.querySelector("[data-testid=where]")?.textContent;
}

/** Pretend this document is framed by `href` — or, with `throws`, by another origin. */
function fakeTop(href: string | null, throws = false) {
  Object.defineProperty(window, "top", {
    configurable: true,
    get: () => ({
      get location() {
        if (throws) throw new Error("SecurityError: cross-origin");
        return { href };
      },
    }),
  });
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
