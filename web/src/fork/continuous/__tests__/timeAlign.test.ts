import { describe, expect, it } from "vitest";
import {
  ceilHourInTz,
  dayKeyInTz,
  dayKeyToStartInTz,
  floorHourInTz,
  pagesFor,
  sameHour,
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
  it("uses the SAME grid however you got there (72 h — the ensureLoaded bug)", () => {
    // the old day-anchored grid made pagesFor(t, t+1) disagree with pagesFor(oldest, …)
    // for 2 out of every 3 days, so ensureLoaded() never found its page by `after`.
    const oldest = dayKeyToStartInTz("2026-07-27", BALI);
    const grid = pagesFor(oldest, oldest + 30 * 86400, 72, BALI);
    for (const page of grid) {
      const probe = page.after + 5000;
      expect(pagesFor(probe, probe + 1, 72, BALI)[0]).toEqual(page);
    }
  });
  it("keeps 72 h boundaries on whole local hours in a DST zone", () => {
    const from = dayKeyToStartInTz("2026-09-20", SYD); // around the AU DST change
    for (const p of pagesFor(from, from + 30 * 86400, 72, SYD)) {
      expect(floorHourInTz(p.after, SYD)).toBe(p.after);
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

describe("sameHour", () => {
  // "did the seek land?" is decided at chunk granularity — see RecordingView's
  // `forkSeekLanding`. These are UTC hours, which is what playback chunks are cut on.
  const h = 1787450400; // a whole hour boundary

  it("is true inside one hour, including both edges of the open interval", () => {
    expect(sameHour(h, h)).toBe(true);
    expect(sameHour(h, h + 3599)).toBe(true);
    expect(sameHour(h + 1, h + 1800)).toBe(true);
  });

  it("is false across the boundary, one second apart", () => {
    expect(sameHour(h + 3599, h + 3600)).toBe(false);
    expect(sameHour(h, h - 1)).toBe(false);
  });

  it("tolerates the fractional timestamps the player reports", () => {
    expect(sameHour(h + 12.34, h + 12)).toBe(true);
    expect(sameHour(h + 3599.9, h + 3600.1)).toBe(false);
  });
});
