import { describe, expect, it } from "vitest";
import { dedupeMirrors, hasMirrors, mirrorMapFromConfig } from "../mirrors";
import type { ReviewSegment } from "@/types/review";

// The real shape on this box, measured: entrance_tele mirrors entrance_high and the two
// rows carry a byte-identical start_time.
const config = {
  cameras: {
    entrance_high: { review: { alerts: { mirror_from: [] } } },
    entrance_tele: { review: { alerts: { mirror_from: ["entrance_high"] } } },
  },
} as never;

const review = (
  id: string,
  camera: string,
  start_time: number,
  severity = "alert",
) => ({ id, camera, start_time, severity }) as ReviewSegment;

describe("mirrorMapFromConfig", () => {
  it("reads only cameras that declare a mirror source", () => {
    const map = mirrorMapFromConfig(config);
    expect([...map.keys()]).toEqual(["entrance_tele"]);
    expect(map.get("entrance_tele")).toEqual(["entrance_high"]);
    expect(hasMirrors(map)).toBe(true);
  });

  it("is empty — and so offers no toggle — on a box without the fork's backend", () => {
    const map = mirrorMapFromConfig({
      cameras: { front: { review: {} } },
    } as never);
    expect(hasMirrors(map)).toBe(false);
    expect(mirrorMapFromConfig(undefined).size).toBe(0);
  });
});

describe("dedupeMirrors (F19)", () => {
  const map = mirrorMapFromConfig(config);

  it("drops the mirror and keeps the SOURCE row", () => {
    const items = [
      review("a", "entrance_high", 1786636678.713004),
      review("b", "entrance_tele", 1786636678.713004),
    ];
    expect(dedupeMirrors(items, map).map((r) => r.id)).toEqual(["a"]);
  });

  it("keeps the group at ONE row whichever twin has arrived", () => {
    // The WS delivers a pair in write order, so a lone mirror row can be kept and then
    // replaced when its source lands. The COUNT the virtualizer sees must not change across
    // that — a mid-list removal is the one shape K2's prepend compensation cannot absorb.
    const before = [
      review("b", "entrance_tele", 5000),
      review("src", "entrance_high", 4000),
    ];
    const after = [
      review("a", "entrance_high", 5000),
      review("b", "entrance_tele", 5000),
      review("src", "entrance_high", 4000),
    ];
    expect(dedupeMirrors(before, map)).toHaveLength(2);
    expect(dedupeMirrors(after, map)).toHaveLength(2);
    expect(dedupeMirrors(after, map).map((r) => r.id)).toEqual(["a", "src"]);
  });

  it("keeps a mirror whose OWN twin is not on the list — one row, never zero", () => {
    // the trap in the simpler per-camera rule: some other entrance_high row being present
    // is not evidence that THIS event's source row is displayed. Dropping it loses the
    // event entirely, which is worse than showing it twice.
    const items = [
      review("b", "entrance_tele", 5000),
      review("other", "entrance_high", 1000),
    ];
    expect(dedupeMirrors(items, map).map((r) => r.id)).toEqual(["b", "other"]);
  });

  it("keeps mirror rows when the SOURCE CAMERA is filtered out entirely", () => {
    // e.g. `cameras=entrance_tele`: dropping them would lose the events altogether
    const items = [
      review("b", "entrance_tele", 5000),
      review("c", "entrance_tele", 4000),
    ];
    expect(dedupeMirrors(items, map).map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("halves a list of pairs", () => {
    const items = [];
    for (let i = 0; i < 10; i++) {
      items.push(review(`h${i}`, "entrance_high", 5000 - i));
      items.push(review(`t${i}`, "entrance_tele", 5000 - i));
    }
    expect(dedupeMirrors(items, map)).toHaveLength(10);
    expect(
      dedupeMirrors(items, map).every((r) => r.camera === "entrance_high"),
    ).toBe(true);
  });

  it("never drops a row on a box with no mirroring configured", () => {
    const items = [
      review("a", "entrance_high", 5000),
      review("b", "entrance_tele", 5000),
    ];
    expect(dedupeMirrors(items, new Map())).toHaveLength(2);
  });

  it("leaves a single-item list alone", () => {
    const items = [review("b", "entrance_tele", 5000)];
    expect(dedupeMirrors(items, map)).toEqual(items);
  });
});
