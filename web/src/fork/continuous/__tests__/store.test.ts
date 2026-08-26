import { describe, expect, it } from "vitest";
import { ReviewSegment } from "@/types/review";
import { mergeReviews, ReviewPage } from "../store";

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

  it("drops removed ids — the delete tombstone", () => {
    // a deleted review is gone from the server, but the pages already in memory still
    // hold it; without the tombstone the toolbar's delete leaves a ghost card.
    const out = mergeReviews(pages, new Map(), new Set(["b"]));
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
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
