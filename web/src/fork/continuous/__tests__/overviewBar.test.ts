/**
 * fork/continuous — L1 for the continuous overview bar's bucketing.
 *
 * The two properties worth pinning are exactly the two that made upstream's SummaryTimeline
 * unusable here, and both would regress silently: node count must be bounded by the BAR's
 * height rather than by history, and the span drawn must be the LOADED window rather than
 * a fixed 24 h.
 */
import { describe, expect, it } from "vitest";
import { bucketReviews } from "../ContinuousOverviewBar";
import type { ReviewSegment } from "@/types/review";

const NEWEST = 1_800_000_000;
const DAY = 86_400;

const rev = (
  start: number,
  end: number,
  severity = "alert",
  has_been_reviewed = false,
) =>
  ({
    id: `${start}`,
    camera: "entrance_high",
    start_time: start,
    end_time: end,
    severity,
    has_been_reviewed,
  }) as ReviewSegment;

describe("bucketReviews", () => {
  it("returns exactly bucketCount slots however many reviews there are", () => {
    const many = Array.from({ length: 6500 }, (_, i) =>
      rev(NEWEST - i * 300, NEWEST - i * 300 + 30),
    );
    const buckets = bucketReviews(
      many,
      "alert",
      NEWEST,
      NEWEST - 30 * DAY,
      200,
    );
    expect(buckets).toHaveLength(200);
  });

  it("indexes from the NEWEST end, matching the strip's geometry", () => {
    const buckets = bucketReviews(
      [rev(NEWEST - 60, NEWEST - 30)],
      "alert",
      NEWEST,
      NEWEST - 10 * DAY,
      100,
    );
    expect(buckets[0]).toBeTruthy();
    expect(buckets[99]).toBeUndefined();
  });

  it("covers the whole loaded window, not a fixed 24 h slice of it", () => {
    // an item 29 days back must land near the OLD end of a 30-day window; under upstream's
    // 24 h span it would be clamped to the newest edge and the bar would lie
    const buckets = bucketReviews(
      [rev(NEWEST - 29 * DAY, NEWEST - 29 * DAY + 60)],
      "alert",
      NEWEST,
      NEWEST - 30 * DAY,
      100,
    );
    const filled = buckets.findIndex(Boolean);
    expect(filled).toBeGreaterThan(90);
  });

  it("ignores other severities — the bar follows the active tab", () => {
    const buckets = bucketReviews(
      [rev(NEWEST - 60, NEWEST - 30, "detection")],
      "alert",
      NEWEST,
      NEWEST - DAY,
      50,
    );
    expect(buckets.every((b) => b === undefined)).toBe(true);
  });

  it("marks a bucket unreviewed if ANY item in it still wants attention", () => {
    const buckets = bucketReviews(
      [
        rev(NEWEST - 60, NEWEST - 50, "alert", true),
        rev(NEWEST - 55, NEWEST - 45, "alert", false),
      ],
      "alert",
      NEWEST,
      NEWEST - DAY,
      20,
    );
    expect(buckets[0]?.reviewed).toBe(false);
  });

  it("spreads a long review across every bucket it covers", () => {
    const buckets = bucketReviews(
      [rev(NEWEST - 10 * DAY, NEWEST - 5 * DAY)],
      "alert",
      NEWEST,
      NEWEST - 20 * DAY,
      20,
    );
    expect(buckets.filter(Boolean).length).toBeGreaterThan(3);
  });

  it("survives a degenerate window instead of dividing by zero", () => {
    expect(
      bucketReviews([rev(NEWEST, NEWEST)], "alert", NEWEST, NEWEST, 10),
    ).toEqual(new Array(10).fill(undefined));
    expect(bucketReviews([], "alert", NEWEST, NEWEST - DAY, 0)).toEqual([]);
  });
});
