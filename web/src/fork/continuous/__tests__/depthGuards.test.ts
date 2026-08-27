import { describe, expect, it } from "vitest";
import {
  clampExportRange,
  movedHandle,
  MAX_EXPORT_SPAN_S,
} from "../exportClamp";
import {
  effectiveScaleDuration,
  isZoomPinned,
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

  it("leaves exactly one level offerable past the pin — which is how the button disables", () => {
    // the panel truncates `possibleZoomLevels` rather than carrying a second allow-list;
    // upstream then disables its own zoom-in button at the end of the list
    const levels = [
      { segmentDuration: 30 },
      { segmentDuration: 15 },
      { segmentDuration: 5 },
    ];
    const allowed = levels.filter(
      (l) => l.segmentDuration >= PINNED_SEGMENT_DURATION,
    );
    expect(allowed).toHaveLength(1);
    expect(allowed[0].segmentDuration).toBe(PINNED_SEGMENT_DURATION);
  });
});
