/**
 * fork/continuous — S4 (History `timeline` tab) and S3 (Review page significant-motion
 * strip, `motionOnly`). Upstream's ReviewTimeline (handlebar, export handles, zoom
 * buttons, drag math) is IMPORTED unchanged; only the segment surface underneath it is
 * ours: K1 (useFixedPitchWindow) + the copied MotionSegment cell + the bucket index.
 *
 * Geometry (§3.4): row 0 is the NEWEST time (`startAligned`), rows grow downward into the
 * past. `segments[]` is materialised for the loaded window only because upstream's
 * ReviewTimeline / useDraggableElement take `segments: number[]` (F3: bounded by the loaded
 * span, not the retained span; at 30 s that is 2,880 numbers per loaded day).
 *
 * D6 / D7: the strip shows the whole axis, and a gap says WHY it is a gap. `gapIndex.ts`
 * classifies four ways — available / outage / expired / unknown — from the retention
 * horizon, with a bucket index so the lookup is O(1) per cell (past the recording floor
 * EVERY cell is a gap, so the old `ranges.some(...)` scan was F11 in a new place). Upstream's
 * `MotionSegment` still gets the tri-state boolean it understands; the expired-vs-outage
 * difference is drawn by a fork OVERLAY row rather than by editing the copied cell, which
 * also keeps the severity tint visible over both (§14.1a: the tint is a gradient, the
 * blackout is a background-colour, so `tailwind-merge` keeps both).
 *
 * D24: past PIN_ZOOM_BEYOND_S from the newest edge the requested `scale` stops getting
 * finer even if the strip is drawn at a finer pitch — see zoomPin.ts for why that is the
 * half that protects the box.
 *
 * P3 (§11.2): the segment scaffolding (ticks, labels, review blips, handlebar) renders in
 * the first frame from review data alone; motion bars fill in when their page lands.
 */
import { RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReviewSegment,
  TimelineZoomDirection,
  ZoomLevel,
} from "@/types/review";
import { cn } from "@/lib/utils";
import ReviewTimeline from "@/components/timeline/ReviewTimeline";
import { useMotionSegmentUtils } from "@/hooks/use-motion-segment-utils";
import { MotionSegment } from "./cells/MotionSegment";
import { useContinuousStrict } from "./ContinuousProvider";
import { useSegmentEventIndex } from "./useSegmentEventIndex";
import { useHeavyPages } from "./useHeavyPages";
import { SEGMENT_HEIGHT, useFixedPitchWindow } from "./useFixedPitchWindow";
import { alignDown } from "./timeAlign";
import { denseStripTarget } from "./navigation";
import { buildGapIndex, GAP_PRESENTATION } from "./gapIndex";
import { effectiveScaleDuration } from "./zoomPin";

/**
 * How far the viewport must move before the panel is told (D24). One hour is two orders of
 * magnitude finer than the three-day pin it feeds and coarse enough that a scroll does not
 * re-render the panel per row.
 */
const VIEWPORT_REPORT_EPSILON_S = 3600;

/** A gap run has to be at least this many rows before it gets a text badge (see renderRow). */
const GAP_RUN_LABEL_ROWS = 8;

