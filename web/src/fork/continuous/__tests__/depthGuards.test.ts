import { describe, expect, it } from "vitest";
import {
  clampExportRange,
  movedHandle,
  movedHandleFromState,
  MAX_EXPORT_SPAN_S,
} from "../exportClamp";
import {
  effectiveScaleDuration,
  isZoomPinned,
  offeredZoomLevels,
  zoomChangeAllowed,
  PINNED_SEGMENT_DURATION,
  PIN_ZOOM_BEYOND_S,
} from "../zoomPin";

const NOW = 1_800_000_000;

describe("clampExportRange (F14 / D20)", () => {
  it("leaves a legal span alone and says so", () => {
    const r = clampExportRange({ after: NOW - 3600, before: NOW }, "after");
    expect(r.clamped).toBe(false);
    expect(r.range).toEqual({ after: NOW - 3600, before: NOW });
  });

  it("clamps to exactly 24 h, anchored on the handle that did NOT move", () => {
    const r = clampExportRange(
      { after: NOW - 40 * 86400, before: NOW },
      "after",
    );
    expect(r.clamped).toBe(true);
    expect(r.range.before).toBe(NOW); // the anchor did not move
    expect(r.range.before - r.range.after).toBe(MAX_EXPORT_SPAN_S);
  });

  it("clamps the other way when the END handle is the one dragged", () => {
    const r = clampExportRange(
      { after: NOW - 40 * 86400, before: NOW },
      "before",
    );
    expect(r.range.after).toBe(NOW - 40 * 86400); // the anchor did not move
    expect(r.range.before - r.range.after).toBe(MAX_EXPORT_SPAN_S);
  });

  it("accepts exactly 24 h — the preset ceiling must remain reachable", () => {
    const r = clampExportRange(
      { after: NOW - MAX_EXPORT_SPAN_S, before: NOW },
      "after",
    );
    expect(r.clamped).toBe(false);
  });

  it("normalises a range whose handles have crossed over", () => {
    const r = clampExportRange({ after: NOW, before: NOW - 3600 }, "after");
    expect(r.range.after).toBeLessThan(r.range.before);
  });
});

describe("movedHandle", () => {
  it("names the end handle when only the end changed", () => {
    expect(
      movedHandle({ after: 100, before: 200 }, { after: 100, before: 900 }),
    ).toBe("before");
  });
  it("names the start handle when the start changed", () => {
    expect(
      movedHandle({ after: 100, before: 200 }, { after: 10, before: 200 }),
    ).toBe("after");
  });
  it("treats the seeding frame as a start drag", () => {
    expect(movedHandle(undefined, { after: 10, before: 200 })).toBe("after");
  });

  it("reads the FIRST drag off the handle state, not off a previous range (M5)", () => {
    // exportEnd set, exportStart still 0 => the END handle moved, whatever the (absent)
    // previous applied range would have implied
    expect(
      movedHandleFromState(0, 900, undefined, { after: 100, before: 900 }),
    ).toBe("before");
    expect(
      movedHandleFromState(100, 0, undefined, { after: 100, before: 900 }),
    ).toBe("after");
  });

  it("negative control: the old rule anchors the wrong handle on a first END drag", () => {
    // this is the defect — `movedHandle` alone answers "after", so the clamp would pull the
    // START handle (the anchor) instead of trimming the end the user is dragging
    expect(movedHandle(undefined, { after: 100, before: 900 })).toBe("after");
    const wrong = clampExportRange(
      { after: NOW - 40 * 86400, before: NOW },
      movedHandle(undefined, { after: NOW - 40 * 86400, before: NOW }),
    );
    const right = clampExportRange(
      { after: NOW - 40 * 86400, before: NOW },
      movedHandleFromState(0, NOW, undefined, {
        after: NOW - 40 * 86400,
        before: NOW,
      }),
    );
    expect(wrong.range.after).not.toBe(right.range.after);
    expect(right.range.after).toBe(NOW - 40 * 86400); // the anchor did NOT move
  });
});

describe("zoom pinning (D24)", () => {
  it("is not pinned inside the threshold", () => {
    expect(isZoomPinned(NOW - PIN_ZOOM_BEYOND_S + 60, NOW)).toBe(false);
    expect(effectiveScaleDuration(5, NOW - 3600, NOW)).toBe(5);
  });

  it("coarsens the REQUESTED scale past the threshold, whatever the strip draws at", () => {
    const deep = NOW - PIN_ZOOM_BEYOND_S - 60;
    expect(isZoomPinned(deep, NOW)).toBe(true);
    expect(effectiveScaleDuration(5, deep, NOW)).toBe(PINNED_SEGMENT_DURATION);
    expect(effectiveScaleDuration(15, deep, NOW)).toBe(PINNED_SEGMENT_DURATION);
  });

  it("never makes a COARSER pitch finer — the pin is a floor, not a setting", () => {
    const deep = NOW - PIN_ZOOM_BEYOND_S - 60;
    expect(effectiveScaleDuration(60, deep, NOW)).toBe(60);
  });

  const LEVELS = [
    { segmentDuration: 30 },
    { segmentDuration: 15 },
    { segmentDuration: 5 },
  ];

  it("offers only the pinned pitch past the pin — which is what disables the button", () => {
    expect(offeredZoomLevels(LEVELS, 30, true)).toEqual([
      { segmentDuration: 30 },
    ]);
    // index 0 of a one-entry list is also the LAST entry, which is upstream's own
    // disabled condition for zoom-in
    expect(offeredZoomLevels(LEVELS, 30, false)).toEqual(LEVELS);
  });

  it("keeps the FULL list for someone already finer than the pin", () => {
    // truncating would drop their current level, `currentZoomLevel` goes to -1 and upstream
    // hides the whole control
    expect(offeredZoomLevels(LEVELS, 5, true)).toEqual(LEVELS);
  });

  it("refuses to get finer past the pin", () => {
    expect(zoomChangeAllowed(30, 15, true)).toBe(false);
    expect(zoomChangeAllowed(30, 5, true)).toBe(false);
  });

  it("ALWAYS allows coarsening past the pin — the trap this closes", () => {
    // a user already at 5 s must be able to zoom out; rejecting every level below the pin
    // left the enabled zoom-out button silently dead
    expect(zoomChangeAllowed(5, 15, true)).toBe(true);
    expect(zoomChangeAllowed(5, 30, true)).toBe(true);
    expect(zoomChangeAllowed(15, 30, true)).toBe(true);
  });

  it("allows anything inside the pin", () => {
    expect(zoomChangeAllowed(30, 5, false)).toBe(true);
  });
});
