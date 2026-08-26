/**
 * fork/continuous — drop-in replacement for RecordingView's private `Timeline` (§8.1).
 * Same props; the continuous window comes from the provider, not from `timeRange`.
 * Branches to the three History surfaces:
 *   timeline → ContinuousMotionStrip (S4, K1)
 *   events   → ContinuousEventList   (S5, K2 — Phase 4; interim plain list)
 *   detail   → ContinuousDetailStream (S6, K2 — Phase 4; interim upstream DetailStream)
 * Zoom state, the three-way tab layout classes and the export-handle wiring mirror
 * upstream's `Timeline` so RecordingView needs no other change.
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
import { TimeRange, TimelineType } from "@/types/timeline";
import { useTimelineZoom } from "@/hooks/use-timeline-zoom";
import {
  GenAISummaryChip,
  GenAISummaryDialog,
} from "@/components/overlay/chip/GenAISummaryChip";
import { ContinuousMotionStrip } from "./ContinuousMotionStrip";
import { ContinuousEventList } from "./ContinuousEventList";
import { ContinuousDetailStream } from "./ContinuousDetailStream";
import { useContinuousStrict } from "./ContinuousProvider";

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

  // zoom (mirrors upstream Timeline)
  const [zoomSettings, setZoomSettings] = useState(ZOOM_LEVELS[0]);
  const handleZoomChange = useCallback(
    (i: number) => setZoomSettings(ZOOM_LEVELS[i]),
    [],
  );
  const currentZoomLevel = ZOOM_LEVELS.findIndex(
    (l) => l.segmentDuration === zoomSettings.segmentDuration,
  );
  const { isZooming, zoomDirection } = useTimelineZoom({
    zoomSettings,
    zoomLevels: ZOOM_LEVELS,
    onZoomChange: handleZoomChange,
    timelineRef: selectedTimelineRef,
    timelineDuration: ctx.window.newest - ctx.window.oldest,
  });

  // export handles (mirrors upstream)
  const [exportStart, setExportStartTime] = useState<number>(0);
  const [exportEnd, setExportEndTime] = useState<number>(0);
  useEffect(() => {
    if (exportRange && exportStart != 0 && exportEnd != 0) {
      if (exportRange.after != exportStart) setCurrentTime(exportStart);
      else if (exportRange?.before != exportEnd) setCurrentTime(exportEnd);
      setExportRange({ after: exportStart, before: exportEnd });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportStart, exportEnd, setExportRange, setCurrentTime]);

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
      {timelineType == "timeline" ? (
        <ContinuousMotionStrip
          timelineRef={selectedTimelineRef}
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
          possibleZoomLevels={ZOOM_LEVELS}
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
          onSelect={(review) =>
            manuallySetCurrentTime(review.start_time - REVIEW_PADDING, true)
          }
        />
      )}
    </div>
  );
}
