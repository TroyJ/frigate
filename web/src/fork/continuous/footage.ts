/**
 * fork/continuous — D21 / §14.1a: why is there no video here?
 *
 * The database records NO reason for a gap. `/recordings/unavailable` derives gaps purely
 * by absence, and the `Recordings` model has no reason field, no outage log, no tombstone.
 * But the reason is recoverable from a horizon comparison, entirely client-side:
 *
 *   W = MIN(recordings.start_time)   — what the free-space reaper actually left
 *   requested older than W  →  the footage aged out
 *   requested newer than W  →  a real outage (camera down, Frigate restart, disk full)
 *
 * Retention reaps oldest-first, so it cannot punch a hole AFTER the horizon; anything
 * missing on the recent side of W is therefore an outage. This is an INFERENCE, not a
 * record — a camera that was down 40 days ago is indistinguishable from reaped, which is
 * fine because nobody needs to know why 40-day-old footage is missing. Say "expired"
 * rather than implying certainty about a cause we do not have.
 *
 * `unknown` is returned while the extent has not loaded, so the caller can fall back to
 * upstream's neutral wording rather than assert something wrong for a beat.
 */
export type MissingFootageReason = "expired" | "outage" | "unknown";

export function classifyMissingFootage(
  requested: number,
  oldestRecording: number | undefined,
): MissingFootageReason {
  if (oldestRecording === undefined) return "unknown";
  return requested < oldestRecording ? "expired" : "outage";
}

/**
 * English strings, rendered as-is.
 *
 * NOT as an i18n `defaultValue`: upstream installs a `parseMissingKeyHandler`
 * (`utils/i18n.ts`) that takes precedence over `defaultValue`, so a key with no locale entry
 * renders as a humanised KEY rather than the fallback — measured on the deep-link notice,
 * which rendered the literal word "Review-missing" where a sentence belonged. Translating
 * the fork's strings means adding real entries to the locale bundles, which is upstream
 * surface and a separate decision.
 */
export const MISSING_FOOTAGE_TEXT: Record<MissingFootageReason, string> = {
  expired: "No footage retained for this period",
  outage: "No recording was made during this period",
  unknown: "No recordings found for this time",
};

export function describeMissingFootage(
  requested: number,
  oldestRecording: number | undefined,
): { reason: MissingFootageReason; text: string } {
  const reason = classifyMissingFootage(requested, oldestRecording);
  return { reason, text: MISSING_FOOTAGE_TEXT[reason] };
}
