/**
 * fork/continuous — S1: the Review page's card grid as a virtualized, continuous surface
 * (handover §4A.1, Family B / kernel K2).
 *
 * Replaces the inline grid `<div>` inside `EventView`'s private `DetectionReview`. The
 * cell — upstream's `PreviewThumbnailPlayer` — is IMPORTED unchanged (§4A.3): the fork
 * owns containers, upstream owns cells.
 *
 * Why it must be virtualized rather than just fed a longer array: this cell holds a
 * `<video preload="auto">` for its hover preview. At 24 h that is ~150 of them; at the
 * review floor it is thousands, and the page dies. `useItemWindow` keeps the mounted set
 * bounded and compensates prepends at the head so the live tail never jumps the view
 * (§9.2/§9.3).
 *
 * **Minimap coupling (S1 ⇄ S2), and why the IntersectionObserver is gone.** Upstream
 * computes `minimapBounds` from an `IntersectionObserver` over the grid's DOM children.
 * Under virtualization those children mount and unmount as you scroll, so the observed
 * set churns and its callback ordering decides the bounds — stale entries survive an
 * unmount and the band jitters. The virtualizer already knows, exactly, which item
 * indices intersect the viewport, so we derive the bounds from geometry instead: same
 * `{start, end}` contract, same `visibleTimestamps` array, no observer. Do not "restore"
 * the observer — it is not equivalent once rows unmount.
 *
 * D14: a day-jump on a sparse surface lands on the day's EARLIEST review (the dense strips
 * land on 00:00 instead); an empty day falls back to the nearest item at or before the
 * day's end.
 * D9/F15/F17: a review whose camera, config entry or thumbnail has gone is an expected
 * state at depth — the cell degrades, it must never throw, so nothing here dereferences
 * `config.cameras[review.camera]`. It LOOKS it up (Phase 9) and swaps in
 * `DegradedReviewCell` when the answer is "not there"; a reaped thumbnail is caught by a
 * capture-phase `error` listener on the row, because `error` does not bubble and the cell
 * that owns the `<img>` is upstream's.
 * F19 (Phase 9): mirrored reviews are collapsed here, on S1 only — the strips draw bands,
 * and two rows with a byte-identical `start_time` occupy the same band either way.
 */
