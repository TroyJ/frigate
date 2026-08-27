import { describe, expect, it } from "vitest";
import { buildGapIndex, GAP_PRESENTATION } from "../gapIndex";

const HOUR = 3600;
const seg = (start: number, end: number) =>
  ({ start_time: start, end_time: end }) as never;

// A box shaped like this one: reviews go back weeks, recordings only days.
const W = 1_000_000; // MIN(recordings.start_time) — the retention horizon
const loaded = [{ after: W - 10 * HOUR, before: W + 10 * HOUR }];

describe("buildGapIndex — the three-way classifier (D7 / §14.1a)", () => {
  it("splits a gap on the horizon: older is expired, newer is an outage", () => {
    const idx = buildGapIndex(
      [seg(W - 5 * HOUR, W - 4 * HOUR), seg(W + 2 * HOUR, W + 3 * HOUR)],
      loaded,
      W,
    );
    expect(idx.classify(W - 4.5 * HOUR)).toBe("expired");
    expect(idx.classify(W + 2.5 * HOUR)).toBe("outage");
  });

  it("reports recorded time as available", () => {
    const idx = buildGapIndex([seg(W + 2 * HOUR, W + 3 * HOUR)], loaded, W);
    expect(idx.classify(W + 5 * HOUR)).toBe("available");
  });

  it("reports UNKNOWN outside the loaded windows — never 'available'", () => {
    // the whole point: before the gap page lands the strip must not paint 'all fine'
    const idx = buildGapIndex([], loaded, W);
    expect(idx.classify(W + 50 * HOUR)).toBe("unknown");
    expect(idx.classify(W - 50 * HOUR)).toBe("unknown");
    expect(idx.hasRecording(W + 50 * HOUR)).toBeUndefined();
  });

  it("makes the weaker claim while the horizon is unknown", () => {
    // asserting 'expired' without MIN(recordings.start_time) would be asserting a cause
    const idx = buildGapIndex(
      [seg(W - 5 * HOUR, W - 4 * HOUR)],
      loaded,
      undefined,
    );
    expect(idx.classify(W - 4.5 * HOUR)).toBe("outage");
  });

  it("maps to upstream's tri-state boolean without losing the not-loaded state", () => {
    const idx = buildGapIndex([seg(W + 2 * HOUR, W + 3 * HOUR)], loaded, W);
    expect(idx.hasRecording(W + 5 * HOUR)).toBe(true);
    expect(idx.hasRecording(W + 2.5 * HOUR)).toBe(false);
    expect(idx.hasRecording(W + 500 * HOUR)).toBeUndefined();
  });

  it("is exclusive at the range end, so back-to-back gaps do not overlap", () => {
    const idx = buildGapIndex([seg(W + HOUR, W + 2 * HOUR)], loaded, W);
    expect(idx.classify(W + HOUR)).toBe("outage"); // inclusive start
    expect(idx.classify(W + 2 * HOUR)).toBe("available"); // exclusive end
  });

  it("handles a gap spanning many buckets — the steady state past the floor", () => {
    // one range covering three weeks; every probe inside it must classify, not just the
    // one in the range's first bucket (the bug a naive index would have)
    const wide = [{ after: W - 800 * HOUR, before: W + HOUR }];
    const idx = buildGapIndex([seg(W - 800 * HOUR, W - 1 * HOUR)], wide, W);
    for (const t of [W - 799 * HOUR, W - 400 * HOUR, W - 2 * HOUR]) {
      expect(idx.classify(t)).toBe("expired");
    }
  });

  it("ignores degenerate ranges rather than indexing them for ever", () => {
    const idx = buildGapIndex([seg(W + HOUR, W + HOUR)], loaded, W);
    expect(idx.classify(W + HOUR)).toBe("available");
  });
});

describe("GAP_PRESENTATION — §17.7 check 7", () => {
  it("gives all three non-available states a DIFFERENT appearance", () => {
    const classes = [
      GAP_PRESENTATION.outage.className,
      GAP_PRESENTATION.expired.className,
      GAP_PRESENTATION.unknown.className,
    ];
    expect(new Set(classes).size).toBe(3);
  });

  it("keeps both blackout overlays translucent, so a review blip shows through", () => {
    // §14.1a: black with coloured marks where things happened is the point of D6. An
    // opaque overlay would erase the severity tint underneath.
    for (const key of ["outage", "expired"] as const) {
      expect(GAP_PRESENTATION[key].className).not.toMatch(
        /(^|\s)bg-background(\s|$)/,
      );
    }
  });

  it("labels every state — a blackout the user cannot name is not distinguishable", () => {
    for (const key of ["outage", "expired", "unknown"] as const) {
      expect(GAP_PRESENTATION[key].label.length).toBeGreaterThan(10);
      expect(GAP_PRESENTATION[key].shortLabel.length).toBeGreaterThan(0);
    }
    expect(GAP_PRESENTATION.outage.label).not.toBe(
      GAP_PRESENTATION.expired.label,
    );
  });
});
