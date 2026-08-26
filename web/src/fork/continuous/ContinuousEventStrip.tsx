/**
 * fork/continuous — S2: the Review page's right-edge review strip (handover §4A.1).
 *
 * Drop-in replacement for upstream's `EventReviewTimeline`. Upstream's `ReviewTimeline`
 * shell (handlebar, drag math, zoom buttons) is IMPORTED unchanged; only the segment
 * surface underneath is ours: K1 (`useFixedPitchWindow`) + the copied `EventSegment` cell
 * + the bucket index. The span comes from the continuous provider, not from a
 * `timelineStart`/`timelineEnd` pair, so the strip runs to the review floor (D2) instead
 * of stopping at 24 h.
 *
 * Geometry (§3.4, and §4.3's trap): row 0 is the NEWEST time (`startAligned`) and rows
 * grow downward into the past. `segments[]` is materialised for the loaded window only,
 * because upstream's `ReviewTimeline` / `useDraggableElement` take `segments: number[]`
 * (F3: bounded by the loaded span, not the retained one).
 *
 * F11: every cell gets `bucket[t-d] ∪ bucket[t] ∪ bucket[t+d]` from `useSegmentEventIndex`
 * rather than the whole review array. Do not pass `events` straight through — at the
 * review floor that is thousands of items scanned ~8× per cell per render.
 *
 * S1 coupling: `minimapStartTime`/`minimapEndTime` and `visibleTimestamps` come from
 * `ContinuousReviewGrid` (which derives them from its virtualizer, not from an
 * IntersectionObserver — see that file). The auto-scroll-to-visible effect mirrors
 * upstream's so the strip keeps following the grid.
 *
 * No motion or recording data is fetched here: `EventSegment` paints from reviews alone,
 * so S2 costs nothing beyond the `/review` pages the provider already holds (§10 rule 1).
 */
import React, {
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  ReviewSegment,
  ReviewSeverity,
  TimelineZoomDirection,
  ZoomLevel,
} from "@/types/review";
import ReviewTimeline from "@/components/timeline/ReviewTimeline";
import { EventSegment } from "./cells/EventSegment";
import { useContinuousStrict } from "./ContinuousProvider";
import { useSegmentEventIndex } from "./useSegmentEventIndex";
import { SEGMENT_HEIGHT, useFixedPitchWindow } from "./useFixedPitchWindow";
import { alignDown, startOfDayInTz } from "./timeAlign";

export type ContinuousEventStripProps = {
  events: ReviewSegment[];
  segmentDuration: number;
  timestampSpread: number;
  showHandlebar?: boolean;
  handlebarTime?: number;
  setHandlebarTime?: React.Dispatch<React.SetStateAction<number>>;
  showMinimap?: boolean;
  minimapStartTime?: number;
  minimapEndTime?: number;
  visibleTimestamps?: number[];
  severityType: ReviewSeverity;
  contentRef: RefObject<HTMLDivElement>;
  timelineRef?: RefObject<HTMLDivElement>;
  onHandlebarDraggingChange?: (isDragging: boolean) => void;
  dense?: boolean;
  isZooming: boolean;
  zoomDirection: TimelineZoomDirection;
  onZoomChange?: (newZoomLevel: number) => void;
  possibleZoomLevels?: ZoomLevel[];
  currentZoomLevel?: number;
};

