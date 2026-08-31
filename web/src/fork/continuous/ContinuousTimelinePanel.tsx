/**
 * fork/continuous — drop-in replacement for RecordingView's private `Timeline` (§8.1).
 * Same props; the continuous window comes from the provider, not from `timeRange`.
 * Branches to the three History surfaces:
 *   timeline → ContinuousMotionStrip (S4, K1)
 *   events   → ContinuousEventList   (S5, K2 — Phase 4; interim plain list)
 *   detail   → ContinuousDetailStream (S6, K2 — Phase 4; interim upstream DetailStream)
 * Zoom state, the three-way tab layout classes and the export-handle wiring mirror
 * upstream's `Timeline` so RecordingView needs no other change.
 *
 * Two Phase-9 depth guards live at this level, because this is where both knobs are owned:
 *  - **F14/D20, the export cap.** The handles are clamped to the strip, and the strip is now
 *    fifteen months long. `exportClamp.ts` says why 24 h and why "clamped WITH a message"
 *    rather than silently truncated; the message is rendered here, carrying the applied
 *    range so it is assertable.
 *  - **D24, zoom pinning.** Past the pin depth the finer levels are simply not offered
 *    (upstream disables its own zoom-in button at the end of the list, so truncating the
 *    list is the whole fix and needs no upstream change), and a notice says why. The
 *    request-scale half of D24 is in the strip — see zoomPin.ts.
 */
import {
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isDesktop, isMobileOnly } from "react-device-detect";
import { cn } from "@/lib/utils";
import { REVIEW_PADDING, ReviewSegment, ZoomLevel } from "@/types/review";
import { reviewSeekTarget } from "./seekTarget";
import { TimeRange, TimelineType } from "@/types/timeline";
import { useTimelineZoom } from "@/hooks/use-timeline-zoom";
import {
  GenAISummaryChip,
  GenAISummaryDialog,
} from "@/components/overlay/chip/GenAISummaryChip";
import { ContinuousMotionStrip } from "./ContinuousMotionStrip";
import { ContinuousEventList } from "./ContinuousEventList";
import { ContinuousDetailStream } from "./ContinuousDetailStream";
import { ContinuousNewChip } from "./ContinuousNewChip";
import { useContinuousStrict } from "./ContinuousProvider";
import {
  clampExportRange,
  movedHandleFromState,
  EXPORT_CLAMP_TEXT,
} from "./exportClamp";
import {
  isZoomPinned,
  offeredZoomLevels,
  zoomChangeAllowed,
  ZOOM_PINNED_TEXT,
} from "./zoomPin";

export type ContinuousTimelinePanelProps = {
  contentRef: MutableRefObject<HTMLDivElement | null>;
  timelineRef?: MutableRefObject<HTMLDivElement | null>;
  mainCamera: string;
  timelineType: TimelineType;
  timeRange: TimeRange;
  mainCameraReviewItems: ReviewSegment[];
  activeReviewItem?: ReviewSegment;
  currentTime: number;
  exportRange?: TimeRange;
  isPlaying?: boolean;
  setCurrentTime: React.Dispatch<React.SetStateAction<number>>;
  manuallySetCurrentTime: (time: number, force: boolean) => void;
  setScrubbing: React.Dispatch<React.SetStateAction<boolean>>;
  setExportRange: (range: TimeRange) => void;
  onAnalysisOpen: (open: boolean) => void;
};

const ZOOM_LEVELS: ZoomLevel[] = [
  { segmentDuration: 30, timestampSpread: 15 },
  { segmentDuration: 15, timestampSpread: 5 },
  { segmentDuration: 5, timestampSpread: 1 },
];