export type ContinuousMotionStripProps = {
  cameras: string; // comma-separated, as the API takes it
  events: ReviewSegment[]; // already filtered to `cameras`
  segmentDuration: number;
  timestampSpread: number;
  showHandlebar?: boolean;
  handlebarTime?: number;
  setHandlebarTime?: React.Dispatch<React.SetStateAction<number>>;
  onlyInitialHandlebarScroll?: boolean;
  motionOnly?: boolean;
  showExportHandles?: boolean;
  exportStartTime?: number;
  exportEndTime?: number;
  setExportStartTime?: React.Dispatch<React.SetStateAction<number>>;
  setExportEndTime?: React.Dispatch<React.SetStateAction<number>>;
  contentRef: RefObject<HTMLDivElement>;
  timelineRef?: RefObject<HTMLDivElement>;
  onHandlebarDraggingChange?: (isDragging: boolean) => void;
  dense?: boolean;
  isZooming: boolean;
  zoomDirection: TimelineZoomDirection;
  alwaysShowMotionLine?: boolean;
  onZoomChange?: (newZoomLevel: number) => void;
  possibleZoomLevels?: ZoomLevel[];
  currentZoomLevel?: number;
  surface?: "timeline" | "motion";
  /**
   * D24: the OLDEST time currently on screen. The panel owns the zoom controls but has no
   * idea where the strip is scrolled to, and "how deep is the viewport" is the only input
   * the pin takes — the playhead is not a substitute, because scrolling the strip back
   * three weeks does not move it.
   */
  onViewportChange?: (oldestVisible: number) => void;
};

