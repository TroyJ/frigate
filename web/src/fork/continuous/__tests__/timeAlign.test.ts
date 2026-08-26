import { describe, expect, it } from "vitest";
import {
  ceilHourInTz,
  dayKeyInTz,
  dayKeyToStartInTz,
  floorHourInTz,
  pagesFor,
  startOfNextDayInTz,
  startOfPrevDayInTz,
} from "../timeAlign";

const BALI = "Asia/Makassar"; // UTC+8, no DST
const KTM = "Asia/Kathmandu"; // UTC+5:45 — hour boundaries do NOT coincide with UTC hours
const SYD = "Australia/Sydney"; // DST-crossing zone for upstream safety (§13 point 4)

describe("hour alignment in the display timezone (§5.3, §13)", () => {
  it("floors to a whole hour in Bali (coincides with UTC hours)", () => {
    const t = 1756200000 + 1234; // arbitrary
    expect(floorHourInTz(t, BALI) % 3600).toBe(0);
    expect(floorHourInTz(t, BALI)).toBeLessThanOrEqual(t);
  });
  it("floors to a local hour in Kathmandu (offset :45 from UTC)", () => {
    const t = 1756200000;
    const f = floorHourInTz(t, KTM);
    expect((f + 45 * 60) % 3600).toBe(0);
    expect(t - f).toBeLessThan(3600);
  });
  it("ceil is identity on a boundary, else the next hour", () => {
    const f = floorHourInTz(1756200000, BALI);
    expect(ceilHourInTz(f, BALI)).toBe(f);
    expect(ceilHourInTz(f + 1, BALI)).toBe(f + 3600);
  });
});

describe("day navigation (D3 / D14)", () => {
  it("previous day is a calendar decrement, not t - 86400, across a DST change", () => {
    // 2025-10-05 is the Sydney DST start (02:00 → 03:00): that day is 23 h long
    const oct6 = dayKeyToStartInTz("2025-10-06", SYD);
    const oct5 = startOfPrevDayInTz(oct6, SYD);
    expect(dayKeyInTz(oct5, SYD)).toBe("2025-10-05");
    expect(oct6 - oct5).toBe(23 * 3600);
    expect(startOfNextDayInTz(oct5, SYD)).toBe(oct6);
  });
  it("round-trips day keys", () => {
    const t = dayKeyToStartInTz("2026-08-26", BALI);
    expect(dayKeyInTz(t, BALI)).toBe("2026-08-26");
    expect(dayKeyInTz(t + 86399, BALI)).toBe("2026-08-26");
    expect(dayKeyInTz(t + 86400, BALI)).toBe("2026-08-27");
  });
});

describe("pagesFor — deterministic hour-aligned grid", () => {
  it("returns the same page for any timestamp inside it", () => {
    const day = dayKeyToStartInTz("2026-08-20", BALI);
    const a = pagesFor(day + 100, day + 101, 24, BALI)[0];
    const b = pagesFor(day + 80000, day + 80001, 24, BALI)[0];
    expect(a).toEqual(b);
    expect(a.after).toBe(day);
    expect(a.before - a.after).toBe(24 * 3600);
  });
  it("every page boundary is a whole hour in the display tz", () => {
    const from = dayKeyToStartInTz("2026-08-01", KTM) + 5000;
    const to = from + 10 * 86400;
    for (const p of pagesFor(from, to, 72, KTM)) {
      expect(floorHourInTz(p.after, KTM)).toBe(p.after);
    }
  });
  it("covers [after, before)", () => {
    const from = 1756200000;
    const pages = pagesFor(from, from + 7 * 86400, 24, BALI);
    expect(pages[0].after).toBeLessThanOrEqual(from);
    expect(pages[pages.length - 1].before).toBeGreaterThanOrEqual(
      from + 7 * 86400,
    );
  });
});
