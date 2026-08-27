/**
 * fork/continuous — paged `/review/activity/motion` + `/recordings/unavailable` (2a).
 *
 * Constraints encoded here (do not "simplify" them away):
 *  - §5.3 / F2: page boundaries are WHOLE HOURS in the display timezone, because the
 *    backend min-max normalises motion per one-hour chunk counted from index 0 of the
 *    response. Unaligned pages give different bar heights for the same timestamp.
 *  - F12 / F21: at most ONE heavy request in flight (the provider's `heavyQueue`,
 *    concurrency 1); pages the viewport has scrolled away from are aborted; pages are
 *    requested only for the visible range ± one page, never prefetched further. Stalling
 *    the single-worker API makes the Supervisor watchdog recreate the add-on.
 *  - §10 rule 1: only the dense strips call this hook. The list tabs never fetch motion.
 *  - §14.6: at most MAX_PAGES_PER_FAMILY pages are retained per (cameras, scale) family;
 *    the farthest from the viewport are dropped and refetched on scroll-back.
 *  - `/recordings/unavailable` is only cheap AFTER D27 is on the box (0.17.1-troy.11);
 *    it is fetched in the same serialised job as the motion page for the same window.
 *
 * Pages are HEAVY_PAGE_HOURS long (a day) and keyed by their `after`; the cache is
 * module-level so switching tabs and back does not refetch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { MotionData } from "@/types/review";
import { RecordingSegment } from "@/types/record";
import { FetchQueue, isAbort } from "./fetchQueue";
import { HeavyPage, mergeHeavy } from "./store";
import { pagesFor } from "./timeAlign";

export const HEAVY_PAGE_HOURS = 24;
export const MAX_PAGES_PER_FAMILY = 20;

const cache = new Map<string, Map<number, HeavyPage>>();

function familyKey(cameras: string, motionScale: number, unavailScale: number) {
  return `${cameras}|${motionScale}|${unavailScale}`;
}

export type HeavyData = {
  motion: MotionData[];
  unavailable: RecordingSegment[];
  /** Hour-aligned windows for which data has landed. */
  loaded: { after: number; before: number }[];
  /** True while any page intersecting the requested range is still loading. */
  loading: boolean;
  isLoaded: (t: number) => boolean;
};