export function ContinuousEventStrip({
  events,
  segmentDuration,
  timestampSpread,
  showHandlebar = false,
  handlebarTime,
  setHandlebarTime,
  showMinimap = false,
  minimapStartTime,
  minimapEndTime,
  visibleTimestamps,
  severityType,
  contentRef,
  timelineRef,
  onHandlebarDraggingChange,
  dense = false,
  isZooming,
  zoomDirection,
  onZoomChange,
  possibleZoomLevels,
  currentZoomLevel,
}: ContinuousEventStripProps) {
  const ctx = useContinuousStrict();
  const internalRef = useRef<HTMLDivElement>(null);
  const scrollRef = timelineRef ?? internalRef;

  // `newest` is 60 s-aligned (+2 min headroom) so this is exact for every zoom level.
  const startAligned = useMemo(
    () => alignDown(ctx.window.newest, segmentDuration),
    [ctx.window.newest, segmentDuration],
  );
  const count = useMemo(
    () => Math.ceil((startAligned - ctx.window.oldest) / segmentDuration),
    [startAligned, ctx.window.oldest, segmentDuration],
  );
  const timelineDuration = count * segmentDuration;

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

  const lookupEvents = useSegmentEventIndex(events, segmentDuration);

  const scrollToSegment = useCallback(
    (segmentTime: number, ifNeeded?: boolean, behavior?: ScrollBehavior) => {
      const index = Math.round((startAligned - segmentTime) / segmentDuration);
      if (index < 0 || index >= count) return;
      // `ifNeeded` defaults ON here, and that IS a behaviour change beyond the minimap
      // follow: upstream's `useDraggableElement` calls `scrollToSegment(t)` with no second
      // argument in five places (drag move, the handlebar follow, and three collapsed-
      // timeline paths) and upstream treated that as "always centre". With `ifNeeded` the
      // scroll is skipped while the target is inside the viewport minus a 20-row (160 px)
      // guard band at each edge — i.e. exactly when centring would have been a visible
      // yank for no reason — and still fires as the handle approaches an edge, which is
      // the case that matters. Revisit if dragging ever feels like it stops following.
      win.scrollToIndex(index, { ifNeeded: ifNeeded ?? true, behavior });
    },
    [startAligned, segmentDuration, count, win],
  );

  // The COPIED cell gets a no-op instead of the real `scrollToSegment`. Its only use of it
  // is the minimap effect (cells/EventSegment.tsx: `scrollToSegment(alignedMinimapStartTime)`,
  // unconditional, centred, smooth) whose deps include `events` — and the fork rebuilds
  // that array from the bucket index on every window change, so the effect re-fires
  // constantly and yanks the strip out from under the user. The container owns that scroll
  // now, once, with `ifNeeded` (see the effect above). Do not pass the real one back in.
  const cellScrollToSegment = useCallback(() => {}, []);

  // Keep the minimap band in view. Upstream does this INSIDE the cell — `EventSegment`
  // fires `scrollToSegment` when the first in-band segment mounts. Under K1 that cell is
  // virtualized away whenever the strip is scrolled somewhere else, so the effect never
  // runs and the band silently stops being followed. The container always knows the band's
  // time, so the follow lives here. `ifNeeded` so it does not fight a user scrolling the
  // strip (that is what upstream's "check if the first segment is out of view" meant).
  useEffect(() => {
    if (!showMinimap || !minimapStartTime) return;
    scrollToSegment(
      alignDown(minimapStartTime, segmentDuration),
      true,
      "smooth",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMinimap, minimapStartTime, segmentDuration]);

  /**
   * Which review a segment click means. Upstream's cell resolves this with `getEvent`:
   * the first event overlapping the segment WHOSE SEVERITY MATCHES the displayed tab —
   * so clicking a detection band while on Alerts targets nothing, and a click anywhere in
   * an event's band targets that event, not the next one along. Reproduced exactly here,
   * because the container is where the scroll now happens (the card upstream queried for
   * is usually unmounted under K2).
   *
   * `events` is the provider's UNFILTERED review list, matching upstream, which passes
   * `reviewItems.all` — the strip paints every severity so you can see a detection band
   * while on the alert tab. The grid, by contrast, shows the filtered list. That asymmetry
   * is why the severity match below is not optional: without it a click on a band the grid
   * cannot show would scroll the grid to an unrelated card.
   */
  const eventAt = useCallback(
    (segmentTime: number): ReviewSegment | undefined =>
      lookupEvents(segmentTime).find((e) => {
        const start =
          Math.floor(e.start_time / segmentDuration) * segmentDuration;
        const end = e.end_time
          ? Math.floor(e.end_time / segmentDuration) * segmentDuration +
            segmentDuration
          : Date.now() / 1000 + segmentDuration;
        return (
          segmentTime >= start &&
          segmentTime < end &&
          e.severity === severityType
        );
      }),
    [lookupEvents, segmentDuration, severityType],
  );

  // follow the grid (upstream EventReviewTimeline's behaviour, unchanged)
  useEffect(() => {
    if (!visibleTimestamps?.length || showMinimap) return;
    const newest = Math.max(
      ...visibleTimestamps.map((t) => alignDown(t, segmentDuration)),
    );
    scrollToSegment(newest, true);
    // scrolling on every reviewed-flag change would fight the user
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTimestamps, showMinimap, segmentDuration]);

  // navigation registry (§2A.3 / D14): dense strips jump to the day's OLDEST edge —
  // 00:00 box time — placed at the top of the viewport, so the user scrolls up through it.
  useEffect(
    () =>
      ctx.registerSurface("strip", {
        scrollToTop: () => win.scrollToIndex(0, { align: "start" }),
        scrollToTime: (t) => {
          const dayStart = startOfDayInTz(t, ctx.tz);
          const index = Math.round(
            (startAligned - alignDown(dayStart, segmentDuration)) /
              segmentDuration,
          );
          win.scrollToIndex(Math.max(0, Math.min(count - 1, index)), {
            align: "start",
          });
        },
      }),
    [ctx, startAligned, segmentDuration, count, win],
  );

  const reportAtTop = ctx.reportAtTop;
  useEffect(
    () => reportAtTop("strip", win.stickToTop),
    [reportAtTop, win.stickToTop],
  );

  const rows = useMemo(() => {
    const out: number[] = [];
    for (let i = win.visible.start; i < win.visible.end; i++) out.push(i);
    return out;
  }, [win.visible]);

  return (
    <ReviewTimeline
      timelineRef={scrollRef}
      contentRef={contentRef}
      segmentDuration={segmentDuration}
      timelineDuration={timelineDuration}
      timelineStartAligned={startAligned}
      showHandlebar={showHandlebar}
      onHandlebarDraggingChange={onHandlebarDraggingChange}
      showExportHandles={false}
      handlebarTime={handlebarTime}
      setHandlebarTime={setHandlebarTime}
      timelineCollapsed={false}
      dense={dense}
      segments={segments}
      scrollToSegment={scrollToSegment}
      isZooming={isZooming}
      zoomDirection={zoomDirection}
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
          {rows.map((i) => {
            const segmentTime = segments[i];
            return (
              <div
                key={segmentTime}
                style={{
                  position: "absolute",
                  top: `${i * SEGMENT_HEIGHT}px`,
                  height: `${SEGMENT_HEIGHT}px`,
                  width: "100%",
                }}
                // Upstream's cell scrolls the grid by querying the DOM for the matching
                // card (`[data-segment-start=…]`). Under K2 that card is usually not
                // mounted, so the query finds nothing and the click does nothing. Route the
                // scroll through the navigation registry instead (§2A.3) — the cell's own
                // handler still runs and still flashes the ring when the card IS mounted.
                //
                // Guarded on there BEING an event, because upstream's handler is: a click
                // on empty strip did nothing, and making it navigate turns every stray
                // click into a jump. The event's own id and start_time are passed, so the
                // grid selects that exact card and, if the filters hide it, falls back to
                // the nearest card to the EVENT rather than to an arbitrary segment time.
                onClickCapture={() => {
                  const hit = eventAt(segmentTime);
                  if (!hit) return;
                  ctx.navigateToTime(hit.start_time, {
                    surface: "grid",
                    selectId: hit.id,
                  });
                }}
              >
                <EventSegment
                  events={lookupEvents(segmentTime)}
                  segmentTime={segmentTime}
                  segmentDuration={segmentDuration}
                  timestampSpread={timestampSpread}
                  showMinimap={showMinimap}
                  minimapStartTime={minimapStartTime}
                  minimapEndTime={minimapEndTime}
                  severityType={severityType}
                  contentRef={contentRef}
                  setHandlebarTime={setHandlebarTime}
                  scrollToSegment={cellScrollToSegment}
                  dense={dense}
                />
              </div>
            );
          })}
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
