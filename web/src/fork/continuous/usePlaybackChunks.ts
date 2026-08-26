/**
 * fork/continuous — Phase 6: the playback chunk window (§9.5, F1, Q3=A).
 *
 * Upstream's `getChunkedTimeDay` caps at 24 hourly chunks and then emits ONE catch-all
 * chunk for the rest; with a multi-day window that hands nginx-vod-module a multi-day HLS
 * playlist which stalls silently (F1). The first fork version fixed that by emitting hourly
 * chunks over the WHOLE retained range — correct, but 8,784 objects rebuilt on every 30 s
 * tail tick, with `RecordingView` scanning them on every seek.
 *
 * This is the §9.5 shape instead: a SLIDING window of hourly chunks around the playhead.
 *
 * Three properties the consumer depends on, none of them optional:
 *
 *  1. **Hourly chunks.** Never widen a chunk. One hour is what nginx-vod serves reliably
 *     here; the F1 stall was a multi-day *chunk*, not a long *list*.
 *  2. **Stable identity between re-anchors.** `RecordingView` keeps an INDEX into this
 *     array (`selectedRangeIdx`), so a new array on every tick would make it re-scan and,
 *     worse, re-point if the origin moved. The window therefore re-anchors only when the
 *     playhead leaves the middle half of it (hysteresis), and grows at the newest end only
 *     when a whole hour completes — not every tail tick.
 *  3. **The playhead is always inside the returned list.** Anchor ± `spanHours`, re-anchor
 *     at ± `spanHours / 2`, so a seek that lands outside triggers a re-anchor that contains
 *     it (Q3=A: auto-load, then apply the seek). A caller that gets -1 from `findIndex`
 *     has hit a bug here, not a legitimate state.
 *
 * The oldest edge is clamped to `floor` (the retention extent) and the newest to the end of
 * the current hour, so the list never advertises chunks that cannot exist.
 */
import { useMemo, useRef } from "react";
import { TimeRange } from "@/types/timeline";
import { HOUR } from "./timeAlign";

/** ± this many hours of chunks around the anchor. 6 h either side = 13 chunks. */
export const CHUNK_SPAN_HOURS = 6;

export type PlaybackChunkWindow = {
  chunks: TimeRange[];
  /** Index of the chunk containing `t`, or -1 when it is outside the window. */
  indexOf: (t: number) => number;
};

/** Whole-hour floor/ceil in UTC terms — chunk edges are wall-clock hours, not tz days. */
const floorHour = (t: number) => Math.floor(t / HOUR) * HOUR;
const ceilHour = (t: number) => Math.ceil(t / HOUR) * HOUR;

export function buildChunks(
  anchor: number,
  now: number,
  floor: number,
  spanHours: number,
): TimeRange[] {
  const start = Math.max(
    floorHour(floor),
    floorHour(anchor - spanHours * HOUR),
  );
  const end = Math.min(ceilHour(now), ceilHour(anchor + spanHours * HOUR));
  const out: TimeRange[] = [];
  for (let t = start; t < end; t += HOUR) {
    out.push({ after: t, before: t + HOUR });
  }
  // never hand back an empty list: the player would have no range at all
  if (out.length === 0) {
    const t = floorHour(Math.min(anchor, now));
    out.push({ after: t, before: t + HOUR });
  }
  return out;
}

/**
 * Decide whether to move the anchor. Returns the anchor to use.
 * Re-anchors when the playhead is outside the middle half of the current window, or when
 * the window no longer reaches `now` while the playhead is riding the live edge.
 */
export function nextAnchor(
  current: number | undefined,
  playhead: number,
  spanHours: number,
): number {
  if (current === undefined) return playhead;
  if (Math.abs(playhead - current) > (spanHours / 2) * HOUR) return playhead;
  return current;
}

export function usePlaybackChunks(params: {
  /** Where the player is. Undefined before the first report — falls back to `now`. */
  playhead: number | undefined;
  /** Tail tick (epoch seconds); only whole-hour changes alter the list. */
  now: number;
  /** Oldest timestamp that can have recordings (from `/recordings/summary`). */
  floor: number;
  spanHours?: number;
}): PlaybackChunkWindow {
  const { playhead, now, floor, spanHours = CHUNK_SPAN_HOURS } = params;
  const anchorRef = useRef<number>();
  const target = playhead ?? now;
  anchorRef.current = nextAnchor(anchorRef.current, target, spanHours);
  const anchor = anchorRef.current;
  // quantising `now` to the hour is what keeps the identity stable across tail ticks
  const nowHour = ceilHour(now);

  const chunks = useMemo(
    () => buildChunks(anchor, nowHour, floor, spanHours),
    [anchor, nowHour, floor, spanHours],
  );

  return useMemo(
    () => ({
      chunks,
      indexOf: (t: number) =>
        chunks.findIndex((c) => c.after <= t && c.before > t),
    }),
    [chunks],
  );
}
