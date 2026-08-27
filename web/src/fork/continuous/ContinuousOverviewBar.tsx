/**
 * fork/continuous — the continuous replacement for upstream's `SummaryTimeline`.
 *
 * **Why upstream's cannot be used here, stated once so nobody re-adds it.** `SummaryTimeline`
 * consolidates the review list into `ConsolidatedSegmentData` runs and renders one
 * `<SummarySegment>` per run over `timelineStart..timelineEnd`. Two things break at depth:
 *
 *  1. **Node count is O(reviews).** Every review contributes a run, and each is separated
 *     from the next by an `empty` run, so ~6,500 rows at the review floor is ~13,000 DOM
 *     nodes in a 10 px-wide column — rebuilt on every page arrival.
 *  2. **The span is wrong.** It draws `timelineStart..timelineEnd`, which is upstream's 24 h
 *     window. Under a continuous strip the overview would confidently show one day's worth
 *     of marks against a scroller holding a month: not merely slow, actively lying.
 *
 * So the fork draws BUCKETS instead of runs. The loaded window is divided into a fixed
 * number of buckets — one per pixel of available height, capped at MAX_BUCKETS — and each
 * carries the strongest severity that falls in it. Node count is bounded by the bar's
 * HEIGHT, not by history: the same ~200 divs whether the window holds a day or a year, and
 * one O(reviews) pass to fill them. Empty buckets render nothing at all.
 *
 * The interaction is upstream's, because it is the right one and users know it: a viewport
 * indicator you can drag, and a click that jumps. Both are pure geometry here — the strip is
 * fixed-pitch (K1), so scroll fraction IS time fraction, with none of upstream's
 * `alignStartDateToTimeline` arithmetic in the middle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ReviewSegment, ReviewSeverity } from "@/types/review";

/** Upper bound on rendered buckets — one per pixel is already finer than the eye. */
export const MAX_BUCKETS = 400;

export type ContinuousOverviewBarProps = {
  /** The strip this bar summarises and steers (S2/S3's scroller). */
  reviewTimelineRef: React.RefObject<HTMLDivElement>;
  events: ReviewSegment[];
  severityType: ReviewSeverity;
  /** Loaded window edges, newest first — the span the strip actually covers. */
  newest: number;
  oldest: number;
};

type Bucket = { severity: ReviewSeverity; reviewed: boolean };

/**
 * One pass over the reviews, bucketed by position in the window.
 *
 * Exported for L1: "does the bar summarise the LOADED window" and "is the node count bounded
 * by height rather than history" are both properties of this function, and both are the
 * things that would silently regress if someone swapped it back for a per-review render.
 */
export function bucketReviews(
  events: ReviewSegment[],
  severityType: ReviewSeverity,
  newest: number,
  oldest: number,
  bucketCount: number,
): (Bucket | undefined)[] {
  const out: (Bucket | undefined)[] = new Array(bucketCount).fill(undefined);
  const span = newest - oldest;
  if (!(span > 0) || bucketCount <= 0) return out;
  for (const e of events) {
    if (e.severity !== severityType) continue;
    // index 0 is the NEWEST end, matching the strip's geometry (§3.4)
    const start = Math.min(newest, Math.max(oldest, e.start_time));
    const end = Math.min(newest, Math.max(oldest, e.end_time ?? e.start_time));
    const first = Math.floor(((newest - end) / span) * bucketCount);
    const last = Math.floor(((newest - start) / span) * bucketCount);
    for (
      let i = Math.max(0, first);
      i <= Math.min(bucketCount - 1, last);
      i++
    ) {
      const prev = out[i];
      // an unreviewed item in a bucket wins: the bar's job is to show what still wants
      // attention, and a bucket is a minute of wall time, not one event
      out[i] = {
        severity: e.severity,
        reviewed: (prev?.reviewed ?? true) && !!e.has_been_reviewed,
      };
    }
  }
  return out;
}

export function ContinuousOverviewBar({
  reviewTimelineRef,
  events,
  severityType,
  newest,
  oldest,
}: ContinuousOverviewBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [view, setView] = useState({ top: 0, size: 1 });
  const dragging = useRef(false);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the strip. Fixed pitch means scroll fraction is time fraction exactly, so there
  // is nothing to align and nothing to round.
  useEffect(() => {
    const content = reviewTimelineRef.current;
    if (!content) return;
    const update = () => {
      const total = content.scrollHeight || 1;
      setView({
        top: content.scrollTop / total,
        size: Math.min(1, content.clientHeight / total),
      });
    };
    update();
    content.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(content);
    return () => {
      content.removeEventListener("scroll", update);
      ro.disconnect();
    };
    // `newest`/`oldest` are here because the window growing changes scrollHeight without
    // emitting a scroll event — the same class of bug as K1's arrival re-arm.
  }, [reviewTimelineRef, newest, oldest]);

  const bucketCount = Math.max(1, Math.min(MAX_BUCKETS, Math.floor(height)));
  const buckets = useMemo(
    () => bucketReviews(events, severityType, newest, oldest, bucketCount),
    [events, severityType, newest, oldest, bucketCount],
  );

  const scrollToFraction = useCallback(
    (fraction: number) => {
      const content = reviewTimelineRef.current;
      if (!content) return;
      const total = content.scrollHeight;
      const centred = fraction * total - content.clientHeight / 2;
      content.scrollTop = Math.max(0, Math.min(total, centred));
    },
    [reviewTimelineRef],
  );

  const fractionFromEvent = useCallback((clientY: number) => {
    const el = barRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientY - rect.top) / (rect.height || 1)));
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      e.preventDefault();
      scrollToFraction(fractionFromEvent(e.clientY));
    };
    const onUp = () => (dragging.current = false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [scrollToFraction, fractionFromEvent]);

  return (
    <div
      ref={barRef}
      data-continuous-overview="true"
      data-overview-buckets={bucketCount}
      className="relative h-full w-full cursor-pointer touch-none select-none bg-secondary"
      onMouseDown={(e) => {
        dragging.current = true;
        scrollToFraction(fractionFromEvent(e.clientY));
      }}
      onTouchStart={(e) =>
        scrollToFraction(fractionFromEvent(e.touches[0].clientY))
      }
      onTouchMove={(e) =>
        scrollToFraction(fractionFromEvent(e.touches[0].clientY))
      }
    >
      {buckets.map((b, i) =>
        b ? (
          <div
            key={i}
            data-overview-severity={b.severity}
            className={cn(
              "absolute inset-x-0",
              b.severity === "alert" && "bg-severity_alert",
              b.severity === "detection" && "bg-severity_detection",
              b.severity === "significant_motion" &&
                "bg-severity_significant_motion",
              b.reviewed && "opacity-40",
            )}
            style={{
              top: `${(i / bucketCount) * 100}%`,
              height: `${100 / bucketCount}%`,
            }}
          />
        ) : null,
      )}
      <div
        data-overview-viewport="true"
        className="pointer-events-none absolute inset-x-0 rounded-sm bg-primary/20 ring-1 ring-inset ring-primary/60"
        style={{
          top: `${view.top * 100}%`,
          height: `${Math.max(2, view.size * 100)}%`,
        }}
      />
    </div>
  );
}
