/**
 * fork/continuous — drop-in replacement for RecordingView's private `Timeline` (§8.1).
 * Same props; reads the continuous window from the provider. Branches to the three
 * History surfaces (S4 timeline / S5 events / S6 detail).
 */
import { MutableRefObject } from "react";
import { ReviewSegment } from "@/types/review";
import { TimeRange, TimelineType } from "@/types/timeline";

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

export function ContinuousTimelinePanel(props: ContinuousTimelinePanelProps) {
  // 1f placeholder — replaced in 3b
  return (
    <div className="flex w-[100px] flex-shrink-0 items-center justify-center bg-secondary text-xs text-muted-foreground">
      continuous {props.timelineType}
    </div>
  );
}
