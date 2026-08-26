import { describe, expect, it } from "vitest";
import { indexAtOrAfter } from "../dayNav";
import { startOfDayInTz } from "../timeAlign";

// newest-first, as D23 requires
const items = [500, 400, 300, 200, 100].map((start_time) => ({ start_time }));

describe("indexAtOrAfter", () => {
  it("returns the OLDEST item at or after t, not the oldest item loaded", () => {
    // the regression this replaced landed on index 4 (the bottom of the list) every time
    expect(indexAtOrAfter(items, 250)).toBe(2); // 300
    expect(indexAtOrAfter(items, 300)).toBe(2); // exact match is inclusive
    expect(indexAtOrAfter(items, 450)).toBe(0); // 500
  });

  it("clamps to the newest item when everything loaded is older than t", () => {
    expect(indexAtOrAfter(items, 10_000)).toBe(0);
  });

  it("clamps to the oldest item when t is older than everything", () => {
    expect(indexAtOrAfter(items, 1)).toBe(4);
  });

  it("returns -1 for an empty list", () => {
    expect(indexAtOrAfter([], 100)).toBe(-1);
  });

  it("a day-jump is the same scan with 00:00 box time (D14)", () => {
    const tz = "Asia/Makassar";
    // 2026-08-20 in box time; one item inside that day, one the day before
    const dayStart = startOfDayInTz(Date.UTC(2026, 7, 20, 12) / 1000, tz);
    const day = [
      { start_time: dayStart + 20 * 3600 }, // late that evening
      { start_time: dayStart + 3600 }, // 01:00 — the day's EARLIEST
      { start_time: dayStart - 3600 }, // the previous day
    ];
    expect(indexAtOrAfter(day, dayStart)).toBe(1);
  });
});
