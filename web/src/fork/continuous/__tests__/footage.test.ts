import { describe, expect, it } from "vitest";
import { classifyMissingFootage, describeMissingFootage } from "../footage";

const DAY = 86400;
const now = 1_800_000_000;
const oldestRecording = now - 4 * DAY;

describe("classifyMissingFootage (D21 / §14.1a)", () => {
  it("older than the retention horizon reads as expired", () => {
    expect(classifyMissingFootage(now - 10 * DAY, oldestRecording)).toBe(
      "expired",
    );
  });

  it("inside the horizon reads as an outage — retention reaps oldest-first, so it cannot punch a hole here", () => {
    expect(classifyMissingFootage(now - DAY, oldestRecording)).toBe("outage");
  });

  it("is unknown until the extent has loaded, so the caller can stay neutral", () => {
    expect(classifyMissingFootage(now - DAY, undefined)).toBe("unknown");
    expect(describeMissingFootage(now - DAY, undefined).text).toMatch(
      /No recordings found/,
    );
  });

  it("the boundary itself is not expired", () => {
    expect(classifyMissingFootage(oldestRecording, oldestRecording)).toBe(
      "outage",
    );
  });

  it("says what it means without claiming a cause it cannot know", () => {
    expect(
      describeMissingFootage(now - 10 * DAY, oldestRecording).text,
    ).toMatch(/retained/);
  });
});