import {
  MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR from "swr";
import { cn } from "@/lib/utils";
import { Preview } from "@/types/preview";
import { ReviewSegment } from "@/types/review";
import { TimeRange } from "@/types/timeline";
import { FrigateConfig } from "@/types/frigateConfig";
import PreviewThumbnailPlayer from "@/components/player/PreviewThumbnailPlayer";
import { useContinuousStrict } from "./ContinuousProvider";
import { useItemWindow } from "./useItemWindow";
import { indexAtOrAfter } from "./dayNav";
import { dedupeMirrors, mirrorMapFromConfig } from "./mirrors";
import { DegradedReviewCell } from "./cells/DegradedReviewCell";

/**
 * How long a failed thumbnail stays "dead" before the cell re-probes it. A reaped file
 * fails again immediately; a transient 502 heals. Long enough not to hammer, short enough
 * that a card is not wrong for the session.
 */
const DEAD_THUMB_TTL_MS = 60_000;

/** Fallback until a row has been measured once (see `rowHeight` below). */
const CARD_ESTIMATE = 240;
const GAP = 16;

/**
 * Column count mirrors upstream's grid classes
 * (`grid-cols-1 sm:grid-cols-2 md:grid-cols-3 3xl:grid-cols-4`) against the SAME
 * viewport breakpoints Tailwind uses — 640 / 768 / 1920 (tailwind.config.cjs). If those
 * classes change, change this with them or the lanes and the CSS will disagree.
 */
function columnsForWidth(w: number): number {
  if (w >= 1920) return 4;
  if (w >= 768) return 3;
  if (w >= 640) return 2;
  return 1;
}

export type VisibleReviewRange = {
  bounds: { start: number; end: number };
  timestamps: number[];
};

export type ContinuousReviewGridProps = {
  contentRef: MutableRefObject<HTMLDivElement | null>;
  items: ReviewSegment[];
  /** The strip's current zoom pitch — only used to emit `data-segment-start` (see below). */
  segmentDuration: number;
  selectedReviews: ReviewSegment[];
  relevantPreviews?: Preview[];
  timeRange: TimeRange;
  scrollLock: boolean;
  markItemAsReviewed: (review: ReviewSegment) => void;
  onPreviewTimeUpdate: (time: number | undefined) => void;
  onSelectReview: (
    review: ReviewSegment,
    ctrl: boolean,
    detail: boolean,
  ) => void;
  onVisibleChange: (range: VisibleReviewRange) => void;
};

export function ContinuousReviewGrid({
  contentRef,
  items: rawItems,
  segmentDuration,
  selectedReviews,
  relevantPreviews,
  timeRange,
  scrollLock,
  markItemAsReviewed,
  onPreviewTimeUpdate,
  onSelectReview,
  onVisibleChange,
}: ContinuousReviewGridProps) {
  const ctx = useContinuousStrict();
  const { data: config } = useSWR<FrigateConfig>("config");

  // --- F15 / F17 / F19 depth guards (Phase 9) -----------------------------------------
  // The config is the ONLY thing that says whether a camera still exists. Read once here
  // and passed down as a predicate — nothing in the render path indexes into it, so an
  // absent camera is a value, never a throw.
  const knownCameras = useMemo(
    () => new Set(Object.keys(config?.cameras ?? {})),
    [config],
  );
  const configLoaded = config != undefined;
  const mirrors = useMemo(() => mirrorMapFromConfig(config), [config]);
  // from the CONTEXT: `useUserPersistence` does not share state between hook instances
  const dedupe = ctx.dedupeMirrors;
  const { items, suppressed } = useMemo(() => {
    if (!dedupe)
      return { items: rawItems, suppressed: new Map<string, string[]>() };
    return dedupeMirrors(rawItems, mirrors);
  }, [rawItems, dedupe, mirrors]);

  /**
   * M2: marking or deleting a visible card must take its SUPPRESSED TWIN with it.
   *
   * Dedup runs downstream of the filter, so hiding one row of a pair is only ever a display
   * choice — the backend still has both. Mark the visible `entrance_high` row and
   * `patchReviews` removes it from the list; the `entrance_tele` row it was suppressing then
   * has no visible source, un-suppresses, and pops back into the grid — as an item the user
   * has just marked, still unreviewed, and which the server was never told about. From the
   * reader's side the card refuses to go away.
   *
   * So the twin rides along with every gesture the grid initiates: `markWithTwins` for the
   * single mark (hover / open), `selectWithTwins` for a ctrl-click, which is all the bulk
   * paths need — `r` and the selection toolbar both post `selectedReviews`.
   */
  /**
   * Ctrl-click selects the suppressed twin too.
   *
   * That is all the plumbing the BULK paths need: `r` and the selection toolbar both post
   * `selectedReviews`, so putting both rows in the selection makes them post both ids with
   * no change to the seam or to upstream. Only a real selection gesture does this — a plain
   * click opens a review and must not drag a second row into a selection.
   */
  const selectWithTwins = useCallback(
    (review: ReviewSegment, ctrl: boolean, detail: boolean) => {
      onSelectReview(review, ctrl, detail);
      if (!ctrl) return;
      for (const twinId of suppressed.get(review.id) ?? []) {
        const twin = rawItems.find((it: ReviewSegment) => it.id === twinId);
        if (twin) onSelectReview(twin, true, detail);
      }
    },
    [onSelectReview, suppressed, rawItems],
  );

  /** Mark a card AND whatever mirror row it is standing in for. */
  const markWithTwins = useCallback(
    (review: ReviewSegment) => {
      markItemAsReviewed(review);
      for (const twinId of suppressed.get(review.id) ?? []) {
        const twin = rawItems.find((it: ReviewSegment) => it.id === twinId);
        if (twin) markItemAsReviewed(twin);
      }
    },
    [markItemAsReviewed, suppressed, rawItems],
  );

  /**
   * Thumbnails that 404.
   *
   * `error` does not bubble and the `<img>` belongs to upstream's imported cell, so this is
   * a capture-phase listener on the grid container — one listener for every card, instead
   * of a prop upstream does not have.
   *
   * Two things it must NOT do, both learned the hard way:
   *  - fire for any `<img>` in the card. The cell renders more than the thumbnail, and a
   *    single failed request for something else would degrade a perfectly good review. The
   *    failing `src` is matched against the review's own `thumb_path` before it counts.
   *  - latch for the session. A tunnel 502 or a dropped connection is transient, and a
   *    permanent downgrade on one bad response is worse than a moment of broken image.
   *    Entries expire after DEAD_THUMB_TTL_MS so the cell re-probes; a genuinely reaped
   *    file simply fails again and re-degrades, which costs one request per card per
   *    minute at most.
   */
  const [deadThumbs, setDeadThumbs] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const gridRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const onError = (e: Event) => {
      const target = e.target as HTMLImageElement | null;
      if (!target || target.tagName !== "IMG") return;
      const card = target.closest("[data-continuous-id]");
      const id = card?.getAttribute("data-continuous-id");
      const thumb = card?.getAttribute("data-continuous-thumb");
      if (!id || !thumb) return;
      // the thumbnail, not merely an image inside the card
      const src = target.getAttribute("src") || "";
      if (!src.endsWith(thumb)) return;
      setDeadThumbs((prev) => {
        const next = new Map(prev);
        next.set(id, Date.now());
        return next;
      });
    };
    el.addEventListener("error", onError, true);
    return () => el.removeEventListener("error", onError, true);
  }, []);
  // expire entries so a transient failure heals itself
  useEffect(() => {
    if (!deadThumbs.size) return;
    const timer = window.setTimeout(() => {
      const cutoff = Date.now() - DEAD_THUMB_TTL_MS;
      setDeadThumbs((prev) => {
        const next = new Map([...prev].filter(([, at]) => at > cutoff));
        return next.size === prev.size ? prev : next;
      });
    }, DEAD_THUMB_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [deadThumbs]);

  const [columns, setColumns] = useState(() =>
    columnsForWidth(typeof window === "undefined" ? 1280 : window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setColumns(columnsForWidth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /**
   * Every card in this grid is the SAME height — an `aspect-video` box at the lane width —
   * so the grid can be fixed-pitch like K1 instead of measured like a real variable-height
   * list. That matters for §9.2: with `measureElement` the virtualizer applies a row's real
   * height in a LATER commit and adjusts the scroll offset itself, which fights the anchor
   * compensation in useItemWindow and left the view tens of pixels out on every burst of
   * arrivals. Measuring ONE row and pinning every row to that height removes the estimate
   * error entirely, so the compensation is exact.
   *
   * Measured rather than computed from the aspect ratio because the paddings and the
   * caption row are upstream's business, not ours to duplicate.
   */
  const [rowHeight, setRowHeight] = useState(CARD_ESTIMATE);
  const probeRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    // Observe the CONTAINER, not the probe row. `probeRef` is attached to whichever row is
    // currently first, so it moves as you scroll and an observer bound to it ends up
    // watching a detached node and never fires again. Row height only changes when the
    // container's width changes anyway, which is exactly what this sees.
    const measure = () => {
      const h = probeRef.current?.getBoundingClientRect().height ?? 0;
      if (h > 0) setRowHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [contentRef, columns, items.length]);

  /**
   * Virtualize by ROW, not by card, and do not use the virtualizer's `lanes`.
   *
   * `lanes` packs masonry-style — each item goes to the shortest lane — so inserting one
   * card at the head does not shift everything down by a predictable amount; items move
   * BETWEEN lanes and their offsets change at different commits. Measured: after three
   * arrivals the card at the top of the viewport had not moved at all while the card in the
   * middle had moved a full row, so no single scroll correction can hold the view still.
   * Grouping into fixed rows first makes the layout index-major and the shift exactly
   * `ceil((head + n) / columns) - ceil(head / columns)` rows — which the anchor
   * compensation in `useItemWindow` then cancels exactly.
   */
  const rows = useMemo(() => {
    const out: { id: string; cards: ReviewSegment[] }[] = [];
    for (let i = 0; i < items.length; i += columns) {
      const cards = items.slice(i, i + columns);
      out.push({ id: cards[0].id, cards });
    }
    return out;
  }, [items, columns]);

  // `ctx.loadOlder`, not `ctx`: the context object is a new identity on every provider
  // render, and this callback's identity is what re-arms the near-end effect.
  const ctxLoadOlder = ctx.loadOlder;
  const onNearEnd = useCallback(() => ctxLoadOlder(), [ctxLoadOlder]);
  const estimate = useCallback(() => rowHeight, [rowHeight]);
  const win = useItemWindow({
    scrollRef: contentRef as MutableRefObject<HTMLDivElement>,
    items: rows,
    estimateSize: estimate,
    gap: GAP,
    onNearEnd,
    // a page can land with no items this grid shows — see `windowKey`
    windowKey: ctx.pagesLoaded,
    // a filter change discards every page without remounting us — see `resetKey`
    resetKey: ctx.filterKey,
  });

  // --- S1 ⇄ S2 coupling: which items are actually on screen (see header) --------------
  const selectedIds = useMemo(
    () => new Set(selectedReviews.map((r) => r.id)),
    [selectedReviews],
  );
  const virtualItems = win.virtualItems;
  const reportViewTime = ctx.reportViewTime;
  const reportRef = useRef<string>("");
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    const timestamps: number[] = [];
    for (const v of virtualItems) {
      // overscanned rows are rendered but not visible — they must not widen the band
      if (v.start + v.size <= top || v.start >= bottom) continue;
      for (const card of rows[v.index]?.cards ?? [])
        timestamps.push(card.start_time);
    }
    if (!timestamps.length) return;
    const range: VisibleReviewRange = {
      bounds: {
        start: Math.min(...timestamps),
        end: Math.max(...timestamps),
      },
      timestamps,
    };
    const key = `${range.bounds.start}|${range.bounds.end}|${timestamps.length}`;
    if (key === reportRef.current) return;
    reportRef.current = key;
    onVisibleChange(range);
    // D1: the calendar FOLLOWS the surface instead of filtering it. The newest visible card
    // is the day the user would say they are looking at; the provider only keeps day
    // granularity, so this costs nothing at scroll rate.
    reportViewTime(range.bounds.end);
  }, [virtualItems, rows, contentRef, onVisibleChange, reportViewTime]);

  // §9.3: pinned to the newest edge? The chip is meaningless there and the provider clears
  // its counter. STICK_THRESHOLD is in useItemWindow; one card height is far too coarse.
  const reportAtTop = ctx.reportAtTop;
  const forgetSurface = ctx.forgetSurface;
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const onScroll = () => reportAtTop("grid", el.scrollTop < 24);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [contentRef, reportAtTop, items.length]);
  // Retiring the surface is a MOUNT-scoped concern and gets its own effect: folded into
  // the listener effect above it re-ran on every `items.length` change, and a forget +
  // re-report is two provider state updates per page arrival — pure render churn on the
  // one component that decides when to load more (see `useItemWindow`).
  useEffect(() => () => forgetSurface("grid"), [forgetSurface]);

  // --- navigation registry (§2A.3 / D14) ---------------------------------------------
  useEffect(
    () =>
      ctx.registerSurface("grid", {
        scrollToTop: () => {
          // `behavior: "smooth"` loses races here: clearing the chip re-renders the
          // provider and the grid mid-animation and Chrome abandons the scroll partway.
          // "Go to now" should be instant anyway.
          const el = contentRef.current;
          if (el) el.scrollTop = 0;
        },
        scrollToTime: (t, opts) => {
          // indices are ROWS now, so an item index has to be divided down to its row
          if (opts?.selectId) {
            const i = items.findIndex((it) => it.id === opts.selectId);
            if (i >= 0) {
              win.scrollToIndex(Math.floor(i / columns), { align: "start" });
              return;
            }
          }
          // see dayNav.ts: one scan serves both a strip-segment click (pass the moment)
          // and a calendar day-jump (pass 00:00 box time → D14's day's-earliest-review).
          // The intent needs no branch HERE — on a sparse surface "the first item at or
          // after 00:00" IS the day's earliest review — and an empty day lands on the
          // nearest item after it, which is the closest thing to a day with no cards.
          const idx = indexAtOrAfter(items, t);
          if (idx >= 0)
            win.scrollToIndex(Math.floor(idx / columns), { align: "start" });
        },
      }),
    [ctx, win, items, columns, contentRef],
  );

  return (
    <div
      ref={gridRef}
      className="relative w-full px-1 md:mx-2"
      style={{ height: `${win.virtualizer.getTotalSize()}px` }}
    >
      {virtualItems.map((v) => {
        const row = rows[v.index];
        if (!row) return null;
        return (
          <div
            key={v.key}
            // fixed pitch: NOT `virtualizer.measureElement`. See `rowHeight` above — the
            // measurement feedback loop is what made §9.2 compensation inexact here.
            ref={v.index === virtualItems[0]?.index ? probeRef : undefined}
            data-index={v.index}
            className="absolute inset-x-0 top-0 flex"
            style={{
              transform: `translateY(${v.start}px)`,
              height: `${rowHeight}px`,
            }}
          >
            {row.cards.map((review) => {
              // D11: a deep link must HIGHLIGHT what it landed on, not merely scroll to it.
              // `selectedReviews` is EventView's ctrl-click selection and knows nothing
              // about a link, so the provider's `selectedId` rings the card the same way.
              const linked = ctx.selectedId === review.id;
              const selected = selectedIds.has(review.id) || linked;
              return (
                <div
                  key={review.id}
                  // §9.2 anchor: this must be on the CARD, not the row. Row ids are derived
                  // from their first card, so every insertion renames every row and the
                  // anchor would never be found again — measured as "no compensation at
                  // all", a full row of jump. A card id is stable for the item's life.
                  data-continuous-id={review.id}
                  data-start={review.start_time}
                  // the thumbnail this card OWNS — the error listener above matches the
                  // failing `src` against it so an unrelated image cannot degrade the cell
                  data-continuous-thumb={(review.thumb_path || "")
                    .split("/")
                    .pop()}
                  // the deep-link landing, assertable from a gate (the ring is a Tailwind
                  // outline class and "is it highlighted" is not otherwise readable)
                  data-continuous-linked={linked ? "true" : undefined}
                  // upstream's copied EventSegment finds this card by
                  // `[data-segment-start="<segStart - segmentDuration>"]` to flash its ring
                  // when a strip segment is clicked. Keep the attribute so that still works
                  // for cards that happen to be mounted; the SCROLL half of that
                  // interaction goes through navigateToTime (see ContinuousEventStrip).
                  data-segment-start={
                    Math.floor(review.start_time / segmentDuration) *
                      segmentDuration -
                    segmentDuration
                  }
                  className="review-item relative h-full rounded-lg px-1 md:px-2"
                  style={{ width: `${100 / columns}%` }}
                >
                  <div className="aspect-video overflow-hidden rounded-lg">
                    {/* D9/F15: the camera has left the config. Wait for the config to
                        actually arrive before judging — `knownCameras` is empty for the
                        first frames and every card would degrade. */}
                    {configLoaded && !knownCameras.has(review.camera) ? (
                      <DegradedReviewCell
                        review={review}
                        reason="camera-missing"
                        tz={ctx.tz}
                      />
                    ) : deadThumbs.has(review.id) ? (
                      /* F17: only the image is gone. The review — and very possibly the
                         recording — is not, so this stays clickable. */
                      <DegradedReviewCell
                        review={review}
                        reason="thumb-missing"
                        tz={ctx.tz}
                        onClick={() => onSelectReview(review, false, false)}
                      />
                    ) : (
                      <PreviewThumbnailPlayer
                        review={review}
                        allPreviews={relevantPreviews}
                        timeRange={timeRange}
                        setReviewed={(rev) => markWithTwins(rev)}
                        scrollLock={scrollLock}
                        onTimeUpdate={onPreviewTimeUpdate}
                        onClick={(rev, ctrl, detail) =>
                          selectWithTwins(rev, ctrl, detail)
                        }
                      />
                    )}
                  </div>
                  <div
                    className={cn(
                      "review-item-ring pointer-events-none absolute inset-0 z-10 size-full rounded-lg outline outline-[3px] -outline-offset-[2.8px]",
                      selected
                        ? `outline-severity_${review.severity} shadow-severity_${review.severity}`
                        : "outline-transparent duration-500",
                    )}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
      {ctx.isLoadingOlder && (
        <div className="absolute inset-x-0 bottom-0 py-2 text-center text-xs text-muted-foreground">
          …
        </div>
      )}
    </div>
  );
}