export function ContinuousTimelinePanel({
  contentRef,
  timelineRef,
  mainCamera,
  timelineType,
  activeReviewItem,
  currentTime,
  exportRange,
  isPlaying,
  setCurrentTime,
  manuallySetCurrentTime,
  setScrubbing,
  setExportRange,
  onAnalysisOpen,
}: ContinuousTimelinePanelProps) {
  const ctx = useContinuousStrict();
  // §9.5: the playback chunk window follows the playhead, and RecordingView owns it.
  const reportPlayhead = ctx.reportPlayhead;
  // D1: and so does the calendar — in History the day the user is looking at IS the day the
  // playhead is in. The provider keeps this at day granularity, so reporting it on every
  // timestamp tick costs one comparison.
  const reportViewTime = ctx.reportViewTime;
  useEffect(() => {
    if (currentTime) {
      reportPlayhead(currentTime);
      reportViewTime(currentTime);
    }
  }, [currentTime, reportPlayhead, reportViewTime]);
  const internalTimelineRef = useRef<HTMLDivElement>(null);
  const selectedTimelineRef = timelineRef || internalTimelineRef;

  // provider-backed review items for this camera (D23 order), not upstream's 24 h prop
  const items = useMemo(
    () => ctx.reviewsByCamera.get(mainCamera) ?? [],
    [ctx.reviewsByCamera, mainCamera],
  );
  const active = useMemo(
    () =>
      activeReviewItem ??
      items.find(
        (rev) =>
          rev.start_time - REVIEW_PADDING < currentTime &&
          rev.end_time &&
          currentTime < rev.end_time + REVIEW_PADDING,
      ),
    [activeReviewItem, items, currentTime],
  );

  // zoom (mirrors upstream Timeline), with D24's pin on top
  const [zoomSettings, setZoomSettings] = useState(ZOOM_LEVELS[0]);
  const [oldestVisible, setOldestVisible] = useState<number>();
  const pinned = isZoomPinned(
    oldestVisible ?? ctx.window.newest,
    ctx.window.newest,
  );
  /**
   * The levels the control OFFERS. Truncating the list is enough on its own: upstream
   * disables its zoom-in button when the current index is the last one, so a list of
   * `[30 s]` renders exactly the "finer zoom buttons disabled" D24 asks for, with no
   * upstream change at all.
   *
   * The one case that must not truncate is a user who was ALREADY at a finer pitch when
   * they scrolled deep — their current level would fall off the list, `currentZoomLevel`
   * would be −1, and upstream hides the whole control on that. Their view is not made
   * cheaper by hiding the buttons anyway; the request-scale pin in the strip has already
   * capped what that costs the box.
   */
  const zoomLevels = useMemo(
    () => offeredZoomLevels(ZOOM_LEVELS, zoomSettings.segmentDuration, pinned),
    [pinned, zoomSettings.segmentDuration],
  );
  const handleZoomChange = useCallback(
    (i: number) => {
      const level = zoomLevels[i];
      if (!level) return;
      // belt and braces: the wheel-zoom hook drives this too and does not read the disabled
      // state off the buttons
      if (
        !zoomChangeAllowed(
          zoomSettings.segmentDuration,
          level.segmentDuration,
          pinned,
        )
      ) {
        return;
      }
      setZoomSettings(level);
    },
    [zoomLevels, pinned, zoomSettings.segmentDuration],
  );
  const currentZoomLevel = zoomLevels.findIndex(
    (l) => l.segmentDuration === zoomSettings.segmentDuration,
  );
  const { isZooming, zoomDirection } = useTimelineZoom({
    zoomSettings,
    zoomLevels,
    onZoomChange: handleZoomChange,
    timelineRef: selectedTimelineRef,
    timelineDuration: ctx.window.newest - ctx.window.oldest,
  });

  // export handles (mirrors upstream) + F14/D20's cap
  const [exportStart, setExportStartTime] = useState<number>(0);
  const [exportEnd, setExportEndTime] = useState<number>(0);
  const [exportClamped, setExportClamped] = useState<TimeRange>();
  const lastAppliedExport = useRef<TimeRange>();
  useEffect(() => {
    if (!exportRange) return;
    /**
     * Upstream requires BOTH handle times to be non-zero before it applies anything, and
     * each is only set by dragging its own handle — so a user who drags only the start bar
     * (the common gesture: bracket backwards from the playhead) writes no range at all, and
     * on the fork that would mean the 24 h cap never ran on the exact drag F14 is about.
     * The untouched handle is seeded from the range the dialog already set.
     */
    const exportStartTime = exportStart || exportRange.after;
    const exportEndTime = exportEnd || exportRange.before;
    // Which handle moved, decided from WHICH ONE HAS A VALUE — not from a comparison
    // against a previous applied range, which does not exist on the first drag.
    // `movedHandle(undefined, …)` answers "after", so the very first drag of the END handle
    // clamped by moving the START one: the anchor teleported, which is precisely what
    // `clampExportRange`'s contract forbids.
    const moved = movedHandleFromState(
      exportStart,
      exportEnd,
      lastAppliedExport.current,
      { after: exportStartTime, before: exportEndTime },
    );
    if (
      exportStartTime !== exportRange.after ||
      exportEndTime !== exportRange.before
    ) {
      if (exportRange.after != exportStartTime) setCurrentTime(exportStartTime);
      else if (exportRange?.before != exportEndTime)
        setCurrentTime(exportEndTime);
      // F14: the handles used to be capped at ~24 h purely because the strip WAS 24 h. It
      // is now months long and nothing downstream guards the span — not ExportDialog, not
      // `frigate/api/export.py`, which happily queries every Recordings row in range and
      // starts an ffmpeg job that can occupy the Pi for hours and fill the disk.
      const requested = { after: exportStartTime, before: exportEndTime };
      const { range, clamped } = clampExportRange(requested, moved);
      lastAppliedExport.current = range;
      setExportClamped(clamped ? range : undefined);
      setExportRange(range);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportStart, exportEnd, setExportRange, setCurrentTime]);
  // leaving export mode clears the notice with it
  useEffect(() => {
    if (exportRange === undefined) {
      setExportClamped(undefined);
      lastAppliedExport.current = undefined;
    }
  }, [exportRange]);

  return (
    <div
      className={cn(
        "relative overflow-hidden",
        isDesktop
          ? cn(
              timelineType == "timeline"
                ? "w-[100px] flex-shrink-0"
                : timelineType == "detail"
                  ? "min-w-[20rem] max-w-[30%] flex-shrink-0 flex-grow-0 basis-[30rem] md:min-w-[20rem] md:max-w-[25%] lg:min-w-[30rem] lg:max-w-[33%]"
                  : "w-80 flex-shrink-0",
            )
          : cn(
              timelineType == "timeline"
                ? "portrait:flex-grow landscape:w-[100px] landscape:flex-shrink-0"
                : "portrait:flex-grow landscape:w-[19rem] landscape:flex-shrink-0",
            ),
      )}
    >
      {isMobileOnly && timelineType == "timeline" && (
        <GenAISummaryDialog review={active} onOpen={onAnalysisOpen}>
          <GenAISummaryChip review={active} />
        </GenAISummaryDialog>
      )}
      {timelineType != "detail" && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[30px] w-full bg-gradient-to-b from-secondary to-transparent"></div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[30px] w-full bg-gradient-to-t from-secondary to-transparent"></div>
        </>
      )}
      {/* D17: the "N new" chip serves both pages. On the narrow 100 px timeline column
          there is no room for it, and the strip's own stick-to-top covers that case. */}
      {timelineType != "timeline" && (
        <ContinuousNewChip className="absolute inset-x-0 top-2 z-30" />
      )}
      {/* F14/D20: clamped, and SAID SO. A silent truncation reads as "the drag broke".
          `data-export-range` carries the range that was actually applied, so the gate can
          assert the outcome rather than count pixels between two blue bars. */}
      {exportClamped && (
        <div
          data-export-clamp="24h"
          data-export-range={JSON.stringify(exportClamped)}
          className="pointer-events-none absolute inset-x-1 top-1 z-40 rounded bg-destructive/90 px-1 py-0.5 text-center text-[10px] leading-tight text-white"
        >
          {EXPORT_CLAMP_TEXT}
        </div>
      )}
      {/* D24: the buttons going quiet on their own is not an explanation. */}
      {pinned && timelineType == "timeline" && (
        <div
          data-zoom-pinned="true"
          className="pointer-events-none absolute inset-x-1 bottom-16 z-40 rounded bg-background/85 px-1 py-0.5 text-center text-[10px] leading-tight text-muted-foreground"
        >
          {ZOOM_PINNED_TEXT}
        </div>
      )}
      {timelineType == "timeline" ? (
        <ContinuousMotionStrip
          timelineRef={selectedTimelineRef}
          onViewportChange={setOldestVisible}
          cameras={mainCamera}
          events={items}
          segmentDuration={zoomSettings.segmentDuration}
          timestampSpread={zoomSettings.timestampSpread}
          showHandlebar={exportRange == undefined}
          showExportHandles={exportRange != undefined}
          exportStartTime={exportRange?.after}
          exportEndTime={exportRange?.before}
          setExportStartTime={setExportStartTime}
          setExportEndTime={setExportEndTime}
          handlebarTime={currentTime}
          setHandlebarTime={setCurrentTime}
          contentRef={contentRef}
          onHandlebarDraggingChange={(scrubbing) => setScrubbing(scrubbing)}
          isZooming={isZooming}
          zoomDirection={zoomDirection}
          onZoomChange={handleZoomChange}
          possibleZoomLevels={zoomLevels}
          currentZoomLevel={currentZoomLevel}
        />
      ) : timelineType == "detail" ? (
        <ContinuousDetailStream
          items={items}
          currentTime={currentTime}
          isPlaying={isPlaying}
          onSeek={(timestamp, play) =>
            manuallySetCurrentTime(timestamp, play ?? true)
          }
        />
      ) : (
        <ContinuousEventList
          items={items}
          activeReviewItem={active}
          // `.24`: AT the detection, like the deep link and the Review-grid card. This is
          // the same "show me THIS alert" gesture, on the very surface a `?id=&tab=events`
          // link lands on — with the 4 s padding the playhead jumped BACKWARDS from where
          // the link had just put it (reviewer finding on `.23`).
          onSelect={(review) =>
            manuallySetCurrentTime(reviewSeekTarget(review.start_time), true)
          }
        />
      )}
    </div>
  );
}
