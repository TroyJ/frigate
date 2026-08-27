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
  const ids = (r: { items: { id: string }[] }) => r.items.map((x) => x.id);

  it("drops the mirror and keeps the SOURCE row", () => {
    const items = [
      review("a", "entrance_high", 1786636678.713004),
      review("b", "entrance_tele", 1786636678.713004),
    ];
    expect(ids(dedupeMirrors(items, map))).toEqual(["a"]);
  });

  it("reports WHICH row each kept card is standing in for (M2)", () => {
    // Without this map, marking the visible row removes it, the hidden twin un-suppresses
    // and pops back — an item the reader has just dealt with, still unreviewed, that the
    // server was never told about. The caller cannot fix that without knowing the pairing.
    const items = [
      review("a", "entrance_high", 5000),
      review("b", "entrance_tele", 5000),
    ];
    const { suppressed } = dedupeMirrors(items, map);
    expect(suppressed.get("a")).toEqual(["b"]);
    expect(suppressed.size).toBe(1);
  });

  it("suppresses nothing when nothing is dropped", () => {
    const items = [review("b", "entrance_tele", 5000)];
    const { items: kept, suppressed } = dedupeMirrors(items, map);
    expect(kept).toHaveLength(1);
    expect(suppressed.size).toBe(0);
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
    expect(dedupeMirrors(before, map).items).toHaveLength(2);
    expect(dedupeMirrors(after, map).items).toHaveLength(2);
    expect(ids(dedupeMirrors(after, map))).toEqual(["a", "src"]);
  });

  it("keeps a mirror whose OWN twin is not on the list — one row, never zero", () => {
    // the trap in a per-camera rule: some other entrance_high row being present is not
    // evidence that THIS event's source row is displayed
    const items = [
      review("b", "entrance_tele", 5000),
      review("other", "entrance_high", 1000),
    ];
    expect(ids(dedupeMirrors(items, map))).toEqual(["b", "other"]);
  });

  it("matches on an IDENTICAL start_time, never a nearby one", () => {
    // real twins are byte-identical; a tolerance could cross-match two separate events on
    // the two sensors and silently drop one of them
    const items = [
      review("a", "entrance_high", 5000),
      review("b", "entrance_tele", 4999),
    ];
    expect(dedupeMirrors(items, map).items).toHaveLength(2);
  });

  it("does not collapse across severities", () => {
    const items = [
      review("a", "entrance_high", 5000, "alert"),
      review("b", "entrance_tele", 5000, "detection"),
    ];
    expect(dedupeMirrors(items, map).items).toHaveLength(2);
  });

  it("halves a list of pairs", () => {
    const items = [];
    for (let i = 0; i < 10; i++) {
      items.push(review(`h${i}`, "entrance_high", 5000 - i));
      items.push(review(`t${i}`, "entrance_tele", 5000 - i));
    }
    const { items: kept, suppressed } = dedupeMirrors(items, map);
    expect(kept).toHaveLength(10);
    expect(kept.every((r) => r.camera === "entrance_high")).toBe(true);
    expect(suppressed.size).toBe(10);
  });

  it("never drops a row on a box with no mirroring configured", () => {
    const items = [
      review("a", "entrance_high", 5000),
      review("b", "entrance_tele", 5000),
    ];
    expect(dedupeMirrors(items, new Map()).items).toHaveLength(2);
  });

  it("leaves a single-item list alone", () => {
    const items = [review("b", "entrance_tele", 5000)];
    expect(dedupeMirrors(items, map).items).toEqual(items);
  });
});
