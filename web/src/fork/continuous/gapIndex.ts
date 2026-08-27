/**
 * fork/continuous — D7 / §14.1a: the three-way gap classifier, bucket-indexed.
 *
 * The database records NO reason for a gap. `/recordings/unavailable` derives gaps purely
 * by absence — it walks the range in `scale`-second steps and emits a gap wherever no
 * `Recordings` row overlaps — and the model has no reason field, no outage log, no
 * tombstone. But the reason IS recoverable from a horizon comparison, entirely client-side
 * (the same inference `footage.ts` makes for the player's D21 state):
 *
 *   W = MIN(recordings.start_time)   — what the free-space reaper actually left
 *   gap older than W  →  expired     (footage aged out)
 *   gap newer than W  →  outage      (camera down, Frigate restart, disk full, F12 kill)
 *
 * Retention reaps oldest-first, so it cannot punch a hole AFTER the horizon. It is an
 * INFERENCE, not a record: a camera down 40 days ago is indistinguishable from reaped,
 * which is fine — nobody needs to know why 40-day-old footage is missing.
 *
 * **The fourth state is the one that was missing and it is the one that matters most on a
 * continuous strip.** `undefined` — "the gap page for this time has not landed yet" — used
 * to render as "not known to be missing", i.e. as a normal recorded bed. At 24 h that was
 * invisible; past the recording floor EVERY segment is a gap, so the strip painted "all
 * fine" and repainted black a beat later. Four states, four appearances:
 *
 *   available  recording exists                → normal bed, motion bars
 *   outage     known gap, newer than W         → blackout, style A
 *   expired    known gap, older than W         → blackout, style B (hatched, dimmer)
 *   unknown    gap data not fetched yet        → skeleton shimmer, NEVER either blackout
 *
 * **Why a bucket index (§14.1a's second consequence).** The old lookup was
 * `unavailable.some(r => t >= r.start_time && t < r.end_time)` — O(ranges) per call, once
 * per visible cell per render. Past the floor the range list is long and every cell is a
 * gap, so that is the F11 problem again in a different place. Bucketing by a fixed
 * BUCKET_S grid makes each lookup O(ranges in one bucket) ≈ O(1), built once per page
 * arrival. `loaded` gets the same treatment: it is a short list today, but it is consulted
 * on exactly the same hot path.
 */
import { RecordingSegment } from "@/types/record";

export type GapState = "available" | "outage" | "expired" | "unknown";

/** Bucket width for the index. One hour: `/recordings/unavailable` gaps are minutes-to-days. */
export const BUCKET_S = 3600;

export type GapIndex = {
  classify: (t: number) => GapState;
  /** `true` / `false` / `undefined` in upstream's tri-state terms — for ReviewTimeline. */
  hasRecording: (t: number) => boolean | undefined;
};

type Range = { start: number; end: number };

function bucketize(ranges: Range[]): Map<number, Range[]> {
  const buckets = new Map<number, Range[]>();
  for (const r of ranges) {
    if (!(r.end > r.start)) continue;
    const first = Math.floor(r.start / BUCKET_S);
    const last = Math.floor((r.end - 1e-6) / BUCKET_S);
    // A range spanning many buckets is registered in each: a whole reaped week is one
    // range over ~168 buckets, which is cheap to build and keeps every lookup O(1).
    for (let b = first; b <= last; b++) {
      const list = buckets.get(b);
      if (list) list.push(r);
      else buckets.set(b, [r]);
    }
  }
  return buckets;
}

function covers(buckets: Map<number, Range[]>, t: number): boolean {
  const list = buckets.get(Math.floor(t / BUCKET_S));
  if (!list) return false;
  for (const r of list) if (t >= r.start && t < r.end) return true;
  return false;
}

/**
 * @param unavailable  gap ranges from `/recordings/unavailable` (the merged page data)
 * @param loaded       hour-aligned windows whose gap page HAS landed (`HeavyData.loaded`)
 * @param oldestRecording  W — `MIN(recordings.start_time)` from `/recordings/summary`.
 *                     `undefined` while the summary is in flight: everything known-missing
 *                     is then reported as `outage`, because claiming "expired" without a
 *                     horizon would be asserting a cause we do not have. It is the weaker
 *                     claim of the two, and it resolves within one SWR round-trip.
 */
export function buildGapIndex(
  unavailable: RecordingSegment[],
  loaded: { after: number; before: number }[],
  oldestRecording: number | undefined,
): GapIndex {
  const gapBuckets = bucketize(
    unavailable.map((r) => ({ start: r.start_time, end: r.end_time })),
  );
  const loadedBuckets = bucketize(
    loaded.map((r) => ({ start: r.after, end: r.before })),
  );

  const classify = (t: number): GapState => {
    if (!covers(loadedBuckets, t)) return "unknown";
    if (!covers(gapBuckets, t)) return "available";
    if (oldestRecording === undefined) return "outage";
    return t < oldestRecording ? "expired" : "outage";
  };

  return {
    classify,
    hasRecording: (t: number) => {
      const state = classify(t);
      return state === "unknown" ? undefined : state === "available";
    },
  };
}

/**
 * How each state looks, and what it is called. §17.7 check 7 is the acceptance: "blackout
 * is labelled and distinguishable from an outage; not loaded looks like neither."
 *
 * The classes are deliberately different CSS PROPERTIES from the severity tint the review
 * blips draw (`background-image` gradient stops), so a blip inside a blacked-out region
 * still shows its colour over the dark bed — that is what makes D6 useful rather than
 * decorative (§14.1a). `expired` therefore uses a repeating-gradient hatch as an OVERLAY
 * row rather than as the cell's own background.
 */
export const GAP_PRESENTATION: Record<
  Exclude<GapState, "available">,
  { label: string; shortLabel: string; className: string }
> = {
  outage: {
    label: "No recording was made — camera unavailable",
    shortLabel: "no recording",
    // A faint warm wash and an inset edge over the blackout the cell already paints.
    // TRANSLUCENT on purpose: an opaque overlay would hide the review blip, and "black with
    // coloured marks where things happened" is the whole point of D6.
    className: "bg-severity_alert/10 ring-1 ring-inset ring-severity_alert/30",
  },
  expired: {
    label: "Footage expired — past the recording retention",
    shortLabel: "expired",
    // Diagonal hatch, also translucent: nothing is wrong here, this footage simply aged out.
    // A pattern rather than a colour, so the two blackout reasons differ in TEXTURE and are
    // still told apart at a glance on an 8 px row.
    className:
      "[background-image:repeating-linear-gradient(45deg,rgba(255,255,255,0.16)_0px,rgba(255,255,255,0.16)_1px,transparent_1px,transparent_4px)]",
  },
  unknown: {
    label: "Loading recording availability…",
    shortLabel: "loading",
    // The one that replaces the row entirely — there is no cell to show through, because we
    // do not yet know what it would say.
    className: "animate-pulse bg-secondary-highlight/40",
  },
};
