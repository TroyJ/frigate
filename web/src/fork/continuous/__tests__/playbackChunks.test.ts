import { describe, expect, it } from "vitest";
import {
  buildChunks,
  nextAnchor,
  CHUNK_SPAN_HOURS,
} from "../usePlaybackChunks";

const HOUR = 3600;
const h = (n: number) => n * HOUR;

describe("buildChunks", () => {
  const now = h(1000);
  const floor = h(900);

  it("emits ONE-HOUR chunks only (F1: a multi-day chunk is what stalled nginx-vod)", () => {
    for (const c of buildChunks(h(950), now, floor, 6)) {
      expect(c.before - c.after).toBe(HOUR);
    }
  });

  it("covers anchor ± span and always contains the anchor", () => {
    const anchor = h(950) + 137; // mid-hour
    const chunks = buildChunks(anchor, now, floor, 6);
    // both edges are widened to whole hours, so a mid-hour anchor gets full ±span cover
    expect(chunks[0].after).toBe(h(944));
    expect(chunks[chunks.length - 1].before).toBe(h(957));
    expect(chunks.some((c) => c.after <= anchor && c.before > anchor)).toBe(
      true,
    );
  });

  it("clamps the old edge to the retention floor", () => {
    expect(buildChunks(h(902), now, floor, 6)[0].after).toBe(floor);
  });

  it("clamps the new edge to the current hour, never past it", () => {
    const chunks = buildChunks(h(999), now, floor, 6);
    expect(chunks[chunks.length - 1].before).toBeLessThanOrEqual(now);
  });

  it("never returns an empty list — the player would have no range at all", () => {
    // anchor older than the floor: the clamped span collapses
    const chunks = buildChunks(h(100), now, floor, 6);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].before - chunks[0].after).toBe(HOUR);
  });

  it("is identical for two anchors in the same hour — the identity RecordingView indexes into", () => {
    const a = buildChunks(h(950) + 5, now, floor, 6);
    const b = buildChunks(h(950) + 3599, now, floor, 6);
    expect(a).toEqual(b);
  });
});

describe("nextAnchor (hysteresis)", () => {
  it("adopts the playhead when there is no anchor yet", () => {
    expect(nextAnchor(undefined, h(950), 6)).toBe(h(950));
  });

  it("holds while the playhead is inside the middle half — playback must not re-slice", () => {
    expect(nextAnchor(h(950), h(950) + h(2), 6)).toBe(h(950));
    expect(nextAnchor(h(950), h(950) - h(2), 6)).toBe(h(950));
  });

  it("re-anchors once the playhead passes half a span, so it is always inside the window", () => {
    const moved = nextAnchor(h(950), h(950) + h(4), 6);
    expect(moved).toBe(h(950) + h(4));
    const chunks = buildChunks(moved, h(10_000), 0, 6);
    expect(chunks.some((c) => c.after <= moved && c.before > moved)).toBe(true);
  });

  it("a far seek re-anchors immediately (Q3=A: load, then apply the seek)", () => {
    expect(nextAnchor(h(950), h(100), CHUNK_SPAN_HOURS)).toBe(h(100));
  });
});
