/**
 * fork/continuous — the provider. Owns the continuous window, the paged review data,
 * the live tail, the playback chunk list and the navigation registry.
 *
 * Why the window lives here and not in `pages/Events.tsx` (§8.1–8.5): upstream's single
 * 24-hour `selectedTimeRange` stays exactly as it is; the fork panels read this context
 * instead, so the whole feature is reversible by the toggle and the upstream diff stays at
 * the seam. `RecordingView` is remounted by upstream whenever `beforeTs` moves (F7) — this
 * provider sits above that, so loaded pages and scroll depth survive the remount.
 *
 * Playback chunks (F1): upstream's `getChunkedTimeDay` caps at 24 hourly chunks and then
 * emits one catch-all chunk for the rest — with a multi-day window that hands
 * nginx-vod-module a multi-day HLS playlist that stalls silently. The fork supplies a flat
 * list of ONE-HOUR chunks from the retention floor to now. The list only ever grows at the
 * newest end (tail tick), never at the oldest, because `RecordingView` keeps an *index*
 * into it (`selectedRangeIdx`) — prepending would silently re-point the player.
 */
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import axios from "axios";
import useSWR from "swr";
import { FrigateConfig } from "@/types/frigateConfig";
import {
  ReviewSegment,
  RecordingsSummary,
  ReviewSummary,
} from "@/types/review";
import { TimeRange } from "@/types/timeline";
import { useTimezone } from "@/hooks/use-date-utils";
import { useFrigateReviews } from "@/api/ws";
import { useContinuousEnabled } from "./useContinuousEnabled";
import { FetchQueue, isAbort } from "./fetchQueue";
import { ReviewPage, mergeReviews, groupByCamera } from "./store";
import { usePlaybackChunks } from "./usePlaybackChunks";
import {
  DAY,
  EDGE_ALIGN,
  HOUR,
  alignUp,
  dayKeyToStartInTz,
  floorHourInTz,
  pagesFor,
} from "./timeAlign";

export type SurfaceName =
  | "timeline"
  | "events"
  | "detail"
  | "grid"
  | "strip"
  | "motion";

export type SurfaceApi = {
  /** Scroll so `t` is in view; select `selectId` if given. */
  scrollToTime: (t: number, selectId?: string) => void;
  /** Jump to the newest edge. Used by the "N new" chip (§9.3, D17). */
  scrollToTop?: () => void;
};

export type NavigateOptions = { surface?: SurfaceName; selectId?: string };

export type ContinuousFilter = {
  cameras?: string;
  labels?: string;
  zones?: string;
};

export type ContinuousContextValue = {
  enabled: boolean;
  tz: string;
  /** Tail tick: epoch seconds, advanced every TAIL_TICK_MS while visible. */
  now: number;
  window: { newest: number; oldest: number };
  hasMore: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => void;
  ensureLoaded: (t: number) => Promise<void>;
  reviews: ReviewSegment[];
  reviewsByCamera: Map<string, ReviewSegment[]>;
  patchReviews: (ids: string[], patch: Partial<ReviewSegment>) => void;
  /** Drop reviews from the merged list — deletes, which no page refetch will undo. */
  removeReviews: (ids: string[]) => void;
  chunks: TimeRange[];
  /** Where the player is, as last reported. Undefined until a surface reports. */
  playhead?: number;
  /** Tell the provider where the player is, so the chunk window can follow it (§9.5). */
  reportPlayhead: (t: number) => void;
  /** Tell the provider whether the active surface is pinned to the newest edge (§9.3). */
  reportAtTop: (atTop: boolean) => void;
  /** Jump the active surface to the newest edge. */
  scrollToTop: () => void;
  registerSurface: (name: SurfaceName, api: SurfaceApi) => () => void;
  navigateToTime: (t: number, opts?: NavigateOptions) => Promise<void>;
  selectedId?: string;
  setSelectedId: (id?: string) => void;
  /** Number of items that arrived at the head while the user was not at the top. */
  pendingNew: number;
  clearPendingNew: () => void;
  extent: { oldestReview?: number; oldestRecording?: number };
  heavyQueue: FetchQueue;
};

