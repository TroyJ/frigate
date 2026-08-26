import { describe, expect, it } from "vitest";
import { ReviewSegment } from "@/types/review";
import {
  buildSegmentEventIndex,
  lookupSegmentEvents,
} from "../useSegmentEventIndex";

const mk = (id: string, start: number, end?: number): ReviewSegment =>
  ({
    id,
    camera: "c",
    severity: "alert",
    start_time: start,
    end_time: end,
    thumb_path: "",
    has_been_reviewed: false,
    data: {
      audio: [],
      detections: [],
      objects: [],
      significant_motion_areas: [],
      zones: [],
    },
  }) as ReviewSegment;

// upstream's predicate, reproduced as the oracle (use-event-segment-utils.ts)
function oracle(events: ReviewSegment[], t: number, d: number) {
  const segStart = (x: number) => Math.floor(x / d) * d;
  const segEnd = (x?: number) =>
    x ? Math.floor(x / d) * d + d : Date.now() / 1000 + d;
  const hit = (q: number) =>
    events.filter((e) => q >= segStart(e.start_time) && q < segEnd(e.end_time));
  return new Set([...hit(t - d), ...hit(t), ...hit(t + d)].map((e) => e.id));
}

describe("useSegmentEventIndex (F11)", () => {
  const d = 30;
  const events = [
    mk("a", 1000, 1070),
    mk("b", 1065, 1100),
    mk("c", 5000, 5010),
    mk("open", 9000),
  ];
  const index = buildSegmentEventIndex(events, d);
  const look = (t: number) => lookupSegmentEvents(index, t, d);

  it("supplies every event upstream's helpers would find at t, t±d", () => {
    for (let t = 900; t < 9300; t += d) {
      const got = new Set(look(t).map((e) => e.id));
      for (const id of oracle(events, t, d))
        expect(got.has(id), `t=${t} missing ${id}`).toBe(true);
    }
  });
  it("returns an empty (shared) array where nothing overlaps", () => {
    expect(look(3000)).toHaveLength(0);
    expect(look(3000)).toBe(look(3030));
  });
  it("open-ended reviews extend to now", () => {
    expect(look(9000 + 100 * d).map((e) => e.id)).toContain("open");
    expect(look(8900).map((e) => e.id)).not.toContain("open");
  });
});
