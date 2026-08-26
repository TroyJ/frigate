import { describe, expect, it } from "vitest";
import { ReviewSegment, ReviewSeverity } from "@/types/review";
import { selectReviewItems } from "../selectReviews";

const mk = (
  id: string,
  start: number,
  severity: ReviewSeverity,
  reviewed = false,
): ReviewSegment =>
  ({
    id,
    camera: "c",
    severity,
    start_time: start,
    end_time: start + 10,
    thumb_path: "",
    has_been_reviewed: reviewed,
    data: { audio: [], detections: [], objects: [], zones: [] },
  }) as unknown as ReviewSegment;

// newest-first, mixed severities, one already reviewed
const reviews = [
  mk("a4", 400, "alert"),
  mk("d3", 300, "detection"),
  mk("a2", 200, "alert", true),
  mk("m1", 100, "significant_motion"),
];

describe("selectReviewItems", () => {
  it("buckets by severity like pages/Events.tsx does", () => {
    expect(
      selectReviewItems(reviews, "alert", false, true).map((r) => r.id),
    ).toEqual(["a4", "a2"]);
    expect(
      selectReviewItems(reviews, "detection", false, true).map((r) => r.id),
    ).toEqual(["d3"]);
    expect(
      selectReviewItems(reviews, "significant_motion", false, true).map(
        (r) => r.id,
      ),
    ).toEqual(["m1"]);
  });

  it("showAll ignores the severity bucket", () => {
    expect(selectReviewItems(reviews, "alert", true, true)).toHaveLength(4);
  });

  it("drops reviewed items unless showReviewed", () => {
    expect(
      selectReviewItems(reviews, "alert", false, false).map((r) => r.id),
    ).toEqual(["a4"]);
  });

  it("is start_time DESC regardless of input order (D23/F9)", () => {
    // upstream's /review sorts severity ASC first; concatenated pages arrive interleaved
    const jumbled = [reviews[2], reviews[0], reviews[3], reviews[1]];
    expect(
      selectReviewItems(jumbled, undefined, true, true).map(
        (r) => r.start_time,
      ),
    ).toEqual([400, 300, 200, 100]);
  });

  it("does not mutate the input array (the provider's list is shared)", () => {
    const input = [reviews[2], reviews[0]];
    const before = input.map((r) => r.id);
    selectReviewItems(input, undefined, true, true);
    expect(input.map((r) => r.id)).toEqual(before);
  });
});
