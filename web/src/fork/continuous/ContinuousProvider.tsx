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
import { useDedupeMirrors } from "./useDedupeMirrors";
import { FetchQueue, isAbort } from "./fetchQueue";
import {
  ReviewPage,
  mergeReviews,
  groupByCamera,
  retirePatches,
} from "./store";
import { matchesFilter } from "./filterMatch";
import { planNavigation, windowSettled } from "./navigation";
import { usePlaybackChunks } from "./usePlaybackChunks";
import {
  DAY,
  EDGE_ALIGN,
  HOUR,
  alignUp,
  dayKeyToStartInTz,
  floorHourInTz,
  pagesFor,
  startOfDayInTz,
} from "./timeAlign";

export type SurfaceName =
  | "timeline"
  | "events"
  | "detail"
  | "grid"
  | "strip"
  | "motion";

/**
 * WHY a navigation is happening, because D14 makes the answer differ per surface.
 *
 *  - `moment` — a deep link, or a click on a specific review: put THAT instant in view.
 *  - `day` — a calendar pick: sparse surfaces (S1/S5/S6) land on the day's EARLIEST item,
 *    dense strips (S2/S3/S4) put 00:00 box time at the TOP of the viewport so the user
 *    scrolls up through the day.
 *
 * Collapsing the two — which is what a bare `scrollToTime(t)` did — means a deep link to a
 * 03:14 alert scrolls the strip to that day's midnight instead of to the alert.
 */
export type NavIntent = "moment" | "day";

export type ScrollToTimeOptions = {
  /** Select this item if the surface can find it; otherwise fall back to the time. */
  selectId?: string;
  intent?: NavIntent;
};

export type SurfaceApi = {
  /** Scroll so `t` is in view, per `opts.intent` (D14). */
  scrollToTime: (t: number, opts?: ScrollToTimeOptions) => void;
  /** Jump to the newest edge. Used by the "N new" chip (§9.3, D17). */
  scrollToTop?: () => void;
};

export type NavigateOptions = {
  surface?: SurfaceName;
  selectId?: string;
  intent?: NavIntent;
  /**
   * D15: in History a day-jump also seeks the player; on the Review page there is no
   * player, so it scrolls only. That falls out of WHO REGISTERED A SEEKER rather than out
   * of a flag — `RecordingView` registers one, `EventView` does not — so the default is
   * "seek if anything can". Pass `false` for a navigation that must never move playback.
   */
  seek?: boolean;
};

/** A navigation asked for from outside the provider (the `?id=`/`?t=` deep link, §2A.3). */
export type DeepLinkNav = {
  t: number;
  selectId?: string;
  surface?: SurfaceName;
};

export type ContinuousFilter = {
  cameras?: string;
  labels?: string;
  zones?: string;
};

