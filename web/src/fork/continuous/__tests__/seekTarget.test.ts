/**
 * fork/continuous — L1 for the `.23` lead-in decision (`seekTarget.ts`).
 *
 * The defect being fixed is not a crash: it is 6 s of empty driveway in front of every
 * alert a phone opens (4 s of `REVIEW_PADDING` plus the keyframe snap). So the assertions
 * are exact — `toBe(start)`, not "close to" — because the only failure mode is a small
 * constant creeping back in, and a tolerance would hide exactly that.
 *
 * The second half of the file is a SOURCE fact. `onSelectReview` lives in an upstream file
 * that renders half the Review page, so the card click cannot be exercised at L1 without a
 * DOM harness for `EventView`; what can be pinned is that the call site uses this module
 * instead of its own arithmetic. Its negative control is the inline computation coming
 * back, which is exactly how this change would be lost in a future upstream merge.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { REVIEW_PADDING } from "@/types/review";
import {
  cardOpenStartTime,
  CONTINUOUS_LEAD_IN,
  reviewSeekTarget,
} from "../seekTarget";

const START = 1_788_166_705.391357;

describe("reviewSeekTarget", () => {
  it("opens AT the detection, with no lead-in at all", () => {
    expect(CONTINUOUS_LEAD_IN).toBe(0);
    expect(reviewSeekTarget(START)).toBe(START);
    // …and specifically not upstream's 4 s, which is the number this change removes
    expect(reviewSeekTarget(START)).not.toBe(START - REVIEW_PADDING);
  });

  it("keeps sub-second precision — a review id's own timestamp is fractional", () => {
    expect(reviewSeekTarget(START)).toBeCloseTo(START, 6);
  });
});

describe("cardOpenStartTime (the Review-grid card click)", () => {
  it("on the continuous grid, a card opens at its own start_time", () => {
    // the deep link and the card click must agree: same review, same landing
    expect(
      cardOpenStartTime({
        continuous: true,
        reviewStart: START,
        timeRangeAfter: START - 3600,
      }),
    ).toBe(START);
    expect(
      cardOpenStartTime({
        continuous: true,
        reviewStart: START,
        timeRangeAfter: START - 3600,
      }),
    ).toBe(reviewSeekTarget(START));
  });

  it("ignores the 24 h day clamp when the window is continuous (the `.14` defect)", () => {
    // upstream's clamp would open a 30-day-old card at "24 hours ago"
    const dayClamp = START + 86_400;
    expect(
      cardOpenStartTime({
        continuous: true,
        reviewStart: START,
        timeRangeAfter: dayClamp,
      }),
    ).toBe(START);
  });

  it("leaves upstream's non-continuous behaviour exactly as it was", () => {
    // still padded, still clamped — `.23` changes the continuous surfaces only
    expect(
      cardOpenStartTime({
        continuous: false,
        reviewStart: START,
        timeRangeAfter: START - 3600,
      }),
    ).toBe(START - REVIEW_PADDING);
    const clamp = START + 600;
    expect(
      cardOpenStartTime({
        continuous: false,
        reviewStart: START,
        timeRangeAfter: clamp,
      }),
    ).toBe(clamp - REVIEW_PADDING);
  });
});

describe("History's events list goes through this module too (`.24`)", () => {
  const src = readFileSync(
    resolve(__dirname, "../ContinuousTimelinePanel.tsx"),
    "utf8",
  )
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("the events-list card click seeks to start_time, not start_time - REVIEW_PADDING", () => {
    // the same gesture as the grid, on the surface a `?id=&tab=events` link lands on: with
    // the padding, tapping the alert beside the player moved the playhead 4 s BACKWARDS
    // from where the link had put it
    expect(src).toMatch(
      /onSelect=\{\(review\)\s*=>\s*manuallySetCurrentTime\(\s*reviewSeekTarget\(review\.start_time\)/,
    );
    expect(src).not.toContain(
      "manuallySetCurrentTime(review.start_time - REVIEW_PADDING",
    );
  });

  it("still keeps REVIEW_PADDING for the playhead-inside-review tolerance", () => {
    // that one is a TOLERANCE, not a seek: tightening it would make a review stop being
    // "current" 4 s early
    expect(src).toContain("rev.start_time - REVIEW_PADDING < currentTime");
  });
});

describe("the card click goes through this module", () => {
  const src = readFileSync(
    resolve(__dirname, "../../../views/events/EventView.tsx"),
    "utf8",
  );
  // comments stripped: a commented-out call must not satisfy the check (the lesson from
  // `topLinkBridge.test.tsx`'s own negative control)
  const code = src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("imports cardOpenStartTime and calls it", () => {
    expect(code).toMatch(
      /import\s*\{[\s\S]*?cardOpenStartTime[\s\S]*?\}\s*from\s*"@\/fork\/continuous"/,
    );
    expect(code).toMatch(/cardOpenStartTime\(\{/);
  });

  it("finds the card again by the start it was OPENED at (`.25` scroll restore)", () => {
    // Returning from a recording scrolls the grid back to the card you were watching, by
    // looking it up with `data-start`. Upstream pairs `+ REVIEW_PADDING` with its own
    // `- REVIEW_PADDING` open; `.23` stopped subtracting on the continuous path, so the
    // selector matched nothing and the grid quietly stopped scrolling. Reverting this line
    // changes no other test — hence the grep. (Reviewer item on `.25`.)
    expect(code).toMatch(
      /\[data-start="\$\{continuous\.enabled \? startTime : startTime \+ REVIEW_PADDING\}"\]/,
    );
    expect(code).not.toContain('[data-start="${startTime + REVIEW_PADDING}"]');
  });

  it("no longer subtracts REVIEW_PADDING when it opens a card", () => {
    // the exact line this change replaces — its return would silently restore the 4 s
    expect(code).not.toContain(
      "startTime: effectiveStartTime - REVIEW_PADDING",
    );
    const open = code.slice(
      code.indexOf("const onSelectReview"),
      code.indexOf("const onSelectAllReviews"),
    );
    expect(open.length).toBeGreaterThan(200);
    expect(open).toContain("cardOpenStartTime({");
    expect(open).not.toContain("REVIEW_PADDING");
  });
});
