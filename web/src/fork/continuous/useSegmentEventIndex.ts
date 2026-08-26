/**
 * fork/continuous — the bucket index that removes F11.
 *
 * Why this exists: the dense time cells (MotionSegment, EventSegment) take the ENTIRE
 * review array as their `events` prop and, through `use-event-segment-utils.ts`, scan all
 * of it 2–8 times per cell per render. At 24 h that is ~60k compares per frame; at 365 d
 * it is ~2.6 M, re-run on every scroll tick and every live-tail insert (handover §4A.4).
 *
 * The fix costs the cells nothing: every helper in the utils hook uses the same overlap
 * predicate  `time >= segStart(e.start_time) && time < segEnd(e.end_time)`, and
 * `shouldShowRoundedCorners` additionally probes `segmentTime ± segmentDuration`. So the
 * container indexes each review into every segment bucket it spans, and hands each cell
 * `bucket[t-d] ∪ bucket[t] ∪ bucket[t+d]` — typically 0–3 items — as its `events` prop.
 * Semantically identical, O(1) per cell.
 *
 * Two wrinkles (§4A.4):
 *  - `getSegmentEnd(undefined)` in the utils hook returns *now* + segmentDuration: an
 *    in-progress review extends to the present. Open-ended reviews are held separately and
 *    appended to every bucket at or after their start, evaluated at lookup time — never
 *    baked into the map with a timestamp that goes stale.
 *  - The map is rebuilt only when the review array identity changes; the provider keeps
 *    that identity stable across tail ticks that change nothing.
 *
 * This is the *semantic bet* of D8 / §7.4: it holds only while the copied cells' helpers
 * keep using that predicate and that ±1 probe. The copied files carry the same note.
 */
import { useCallback, useMemo } from "react";
import { ReviewSegment } from "@/types/review";

export type SegmentEventLookup = (segmentTime: number) => ReviewSegment[];

const EMPTY: ReviewSegment[] = [];

export function buildSegmentEventIndex(
  events: ReviewSegment[],
  segmentDuration: number,
): { closed: Map<number, ReviewSegment[]>; open: ReviewSegment[] } {
  const closed = new Map<number, ReviewSegment[]>();
  const open: ReviewSegment[] = [];
  for (const e of events) {
    if (!e.end_time) {
      open.push(e);
      continue;
    }
    const start = Math.floor(e.start_time / segmentDuration) * segmentDuration;
    const end =
      Math.floor(e.end_time / segmentDuration) * segmentDuration + segmentDuration;
    for (let t = start; t < end; t += segmentDuration) {
      const bucket = closed.get(t);
      if (bucket) bucket.push(e);
      else closed.set(t, [e]);
    }
  }
  return { closed, open };
}

export function useSegmentEventIndex(
  events: ReviewSegment[],
  segmentDuration: number,
): SegmentEventLookup {
  const index = useMemo(
    () => buildSegmentEventIndex(events, segmentDuration),
    [events, segmentDuration],
  );

  return useCallback(
    (segmentTime: number): ReviewSegment[] => {
      const { closed, open } = index;
      // ±1 segment because shouldShowRoundedCorners probes the neighbours (§4A.4)
      const a = closed.get(segmentTime - segmentDuration);
      const b = closed.get(segmentTime);
      const c = closed.get(segmentTime + segmentDuration);
      let out: ReviewSegment[] | undefined;
      if (a || b || c || open.length) {
        out = [];
        const seen = new Set<string>();
        for (const bucket of [a, b, c]) {
          if (!bucket) continue;
          for (const e of bucket) {
            if (!seen.has(e.id)) {
              seen.add(e.id);
              out.push(e);
            }
          }
        }
        for (const e of open) {
          // an open-ended review spans from its start to "now": include it for every
          // segment at or after its (aligned) start, minus one neighbour probe
          const start =
            Math.floor(e.start_time / segmentDuration) * segmentDuration;
          if (segmentTime + segmentDuration >= start && !seen.has(e.id)) {
            seen.add(e.id);
            out.push(e);
          }
        }
      }
      return out && out.length ? out : EMPTY;
    },
    [index, segmentDuration],
  );
}
