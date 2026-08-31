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
  deepLinkFromTop,
  parseDeepLink,
  preferResolveProblem,
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
    expect(parseDeepLink({ id: null, t: "", tab: null }, NOW)).toBeUndefined();
  });

  it("a bare `?tab=` is still a request — it is contract, and must be consumed", () => {
    // upstream's `useSearchEffect("tab")` consumed it with or without an id; the fork owns
    // the param now, so returning undefined here would silently drop a working link
    expect(parseDeepLink({ tab: "detail" }, NOW)).toEqual({
      id: undefined,
      t: undefined,
      tab: "detail",
      view: "history",
      problems: [],
    });
    expect(parseDeepLink({ surface: "review" }, NOW)?.view).toBe("review");
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

describe("preferResolveProblem (m4)", () => {
  it("expired outranks the D19 filter note, whichever arrives first", () => {
    // Both genuinely co-occur — a deep link to an old alert on the Review page relaxes the
    // filters AND lands past the recording horizon — and arrival order is an axios
    // continuation racing an SWR call, which says nothing about what the reader needs.
    // §2A.5 makes "older than retention" the message that explains the blank player.
    expect(preferResolveProblem("filters-adjusted", "footage-expired")).toBe(
      "footage-expired",
    );
    expect(preferResolveProblem("footage-expired", "filters-adjusted")).toBe(
      "footage-expired",
    );
  });

  it("a gone review outranks everything", () => {
    expect(preferResolveProblem("footage-expired", "review-missing")).toBe(
      "review-missing",
    );
    expect(preferResolveProblem("review-missing", "footage-expired")).toBe(
      "review-missing",
    );
  });

  it("takes the first when there is nothing to compare against", () => {
    expect(preferResolveProblem(undefined, "filters-adjusted")).toBe(
      "filters-adjusted",
    );
  });
});

/**
 * §2A.8 — the link HA's ingress drops.
 *
 * `PANEL` is the URL measured on the box: what the phone actually opens when the push is
 * tapped. `FRAME` is what HA then builds for the add-on iframe — note it carries neither the
 * `/review` path nor the params, which is the entire defect.
 */
const PANEL =
  "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review?id=1788166705.391357-3rk76l";
const FRAME = "https://bali.jezcf.com/api/hassio_ingress/abc123//";

describe("deepLinkFromTop", () => {
  it("takes the params off the parent frame's URL", () => {
    const link = deepLinkFromTop({
      ownSearch: "",
      topHref: PANEL,
      sameOrigin: true,
    });
    expect(link).not.toBeNull();
    expect(link?.id).toBe("1788166705.391357-3rk76l");
    expect(link?.search).toBe("id=1788166705.391357-3rk76l");
  });

  it("carries every param it owns, from anywhere in the parent's search", () => {
    const link = deepLinkFromTop({
      ownSearch: "",
      topHref: `${PANEL}&tab=detail&surface=review&t=1788166705&group=front`,
      sameOrigin: true,
    });
    expect(link?.tab).toBe("detail");
    expect(link?.surface).toBe("review");
    expect(link?.t).toBe("1788166705");
    // upstream's own filter params are NOT carried over — changing a filter discards the
    // loaded window (§2A.4 / F14.4), and a notification link never sets one
    expect(link?.search).not.toContain("group");
  });

  it("returns null when the parent is cross-origin", () => {
    // the read threw: Frigate is embedded somewhere that is not Home Assistant
    expect(
      deepLinkFromTop({ ownSearch: "", topHref: null, sameOrigin: false }),
    ).toBeNull();
    // …and a href that somehow survived must still not be trusted
    expect(
      deepLinkFromTop({ ownSearch: "", topHref: PANEL, sameOrigin: false }),
    ).toBeNull();
  });

  it("lets our OWN params win over the parent's", () => {
    // the user navigated inside the frame: the parent's URL is stale from that moment on
    expect(
      deepLinkFromTop({
        ownSearch: "?id=other-review",
        topHref: PANEL,
        sameOrigin: true,
      }),
    ).toBeNull();
    // any owned param counts, with or without the leading `?`
    expect(
      deepLinkFromTop({
        ownSearch: "tab=events",
        topHref: PANEL,
        sameOrigin: true,
      }),
    ).toBeNull();
    // an EMPTY value is not a link — it must not block the recovery
    expect(
      deepLinkFromTop({ ownSearch: "?id=", topHref: PANEL, sameOrigin: true }),
    ).not.toBeNull();
    // someone else's param does not block it either
    expect(
      deepLinkFromTop({
        ownSearch: "?group=front",
        topHref: PANEL,
        sameOrigin: true,
      }),
    ).not.toBeNull();
  });

  it("returns null when the parent is not a /review link", () => {
    // the iframe URL HA actually builds — no path, no params
    expect(
      deepLinkFromTop({ ownSearch: "", topHref: FRAME, sameOrigin: true }),
    ).toBeNull();
    // the panel with no sub-path: the user simply opened Frigate
    expect(
      deepLinkFromTop({
        ownSearch: "",
        topHref: "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress",
        sameOrigin: true,
      }),
    ).toBeNull();
    // a different sub-path, even carrying an id, is not ours to hijack
    expect(
      deepLinkFromTop({
        ownSearch: "",
        topHref:
          "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/explore?id=x",
        sameOrigin: true,
      }),
    ).toBeNull();
    // `/review` must be a whole path segment
    expect(
      deepLinkFromTop({
        ownSearch: "",
        topHref: "https://bali.jezcf.com/notreview?id=x",
        sameOrigin: true,
      }),
    ).toBeNull();
  });

  it("accepts a trailing slash on the parent's path", () => {
    expect(
      deepLinkFromTop({
        ownSearch: "",
        topHref:
          "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review/?id=abc",
        sameOrigin: true,
      })?.id,
    ).toBe("abc");
  });

  it("returns null when there is nothing to hand over", () => {
    // right path, no params — that is a visit, not a link
    expect(
      deepLinkFromTop({
        ownSearch: "",
        topHref: "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review",
        sameOrigin: true,
      }),
    ).toBeNull();
    // only params we do not own
    expect(
      deepLinkFromTop({
        ownSearch: "",
        topHref:
          "https://bali.jezcf.com/504b4bcb_frigate-fa/ingress/review?group=front",
        sameOrigin: true,
      }),
    ).toBeNull();
    // an unparseable href is "no link", never a throw
    expect(
      deepLinkFromTop({
        ownSearch: "",
        topHref: "not a url",
        sameOrigin: true,
      }),
    ).toBeNull();
  });
});
