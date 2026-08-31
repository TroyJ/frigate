/**
 * fork/continuous — L1 for the degraded review cell (D9 / F15 / F17).
 *
 * Rendered rather than asserted on strings, because the two claims that matter are DOM
 * facts: which degradation happened (a gate has to be able to tell them apart) and whether
 * the cell is still a way into the review. A camera that has left the config has nothing
 * to open; a reaped thumbnail still has a recording behind it about half the time, so
 * making that one inert would lose the user something real.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { DegradedReviewCell } from "../cells/DegradedReviewCell";
import type { ReviewSegment } from "@/types/review";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const review = {
  id: "1785858727.766572-ony5y7",
  camera: "porch_ezviz",
  // 23:52 UTC on Aug 3, 07:52 in Asia/Makassar on Aug 4 — chosen so "which day is this"
  // discriminates between the display timezone and the browser's (D13).
  start_time: 1785801127.766572,
  severity: "alert",
} as ReviewSegment;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DegradedReviewCell", () => {
  it("names WHICH degradation it is, so a gate can tell them apart", () => {
    act(() => {
      root.render(
        <DegradedReviewCell
          review={review}
          reason="camera-missing"
          tz="Asia/Makassar"
        />,
      );
    });
    const el = container.querySelector("[data-continuous-degraded]");
    expect(el?.getAttribute("data-continuous-degraded")).toBe("camera-missing");
  });

  it("is inert when the camera has gone — there is nothing to open", () => {
    act(() => {
      root.render(
        <DegradedReviewCell
          review={review}
          reason="camera-missing"
          tz="Asia/Makassar"
        />,
      );
    });
    const el = container.querySelector("[data-continuous-degraded]")!;
    expect(el.getAttribute("role")).toBeNull();
  });

  it("stays clickable when only the THUMBNAIL is gone", () => {
    let clicks = 0;
    act(() => {
      root.render(
        <DegradedReviewCell
          review={review}
          reason="thumb-missing"
          tz="Asia/Makassar"
          onClick={() => (clicks += 1)}
        />,
      );
    });
    const el = container.querySelector<HTMLElement>(
      "[data-continuous-degraded]",
    )!;
    expect(el.getAttribute("role")).toBe("button");
    act(() => {
      el.click();
    });
    expect(clicks).toBe(1);
  });

  it("says WHEN, in the display timezone — the only useful thing left on the cell", () => {
    act(() => {
      root.render(
        <DegradedReviewCell
          review={review}
          reason="thumb-missing"
          tz="Asia/Makassar"
        />,
      );
    });
    // Aug 4 in Asia/Makassar; still Aug 3 in UTC, so this also pins that the cell is not
    // quietly formatting in the browser's zone.
    expect(container.textContent).toMatch(/Aug 4, 2026/);
    // and it must not render a broken-image glyph or an empty box
    expect(container.querySelector("img")).toBeNull();
    expect((container.textContent ?? "").length).toBeGreaterThan(10);
  });
});
