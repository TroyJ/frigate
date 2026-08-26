/**
 * The copied cells (D8 / §7.4) are a SEMANTIC bet: the fork hands them a pre-sliced
 * `events` array, which is only correct while their helpers keep selecting events with the
 * overlap predicate and probing at most ±1 segment. `UPSTREAM_SHAS` records what we read
 * when we made that bet; this test turns upstream drift into a loud failure instead of a
 * silently-wrong strip. If it fails: diff the upstream file, re-check the predicate, then
 * update both the copy and the SHA line — never just the SHA.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "../../../..");
const SHAS = resolve(__dirname, "../UPSTREAM_SHAS");

function recorded(): [string, string][] {
  return readFileSync(SHAS, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, path] = l.split(/\s+/);
      return [path, sha] as [string, string];
    });
}

describe("copied upstream cells have not drifted", () => {
  const entries = recorded();

  it("records a sha for every copied file", () => {
    expect(entries.length).toBe(3);
  });

  it.each(entries)("%s matches its recorded sha256", (path, sha) => {
    // UPSTREAM_SHAS paths are repo-relative (web/src/...); this test runs from web/
    const abs = resolve(WEB, path.replace(/^web\//, ""));
    const actual = createHash("sha256").update(readFileSync(abs)).digest("hex");
    expect(actual).toBe(sha);
  });
});
