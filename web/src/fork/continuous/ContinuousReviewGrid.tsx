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
 * `config.cameras[review.camera]`.
 */
import {
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Preview } from "@/types/preview";
import { ReviewSegment } from "@/types/review";
import { TimeRange } from "@/types/timeline";
import PreviewThumbnailPlayer from "@/components/player/PreviewThumbnailPlayer";
import { useContinuousStrict } from "./ContinuousProvider";
import { useItemWindow } from "./useItemWindow";
import { indexAtOrAfter } from "./dayNav";

/** Card height estimate: 16:9 thumbnail + the caption row, at ~1/3 of a desktop viewport. */
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
  items,
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

  const [columns, setColumns] = useState(() =>
    columnsForWidth(typeof window === "undefined" ? 1280 : window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setColumns(columnsForWidth(window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onNearEnd = useCallback(() => ctx.loadOlder(), [ctx]);
  const estimate = useCallback(() => CARD_ESTIMATE, []);
  const win = useItemWindow({
    scrollRef: contentRef as MutableRefObject<HTMLDivElement>,
    items,
    estimateSize: estimate,
    gap: GAP,
    onNearEnd,
    lanes: columns,
  });

  // --- S1 ⇄ S2 coupling: which items are actually on screen (see header) --------------
  const selectedIds = useMemo(
    () => new Set(selectedReviews.map((r) => r.id)),
    [selectedReviews],
  );
  const virtualItems = win.virtualItems;
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
      const item = items[v.index];
      if (item) timestamps.push(item.start_time);
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
  }, [virtualItems, items, contentRef, onVisibleChange]);

  // --- navigation registry (§2A.3 / D14) ---------------------------------------------
  useEffect(
    () =>
      ctx.registerSurface("grid", {
        scrollToTime: (t, selectId) => {
          if (selectId && win.scrollToId(selectId)) return;
          // see dayNav.ts: one scan serves both a strip-segment click (pass the moment)
          // and a calendar day-jump (pass 00:00 box time → D14's day's-earliest-review).
          const idx = indexAtOrAfter(items, t);
          if (idx >= 0) win.scrollToIndex(idx, { align: "start" });
        },
      }),
    [ctx, win, items],
  );

  const lanePct = 100 / columns;

  return (
    <div
      className="relative w-full px-1 md:mx-2"
      style={{ height: `${win.virtualizer.getTotalSize()}px` }}
    >
      {virtualItems.map((v) => {
        const review = items[v.index];
        if (!review) return null;
        const selected = selectedIds.has(review.id);
        return (
          <div
            key={v.key}
            ref={win.virtualizer.measureElement}
            data-index={v.index}
            data-start={review.start_time}
            // upstream's copied EventSegment finds this card by
            // `[data-segment-start="<segStart - segmentDuration>"]` to flash its ring when
            // a strip segment is clicked. Keep the attribute so that still works for cards
            // that happen to be mounted; the SCROLL half of that interaction cannot rely on
            // it under virtualization and goes through navigateToTime instead (see
            // ContinuousEventStrip).
            data-segment-start={
              Math.floor(review.start_time / segmentDuration) *
                segmentDuration -
              segmentDuration
            }
            className="review-item absolute top-0 rounded-lg px-1 md:px-2"
            style={{
              transform: `translateY(${v.start}px)`,
              left: `${(v.lane ?? 0) * lanePct}%`,
              width: `${lanePct}%`,
            }}
          >
            <div className="aspect-video overflow-hidden rounded-lg">
              <PreviewThumbnailPlayer
                review={review}
                allPreviews={relevantPreviews}
                timeRange={timeRange}
                setReviewed={markItemAsReviewed}
                scrollLock={scrollLock}
                onTimeUpdate={onPreviewTimeUpdate}
                onClick={(r, ctrl, detail) => onSelectReview(r, ctrl, detail)}
              />
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
      {ctx.isLoadingOlder && (
        <div className="absolute inset-x-0 bottom-0 py-2 text-center text-xs text-muted-foreground">
          …
        </div>
      )}
    </div>
  );
}