export type ContinuousContextValue = {
  enabled: boolean;
  /**
   * F19: collapse mirrored reviews on S1 (one row per EVENT, not per camera).
   *
   * It lives on the CONTEXT rather than in each component, because `useUserPersistence` is
   * per-hook-instance state over IndexedDB — two components calling it do not see each
   * other's writes. Measured: the header toggle flipped its own label and the grid went on
   * de-duplicating regardless, so the control looked broken while the data was untouched.
   */
  dedupeMirrors: boolean;
  setDedupeMirrors: (v: boolean) => void;
  tz: string;
  /** Tail tick: epoch seconds, advanced every TAIL_TICK_MS while visible. */
  now: number;
  window: { newest: number; oldest: number };
  hasMore: boolean;
  isLoadingOlder: boolean;
  loadOlder: () => void;
  /** Count of review pages that have RESOLVED — see `useItemWindow`'s `windowKey`. */
  pagesLoaded: number;
  /**
   * Identity of the active server-side filter (cameras/labels/zones). It changes exactly
   * when the provider discards every loaded page (§14.4), which surfaces need to know
   * because some of their own state is only valid for one filter — see `useItemWindow`'s
   * `resetKey`.
   */
  filterKey: string;
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
  /**
   * Tell the provider whether the active surface is pinned to the newest edge (§9.3).
   * Call it as often as the answer changes; it is a no-op when the value is unchanged.
   * RETIRING the surface is a separate call — `forgetSurface` — made only on unmount.
   */
  reportAtTop: (surface: SurfaceName, atTop: boolean) => void;
  /**
   * Drop a surface's entry entirely, for when it unmounts (§9.3).
   *
   * Not the same as reporting `true`: an unmounted surface has no opinion about the
   * newest edge, and leaving a stale `false` behind latches `allAtTop` off forever.
   */
  forgetSurface: (surface: SurfaceName) => void;
  /** Jump the active surface to the newest edge. */
  scrollToTop: () => void;
  registerSurface: (name: SurfaceName, api: SurfaceApi) => () => void;
  /**
   * D15: how the player is moved when a navigation asks for it. Registered by
   * `RecordingView` only — the Review page has no player, so nothing registers there and
   * `navigateToTime` scrolls without seeking, which is exactly what D15 asks for.
   */
  registerSeek: (fn: (t: number) => void) => () => void;
  navigateToTime: (t: number, opts?: NavigateOptions) => Promise<void>;
  /**
   * The day (00:00 in `tz`) the active surface is looking at, or undefined while it is on
   * today — D1's calendar-as-navigator: the calendar FOLLOWS the surface instead of
   * filtering it. Fed by `reportViewTime`.
   */
  calendarDay?: number;
  /** Tell the provider which moment the active surface is showing (calendar follow). */
  reportViewTime: (t: number) => void;
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

/**
 * A SECOND, narrow context for the calendar seam (D1).
 *
 * `ReviewFilterGroup` and `MobileReviewSettingsDrawer` are upstream components that need
 * exactly three things — is the toggle on, which day is in view, and how to navigate — and
 * subscribing them to the whole context would re-render both on every provider state change,
 * which includes the playhead at four times a second. They are mounted on both pages, so
 * that is a real cost paid for a button label. Everything here is either stable for the
 * provider's life (`navigateToTime`, `scrollToTop`, `tz`) or changes at most once a day
 * (`calendarDay`).
 */
export type ContinuousNavValue = {
  enabled: boolean;
  tz: string;
  calendarDay?: number;
  navigateToTime: (t: number, opts?: NavigateOptions) => Promise<void>;
  scrollToTop: () => void;
};

const ContinuousNavContext = createContext<ContinuousNavValue | undefined>(
  undefined,
);

/** Safe outside the provider: `enabled: false` means "run upstream's path unchanged". */
export function useContinuousNav(): ContinuousNavValue | { enabled: false } {
  return useContext(ContinuousNavContext) ?? { enabled: false };
}

export const TAIL_TICK_MS = 30_000;
const INITIAL_SPAN = DAY;
/** §10: `/review` is cheap; page it generously, drop to 1 day when the first page is slow. */
const REVIEW_PAGE_HOURS_FAST = 72;
const REVIEW_PAGE_HOURS_SLOW = 24;
const SLOW_PAGE_MS = 1500;
const RETENTION_FALLBACK_DAYS = 366;
/**
 * How long a navigation may wait for the page carrying its target item before it gives up
 * and scrolls to the TIME instead. Deliberately generous: `ensureLoaded` has already waited
 * for the page containing `t`, so this only covers the commit that renders it plus the case
 * where the item never arrives at all (deleted, or excluded by the active filter — D19).
 */
const NAV_SETTLE_MS = 8_000;
const NAV_RETRY_MS = 250;
/** Trailing debounce for the calendar's follow-the-surface day (see `reportViewTime`). */
const CALENDAR_FOLLOW_MS = 400;
/**
 * How often `ensureLoaded` re-asks whether the span is covered. It does NOT get a budget of
 * its own: it shares the navigation's single `NAV_SETTLE_MS` deadline, so paging and the
 * settle cannot add up to twice the number written in the code.
 */
const ENSURE_LOADED_POLL_MS = 50;
/**
 * How long an unnamed (broadcast) navigation is replayed into surfaces that mount after it.
 * One page's surfaces mount within a commit or two of each other; a second is generous and
 * still far short of anything a user would experience as the view moving on its own.
 */
const BROADCAST_REPLAY_MS = 1_000;

type Props = {
  filter: ContinuousFilter;
  /** A deep link to run once (§2A.3 / D11) — see the effect that consumes it. */
  initialNav?: DeepLinkNav;
  children: ReactNode;
};

export function ContinuousProvider({ filter, initialNav, children }: Props) {
  const [enabled, setEnabled, toggleLoaded] = useContinuousEnabled();
  const [dedupeMirrors, setDedupeMirrors] = useDedupeMirrors();
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
    // planning starts over with the window (§14.4), or a navigation would believe the new,
    // empty map had already been planned down to the old edge
    plannedOldest.current = Math.floor(Date.now() / 1000);
    setOverrides(new Map());
    setPatches(new Map());
    // The chip counts items for the OLD filter. Left standing it announces arrivals that
    // the new filter may exclude, and `seenNew` would suppress a genuine re-announcement
    // of the same id once it matches again.
    seenNew.current.clear();
    setPendingNew(0);
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
          // A patch is a local truth the server has not echoed yet, so it must be RETIRED
          // once the server agrees — otherwise it masks that field for the rest of the
          // session (see `retirePatches`).
          setPatches((prev) => retirePatches(prev, items));
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

  /**
   * The oldest edge this effect has actually PLANNED — every page down to it is in the map.
   *
   * `ensureLoaded` needs it and cannot infer it: lowering `oldest` does not create pages, so
   * between "the window was widened" and "the pages exist" a hole looks identical to one
   * that has been requested and abandoned. Assigned inside the updater rather than in the
   * effect body, because the updater is the moment the pages enter the map — an assignment
   * in the body is true one commit too early, which is precisely the window the bug lived in.
   *
   * It starts at NOW, not at `oldest`: before the effect has run for the first time, nothing
   * has been planned at all — claiming the initial 24 h was already planned is the same
   * false-positive on the very first navigation, and it is the same reasoning as the
   * filter-change reset.
   */
  const plannedOldest = useRef(Math.floor(Date.now() / 1000));

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
      plannedOldest.current = Math.min(plannedOldest.current, oldest);
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
  /**
   * How many review pages have RESOLVED. Surfaces use it to re-arm their load-more check
   * (`useItemWindow`'s `windowKey`), because a page can land carrying nothing they display.
   *
   * It counts ARRIVALS, deliberately, and not `oldest`: keying the re-arm on the window
   * edge feeds `loadOlder`'s own output straight back into its trigger, and the window
   * chains as fast as the in-flight cap allows. Measured when it was tried that way — eight
   * pages requested at mount with nobody scrolling, `[24, 34.9, 106.9, 178.9, 250.9, 322.9,
   * 394.9]` — which is the same runaway the pixel-distance rule was written to stop.
   */
  const pagesLoaded = useMemo(
    () => [...pages.values()].filter((p) => p.status === "done").length,
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

  /**
   * §2A.3 step 1 — extend the window backwards until `t` is loaded, and wait for the whole
   * SPAN, not merely for the page that contains `t`.
   *
   * The distinction is the difference between a day-jump working and landing two days out.
   * Pages resolve out of order (the queue runs two at a time), and `mergeReviews` keeps the
   * list sorted, so a page that lands AFTER the scroll inserts its items in the MIDDLE and
   * pushes the target down by however many it carried. Measured on a jump 9.5 days back:
   * the deep page landed first, the grid resolved the right index (1792, the day's 06:03
   * alert) and scrolled to exactly its row — and then the two intermediate pages landed,
   * inserted ~1000 items above it, and left the viewport on a day two days newer. The
   * scroll was right; the list moved under it.
   *
   * "Loaded" is decided by RANGE COVERAGE (`pagesSettled`), never by page keys. Keys belong
   * to a lattice, and the lattice moves under this loop: `pageHours` flips 72 → 24 the first
   * time a page is slow, which a deep jump is exactly what causes. See `pagesSettled` for
   * both failure modes that produced — waiting for pages nobody will request, and waiting
   * for a key the abort path deleted.
   *
   * It shares ONE deadline with the navigation it belongs to, rather than spending its own
   * budget first: the user clicked a day, and paging that outlives the navigation is not a
   * safety net, it is a stall.
   */
  const newestRef = useRef(newest);
  newestRef.current = newest;
  const ensureLoaded = useCallback(
    async (t: number, deadline: number = Date.now() + NAV_SETTLE_MS) => {
      const target = Math.max(floor, floorHourInTz(t - HOUR, tz));
      setOldest((prev) => Math.min(prev, target));
      while (Date.now() < deadline) {
        if (
          windowSettled(
            plannedOldest.current,
            target,
            newestRef.current,
            pagesRef.current.values(),
          )
        ) {
          return;
        }
        await new Promise((r) => setTimeout(r, ENSURE_LOADED_POLL_MS));
      }
    },
    [floor, tz],
  );
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // §9.3: the chip only means anything while the user is NOT at the newest edge.
  //
  // PER SURFACE, not one boolean. Three surfaces report — the grid, the review strip and
  // the motion strip — and with a single last-writer-wins flag the strip sitting at the top
  // cleared the counter while the GRID was deep in history, so arrivals went unannounced
  // and a redelivered `new` could be counted twice. An item is announced unless the surface
  // that would show it is already at the newest edge.
  const [atTopBySurface, setAtTopBySurface] = useState<
    Partial<Record<SurfaceName, boolean>>
  >({});
  // The entry must also be REMOVED when the surface unmounts, which is what `forgetSurface`
  // is for. The Review tabs are mutually exclusive mounts under one provider, so an ordinary
  // tab switch retires a surface: leaving its last `false` behind held `allAtTop` off for
  // the rest of the session, and the chip then appeared on every arrival while the user sat
  // pinned at now, with nothing able to clear it.
  //
  // It is deliberately NOT a disposer returned from `reportAtTop`: reporting happens on
  // every scroll-state flip, retiring happens once, and tying them together made every flip
  // a forget + re-report — two provider state updates for nothing.
  const forgetSurface = useCallback((surface: SurfaceName) => {
    setAtTopBySurface((prev) => {
      if (!(surface in prev)) return prev;
      const next = { ...prev };
      delete next[surface];
      return next;
    });
  }, []);
  const reportAtTop = useCallback((surface: SurfaceName, v: boolean) => {
    setAtTopBySurface((prev) =>
      prev[surface] === v ? prev : { ...prev, [surface]: v },
    );
  }, []);
  /** True when every mounted surface is pinned to now — nothing to announce anywhere. */
  const allAtTop = useMemo(() => {
    const values = Object.values(atTopBySurface);
    return values.length > 0 && values.every(Boolean);
  }, [atTopBySurface]);

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
    // The socket is a firehose of EVERY review on the box; the pages are filtered
    // server-side and this is not. Without the check, a filtered view rendered items it had
    // excluded, counted them in the chip, and could never drop them again — no refetch
    // returns an item the server filtered out, and an override beats page data (§14.4).
    if (!matchesFilter(item, filter)) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsReview, oldest, removed, filterKey]);

  // Everything on screen is pinned to now — there is nothing to announce (§9.3).
  useEffect(() => {
    if (!allAtTop) return;
    seenNew.current.clear();
    setPendingNew((n) => (n === 0 ? n : 0));
  }, [allAtTop, pendingNew]);

  /**
   * A local change the server has not echoed back yet — today only `has_been_reviewed`.
   *
   * It is kept in its OWN layer rather than folded into `overrides`, because a WS
   * `update`/`end`/`genai` replaces the whole segment and does not carry
   * `has_been_reviewed`: folding it in meant the next message for that id silently
   * un-reviewed a card the user had just marked, and it reappeared in the grid.
   * `mergeReviews` applies patches last, so the local truth survives until a page refetch
   * agrees with it — at which point `fetchPage` retires the patch, so the server is the
   * source of truth again and a change made elsewhere is not masked for the session.
   */
  const [patches, setPatches] = useState<Map<string, Partial<ReviewSegment>>>(
    () => new Map(),
  );
  const patchReviews = useCallback(
    (ids: string[], patch: Partial<ReviewSegment>) => {
      setPatches((prev) => {
        const next = new Map(prev);
        for (const id of ids)
          next.set(id, { ...(next.get(id) ?? {}), ...patch });
        return next;
      });
    },
    [],
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
    setPatches((prev) => {
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Map(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const reviews = useMemo(
    () => mergeReviews(pages.values(), overrides, removed, patches),
    [pages, overrides, removed, patches],
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
  /** The last unnamed (broadcast) navigation, replayed to late-mounting surfaces — see below. */
  const lastBroadcast = useRef<{
    t: number;
    opts?: NavigateOptions;
    until: number;
  }>();
  const [selectedId, setSelectedId] = useState<string>();
  const seekRef = useRef<(t: number) => void>();

  const scrollOptsFor = (opts?: NavigateOptions): ScrollToTimeOptions => ({
    selectId: opts?.selectId,
    intent: opts?.intent ?? "moment",
  });

  const navSeq = useRef(0);
  const [navRequest, setNavRequest] = useState<{
    seq: number;
    t: number;
    opts?: NavigateOptions;
    deadline: number;
  }>();
  const issueNav = useCallback(
    (t: number, opts?: NavigateOptions, deadline?: number) => {
      navSeq.current += 1;
      setNavRequest({
        seq: navSeq.current,
        t,
        opts,
        deadline: deadline ?? Date.now() + NAV_SETTLE_MS,
      });
    },
    [],
  );

  const registerSurface = useCallback(
    (name: SurfaceName, api: SurfaceApi) => {
      surfaces.current.set(name, api);
      activeSurface.current = name;
      const nav = pendingNav.current;
      if (nav && (!nav.opts?.surface || nav.opts.surface === name)) {
        pendingNav.current = undefined;
        if (nav.opts?.surface) {
          api.scrollToTime(nav.t, scrollOptsFor(nav.opts));
        } else {
          // An UNNAMED navigation is meant for every mounted surface (a Review-page deep
          // link: the grid and the strip are on screen together). Replaying it into the one
          // surface that happened to register first would leave the other on another day, so
          // it is re-issued and the effect below fans it out after this commit, by which
          // time the page's other surfaces have registered too.
          issueNav(nav.t, nav.opts);
        }
      } else {
        // A surface that mounts a beat AFTER an unnamed fan-out — the Review strip lands one
        // commit behind the grid on a cold load — would otherwise be the one left showing a
        // different day. The fan-out is remembered briefly and replayed into whoever turns
        // up during that window. Bounded in time rather than by a surface census, because
        // the provider does not know which surfaces a page intends to mount.
        const recent = lastBroadcast.current;
        if (recent && Date.now() < recent.until) {
          api.scrollToTime(recent.t, scrollOptsFor(recent.opts));
        }
      }
      return () => {
        surfaces.current.delete(name);
      };
    },
    [issueNav],
  );

  const registerSeek = useCallback((fn: (t: number) => void) => {
    seekRef.current = fn;
    return () => {
      if (seekRef.current === fn) seekRef.current = undefined;
    };
  }, []);

  // Calendar follow (D1): the day the user is LOOKING at, not a filter. Kept at day
  // granularity deliberately — surfaces report on every scroll frame and on every playhead
  // tick, and provider state that changed at that rate would re-render every surface four
  // times a second for a label.
  const [calendarDay, setCalendarDay] = useState<number>();
  const calendarTimer = useRef<ReturnType<typeof setTimeout>>();
  const reportViewTime = useCallback(
    (t: number) => {
      if (!Number.isFinite(t) || t <= 0) return;
      const day = startOfDayInTz(t, tz);
      const today = startOfDayInTz(Date.now() / 1000, tz);
      // On today the calendar reads "Last 24 hours", as it does upstream at rest.
      const next = day >= today ? undefined : day;
      // TRAILING, not immediate. Day granularity alone is not enough: a scroll to the review
      // floor crosses ~31 day boundaries, and a provider state change re-renders every
      // mounted surface, so the unthrottled version put ~31 extra reflows into exactly the
      // scroll during which the other gates are trying to click a card. A calendar label is
      // never worth a reflow mid-gesture.
      clearTimeout(calendarTimer.current);
      calendarTimer.current = setTimeout(
        () => setCalendarDay((prev) => (prev === next ? prev : next)),
        CALENDAR_FOLLOW_MS,
      );
    },
    [tz],
  );
  useEffect(() => () => clearTimeout(calendarTimer.current), []);

  // Every mounted surface, not just the "active" one: the Review page has a grid AND a
  // strip on screen together, `activeSurface` is just whichever registered last, and "go to
  // now" means both of them. Sending it to one leaves the other pointing at history.
  // `newest` from a REF, so this callback is stable for the provider's life. It ticks with
  // the tail (≤60 s), and with it in the deps the narrow calendar context re-identified once
  // a minute — which is exactly the churn that context exists to keep away from two upstream
  // components.
  const scrollToTop = useCallback(() => {
    for (const api of surfaces.current.values()) {
      if (api.scrollToTop) api.scrollToTop();
      else api.scrollToTime(newestRef.current);
    }
  }, []);

  /**
   * §2A.3 / D11 — THE navigation primitive. The calendar day-jump, a strip segment click and
   * the alert deep-link are all callers of this one function; built separately they diverge,
   * which is the failure §2A.3 was written to prevent.
   *
   *   1. extend the window backwards until `t` is loaded   (`ensureLoaded`, §10 paging)
   *   2. hand the request to the surface, AFTER the commit that carries the new page
   *   3. select `selectId` so the item is visibly highlighted
   *   4. seek the player, if one registered (D15 — History yes, Review page no)
   *
   * Step 2 is why this is a state transition and not a straight call. `ensureLoaded`
   * resolves when the PAGE has landed in provider state; the surface that has to scroll is
   * a child that has not re-rendered yet, and the `scrollToTime` closure sitting in the
   * registry still sees the old `items` array. Calling it there scrolls to a stale index —
   * for a deep link, reliably the wrong card. The request is parked instead and performed by
   * an effect, which by definition runs after the commit that carries the page.
   */
  const navigateToTime = useCallback(
    async (t: number, opts?: NavigateOptions) => {
      if (!Number.isFinite(t)) return;
      if (opts?.selectId) setSelectedId(opts.selectId);
      // ONE deadline for the whole navigation, shared with paging. Sequential budgets
      // (paging, and only then the settle) add up to a navigation that can take twice as
      // long as either number in the code suggests.
      const deadline = Date.now() + NAV_SETTLE_MS;
      await ensureLoaded(t, deadline);
      issueNav(t, opts, deadline);
    },
    [ensureLoaded, issueNav],
  );

  useEffect(() => {
    const req = navRequest;
    if (!req) return;
    // A named surface goes to that surface; an UNNAMED one goes to every mounted surface,
    // for the same reason `scrollToTop` does — the Review page has a grid AND a strip on
    // screen at once, and a calendar day-jump that moved only whichever registered last
    // would leave the other pointing at a different day. A deep link and a strip click both
    // name their target, so they are unaffected.
    const named = req.opts?.surface;
    const targets = named
      ? [surfaces.current.get(named)].filter((a): a is SurfaceApi => !!a)
      : [...surfaces.current.values()];
    // `reviews` is in the deps, so a page ARRIVAL re-runs this; the timer below covers the
    // case where no further page arrives and the request must still be honoured against the
    // time rather than dropped in silence. See `planNavigation`.
    const step = planNavigation({
      hasSurface: targets.length > 0,
      selectId: req.opts?.selectId,
      itemLoaded: reviews.some((r) => r.id === req.opts?.selectId),
      now: Date.now(),
      deadline: req.deadline,
    });
    // A NAMED navigation supersedes any parked broadcast, from the moment it is ISSUED —
    // not when it eventually lands. Clearing it only on the `go` path left a deferred or
    // waiting named nav (a deep link whose surface has not mounted, or one still waiting for
    // its item) with the older page-wide jump replayable underneath it, which is the exact
    // ordering in which a `?surface=history` link arrives.
    if (named) lastBroadcast.current = undefined;
    if (step === "defer") {
      // The surface has not mounted yet — a `?surface=history` deep link navigates before
      // `RecordingView` exists. `registerSurface` replays it on mount.
      pendingNav.current = { t: req.t, opts: req.opts };
      setNavRequest(undefined);
      return;
    }
    if (step === "wait") {
      const timer = setTimeout(
        () =>
          setNavRequest((cur) =>
            cur && cur.seq === req.seq ? { ...cur } : cur,
          ),
        NAV_RETRY_MS,
      );
      return () => clearTimeout(timer);
    }
    if (!named) {
      lastBroadcast.current = {
        t: req.t,
        opts: req.opts,
        until: Date.now() + BROADCAST_REPLAY_MS,
      };
    }
    for (const api of targets) api.scrollToTime(req.t, scrollOptsFor(req.opts));
    // D15: History registered a seeker, the Review page did not — see `registerSeek`.
    if (req.opts?.seek !== false) seekRef.current?.(req.t);
    setNavRequest(undefined);
  }, [navRequest, reviews]);

  /**
   * The deep link (§2A.3). It arrives as a prop because `pages/Events.tsx` — which owns the
   * search params — sits ABOVE this provider, and because the provider is remounted when
   * the page switches between the Review grid and the History scrubber. Running it from an
   * effect keyed on the object's identity means the navigation survives that remount and
   * happens exactly once per link.
   */
  const lastInitialNav = useRef<DeepLinkNav>();
  useEffect(() => {
    if (!initialNav || lastInitialNav.current === initialNav) return;
    lastInitialNav.current = initialNav;
    navigateToTime(initialNav.t, {
      surface: initialNav.surface,
      selectId: initialNav.selectId,
      intent: "moment",
      // The deep link opens the player at the moment itself (`setRecording` already did
      // that); seeking again from here would fight the mount.
      seek: false,
    });
  }, [initialNav, navigateToTime]);

  // console escape hatch for bring-up: frigateContinuous(false)
  useEffect(() => {
    (
      window as unknown as { frigateContinuous: (v: boolean) => void }
    ).frigateContinuous = (v: boolean) => setEnabled(v);
  }, [setEnabled]);

  const value = useMemo<ContinuousContextValue>(
    () => ({
      enabled,
      dedupeMirrors,
      setDedupeMirrors,
      tz,
      now,
      window: { newest, oldest },
      hasMore,
      isLoadingOlder,
      loadOlder,
      pagesLoaded,
      filterKey,
      ensureLoaded,
      reviews,
      reviewsByCamera,
      patchReviews,
      removeReviews,
      chunks,
      playhead,
      reportPlayhead,
      reportAtTop,
      forgetSurface,
      scrollToTop,
      registerSurface,
      registerSeek,
      navigateToTime,
      calendarDay,
      reportViewTime,
      selectedId,
      setSelectedId,
      pendingNew,
      clearPendingNew: () => setPendingNew(0),
      extent,
      heavyQueue,
    }),
    [
      enabled,
      dedupeMirrors,
      setDedupeMirrors,
      tz,
      now,
      newest,
      oldest,
      hasMore,
      isLoadingOlder,
      loadOlder,
      pagesLoaded,
      filterKey,
      ensureLoaded,
      reviews,
      reviewsByCamera,
      patchReviews,
      removeReviews,
      chunks,
      playhead,
      reportPlayhead,
      reportAtTop,
      forgetSurface,
      scrollToTop,
      registerSurface,
      registerSeek,
      navigateToTime,
      calendarDay,
      reportViewTime,
      selectedId,
      pendingNew,
      extent,
      heavyQueue,
    ],
  );

  // The narrow calendar context — see `ContinuousNavValue`. Deliberately NOT derived from
  // `value`: that object changes on every provider state update, which is the churn this
  // exists to keep away from two upstream components.
  const navValue = useMemo<ContinuousNavValue>(
    () => ({ enabled, tz, calendarDay, navigateToTime, scrollToTop }),
    [enabled, tz, calendarDay, navigateToTime, scrollToTop],
  );

  // The toggle is read from IndexedDB asynchronously. RecordingView initialises
  // `selectedRangeIdx` from whichever chunk list it sees at MOUNT, so children must not
  // mount until we know which list that is — otherwise an index into upstream's 24-chunk
  // list is later applied to the fork's retention-wide list (observed: the player opened
  // a chunk from a year earlier). Also stops upstream's Timeline firing its heavy calls.
  if (!toggleLoaded) return null;
  return (
    <ContinuousContext.Provider value={value}>
      <ContinuousNavContext.Provider value={navValue}>
        {children}
      </ContinuousNavContext.Provider>
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
