/**
 * fork/continuous — plain data structures for the provider (no React).
 *
 * Reviews are stored per hour-aligned page and merged into ONE array sorted
 * `start_time DESC` (D23). Upstream's `/review` sorts `severity ASC, start_time DESC`, an
 * order that cannot survive concatenating time-window pages; and `limit`-paging that
 * endpoint would slice by severity, not time (F9) — hence pages are time windows only.
 * WebSocket items override page data by id (§9.4): the WS item always wins.
 */
import { ReviewSegment, MotionData } from "@/types/review";
import { RecordingSegment } from "@/types/record";

export type PageStatus = "queued" | "loading" | "done" | "error";

export type ReviewPage = {
  after: number;
  before: number;
  status: PageStatus;
  items: ReviewSegment[];
};

export type HeavyPage = {
  after: number;
  before: number;
  status: PageStatus;
  motion: MotionData[];
  unavailable: RecordingSegment[];
  /**
   * The live page wants re-fetching (§9.4 tail poll), but its current contents are still
   * the best available and must KEEP RENDERING while the new copy is in flight. Deleting it
   * instead blanked the whole visible day's motion bars and gap shading every 30 s, for as
   * long as the concurrency-1 queue took to refill them.
   */
  stale?: boolean;
};

/**
 * Three layers, applied in this order, and the order is the point:
 *
 *   pages     what the server returned
 *   overrides what the WebSocket sent — the live item always wins over page data (§9.4)
 *   patches   what WE changed locally, and the server has not echoed back
 *
 * `patches` must come LAST. A WS `update`/`end`/`genai` carries the whole segment and does
 * NOT carry `has_been_reviewed`, so replacing wholesale un-reviewed a card the user had
 * just marked — it reappeared in a `showReviewed = false` grid seconds later. Keeping the
 * local patch on top fixes that, and it is dropped once a refetched page agrees (the
 * provider clears a patch when the page value matches it).
 */
export function mergeReviews(
  pages: Iterable<ReviewPage>,
  overrides: Map<string, ReviewSegment>,
  removed: Set<string>,
  patches?: Map<string, Partial<ReviewSegment>>,
): ReviewSegment[] {
  const byId = new Map<string, ReviewSegment>();
  for (const p of pages) {
    for (const r of p.items) byId.set(r.id, r);
  }
  for (const [id, r] of overrides) byId.set(id, r);
  if (patches) {
    for (const [id, patch] of patches) {
      const base = byId.get(id);
      if (base) byId.set(id, { ...base, ...patch });
    }
  }
  for (const id of removed) byId.delete(id);
  const out = [...byId.values()];
  out.sort((a, b) => b.start_time - a.start_time);
  return out;
}

export function groupByCamera(
  reviews: ReviewSegment[],
): Map<string, ReviewSegment[]> {
  const m = new Map<string, ReviewSegment[]>();
  for (const r of reviews) {
    const arr = m.get(r.camera);
    if (arr) arr.push(r);
    else m.set(r.camera, [r]);
  }
  return m;
}

/** Concatenate heavy pages newest-first into flat arrays (order is irrelevant to the cells). */
export function mergeHeavy(pages: Iterable<HeavyPage>): {
  motion: MotionData[];
  unavailable: RecordingSegment[];
  loaded: { after: number; before: number }[];
} {
  const motion: MotionData[] = [];
  const unavailable: RecordingSegment[] = [];
  const loaded: { after: number; before: number }[] = [];
  for (const p of pages) {
    if (p.status !== "done") continue;
    loaded.push({ after: p.after, before: p.before });
    for (const m of p.motion) motion.push(m);
    for (const u of p.unavailable) unavailable.push(u);
  }
  return { motion, unavailable, loaded };
}
