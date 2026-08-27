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
  /**
   * The `before` actually REQUESTED, which for the page containing now is clamped to the
   * current second. `mergeHeavy` reports this as the loaded extent so the gap classifier
   * does not claim knowledge of a future that has not happened.
   */
  loadedBefore?: number;
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
 * local patch on top fixes that, and it is dropped once a refetched page agrees — the
 * retirement is `retirePatches` below, called from the provider's `fetchPage` `.then`:
 * it deletes a patch whose every key already matches the item the server just returned.
 * Without that step a patched id masks the server's value for the whole session.
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

/**
 * Drop every patch the server has caught up with (§14.4).
 *
 * A patch is a local truth that has not been echoed back yet, and `mergeReviews` applies it
 * LAST — so a patch that is never retired masks that field for the rest of the session, and
 * a change made anywhere else (another tab, a phone, the API) can never show through.
 * Only the patched keys are compared, which keeps this independent of what
 * `Partial<ReviewSegment>` grows to hold.
 *
 * Returns the SAME map when nothing was retired: `reviews` is a useMemo keyed on this
 * identity, so returning a fresh copy on every tail-poll refetch would re-merge the whole
 * list 30 s.
 */
export function retirePatches(
  patches: Map<string, Partial<ReviewSegment>>,
  items: ReviewSegment[],
): Map<string, Partial<ReviewSegment>> {
  if (patches.size === 0) return patches;
  let next: Map<string, Partial<ReviewSegment>> | undefined;
  for (const item of items) {
    const patch = patches.get(item.id);
    if (!patch) continue;
    const agreed = Object.entries(patch).every(
      ([k, v]) => item[k as keyof ReviewSegment] === v,
    );
    if (!agreed) continue;
    next ??= new Map(patches);
    next.delete(item.id);
  }
  return next ?? patches;
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
/**
 * Retire the placeholder an ABORTED page left behind.
 *
 * Split out of `useHeavyPages` so the invariant is testable, because getting it wrong is
 * silent and permanent: `mergeHeavy` only emits `done` pages, so a page stuck at `loading`
 * never contributes to `loaded`, the strip shows a skeleton over that whole day for ever,
 * and the re-request guard (`existing && !existing.stale`) refuses to try again. The cache
 * is module-level, so it outlives the component too.
 *
 * Returns true when something was removed (the caller must re-render).
 */
export function dropAbortedPage(
  pages: Map<number, HeavyPage>,
  after: number,
): boolean {
  const page = pages.get(after);
  // only the placeholder: a page that already has DATA must survive an aborted refresh
  if (!page || page.status !== "loading") return false;
  pages.delete(after);
  return true;
}

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
    // The page containing NOW is fetched with `before` clamped to the current second
    // (`useHeavyPages`), so claiming the whole nominal page as loaded asserts knowledge of
    // gap data for a future that has not happened yet. `loadedBefore` carries what was
    // actually asked for; `before` stays the page's own bound for identity and eviction.
    loaded.push({ after: p.after, before: p.loadedBefore ?? p.before });
    for (const m of p.motion) motion.push(m);
    for (const u of p.unavailable) unavailable.push(u);
  }
  return { motion, unavailable, loaded };
}