const ContinuousContext = createContext<ContinuousContextValue | undefined>(
  undefined,
);

export const TAIL_TICK_MS = 30_000;
const INITIAL_SPAN = DAY;
/** §10: `/review` is cheap; page it generously, drop to 1 day when the first page is slow. */
const REVIEW_PAGE_HOURS_FAST = 72;
const REVIEW_PAGE_HOURS_SLOW = 24;
const SLOW_PAGE_MS = 1500;
const RETENTION_FALLBACK_DAYS = 366;

type Props = {
  filter: ContinuousFilter;
  children: ReactNode;
};

export function ContinuousProvider({ filter, children }: Props) {
  const [enabled, setEnabled, toggleLoaded] = useContinuousEnabled();
  const { data: config } = useSWR<FrigateConfig>("config");
  const tz =
    useTimezone(config) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const filterKey = `${filter.cameras ?? ""}|${filter.labels ?? ""}|${filter.zones ?? ""}`;

  // ---- tail tick -------------------------------------------------------------------
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        setNow(Math.floor(Date.now() / 1000));
      }
    }, TAIL_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // ---- window ----------------------------------------------------------------------
  const newest = useMemo(
    () => alignUp(now, EDGE_ALIGN) + 2 * EDGE_ALIGN,
    [now],
  );
  const [oldest, setOldest] = useState(() =>
    floorHourInTz(Math.floor(Date.now() / 1000) - INITIAL_SPAN, tz),
  );

  // ---- extents (D2 / §14.2): stop on the summaries, never on an empty page --------
  const { data: reviewSummary } = useSWR<ReviewSummary>([
    "review/summary",
    {
      timezone: tz,
      cameras: filter.cameras ?? null,
      labels: filter.labels ?? null,
      zones: filter.zones ?? null,
    },
  ]);
  const { data: recordingsSummary } = useSWR<RecordingsSummary>([
    "recordings/summary",
    { timezone: tz, cameras: filter.cameras ?? null },
  ]);
  const extent = useMemo(() => {
    const days = Object.keys(reviewSummary ?? {})
      .filter((k) => k !== "last24Hours")
      .sort();
    const recDays = Object.keys(recordingsSummary ?? {}).sort();
    return {
      oldestReview: days.length ? dayKeyToStartInTz(days[0], tz) : undefined,
      oldestRecording: recDays.length
        ? dayKeyToStartInTz(recDays[0], tz)
        : undefined,
    };
  }, [reviewSummary, recordingsSummary, tz]);
  const floor = useMemo(() => {
    const candidates = [extent.oldestReview, extent.oldestRecording].filter(
      (v): v is number => v !== undefined,
    );
    return candidates.length
      ? Math.min(...candidates)
      : now - RETENTION_FALLBACK_DAYS * DAY;
  }, [extent, now]);
  const hasMore = oldest > floor;

  // ---- review pages ----------------------------------------------------------------
  const reviewQueue = useRef(new FetchQueue(2)).current;
  const heavyQueue = useRef(new FetchQueue(1)).current;
  const [pages, setPages] = useState<Map<number, ReviewPage>>(new Map());
  const [overrides, setOverrides] = useState<Map<string, ReviewSegment>>(
    new Map(),
  );
  // A deleted review is gone from the server, so nothing a page refetch returns will bring
  // it back — but the pages already in memory still hold it, hence the tombstone set.
  // It must be replaced, never mutated: `reviews` is a useMemo keyed on this identity, so
  // an in-place `.add()` leaves ghost cards on screen until something else re-renders.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const pageHours = useRef(REVIEW_PAGE_HOURS_FAST);

  // filter change discards everything (§14.4)
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return;
    lastFilterKey.current = filterKey;
    reviewQueue.cancelAll();
    heavyQueue.cancelAll();
    setPages(new Map());
    setOverrides(new Map());
    setOldest(floorHourInTz(Math.floor(Date.now() / 1000) - INITIAL_SPAN, tz));
  }, [filterKey, reviewQueue, heavyQueue, tz]);

  const fetchPage = useCallback(
    (after: number, before: number, force = false) =>
      reviewQueue
        .enqueue(
          `review:${filterKey}:${after}${force ? ":" + before : ""}`,
          async (signal) => {
            const t0 = performance.now();
            const res = await axios.get<ReviewSegment[]>("review", {
              params: {
                cameras: filter.cameras,
                labels: filter.labels,
                zones: filter.zones,
                reviewed: null,
                before,
                after,
              },
              signal,
            });
            if (performance.now() - t0 > SLOW_PAGE_MS) {
              pageHours.current = REVIEW_PAGE_HOURS_SLOW;
            }
            return res.data;
          },
        )
        .then((items) => {
          setPages((prev) => {
            const next = new Map(prev);
            next.set(after, { after, before, status: "done", items });
            return next;
          });
        })
        .catch((e) => {
          if (isAbort(e)) {
            // never leave an aborted page stuck "loading" — it would count against the
            // in-flight cap forever and freeze extension. Drop it; the grid effect
            // re-requests it if it is still wanted.
            setPages((prev) => {
              if (prev.get(after)?.status !== "loading") return prev;
              const next = new Map(prev);
              next.delete(after);
              return next;
            });
            return;
          }
          setPages((prev) => {
            const next = new Map(prev);
            next.set(after, { after, before, status: "error", items: [] });
            return next;
          });
        }),
    [reviewQueue, filterKey, filter.cameras, filter.labels, filter.zones],
  );

  // keep every page between oldest and newest requested
  useEffect(() => {
    const wanted = pagesFor(oldest, newest, pageHours.current, tz);
    const pending: Promise<void>[] = [];
    setPages((prev) => {
      let next: Map<number, ReviewPage> | undefined;
      for (const p of wanted) {
        const have = prev.get(p.after);
        if (!have) {
          next ??= new Map(prev);
          next.set(p.after, {
            after: p.after,
            before: p.before,
            status: "loading",
            items: [],
          });
          pending.push(fetchPage(p.after, p.before));
        }
      }
      return next ?? prev;
    });
  }, [oldest, newest, tz, fetchPage]);

  // tail: re-fetch the page containing `now` on every tick (cheap; also catches
  // has_been_reviewed changes the WebSocket does not carry)
  useEffect(() => {
    const [head] = pagesFor(now, now + 1, pageHours.current, tz);
    if (head) fetchPage(head.after, head.before, true);
  }, [now, tz, fetchPage]);

  const loadingCount = useMemo(
    () => [...pages.values()].filter((p) => p.status === "loading").length,
    [pages],
  );
  const isLoadingOlder = loadingCount > 0;
  // Bounded lookahead, NOT a hard "any page loading" freeze (which let one slow/stuck
  // page halt the whole window — the ~31-day plateau). `/review` pages are cheap and the
  // reviewQueue already caps real concurrency at 2 (F12 is about the motion endpoint,
  // separately gated); this only stops `oldest` running more than MAX_INFLIGHT_PAGES
  // ahead of what has started loading, so extension stays smooth and self-limiting.
  const MAX_INFLIGHT_PAGES = 4;
  const loadingCountRef = useRef(0);
  loadingCountRef.current = loadingCount;

  const loadOlder = useCallback(() => {
    if (loadingCountRef.current >= MAX_INFLIGHT_PAGES) return;
    setOldest((prev) => {
      if (prev <= floor) return prev;
      return Math.max(
        floor,
        floorHourInTz(prev - pageHours.current * HOUR, tz),
      );
    });
  }, [floor, tz]);

  const ensureLoaded = useCallback(
    async (t: number) => {
      const target = Math.max(floor, floorHourInTz(t - HOUR, tz));
      setOldest((prev) => Math.min(prev, target));
      // wait for the page containing t to land
      const [page] = pagesFor(t, t + 1, pageHours.current, tz);
      if (!page) return;
      for (let i = 0; i < 200; i++) {
        const p = pagesRef.current.get(page.after);
        if (p && p.status !== "loading" && p.status !== "queued") return;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    [floor, tz],
  );
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // §9.3: the chip only means anything while the user is NOT at the newest edge. The
  // active surface reports its stickiness; sitting at the top clears the counter, which is
  // what makes "N new" mean "arrived while you were reading history".
  const [atTop, setAtTop] = useState(true);
  const reportAtTop = useCallback((v: boolean) => {
    setAtTop((prev) => (prev === v ? prev : v));
  }, []);

  // ---- WebSocket merge (§9.4, Phase 7) ---------------------------------------------
  // `useFrigateReviews` carries all four types and the WS item ALWAYS wins over page data:
  //   new    → a segment that no page has yet; it enters via `overrides` (mergeReviews
  //            treats an unknown override id as an insert), which is what makes the live
  //            tail work without refetching a page.
  //   update → `end_time` and GenAI metadata arrive this way.
  //   end    → the segment closed; its blip gains a length.
  //   genai  → summary text landed.
  // All four are the same operation — replace by id — so there is no per-type branch here,
  // only the counter, which is "new" only.
  const wsReview = useFrigateReviews();
  const [pendingNew, setPendingNew] = useState(0);
  const seenNew = useRef(new Set<string>());
  useEffect(() => {
    if (!wsReview || !wsReview.after) return;
    const item = wsReview.after;
    if (item.start_time < oldest) return;
    // A deleted review can still receive an `end`/`genai` message in flight. Re-inserting
    // it would resurrect a card the user just removed, so the tombstone wins.
    if (removed.has(item.id)) return;
    setOverrides((prev) => {
      const existing = prev.get(item.id);
      if (existing && existing === item) return prev;
      const next = new Map(prev);
      next.set(item.id, item);
      return next;
    });
    // count each id once: `new` can be redelivered, and an `update` for something we
    // already counted must not bump it again
    if (wsReview.type === "new" && !seenNew.current.has(item.id)) {
      seenNew.current.add(item.id);
      setPendingNew((n) => n + 1);
    }
  }, [wsReview, oldest, removed]);

  // Sitting at the newest edge means there is nothing "new" to announce (§9.3).
  useEffect(() => {
    if (!atTop) return;
    seenNew.current.clear();
    setPendingNew((n) => (n === 0 ? n : 0));
  }, [atTop, pendingNew]);

  const patchReviews = useCallback(
    (ids: string[], patch: Partial<ReviewSegment>) => {
      setOverrides((prev) => {
        const next = new Map(prev);
        const current = mergeReviews(pagesRef.current.values(), prev, removed);
        for (const id of ids) {
          const r = current.find((x) => x.id === id);
          if (r) next.set(id, { ...r, ...patch });
        }
        return next;
      });
    },
    [removed],
  );

  const removeReviews = useCallback((ids: string[]) => {
    setRemoved((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setOverrides((prev) => {
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const reviews = useMemo(
    () => mergeReviews(pages.values(), overrides, removed),
    [pages, overrides, removed],
  );
  const reviewsByCamera = useMemo(() => groupByCamera(reviews), [reviews]);

  // ---- playback chunks (F1, §9.5) --------------------------------------------------
  // A SLIDING window around the playhead, not the whole retained range — see
  // usePlaybackChunks for why the identity has to stay stable between re-anchors.
  const [playhead, setPlayhead] = useState<number>();
  const reportPlayhead = useCallback((t: number) => {
    if (!Number.isFinite(t)) return;
    setPlayhead((prev) => (prev === t ? prev : t));
  }, []);
  const recordingFloor = useMemo(
    () => extent.oldestRecording ?? now - RETENTION_FALLBACK_DAYS * DAY,
    [extent.oldestRecording, now],
  );
  const playback = usePlaybackChunks({ playhead, now, floor: recordingFloor });
  const chunks = playback.chunks;

  // ---- navigation registry (§2A.3 / D11) -----------------------------------------
  const surfaces = useRef(new Map<SurfaceName, SurfaceApi>());
  const activeSurface = useRef<SurfaceName>("timeline");
  const pendingNav = useRef<{ t: number; opts?: NavigateOptions }>();
  const [selectedId, setSelectedId] = useState<string>();

  const registerSurface = useCallback((name: SurfaceName, api: SurfaceApi) => {
    surfaces.current.set(name, api);
    activeSurface.current = name;
    const nav = pendingNav.current;
    if (nav && (!nav.opts?.surface || nav.opts.surface === name)) {
      pendingNav.current = undefined;
      api.scrollToTime(nav.t, nav.opts?.selectId);
    }
    return () => {
      surfaces.current.delete(name);
    };
  }, []);

  // Every mounted surface, not just the "active" one: the Review page has a grid AND a
  // strip on screen together, `activeSurface` is just whichever registered last, and "go to
  // now" means both of them. Sending it to one leaves the other pointing at history.
  const scrollToTop = useCallback(() => {
    for (const api of surfaces.current.values()) {
      if (api.scrollToTop) api.scrollToTop();
      else api.scrollToTime(newest);
    }
  }, [newest]);

  const navigateToTime = useCallback(
    async (t: number, opts?: NavigateOptions) => {
      await ensureLoaded(t);
      if (opts?.selectId) setSelectedId(opts.selectId);
      const name = opts?.surface ?? activeSurface.current;
      const api = surfaces.current.get(name);
      if (api) api.scrollToTime(t, opts?.selectId);
      else pendingNav.current = { t, opts };
    },
    [ensureLoaded],
  );

  // console escape hatch for bring-up: frigateContinuous(false)
  useEffect(() => {
    (
      window as unknown as { frigateContinuous: (v: boolean) => void }
    ).frigateContinuous = (v: boolean) => setEnabled(v);
  }, [setEnabled]);

  const value = useMemo<ContinuousContextValue>(
    () => ({
      enabled,
      tz,
      now,
      window: { newest, oldest },
      hasMore,
      isLoadingOlder,
      loadOlder,
      ensureLoaded,
      reviews,
      reviewsByCamera,
      patchReviews,
      removeReviews,
      chunks,
      playhead,
      reportPlayhead,
      reportAtTop,
      scrollToTop,
      registerSurface,
      navigateToTime,
      selectedId,
      setSelectedId,
      pendingNew,
      clearPendingNew: () => setPendingNew(0),
      extent,
      heavyQueue,
    }),
    [
      enabled,
      tz,
      now,
      newest,
      oldest,
      hasMore,
      isLoadingOlder,
      loadOlder,
      ensureLoaded,
      reviews,
      reviewsByCamera,
      patchReviews,
      removeReviews,
      chunks,
      playhead,
      reportPlayhead,
      reportAtTop,
      scrollToTop,
      registerSurface,
      navigateToTime,
      selectedId,
      pendingNew,
      extent,
      heavyQueue,
    ],
  );

  // The toggle is read from IndexedDB asynchronously. RecordingView initialises
  // `selectedRangeIdx` from whichever chunk list it sees at MOUNT, so children must not
  // mount until we know which list that is — otherwise an index into upstream's 24-chunk
  // list is later applied to the fork's retention-wide list (observed: the player opened
  // a chunk from a year earlier). Also stops upstream's Timeline firing its heavy calls.
  if (!toggleLoaded) return null;
  return (
    <ContinuousContext.Provider value={value}>
      {children}
    </ContinuousContext.Provider>
  );
}

/** Safe outside the provider: returns `enabled: false` so upstream paths run unchanged. */
export function useContinuous(): ContinuousContextValue | { enabled: false } {
  return useContext(ContinuousContext) ?? { enabled: false };
}

export function useContinuousStrict(): ContinuousContextValue {
  const ctx = useContext(ContinuousContext);
  if (!ctx) throw new Error("useContinuousStrict outside ContinuousProvider");
  return ctx;
}
