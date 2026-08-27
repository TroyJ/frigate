import { describe, expect, it } from "vitest";
import { TZDate } from "react-day-picker";
import { dayStartFromPickedDate, indexAtOrAfter } from "../dayNav";
import {
  dayKeyToStartInTz,
  startOfDayInTz,
  startOfPrevDayInTz,
} from "../timeAlign";

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

  it("an empty day lands on the nearest item AFTER it, not at the bottom", () => {
    // D14's fallback on a sparse surface. The regression this guards against matched the
    // OLDEST loaded item on its first comparison, so every jump landed at the end of the
    // list — which looks like "the day-jump works" until you check WHICH card.
    const tz = "Asia/Makassar";
    const empty = startOfDayInTz(Date.UTC(2026, 7, 20, 12) / 1000, tz);
    const day = [
      { start_time: empty + 3 * 86400 },
      { start_time: empty + 2 * 86400 }, // nearest at-or-after the empty day
      { start_time: empty - 86400 },
    ];
    expect(indexAtOrAfter(day, empty)).toBe(1);
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

describe("dayStartFromPickedDate (D14/D15, §2A.6)", () => {
  const BOX = "Asia/Makassar";

  it("resolves the day the calendar SHOWED to midnight in the box's zone", () => {
    // this is what react-day-picker hands `onSelect` when `timeZone` is set
    const picked = new TZDate(2026, 7, 20, BOX);
    expect(dayStartFromPickedDate(picked, BOX)).toBe(
      dayKeyToStartInTz("2026-08-20", BOX),
    );
  });

  it("a plain browser-local Date resolves to the same box day", () => {
    // the mobile drawer and any caller without `timeZone` produce one of these; taking the
    // Y-M-D off the object rather than its epoch is what makes the two agree
    const picked = new Date(2026, 7, 20, 0, 0, 0, 0);
    expect(dayStartFromPickedDate(picked, BOX)).toBe(
      dayKeyToStartInTz("2026-08-20", BOX),
    );
  });

  it("is NOT `day.getTime()` — that is midnight in whichever zone built it", () => {
    // §2A.6: the bug this replaces. A phone in Sydney (UTC+10) picking 20 Aug asks the box
    // (UTC+8) for a window that starts two hours early, so the day's first two hours of
    // review items land on the wrong day.
    const sydneyMidnight = new TZDate(2026, 7, 20, "Australia/Sydney");
    const naive = sydneyMidnight.getTime() / 1000;
    const correct = dayStartFromPickedDate(sydneyMidnight, BOX);
    expect(correct).toBe(dayKeyToStartInTz("2026-08-20", BOX));
    expect(correct - naive).toBe(2 * 3600);
  });

  it("stepping back a week is a CALENDAR decrement, not seven × 86400", () => {
    // A day is not always 86400 s. Across an October DST start in Sydney one of the seven
    // is 23 h, so the naive arithmetic walks off midnight — and then off the day.
    const SYD = "Australia/Sydney";
    const start = dayKeyToStartInTz("2026-10-08", SYD); // transition was 2026-10-04
    let cursor = start;
    for (let i = 0; i < 7; i++) cursor = startOfPrevDayInTz(cursor, SYD);
    expect(cursor).toBe(dayKeyToStartInTz("2026-10-01", SYD));
    expect(start - 7 * 86400).not.toBe(cursor);
  });
});
