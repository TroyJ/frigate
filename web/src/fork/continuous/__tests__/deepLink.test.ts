/**
 * fork/continuous — L1 for the deep-link param vocabulary (§2A.4/§2A.5, D11).
 *
 * These are the cases a stored link hits in the wild. Each assertion is written against
 * what a FAILURE looks like — a silent fallback that cannot be told apart from the link
 * having worked is the defect, not the fallback itself.
 */
import { describe, expect, it } from "vitest";
import {
  DEEP_LINK_PROBLEM_TEXT,
  parseDeepLink,
  parseMoment,
  parseTab,
  parseView,
} from "../deepLink";

const NOW = 1_787_000_000; // 2026-08-27-ish, epoch seconds

describe("parseTab", () => {
  it("accepts the three literals `pages/Events.tsx` validates against", () => {
    for (const tab of ["timeline", "events", "detail"] as const) {
      expect(parseTab(tab)).toEqual({ tab, valid: true });
    }
  });

  it("falls back to timeline for a retired tab AND reports it", () => {
    // upstream keeps the last tab silently, which on a fresh deep link is
    // indistinguishable from the link having worked — that is the §2A.5 failure
    expect(parseTab("summary")).toEqual({ tab: "timeline", valid: false });
    expect(parseTab("TIMELINE")).toEqual({ tab: "timeline", valid: false });
  });

  it("an absent tab is not a problem", () => {
    expect(parseTab(null)).toEqual({ tab: "timeline", valid: true });
  });
});

describe("parseView (?surface=)", () => {
  it("defaults to history — today's behaviour for every existing push", () => {
    expect(parseView(null)).toEqual({ view: "history", valid: true });
  });

  it("accepts review and history, rejects anything else", () => {
    expect(parseView("review")).toEqual({ view: "review", valid: true });
    expect(parseView("history")).toEqual({ view: "history", valid: true });
    expect(parseView("grid")).toEqual({ view: "history", valid: false });
  });
});

describe("parseMoment (?t=)", () => {
  it("takes epoch seconds", () => {
    expect(parseMoment(String(NOW - 86400), NOW)).toBe(NOW - 86400);
  });

  it("takes milliseconds too — the mistake every link generator makes once", () => {
    expect(parseMoment(String((NOW - 86400) * 1000), NOW)).toBe(NOW - 86400);
  });

  it("rejects what cannot be a recording moment rather than paging back to it", () => {
    expect(parseMoment("banana", NOW)).toBeUndefined();
    expect(parseMoment("0", NOW)).toBeUndefined();
    expect(parseMoment("-1", NOW)).toBeUndefined();
    expect(parseMoment("12345", NOW)).toBeUndefined(); // 1970
    expect(parseMoment(String(NOW + 400 * 86400), NOW)).toBeUndefined();
  });

  it("allows a little clock skew into the future", () => {
    expect(parseMoment(String(NOW + 60), NOW)).toBe(NOW + 60);
  });
});

describe("parseDeepLink", () => {
  it("is undefined when the URL carries nothing this handler owns", () => {
    // …so upstream's cameras/labels/zones/group handlers are left alone (§2A.4)
    expect(parseDeepLink({}, NOW)).toBeUndefined();
    expect(parseDeepLink({ tab: "detail" }, NOW)).toBeUndefined();
  });

  it("the notification contract still parses exactly as it always did", () => {
    // `<slug>/ingress/review?id=<review_id>&tab=detail` — §2A.1 / §2A.7
    expect(
      parseDeepLink({ id: "1786636678.713004-abc", tab: "detail" }, NOW),
    ).toEqual({
      id: "1786636678.713004-abc",
      t: undefined,
      tab: "detail",
      view: "history",
      problems: [],
    });
  });

  it("carries every problem it found, and still returns a usable request", () => {
    const req = parseDeepLink(
      { id: "x", tab: "nope", surface: "sideways", t: "banana" },
      NOW,
    );
    expect(req?.tab).toBe("timeline");
    expect(req?.view).toBe("history");
    expect(req?.problems).toEqual([
      "invalid-tab",
      "invalid-surface",
      "invalid-time",
    ]);
    // the point of D11: a bad param must not throw away the id it came with
    expect(req?.id).toBe("x");
  });

  it("an invalid tab ALONE is still reported", () => {
    // nothing to navigate to, but the user is on the wrong tab and must be told why
    expect(parseDeepLink({ tab: "nope" }, NOW)?.problems).toEqual([
      "invalid-tab",
    ]);
  });

  it("every problem has wording — an unmapped one would render blank", () => {
    const req = parseDeepLink(
      { id: "x", tab: "nope", surface: "sideways", t: "banana" },
      NOW,
    );
    for (const p of req?.problems ?? []) {
      expect(DEEP_LINK_PROBLEM_TEXT[p]?.length ?? 0).toBeGreaterThan(10);
    }
  });
});
