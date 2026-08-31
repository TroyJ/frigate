import { describe, expect, it } from "vitest";
import { ReviewSegment } from "@/types/review";
import {
  dropAbortedPage,
  HeavyPage,
  mergeHeavy,
  mergeReviews,
  retirePatches,
  ReviewPage,
} from "../store";

const mk = (id: string, start: number, reviewed = false): ReviewSegment =>
  ({
    id,
    camera: "c",
    severity: "alert",
    start_time: start,
    end_time: start + 10,
    thumb_path: "",
    has_been_reviewed: reviewed,
    data: { audio: [], detections: [], objects: [], zones: [] },
  }) as unknown as ReviewSegment;

const page = (items: ReviewSegment[]): ReviewPage => ({
  after: 0,
  before: 1_000,
  status: "done",
  items,
});

describe("mergeReviews", () => {
  const pages = [page([mk("a", 300), mk("b", 200)]), page([mk("c", 100)])];

  it("merges pages newest-first (D23)", () => {
    expect(mergeReviews(pages, new Map(), new Set()).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("overrides win over page data (§9.4: the WebSocket item is authoritative)", () => {
    const overrides = new Map([["b", mk("b", 200, true)]]);
    const out = mergeReviews(pages, overrides, new Set());
    expect(out.find((r) => r.id === "b")?.has_been_reviewed).toBe(true);
    expect(out).toHaveLength(3);
  });

  it("an override with an UNKNOWN id is an insert — this is how the live tail adds items", () => {
    // §9.4: a WebSocket `new` arrives before any page contains it. mergeReviews must treat
    // it as an insert, not ignore it, or nothing ever appears without a refetch.
    const overrides = new Map([["z", mk("z", 350)]]);
    const out = mergeReviews(pages, overrides, new Set());
    // and it lands in D23 order, not appended: z is the newest
    expect(out.map((r) => r.id)).toEqual(["z", "a", "b", "c"]);
  });

  it("drops removed ids — the delete tombstone", () => {
    // a deleted review is gone from the server, but the pages already in memory still
    // hold it; without the tombstone the toolbar's delete leaves a ghost card.
    const out = mergeReviews(pages, new Map(), new Set(["b"]));
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("a local patch survives a WebSocket replace (the un-review bug)", () => {
    // §9.4: an `update`/`end`/`genai` carries the whole segment and does NOT carry
    // has_been_reviewed. Applied last, the local patch keeps the card marked.
    const overrides = new Map([["b", mk("b", 200, false)]]);
    const patches = new Map([["b", { has_been_reviewed: true }]]);
    const out = mergeReviews(pages, overrides, new Set(), patches);
    expect(out.find((r) => r.id === "b")?.has_been_reviewed).toBe(true);
  });

  it("a patch for an id no page or override has is ignored, not inserted", () => {
    const patches = new Map([["ghost", { has_been_reviewed: true }]]);
    expect(
      mergeReviews(pages, new Map(), new Set(), patches).map((r) => r.id),
    ).toEqual(["a", "b", "c"]);
  });

  it("removal beats an override for the same id", () => {
    const overrides = new Map([["b", mk("b", 200, true)]]);
    expect(
      mergeReviews(pages, overrides, new Set(["b"])).map((r) => r.id),
    ).toEqual(["a", "c"]);
  });

  it("a removed id stays removed when its page is refetched", () => {
    const refetched = [page([mk("a", 300), mk("b", 200), mk("c", 100)])];
    expect(
      mergeReviews(refetched, new Map(), new Set(["b"])).map((r) => r.id),
    ).toEqual(["a", "c"]);
  });
});

describe("retirePatches", () => {
  it("drops a patch the refetched page agrees with", () => {
    const patches = new Map([["a", { has_been_reviewed: true }]]);
    const out = retirePatches(patches, [mk("a", 300, true)]);
    expect(out.has("a")).toBe(false);
  });

  it("keeps a patch the server has not caught up with yet", () => {
    const patches = new Map([["a", { has_been_reviewed: true }]]);
    const out = retirePatches(patches, [mk("a", 300, false)]);
    expect(out.get("a")).toEqual({ has_been_reviewed: true });
  });

  it("keeps a patch for an id the page did not return", () => {
    const patches = new Map([["a", { has_been_reviewed: true }]]);
    const out = retirePatches(patches, [mk("b", 200, true)]);
    expect(out.has("a")).toBe(true);
  });

  it("returns the same map identity when nothing was retired", () => {
    // `reviews` is a useMemo keyed on this identity — a fresh copy on every 30 s tail
    // refetch would re-merge the whole list for no reason.
    const patches = new Map([["a", { has_been_reviewed: true }]]);
    expect(retirePatches(patches, [mk("a", 300, false)])).toBe(patches);
    expect(retirePatches(new Map(), [mk("a", 300, true)])).toBeInstanceOf(Map);
  });

  it("only compares the patched keys, not the whole segment", () => {
    // the page's copy differs in end_time (the review closed) but agrees on the patch
    const patches = new Map([["a", { has_been_reviewed: true }]]);
    const server = { ...mk("a", 300, true), end_time: 999 } as ReviewSegment;
    expect(retirePatches(patches, [server]).has("a")).toBe(false);
  });

  it("a retired patch stops masking the server value in mergeReviews", () => {
    // the whole point: after retirement a change made elsewhere shows through
    let patches: Map<string, Partial<ReviewSegment>> = new Map([
      ["a", { has_been_reviewed: true }],
    ]);
    patches = retirePatches(patches, [mk("a", 300, true)]);
    const later = mergeReviews(
      [page([mk("a", 300, false)])],
      new Map(),
      new Set(),
      patches,
    );
    expect(later[0].has_been_reviewed).toBe(false);
  });
});

describe("dropAbortedPage — the placeholder an abort leaves behind (B1)", () => {
  const loading = (after: number): HeavyPage => ({
    after,
    before: after + 3600,
    status: "loading",
    motion: [],
    unavailable: [],
  });
  const done = (after: number): HeavyPage => ({
    after,
    before: after + 3600,
    status: "done",
    motion: [],
    unavailable: [],
  });

  it("removes a placeholder so the page can be requested again", () => {
    const pages = new Map([[100, loading(100)]]);
    expect(dropAbortedPage(pages, 100)).toBe(true);
    expect(pages.has(100)).toBe(false);
  });

  it("NEVER removes a page that already has data — an aborted refresh must not blank it", () => {
    const pages = new Map([[100, done(100)]]);
    expect(dropAbortedPage(pages, 100)).toBe(false);
    expect(pages.get(100)?.status).toBe("done");
  });

  it("is a no-op for a page that is not there", () => {
    expect(dropAbortedPage(new Map(), 100)).toBe(false);
  });

  it("negative control: leaving the placeholder makes the day permanently unloaded", () => {
    // this is the defect, spelled out — `mergeHeavy` only emits `done`, so a stuck
    // placeholder means `loaded` never covers that span and the strip shimmers for ever
    const pages = new Map([[100, loading(100)]]);
    expect(mergeHeavy(pages.values()).loaded).toEqual([]);
    dropAbortedPage(pages, 100);
    pages.set(100, done(100));
    expect(mergeHeavy(pages.values()).loaded).toEqual([
      { after: 100, before: 3700 },
    ]);
  });
});
