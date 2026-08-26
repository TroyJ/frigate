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
 * D6 / D7: the strip shows the whole axis. `getRecordingAvailability` is three-way —
 *   true      recording exists            → normal bed
 *   false     known gap                   → blackout (cell draws it)
 *   undefined gap data NOT LOADED YET     → must never render as either: the cell treats
 *             undefined as "fine", so we render a shimmer row instead of the cell.
 * The expired-vs-outage split (retention horizon, §14.1a) is applied in Phase 9.
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
import ReviewTimeline from "@/components/timeline/ReviewTimeline";
import { useMotionSegmentUtils } from "@/hooks/use-motion-segment-utils";
import { MotionSegment } from "./cells/MotionSegment";
import { useContinuousStrict } from "./ContinuousProvider";
import { useSegmentEventIndex } from "./useSegmentEventIndex";
import { useHeavyPages } from "./useHeavyPages";
import { SEGMENT_HEIGHT, useFixedPitchWindow } from "./useFixedPitchWindow";
import { alignDown } from "./timeAlign";

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

  const onNearBottom = useCallback(() => ctx.loadOlder(), [ctx]);
  const win = useFixedPitchWindow({
    scrollRef,
    count,
    startAligned,
    segmentDuration,
    onNearBottom,
  });

  // heavy pages for the visible range only (§10 rule 1)
  const visibleRange = useMemo(() => {
    if (win.visible.end === 0) return undefined;
    return {
      before: startAligned - win.visible.start * segmentDuration,
      after: startAligned - win.visible.end * segmentDuration,
    };
  }, [win.visible, startAligned, segmentDuration]);
  const heavy = useHeavyPages({
    queue: ctx.heavyQueue,
    tz: ctx.tz,
    cameras,
    motionScale: Math.round(segmentDuration / 2),
    unavailScale: Math.round(segmentDuration),
    visible: visibleRange,
    tailTick: ctx.now,
  });

  const { getMotionSegmentValue } = useMotionSegmentUtils(
    segmentDuration,
    heavy.motion,
  );
  const lookupEvents = useSegmentEventIndex(events, segmentDuration);

  // gap index (§14.1a): O(ranges) per lookup is fine while ranges are per-day pages;
  // a bucket index lands with the three-way classifier in Phase 9.
  const getRecordingAvailability = useCallback(
    (time: number): boolean | undefined => {
      if (!heavy.isLoaded(time)) return undefined;
      return !heavy.unavailable.some(
        (r) => time >= r.start_time && time < r.end_time,
      );
    },
    [heavy],
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

  // navigation registry (§2A.3 / D14): scroll so t sits at the top of the viewport
  useEffect(
    () =>
      ctx.registerSurface(surface, {
        scrollToTop: () => win.scrollToIndex(0, { align: "start" }),
        scrollToTime: (t) => {
          const index = Math.round((startAligned - t) / segmentDuration);
          win.scrollToIndex(Math.max(0, Math.min(count - 1, index)), {
            align: "start",
          });
        },
      }),
    [ctx, surface, startAligned, segmentDuration, count, win],
  );

  // The effect RETURNS the disposer: on unmount (a Review tab switch) the entry has to
  // leave the map, or a stale `false` latches the "N new" chip on forever (§9.3).
  const reportAtTop = ctx.reportAtTop;
  useEffect(
    () => reportAtTop(surface, win.stickToTop),
    [reportAtTop, surface, win.stickToTop],
  );

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
    const hasRecording = getRecordingAvailability(segmentTime);
    const style = {
      position: "absolute" as const,
      top: `${i * SEGMENT_HEIGHT}px`,
      height: `${SEGMENT_HEIGHT}px`,
      width: "100%",
    };
    if (hasRecording === undefined) {
      // D7: "not loaded" must look like neither the bed nor the blackout
      return (
        <div
          key={segmentTime}
          style={style}
          className="animate-pulse bg-secondary-highlight/40"
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
    return (
      <div key={segmentTime} style={style}>
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