export function ContinuousMotionStrip({
  cameras,
  events,
  segmentDuration,
  timestampSpread,
  showHandlebar = false,
  handlebarTime,
  setHandlebarTime,
  onlyInitialHandlebarScroll = false,
  motionOnly = false,
  showExportHandles = false,
  exportStartTime,
  exportEndTime,
  setExportStartTime,
  setExportEndTime,
  contentRef,
  timelineRef,
  onHandlebarDraggingChange,
  dense = false,
  isZooming,
  zoomDirection,
  alwaysShowMotionLine = false,
  onZoomChange,
  possibleZoomLevels,
  currentZoomLevel,
  surface = "timeline",
  onViewportChange,
}: ContinuousMotionStripProps) {
  const ctx = useContinuousStrict();
  const internalRef = useRef<HTMLDivElement>(null);
  const scrollRef = timelineRef ?? internalRef;

  // window → rows. `newest` is 60 s-aligned (+2 min headroom) so this is exact for every zoom.
  const startAligned = useMemo(
    () => alignDown(ctx.window.newest, segmentDuration),
    [ctx.window.newest, segmentDuration],
  );
  const count = useMemo(
    () => Math.ceil((startAligned - ctx.window.oldest) / segmentDuration),
    [startAligned, ctx.window.oldest, segmentDuration],
  );
  const timelineDuration = count * segmentDuration;

  // F3 note: bounded by the loaded window (see header)
  const segments = useMemo(
    () =>
      Array.from(
        { length: count },
        (_, i) => startAligned - i * segmentDuration,
      ),
    [count, startAligned, segmentDuration],
  );

  // `ctx.loadOlder`, not `ctx`: the context object is a new identity on every provider
  // render, and this callback's identity is what re-arms the near-end effect.
  const ctxLoadOlder = ctx.loadOlder;
  const onNearBottom = useCallback(() => ctxLoadOlder(), [ctxLoadOlder]);
  const win = useFixedPitchWindow({
    scrollRef,
    count,
    startAligned,
    segmentDuration,
    onNearBottom,
    // a page arriving is the only signal left once the strip is pinned at its bottom and
    // stops emitting scroll events — see `windowKey`
    windowKey: ctx.pagesLoaded,
  });

  // heavy pages for the visible range only (§10 rule 1)
  const visibleRange = useMemo(() => {
    if (win.visible.end === 0) return undefined;
    return {
      before: startAligned - win.visible.start * segmentDuration,
      after: startAligned - win.visible.end * segmentDuration,
    };
  }, [win.visible, startAligned, segmentDuration]);
  // D24: tell the panel how deep the viewport is, so it can pin the zoom controls.
  // THRESHOLDED, not per row: `visibleRange` changes on every scrolled row (8 px), and the
  // panel turns each report into state, so an unthrottled version re-renders the whole
  // History panel at scroll rate to answer a question whose granularity is three DAYS.
  const lastReported = useRef<number>();
  useEffect(() => {
    if (!onViewportChange || visibleRange === undefined) return;
    const t = visibleRange.after;
    if (
      lastReported.current !== undefined &&
      Math.abs(lastReported.current - t) < VIEWPORT_REPORT_EPSILON_S
    ) {
      return;
    }
    lastReported.current = t;
    onViewportChange(t);
  }, [onViewportChange, visibleRange]);

  // D24: the scale the PAGES are requested at, which is not necessarily the pitch the strip
  // is drawn at. `scale` is the step the backend walks the range in, so halving it doubles
  // the work for the same window — and zooming in at depth is the gesture that asks for the
  // finest scale over the widest span, against a single-worker API (F12/F21).
  const scaleDuration = useMemo(
    () =>
      effectiveScaleDuration(
        segmentDuration,
        // the OLDEST edge on screen is what decides the cost of the pages being fetched
        visibleRange?.after ?? ctx.window.newest,
        ctx.window.newest,
      ),
    [segmentDuration, visibleRange, ctx.window.newest],
  );
  // …and the same rule applied per PAGE, which is what actually reaches the box: the
  // viewport reading above can flicker shallow for a frame under a big scroll, a page's own
  // age cannot. Measured without it: one 3-week-old page went out at `scale=3` in the middle
  // of a run where every other deep page was correctly at 15.
  const windowNewest = ctx.window.newest;
  const scaleFor = useCallback(
    (pageAfter: number) => {
      const d = effectiveScaleDuration(
        segmentDuration,
        pageAfter,
        windowNewest,
      );
      return { motion: Math.round(d / 2), unavail: Math.round(d) };
    },
    [segmentDuration, windowNewest],
  );
  const heavy = useHeavyPages({
    queue: ctx.heavyQueue,
    tz: ctx.tz,
    cameras,
    motionScale: Math.round(scaleDuration / 2),
    unavailScale: Math.round(scaleDuration),
    visible: visibleRange,
    scaleFor,
    tailTick: ctx.now,
  });

  const { getMotionSegmentValue } = useMotionSegmentUtils(
    segmentDuration,
    heavy.motion,
  );
  const lookupEvents = useSegmentEventIndex(events, segmentDuration);

  // D7 / §14.1a: bucket-indexed, four-way. Rebuilt only when a page lands or the horizon
  // resolves — NOT per cell, which is what the `.some()` scan it replaced amounted to.
  const gaps = useMemo(
    () =>
      buildGapIndex(
        heavy.unavailable,
        heavy.loaded,
        ctx.extent.oldestRecording,
      ),
    [heavy.unavailable, heavy.loaded, ctx.extent.oldestRecording],
  );
  // upstream's ReviewTimeline and the copied cell speak the tri-state boolean
  const getRecordingAvailability = useCallback(
    (time: number) => gaps.hasRecording(time),
    [gaps],
  );

  const scrollToSegment = useCallback(
    (segmentTime: number, ifNeeded?: boolean, behavior?: ScrollBehavior) => {
      const index = Math.round((startAligned - segmentTime) / segmentDuration);
      if (index < 0 || index >= count) return;
      win.scrollToIndex(index, { ifNeeded, behavior });
    },
    [startAligned, segmentDuration, count, win],
  );

  // keep handlebar centred when zooming (upstream's MotionReviewTimeline behaviour)
  useEffect(() => {
    setTimeout(() => {
      if (handlebarTime !== undefined) {
        scrollToSegment(
          alignDown(handlebarTime, segmentDuration),
          true,
          "auto",
        );
      }
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentDuration]);

  // navigation registry (§2A.3 / D14): scroll so t sits at the top of the viewport. This is
  // a DENSE strip, so a calendar day-jump lands on 00:00 box time (the day's oldest edge,
  // at the top, so the user scrolls up through it) while a deep link or a segment click
  // lands on the moment itself.
  useEffect(
    () =>
      ctx.registerSurface(surface, {
        scrollToTop: () => win.scrollToIndex(0, { align: "start" }),
        scrollToTime: (t, opts) => {
          const target = denseStripTarget(t, opts?.intent, ctx.tz);
          const index = Math.round((startAligned - target) / segmentDuration);
          win.scrollToIndex(Math.max(0, Math.min(count - 1, index)), {
            align: "start",
          });
        },
      }),
    [ctx, surface, startAligned, segmentDuration, count, win],
  );

  // Two effects, not one. Reporting happens whenever `stickToTop` flips; RETIRING the
  // surface happens only on unmount (a Review tab switch), because a stale `false` left in
  // the map latches the "N new" chip on forever (§9.3). Folding the retire into the
  // reporting effect's cleanup would forget-and-re-report on every flip — two extra
  // provider renders for nothing.
  const reportAtTop = ctx.reportAtTop;
  const forgetSurface = ctx.forgetSurface;
  useEffect(() => {
    reportAtTop(surface, win.stickToTop);
  }, [reportAtTop, surface, win.stickToTop]);
  useEffect(() => () => forgetSurface(surface), [forgetSurface, surface]);

  // The Review page's motion tab owns its own playhead; tell the provider so the playback
  // chunk window follows it (§9.5). On History the panel reports instead.
  const reportPlayhead = ctx.reportPlayhead;
  useEffect(() => {
    if (surface !== "motion" || handlebarTime === undefined) return;
    reportPlayhead(handlebarTime);
  }, [surface, handlebarTime, reportPlayhead]);

  // sparse (motionOnly) mode: keep the pitch, filter which rows draw (S3)
  const rows = useMemo(() => {
    const out: number[] = [];
    for (let i = win.visible.start; i < win.visible.end; i++) out.push(i);
    return out;
  }, [win.visible]);

  const renderRow = (i: number) => {
    const segmentTime = segments[i];
    const first = getMotionSegmentValue(segmentTime);
    const second = getMotionSegmentValue(segmentTime + segmentDuration / 2);
    const cellEvents = lookupEvents(segmentTime);
    const gapState = gaps.classify(segmentTime);
    const hasRecording =
      gapState === "unknown" ? undefined : gapState === "available";
    const style = {
      position: "absolute" as const,
      top: `${i * SEGMENT_HEIGHT}px`,
      height: `${SEGMENT_HEIGHT}px`,
      width: "100%",
    };
    if (gapState === "unknown") {
      // D7: "not loaded" must look like neither the bed nor the blackout, or the strip
      // paints "everything is fine" and repaints black a beat later — the worst flicker.
      const { className, label } = GAP_PRESENTATION.unknown;
      return (
        <div
          key={segmentTime}
          style={style}
          data-gap-reason="unknown"
          // this row IS its own presentation (there is no cell under it), so it carries the
          // overlay marker too — that attribute is what a gate reads the three appearances off
          data-gap-overlay="unknown"
          // …and its TIME, like every other row: `data-segment-id` lives on the copied
          // MotionSegment, which a shimmer row does not render, so without this the strip
          // has no readable time axis at all while gap data is in flight
          data-segment-time={segmentTime}
          title={label}
          aria-label={label}
          className={className}
        />
      );
    }
    if (motionOnly) {
      const hasMotion = first > 0 || second > 0;
      const overlapping = cellEvents.some(
        (e) =>
          e.start_time < segmentTime + segmentDuration &&
          (e.end_time ?? Infinity) > segmentTime,
      );
      if (!hasMotion || overlapping) return null;
    }
    const gap =
      gapState === "available" ? undefined : GAP_PRESENTATION[gapState];
    // §17.7 check 7 wants the blackout LABELLED, not merely drawn differently. One badge per
    // RUN — at the newest row of the run, or at the top of the viewport when the run started
    // above it, so a reader parked in the middle of a three-week expired stretch still sees
    // what they are looking at. `GAP_RUN_LABEL_ROWS` keeps it off short gaps, where an 8 px
    // row cannot carry text and a minutes-long hole needs no explanation.
    const runStart =
      gap != undefined &&
      (i === win.visible.start ||
        gaps.classify(segmentTime + segmentDuration) !== gapState);
    const runLongEnough =
      runStart &&
      gaps.classify(segmentTime - GAP_RUN_LABEL_ROWS * segmentDuration) ===
        gapState;
    return (
      <div
        key={segmentTime}
        style={style}
        className="relative"
        // always present, including "available": a self-describing row is what lets a gate
        // assert that a recorded stretch is NOT wearing either blackout
        data-gap-reason={gapState}
        data-segment-time={segmentTime}
        title={gap?.label}
        aria-label={gap?.label}
      >
        {/* D7 style B vs style A. An OVERLAY, not the cell's own background: the copied
            MotionSegment already paints `bg-background` for a gap, and the severity tint
            of a review blip inside that gap is a background-IMAGE gradient, so a second
            background-colour would fight neither but a hatch drawn on top reads over both.
            `pointer-events-none` so the segment underneath is still clickable. */}
        {gap && (
          <div
            data-gap-overlay={gapState}
            className={cn(
              "pointer-events-none absolute inset-0 z-10",
              gap.className,
            )}
          />
        )}
        {gap && runLongEnough && (
          <div
            data-gap-label={gapState}
            className="pointer-events-none absolute left-0 top-0 z-20 max-w-full whitespace-nowrap rounded-sm bg-background/80 px-1 text-[8px] uppercase leading-[10px] tracking-wide text-muted-foreground"
          >
            {gap.shortLabel}
          </div>
        )}
        <MotionSegment
          events={cellEvents}
          firstHalfMotionValue={first}
          secondHalfMotionValue={second}
          hasRecording={hasRecording}
          prevIsNoRecording={
            getRecordingAvailability(segmentTime + segmentDuration) === false
          }
          nextIsNoRecording={
            getRecordingAvailability(segmentTime - segmentDuration) === false
          }
          segmentDuration={segmentDuration}
          segmentTime={segmentTime}
          timestampSpread={timestampSpread}
          motionOnly={motionOnly}
          showMinimap={false}
          setHandlebarTime={setHandlebarTime}
          scrollToSegment={scrollToSegment}
          dense={dense}
          alwaysShowMotionLine={alwaysShowMotionLine}
        />
      </div>
    );
  };

  return (
    <ReviewTimeline
      timelineRef={scrollRef}
      contentRef={contentRef}
      segmentDuration={segmentDuration}
      timelineDuration={timelineDuration}
      timelineStartAligned={startAligned}
      showHandlebar={showHandlebar}
      onHandlebarDraggingChange={onHandlebarDraggingChange}
      onlyInitialHandlebarScroll={onlyInitialHandlebarScroll}
      showExportHandles={showExportHandles}
      handlebarTime={handlebarTime}
      setHandlebarTime={setHandlebarTime}
      exportStartTime={exportStartTime}
      exportEndTime={exportEndTime}
      setExportStartTime={setExportStartTime}
      setExportEndTime={setExportEndTime}
      timelineCollapsed={false}
      dense={dense}
      segments={segments}
      scrollToSegment={scrollToSegment}
      isZooming={isZooming}
      zoomDirection={zoomDirection}
      getRecordingAvailability={getRecordingAvailability}
      onZoomChange={onZoomChange}
      possibleZoomLevels={possibleZoomLevels}
      currentZoomLevel={currentZoomLevel}
    >
      <div
        className="h-full w-full"
        style={{ position: "relative", willChange: "transform" }}
      >
        <div
          style={{
            height: `${count * SEGMENT_HEIGHT}px`,
            position: "relative",
          }}
        >
          {rows.map(renderRow)}
          {ctx.isLoadingOlder && (
            <div
              className="absolute inset-x-0 flex justify-center py-1 text-[9px] text-muted-foreground"
              style={{ top: `${count * SEGMENT_HEIGHT - 16}px` }}
            >
              …
            </div>
          )}
        </div>
      </div>
    </ReviewTimeline>
  );
}
