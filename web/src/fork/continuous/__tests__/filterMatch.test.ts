import { describe, expect, it } from "vitest";
import { ReviewSegment } from "@/types/review";
import { matchesFilter } from "../filterMatch";

const mk = (
  camera: string,
  objects: string[] = [],
  zones: string[] = [],
  audio: string[] = [],
): ReviewSegment =>
  ({
    id: "x",
    camera,
    severity: "alert",
    start_time: 100,
    end_time: 110,
    thumb_path: "",
    has_been_reviewed: false,
    data: { audio, detections: [], objects, zones },
  }) as unknown as ReviewSegment;

describe("matchesFilter — the live tail must obey the same filter as the pages", () => {
  it("passes everything when no filter is set", () => {
    expect(matchesFilter(mk("a"), {})).toBe(true);
  });

  it("filters by camera", () => {
    expect(matchesFilter(mk("a"), { cameras: "a,b" })).toBe(true);
    expect(matchesFilter(mk("c"), { cameras: "a,b" })).toBe(false);
  });

  it("treats 'all' as no filter, the way the API does", () => {
    expect(matchesFilter(mk("c"), { cameras: "all" })).toBe(true);
  });

  it("matches labels against objects OR audio, as the API ORs them", () => {
    expect(matchesFilter(mk("a", ["person"]), { labels: "person" })).toBe(true);
    expect(
      matchesFilter(mk("a", [], [], ["speech"]), { labels: "speech" }),
    ).toBe(true);
    expect(matchesFilter(mk("a", ["car"]), { labels: "person" })).toBe(false);
  });

  it("filters by zone", () => {
    expect(matchesFilter(mk("a", [], ["drive"]), { zones: "drive" })).toBe(
      true,
    );
    expect(matchesFilter(mk("a", [], ["porch"]), { zones: "drive" })).toBe(
      false,
    );
  });

  it("requires every set filter to pass, not any", () => {
    const item = mk("a", ["person"], ["drive"]);
    expect(
      matchesFilter(item, { cameras: "a", labels: "person", zones: "drive" }),
    ).toBe(true);
    expect(
      matchesFilter(item, { cameras: "b", labels: "person", zones: "drive" }),
    ).toBe(false);
  });

  it("survives a segment with no data arrays", () => {
    const bare = { id: "y", camera: "a" } as unknown as ReviewSegment;
    expect(matchesFilter(bare, { cameras: "a" })).toBe(true);
    expect(matchesFilter(bare, { labels: "person" })).toBe(false);
  });
});
