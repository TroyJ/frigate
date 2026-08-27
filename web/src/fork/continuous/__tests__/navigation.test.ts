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
import {
  denseStripTarget,
  pagesSettled,
  planNavigation,
  windowSettled,
} from "../navigation";
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

describe("pagesSettled", () => {
  const done = (after: number, before: number) =>
    ({ after, before, status: "done" }) as const;
  const loading = (after: number, before: number) =>
    ({ after, before, status: "loading" }) as const;

  const H = 3600;
  const DAY = 24 * H;

  it("is settled when finished pages cover the span", () => {
    expect(
      pagesSettled(0, 3 * DAY, [done(0, 2 * DAY), done(2 * DAY, 4 * DAY)]),
    ).toBe(true);
  });

  it("waits while a page is still loading over the hole", () => {
    expect(
      pagesSettled(0, 3 * DAY, [done(2 * DAY, 4 * DAY), loading(0, 2 * DAY)]),
    ).toBe(false);
  });

  it("does not wait for a hole nothing is fetching", () => {
    // Note what this does NOT distinguish: a hole that was requested and abandoned (the
    // abort path deletes the page) from one nobody has asked for yet. Both are "no page,
    // nothing in flight" here — `windowSettled` is what separates them, and the tests below
    // are where that distinction is pinned.
    expect(pagesSettled(0, 3 * DAY, [done(2 * DAY, 4 * DAY)])).toBe(true);
  });

  it("does not care WHICH lattice covered the span — the slow-tier flip", () => {
    // `pageHours` drops 72 → 24 the first time a page is slow, which a deep jump is exactly
    // what causes, and every key is re-latticed. Mixed spans still cover the same seconds.
    const mixed = [
      done(0, 3 * DAY), // a 72 h page requested before the flip
      done(3 * DAY, 4 * DAY), // 24 h pages after it
      done(4 * DAY, 5 * DAY),
    ];
    expect(pagesSettled(0, 5 * DAY, mixed)).toBe(true);
    // …and a genuine gap in the middle of a mixed set is still a gap
    expect(pagesSettled(0, 6 * DAY, mixed)).toBe(true); // nothing in flight past 5 d
    expect(
      pagesSettled(0, 6 * DAY, [...mixed, loading(5 * DAY, 6 * DAY)]),
    ).toBe(false);
  });

  it("treats a failed page as settled — it is never coming", () => {
    expect(
      pagesSettled(0, 2 * DAY, [
        { after: 0, before: DAY, status: "error" },
        done(DAY, 2 * DAY),
      ]),
    ).toBe(true);
  });

  it("an empty span is trivially settled", () => {
    expect(pagesSettled(5, 5, [])).toBe(true);
  });
});

describe("windowSettled — the planning precondition (B1)", () => {
  const H = 3600;
  const DAY = 24 * H;
  const NOW = 30 * DAY;
  const done = (after: number, before: number) =>
    ({ after, before, status: "done" }) as const;
  const loading = (after: number, before: number) =>
    ({ after, before, status: "loading" }) as const;

  // The state a calendar jump to a day 20 days back starts from: a week or so is loaded.
  const loaded = [done(23 * DAY, 26 * DAY), done(26 * DAY, NOW)];

  it("is NOT settled before the request effect has planned the span", () => {
    // THE bug. `ensureLoaded` lowers `oldest` and looks immediately; React has not committed,
    // so the pages for the new span do not exist yet. Coverage stops at the hole, nothing is
    // in flight over it, and the naive answer is "settled" — against a window that has not
    // been extended at all. The calendar day-jump has no `selectId`, so `planNavigation`
    // says "go" at once and the jump lands on whatever happened to be loaded.
    expect(pagesSettled(10 * DAY, NOW, loaded)).toBe(true); // what the old code believed
    expect(windowSettled(23 * DAY, 10 * DAY, NOW, loaded)).toBe(false);
  });

  it("is settled once planning has reached the target and the pages are done", () => {
    const planned = [done(10 * DAY, 23 * DAY), ...loaded];
    expect(windowSettled(10 * DAY, 10 * DAY, NOW, planned)).toBe(true);
  });

  it("still waits for pages that are planned and in flight", () => {
    const inFlight = [loading(10 * DAY, 23 * DAY), ...loaded];
    expect(windowSettled(10 * DAY, 10 * DAY, NOW, inFlight)).toBe(false);
  });

  it("does not wait for a hole that was planned and then ABANDONED", () => {
    // `fetchPage`'s abort branch deletes the page. Planning HAS reached the target, so the
    // hole is finished business rather than something still on its way — which is the
    // distinction the pure coverage test cannot make on its own.
    expect(windowSettled(10 * DAY, 10 * DAY, NOW, loaded)).toBe(true);
  });
});
