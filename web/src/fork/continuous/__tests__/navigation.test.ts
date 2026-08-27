/**
 * fork/continuous — L1 for the two decisions inside `navigateToTime` (§2A.3 / D11 / D14).
 *
 * Both are written against the failure, not the pass:
 *  - `planNavigation` must WAIT while the page carrying the target is still in flight
 *    (scrolling before it lands uses the surface's stale `items` closure and reliably picks
 *    the wrong card), and must STOP waiting at the deadline (an id that will never arrive —
 *    deleted, or hidden by a filter — must still scroll to the time, not vanish).
 *  - `denseStripTarget` must NOT send a moment to midnight; that is the "lands somewhere
 *    near it" failure D11 exists to remove.
 */
import { describe, expect, it } from "vitest";
import { denseStripTarget, planNavigation } from "../navigation";
import { startOfDayInTz } from "../timeAlign";

const BOX = "Asia/Makassar";
const base = {
  hasSurface: true,
  selectId: undefined as string | undefined,
  itemLoaded: false,
  now: 1000,
  deadline: 9000,
};

describe("planNavigation", () => {
  it("defers when the named surface has not mounted yet", () => {
    // a `?surface=history` link navigates before RecordingView exists
    expect(planNavigation({ ...base, hasSurface: false })).toBe("defer");
    expect(
      planNavigation({
        ...base,
        hasSurface: false,
        selectId: "a",
        itemLoaded: true,
      }),
    ).toBe("defer");
  });

  it("goes straight away when no particular item was asked for", () => {
    // a calendar day-jump has no id — there is nothing to wait for
    expect(planNavigation(base)).toBe("go");
  });

  it("waits while the page carrying the target item is still in flight", () => {
    expect(planNavigation({ ...base, selectId: "a", itemLoaded: false })).toBe(
      "wait",
    );
  });

  it("goes as soon as the item is in the merged list", () => {
    expect(planNavigation({ ...base, selectId: "a", itemLoaded: true })).toBe(
      "go",
    );
  });

  it("stops waiting at the deadline and scrolls to the TIME instead", () => {
    // the id is genuinely not in the window (deleted since the push, or excluded by the
    // active filter). Dropping the navigation here is the §2A.5 "lands at now with no
    // explanation" failure wearing a different hat.
    expect(
      planNavigation({
        ...base,
        selectId: "a",
        itemLoaded: false,
        now: 9001,
      }),
    ).toBe("go");
  });
});

describe("denseStripTarget (D14)", () => {
  const t = Date.UTC(2026, 7, 20, 3, 14, 0) / 1000; // 03:14 UTC → 11:14 in Makassar

  it("a calendar day-jump lands on 00:00 BOX time", () => {
    expect(denseStripTarget(t, "day", BOX)).toBe(startOfDayInTz(t, BOX));
  });

  it("a deep link or a segment click lands on the moment itself", () => {
    expect(denseStripTarget(t, "moment", BOX)).toBe(t);
    expect(denseStripTarget(t, undefined, BOX)).toBe(t);
    // the failure this bounds: sending a moment to midnight puts the alert hours off screen
    expect(denseStripTarget(t, "moment", BOX)).not.toBe(startOfDayInTz(t, BOX));
  });

  it("the day boundary is the BOX's, not the browser's", () => {
    // 2026-08-20T17:30Z is already the 21st in Makassar (UTC+8) and still the 20th in UTC
    const evening = Date.UTC(2026, 7, 20, 17, 30) / 1000;
    const inBox = denseStripTarget(evening, "day", BOX);
    const inUtc = denseStripTarget(evening, "day", "UTC");
    // box: 21 Aug 00:00 +08 = 20 Aug 16:00Z. UTC: 20 Aug 00:00Z. Different DAYS, and the
    // 16 h between them is the whole of a jump landing on the wrong one.
    expect(inBox).toBe(Date.UTC(2026, 7, 20, 16) / 1000);
    expect(inUtc).toBe(Date.UTC(2026, 7, 20) / 1000);
    expect(inBox - inUtc).toBe(16 * 3600);
  });
});