export function useHeavyPages(params: {
  queue: FetchQueue;
  tz: string;
  cameras: string;
  motionScale: number;
  unavailScale: number;
  /** The time range currently on screen (newest `before`, oldest `after`). */
  visible: { after: number; before: number } | undefined;
  /**
   * The provider's tail tick (§9.4). There is no push channel for historical motion, so
   * the page containing `now` is dropped and re-requested every time this changes; every
   * older page is immutable and is never refetched. Omit to disable tail polling.
   */
  tailTick?: number;
  enabled?: boolean;
}): HeavyData {
  const {
    queue,
    tz,
    cameras,
    motionScale,
    unavailScale,
    visible,
    tailTick,
    enabled = true,
  } = params;
  const fam = familyKey(cameras, motionScale, unavailScale);
  const [version, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);
  const pages = useMemo(() => {
    let m = cache.get(fam);
    if (!m) {
      m = new Map();
      cache.set(fam, m);
    }
    return m;
  }, [fam]);

  const wantedRef = useRef<Set<number>>(new Set());

  // §9.4 tail poll. Declared BEFORE the fetch effect on purpose: React runs effects in
  // declaration order, so on a tick this deletes the live page and the fetch effect below
  // — which also lists `tailTick` in its deps — immediately re-requests it. Do not instead
  // add `version` to the fetch effect's deps: it ends with an unconditional `rerender()`,
  // so that would spin.
  const lastTick = useRef(tailTick);
  useEffect(() => {
    if (tailTick === undefined || tailTick === lastTick.current) return;
    lastTick.current = tailTick;
    const [live] = pagesFor(tailTick, tailTick + 1, HEAVY_PAGE_HOURS, tz);
    const page = live && pages.get(live.after);
    if (page && page.status === "done" && !page.stale) {
      // MARK, do not delete. `mergeHeavy` only emits `done` pages, so deleting the live
      // page blanked the entire visible day — every motion bar and every gap — on every
      // 30 s tick until the serialised queue refilled it. The stale copy keeps rendering
      // and is swapped for the fresh one on success.
      pages.set(live.after, { ...page, stale: true });
      rerender();
    }
  }, [tailTick, tz, pages, rerender]);

  useEffect(() => {
    if (!visible || !enabled) return;
    const span = HEAVY_PAGE_HOURS * 3600;
    // visible ± one page (§10): never further
    const wanted = pagesFor(
      visible.after - span,
      visible.before + span,
      HEAVY_PAGE_HOURS,
      tz,
    );
    const wantedSet = new Set(wanted.map((p) => p.after));
    // abort pages we scrolled away from
    for (const after of wantedRef.current) {
      if (!wantedSet.has(after)) {
        const p = pages.get(after);
        if (!p) continue;
        // cancel unconditionally: a SHADOW refresh leaves the page `done`, so keying the
        // cancel on status alone left a scrolled-away refresh sitting in the serialised
        // queue, holding the one slot the motion endpoint is allowed (F12).
        queue.cancel(`${fam}:${after}`);
        if (p.status !== "done") pages.delete(after);
      }
    }
    wantedRef.current = wantedSet;

    // nearest-to-viewport first
    const mid = (visible.after + visible.before) / 2;
    const ordered = [...wanted].sort(
      (a, b) =>
        Math.abs(a.after + span / 2 - mid) - Math.abs(b.after + span / 2 - mid),
    );
    for (const p of ordered) {
      const existing = pages.get(p.after);
      if (existing && !existing.stale) continue;
      const before = Math.min(p.before, Math.floor(Date.now() / 1000));
      if (before <= p.after) continue;
      if (existing) {
        // shadow refresh: clear the flag so this does not re-enqueue every render, but
        // leave the data in place so the strip keeps drawing while the fetch is in flight
        pages.set(p.after, { ...existing, stale: false });
      } else {
        pages.set(p.after, {
          after: p.after,
          before: p.before,
          status: "loading",
          motion: [],
          unavailable: [],
        });
      }
      queue
        .enqueue(
          `${fam}:${p.after}`,
          async (signal) => {
            const m = await axios.get<MotionData[]>("review/activity/motion", {
              params: { before, after: p.after, scale: motionScale, cameras },
              signal,
            });
            const u = await axios.get<RecordingSegment[]>(
              "recordings/unavailable",
              {
                params: {
                  before,
                  after: p.after,
                  scale: unavailScale,
                  cameras,
                },
                signal,
              },
            );
            return { motion: m.data ?? [], unavailable: u.data ?? [] };
          },
          -Math.abs(p.after + span / 2 - mid),
        )
        .then(({ motion, unavailable }) => {
          pages.set(p.after, {
            after: p.after,
            before: p.before,
            status: "done",
            motion,
            unavailable,
          });
          // §14.6 cap
          if (pages.size > MAX_PAGES_PER_FAMILY) {
            const far = [...pages.keys()]
              .filter((k) => !wantedRef.current.has(k))
              .sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid));
            while (pages.size > MAX_PAGES_PER_FAMILY && far.length)
              pages.delete(far.shift()!);
          }
          rerender();
        })
        .catch((e) => {
          if (isAbort(e)) return;
          // a failed SHADOW refresh must not blank what is already on screen
          const prior = pages.get(p.after);
          if (prior && prior.status === "done") return;
          pages.set(p.after, {
            after: p.after,
            before: p.before,
            status: "error",
            motion: [],
            unavailable: [],
          });
          rerender();
        });
    }
    rerender();
    // visible is consumed by value (after/before) so a new object with equal edges is a no-op
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visible?.after,
    visible?.before,
    tailTick,
    enabled,
    tz,
    fam,
    pages,
    queue,
    cameras,
    motionScale,
    unavailScale,
    rerender,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // merged view — recomputed when any page lands (rerender bumps)
  // `version` is bumped when a page lands — the Map is mutated in place, so it is the real dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const merged = useMemo(() => mergeHeavy(pages.values()), [pages, version]);
  const loading = useMemo(
    () =>
      [...pages.values()].some(
        (p) => p.status === "loading" && wantedRef.current.has(p.after),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pages, version],
  );
  const isLoaded = useCallback(
    (t: number) => merged.loaded.some((r) => t >= r.after && t < r.before),
    [merged],
  );
  return {
    motion: merged.motion,
    unavailable: merged.unavailable,
    loaded: merged.loaded,
    loading,
    isLoaded,
  };
}
