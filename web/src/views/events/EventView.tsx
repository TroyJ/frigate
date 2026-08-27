import Logo from "@/components/Logo";
import NewReviewData from "@/components/dynamic/NewReviewData";
import ReviewActionGroup from "@/components/filter/ReviewActionGroup";
import ReviewFilterGroup from "@/components/filter/ReviewFilterGroup";
import PreviewThumbnailPlayer from "@/components/player/PreviewThumbnailPlayer";
import EventReviewTimeline from "@/components/timeline/EventReviewTimeline";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTimelineUtils } from "@/hooks/use-timeline-utils";
import { useScrollLockout } from "@/hooks/use-mouse-listener";
import { FrigateConfig } from "@/types/frigateConfig";
import { Preview } from "@/types/preview";
import {
  MotionData,
  RecordingsSummary,
  REVIEW_PADDING,
  ReviewFilter,
  ReviewSegment,
  ReviewSeverity,
  ReviewSummary,
  SegmentedReviewData,
  ZoomLevel,
} from "@/types/review";
import { getChunkedTimeRange } from "@/utils/timelineUtil";
import axios from "axios";
import {
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isDesktop, isMobile, isMobileOnly } from "react-device-detect";
import { LuFolderCheck, LuFolderX } from "react-icons/lu";
import { MdCircle } from "react-icons/md";
import useSWR from "swr";
import MotionReviewTimeline from "@/components/timeline/MotionReviewTimeline";
// fork (continuous timeline seam, handover §8.4 / D4): the three Review-page surfaces
import {
  ContinuousOverviewBar,
  ContinuousDedupToggle,
  ContinuousReviewGrid,
  ContinuousEventStrip,
  ContinuousMotionStrip,
  ContinuousNewChip,
  dayWindowFor,
  selectReviewItems,
  useContinuous,
} from "@/fork/continuous";
import type { VisibleReviewRange } from "@/fork/continuous";
import { Button } from "@/components/ui/button";
import PreviewPlayer, {
  PreviewController,
} from "@/components/player/PreviewPlayer";
import SummaryTimeline from "@/components/timeline/SummaryTimeline";
import { RecordingStartingPoint } from "@/types/record";
import VideoControls from "@/components/player/VideoControls";
import { TimeRange } from "@/types/timeline";
import { useCameraMotionNextTimestamp } from "@/hooks/use-camera-activity";
import useOptimisticState from "@/hooks/use-optimistic-state";
import { Skeleton } from "@/components/ui/skeleton";
import scrollIntoView from "scroll-into-view-if-needed";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FilterList, LAST_24_HOURS_KEY } from "@/types/filter";
import { GiSoundWaves } from "react-icons/gi";
import useKeyboardListener from "@/hooks/use-keyboard-listener";
import { useTimelineZoom } from "@/hooks/use-timeline-zoom";
import { useTranslation } from "react-i18next";
import { EmptyCard } from "@/components/card/EmptyCard";
import { EmptyCardData } from "@/types/card";

type EventViewProps = {
  reviewItems?: SegmentedReviewData;
  currentReviewItems: ReviewSegment[] | null;
  reviewSummary?: ReviewSummary;
  recordingsSummary?: RecordingsSummary;
  relevantPreviews?: Preview[];
  timeRange: TimeRange;
  filter?: ReviewFilter;
  severity: ReviewSeverity;
  startTime?: number;
  showReviewed: boolean;
  setShowReviewed: (show: boolean) => void;
  setSeverity: (severity: ReviewSeverity) => void;
  markItemAsReviewed: (review: ReviewSegment) => void;
  markAllItemsAsReviewed: (currentItems: ReviewSegment[]) => void;
  onOpenRecording: (recordingInfo: RecordingStartingPoint) => void;
  pullLatestData: () => void;
  updateFilter: (filter: ReviewFilter) => void;
};
export default function EventView({
  reviewItems,
  currentReviewItems,
  reviewSummary,
  recordingsSummary,
  relevantPreviews,
  timeRange,
  filter,
  severity,
  startTime,
  showReviewed,
  setShowReviewed,
  setSeverity,
  markItemAsReviewed,
  markAllItemsAsReviewed,
  onOpenRecording,
  pullLatestData,
  updateFilter,
}: EventViewProps) {
  const { t } = useTranslation(["views/events"]);
  const { data: config } = useSWR<FrigateConfig>("config");
  const contentRef = useRef<HTMLDivElement | null>(null);

  // fork: the provider's list, bucketed the same way `pages/Events.tsx` buckets its 24 h
  // one. D18 — this array is also what "select all" means on the virtualized grid.
  const continuous = useContinuous();
  const continuousReviews = continuous.enabled ? continuous.reviews : undefined;
  const continuousItems = useMemo(
    () =>
      continuousReviews
        ? selectReviewItems(
            continuousReviews,
            filter?.showAll ? undefined : severity,
            filter?.showAll,
            showReviewed,
          )
        : null,
    [continuousReviews, severity, filter?.showAll, showReviewed],
  );

  // fork: upstream's mark-reviewed mutations write into the 24 h `reviews` SWR cache,
  // which the continuous surfaces do not read. Mirror them into the provider's override
  // map as well, or a card outside the head page never leaves a `showReviewed = false`
  // grid: the WebSocket message does not carry `has_been_reviewed`, and the provider only
  // force-refetches the page containing `now`.
  const patchContinuous = continuous.enabled ? continuous.patchReviews : null;
  const markReviewed = useCallback(
    (review: ReviewSegment) => {
      patchContinuous?.([review.id], { has_been_reviewed: true });
      markItemAsReviewed(review);
    },
    [markItemAsReviewed, patchContinuous],
  );
  const markManyReviewed = useCallback(
    (items: ReviewSegment[]) => {
      // CAUTION (currently unreachable, a trap for the next caller): this patches EVERY id,
      // while `markAllItemsAsReviewed` filters `end_time` before posting. Hand it an
      // in-progress review and the card flips locally but the server never hears about it.
      // Every present caller pre-filters, so keep doing that rather than relying on this.
      patchContinuous?.(
        items.map((i) => i.id),
        { has_been_reviewed: true },
      );
      markAllItemsAsReviewed(items);
    },
    [markAllItemsAsReviewed, patchContinuous],
  );

  // The selection toolbar (ReviewActionGroup) posts `reviews/viewed` / `reviews/delete`
  // itself and then calls `pullLatestData()`, which refreshes the 24 h SWR window — not the
  // provider. It is on screen for exactly the D18 Ctrl+A flow, so without these the toolbar
  // left stale cards (mark) and ghost cards (delete) in the grid at depth.
  const onToolbarReviewedChange = useCallback(
    (ids: string[], reviewed: boolean) => {
      patchContinuous?.(ids, { has_been_reviewed: reviewed });
    },
    [patchContinuous],
  );
  const removeContinuous = continuous.enabled ? continuous.removeReviews : null;
  const onToolbarDeleted = useCallback(
    (ids: string[]) => {
      removeContinuous?.(ids);
    },
    [removeContinuous],
  );

  // review counts

  const reviewCounts = useMemo(() => {
    if (!reviewSummary) {
      return { alert: -1, detection: -1, significant_motion: -1 };
    }

    let summary;
    if (filter?.before == undefined) {
      summary = reviewSummary[LAST_24_HOURS_KEY];
    } else {
      const day = new Date(filter.before * 1000);
      const key = `${day.getFullYear()}-${("0" + (day.getMonth() + 1)).slice(-2)}-${("0" + day.getDate()).slice(-2)}`;
      summary = reviewSummary[key];
    }

    if (!summary) {
      return { alert: 0, detection: 0, significant_motion: 0 };
    }

    if (showReviewed) {
      return {
        alert: summary.total_alert ?? 0,
        detection: summary.total_detection ?? 0,
      };
    } else {
      return {
        alert: summary.total_alert - summary.reviewed_alert,
        detection: summary.total_detection - summary.reviewed_detection,
      };
    }
  }, [filter, showReviewed, reviewSummary]);

  const emptyCardData: EmptyCardData = useMemo(() => {
    if (
      !config ||
      Object.values(config.cameras).find(
        (cam) => cam.record.enabled_in_config,
      ) != undefined
    ) {
      return {
        title: t("empty." + severity.replace(/_/g, " ")),
      };
    }

    return {
      title: t("empty.recordingsDisabled.title"),
      description: t("empty.recordingsDisabled.description"),
    };
  }, [config, severity, t]);

  // review interaction

  const [selectedReviews, setSelectedReviews] = useState<ReviewSegment[]>([]);
  const onSelectReview = useCallback(
    (review: ReviewSegment, ctrl: boolean, detail: boolean) => {
      if (selectedReviews.length > 0 || ctrl) {
        const index = selectedReviews.findIndex((r) => r.id === review.id);

        if (index != -1) {
          if (selectedReviews.length == 1) {
            setSelectedReviews([]);
          } else {
            const copy = [
              ...selectedReviews.slice(0, index),
              ...selectedReviews.slice(index + 1),
            ];
            setSelectedReviews(copy);
          }
        } else {
          const copy = [...selectedReviews];
          copy.push(review);
          setSelectedReviews(copy);
        }
      } else {
        // If a specific date is selected in the calendar and it's after the event start,
        // use the selected date instead of the event start time
        //
        // fork: that clamp is upstream's 24 h `selectedTimeRange`, which the continuous
        // grid has scrolled far past — applying it opened EVERY card older than 24 h at
        // "24 hours ago" instead of at the review. The clamp only means anything while the
        // calendar is a day FILTER, which the continuous window replaces (D1), so skip it.
        const effectiveStartTime = continuous.enabled
          ? review.start_time
          : timeRange.after > review.start_time
            ? timeRange.after
            : review.start_time;

        onOpenRecording({
          camera: review.camera,
          startTime: effectiveStartTime - REVIEW_PADDING,
          severity: review.severity,
          timelineType: detail ? "detail" : undefined,
        });

        review.has_been_reviewed = true;
        markReviewed(review);
      }
    },
    [
      selectedReviews,
      setSelectedReviews,
      onOpenRecording,
      markReviewed,
      timeRange.after,
      continuous.enabled,
    ],
  );
  const onSelectAllReviews = useCallback(() => {
    // fork (D18): on a virtualized grid "all" is every LOADED item — the array, not the
    // DOM rows and not the 24 h page. The bulk endpoints take ids, so this is safe.
    const selectable = continuousItems ?? currentReviewItems;
    if (!selectable || selectable.length == 0) {
      return;
    }

    if (selectedReviews.length < selectable.length) {
      setSelectedReviews(selectable);
    } else {
      setSelectedReviews([]);
    }
  }, [continuousItems, currentReviewItems, selectedReviews]);

  const exportReview = useCallback(
    (id: string) => {
      // fork: `reviewItems` is upstream's 24 h bundle, so exporting anything the
      // continuous grid scrolled to used to resolve to nothing and return silently.
      // Resolve against the loaded window, and say so when the id really is gone (D9:
      // a stored reference to a deleted review is an expected state, not a crash).
      const review =
        (continuousReviews ?? reviewItems?.all)?.find((seg) => seg.id == id) ??
        reviewItems?.all?.find((seg) => seg.id == id);

      if (!review) {
        toast.error(
          t("export.toast.error.failed", {
            ns: "components/dialog",
            message: t("reviewNotFound", { defaultValue: "review not found" }),
          }),
          { position: "top-center" },
        );
        return;
      }

      const endTime = review.end_time
        ? review.end_time + REVIEW_PADDING
        : Date.now() / 1000;

      axios
        .post(
          `export/${review.camera}/start/${review.start_time - REVIEW_PADDING}/end/${endTime}`,
          { playback: "realtime", image_path: review.thumb_path },
        )
        .then((response) => {
          if (response.status == 200) {
            toast.success(
              t("export.toast.success", { ns: "components/dialog" }),
              {
                position: "top-center",
                action: (
                  <a href="/export" target="_blank" rel="noopener noreferrer">
                    <Button>
                      {t("export.toast.view", { ns: "components/dialog" })}
                    </Button>
                  </a>
                ),
              },
            );
          }
        })
        .catch((error) => {
          const errorMessage =
            error.response?.data?.message ||
            error.response?.data?.detail ||
            "Unknown error";
          toast.error(
            t("export.toast.error.failed", {
              ns: "components/dialog",
              message: errorMessage,
            }),
            {
              position: "top-center",
            },
          );
        });
    },
    [continuousReviews, reviewItems, t],
  );

  const [motionOnly, setMotionOnly] = useState(false);
  const [severityToggle, setSeverityToggle] = useOptimisticState(
    severity,
    setSeverity,
    100,
  );

  // review filter info

  const reviewFilterList = useMemo<FilterList>(() => {
    const uniqueLabels = new Set<string>();
    const uniqueZones = new Set<string>();

    reviewItems?.all?.forEach((rev) => {
      rev.data.objects.forEach((obj) =>
        uniqueLabels.add(obj.replace("-verified", "")),
      );
      rev.data.audio.forEach((aud) => uniqueLabels.add(aud));
    });

    reviewItems?.all?.forEach((rev) => {
      rev.data.zones.forEach((zone) => uniqueZones.add(zone));
    });

    return { labels: [...uniqueLabels], zones: [...uniqueZones] };
  }, [reviewItems]);

  if (!config) {
    return <ActivityIndicator />;
  }

  return (
    <div className="flex size-full flex-col pt-2 md:py-2">
      <Toaster closeButton={true} />
      <div className="relative mb-2 flex h-11 items-center justify-between pl-2 pr-2 md:pl-3">
        {isMobile && (
          <Logo className="absolute inset-x-1/2 h-8 -translate-x-1/2" />
        )}
        <ToggleGroup
          className="*:rounded-md *:px-3 *:py-4"
          type="single"
          size="sm"
          value={severityToggle}
          onValueChange={(value: ReviewSeverity) =>
            value ? setSeverityToggle(value) : null
          } // don't allow the severity to be unselected
        >
          <ToggleGroupItem
            className={cn(severityToggle != "alert" && "text-muted-foreground")}
            value="alert"
            aria-label={t("alerts")}
          >
            <div
              className={cn(
                "flex size-6 items-center justify-center rounded text-severity_alert sm:hidden",
                severityToggle == "alert" ? "font-semibold" : "font-medium",
              )}
            >
              {reviewCounts.alert > -1 ? (
                reviewCounts.alert
              ) : (
                <ActivityIndicator className="size-4" />
              )}
            </div>
            <div className="hidden items-center sm:flex">
              <MdCircle className="size-2 text-severity_alert md:mr-[10px]" />
              <div className="hidden md:flex md:flex-row md:items-center">
                {t("alerts")}
                {reviewCounts.alert > -1 ? (
                  ` ∙ ${reviewCounts.alert}`
                ) : (
                  <ActivityIndicator className="ml-2 size-4" />
                )}
              </div>
            </div>
          </ToggleGroupItem>
          <ToggleGroupItem
            className={cn(
              severityToggle != "detection" && "text-muted-foreground",
            )}
            value="detection"
            aria-label={t("detections")}
          >
            <div
              className={cn(
                "flex size-6 items-center justify-center rounded text-severity_detection sm:hidden",
                severityToggle == "detection" ? "font-semibold" : "font-medium",
              )}
            >
              {reviewCounts.detection > -1 ? (
                reviewCounts.detection
              ) : (
                <ActivityIndicator className="size-4" />
              )}
            </div>
            <div className="hidden items-center sm:flex">
              <MdCircle className="size-2 text-severity_detection md:mr-[10px]" />
              <div className="hidden md:flex md:flex-row md:items-center">
                {t("detections")}
                {reviewCounts.detection > -1 ? (
                  ` ∙ ${reviewCounts.detection}`
                ) : (
                  <ActivityIndicator className="ml-2 size-4" />
                )}
              </div>
            </div>
          </ToggleGroupItem>
          <ToggleGroupItem
            className={cn(
              "rounded-lg px-3 py-4",
              severityToggle != "significant_motion" && "text-muted-foreground",
            )}
            value="significant_motion"
            aria-label={t("motion.label")}
          >
            <GiSoundWaves className="size-6 rotate-90 text-severity_significant_motion sm:hidden" />
            <div className="hidden items-center sm:flex">
              <MdCircle className="size-2 text-severity_significant_motion md:mr-[10px]" />
              <div className="hidden md:block">{t("motion.label")}</div>
            </div>
          </ToggleGroupItem>
        </ToggleGroup>

        {/* fork (F19): one row per EVENT rather than one per camera, on boxes that mirror
            alerts between cameras. Renders nothing anywhere else. Wrapped WITH the filter
            group rather than added beside it: this row is `justify-between`, so a third
            child would push the filters into the middle of the header. */}
        <div className="flex items-center gap-1">
          {selectedReviews.length <= 0 && <ContinuousDedupToggle />}
          {selectedReviews.length <= 0 ? (
            <ReviewFilterGroup
              filters={
                severity == "significant_motion"
                  ? ["cameras", "date", "motionOnly"]
                  : ["cameras", "reviewed", "date", "general"]
              }
              currentSeverity={severityToggle}
              reviewSummary={reviewSummary}
              recordingsSummary={recordingsSummary}
              filter={filter}
              motionOnly={motionOnly}
              filterList={reviewFilterList}
              showReviewed={showReviewed}
              setShowReviewed={setShowReviewed}
              onUpdateFilter={updateFilter}
              setMotionOnly={setMotionOnly}
            />
          ) : (
            <ReviewActionGroup
              selectedReviews={selectedReviews}
              setSelectedReviews={setSelectedReviews}
              onExport={exportReview}
              pullLatestData={pullLatestData}
              onReviewedChange={
                continuous.enabled ? onToolbarReviewedChange : undefined
              }
              onDeleted={continuous.enabled ? onToolbarDeleted : undefined}
            />
          )}
        </div>
      </div>

      <div className="flex h-full overflow-hidden">
        {severity != "significant_motion" && (
          <DetectionReview
            contentRef={contentRef}
            reviewItems={reviewItems}
            currentItems={currentReviewItems}
            continuousItems={continuousItems}
            relevantPreviews={relevantPreviews}
            selectedReviews={selectedReviews}
            itemsToReview={reviewCounts[severityToggle]}
            severity={severity}
            filter={filter}
            timeRange={timeRange}
            startTime={startTime}
            loading={severity != severityToggle}
            emptyCardData={emptyCardData}
            markItemAsReviewed={markReviewed}
            markAllItemsAsReviewed={markManyReviewed}
            onSelectReview={onSelectReview}
            onSelectAllReviews={onSelectAllReviews}
            setSelectedReviews={setSelectedReviews}
            pullLatestData={pullLatestData}
          />
        )}
        {severity == "significant_motion" && (
          <MotionReview
            key={timeRange.before}
            contentRef={contentRef}
            reviewItems={reviewItems}
            continuousItems={continuousItems}
            relevantPreviews={relevantPreviews}
            timeRange={timeRange}
            startTime={startTime}
            filter={filter}
            motionOnly={motionOnly}
            emptyCardData={emptyCardData}
            onOpenRecording={onOpenRecording}
          />
        )}
      </div>
    </div>
  );
}

type DetectionReviewProps = {
  contentRef: MutableRefObject<HTMLDivElement | null>;
  reviewItems?: {
    all: ReviewSegment[];
    alert: ReviewSegment[];
    detection: ReviewSegment[];
    significant_motion: ReviewSegment[];
  };
  currentItems: ReviewSegment[] | null;
  /** fork: the provider's already-bucketed list; null when the toggle is off. */
  continuousItems: ReviewSegment[] | null;
  itemsToReview?: number;
  relevantPreviews?: Preview[];
  selectedReviews: ReviewSegment[];
  severity: ReviewSeverity;
  filter?: ReviewFilter;
  timeRange: { before: number; after: number };
  startTime?: number;
  loading: boolean;
  emptyCardData: EmptyCardData;
  markItemAsReviewed: (review: ReviewSegment) => void;
  markAllItemsAsReviewed: (currentItems: ReviewSegment[]) => void;
  onSelectReview: (
    review: ReviewSegment,
    ctrl: boolean,
    detail: boolean,
  ) => void;
  onSelectAllReviews: () => void;
  setSelectedReviews: (reviews: ReviewSegment[]) => void;
  pullLatestData: () => void;
};
function DetectionReview({
  contentRef,
  reviewItems,
  currentItems,
  continuousItems,
  itemsToReview,
  relevantPreviews,
  selectedReviews,
  severity,
  filter,
  timeRange,
  startTime,
  loading,
  emptyCardData,
  markItemAsReviewed,
  markAllItemsAsReviewed,
  onSelectReview,
  onSelectAllReviews,
  setSelectedReviews,
  pullLatestData,
}: DetectionReviewProps) {
  const { t } = useTranslation(["views/events"]);
  const continuous = useContinuous();

  const reviewTimelineRef = useRef<HTMLDivElement>(null);

  // preview

  const [previewTime, setPreviewTime] = useState<number>();

  const onPreviewTimeUpdate = useCallback(
    (time: number | undefined) => {
      if (!time) {
        setPreviewTime(time);
        return;
      }

      if (!previewTime || time > previewTime) {
        setPreviewTime(time);
      }
    },
    [previewTime, setPreviewTime],
  );

  // timeline interaction

  const timelineDuration = useMemo(
    () => timeRange.before - timeRange.after,
    [timeRange],
  );

  const [zoomSettings, setZoomSettings] = useState({
    segmentDuration: 60,
    timestampSpread: 15,
  });

  const possibleZoomLevels: ZoomLevel[] = useMemo(
    () => [
      { segmentDuration: 60, timestampSpread: 15 },
      { segmentDuration: 30, timestampSpread: 5 },
      { segmentDuration: 10, timestampSpread: 1 },
    ],
    [],
  );

  const handleZoomChange = useCallback(
    (newZoomLevel: number) => {
      setZoomSettings(possibleZoomLevels[newZoomLevel]);
    },
    [possibleZoomLevels],
  );

  const currentZoomLevel = useMemo(
    () =>
      possibleZoomLevels.findIndex(
        (level) => level.segmentDuration === zoomSettings.segmentDuration,
      ),
    [possibleZoomLevels, zoomSettings.segmentDuration],
  );

  const { isZooming, zoomDirection } = useTimelineZoom({
    zoomSettings,
    zoomLevels: possibleZoomLevels,
    onZoomChange: handleZoomChange,
    timelineRef: reviewTimelineRef,
    timelineDuration,
  });

  const { alignStartDateToTimeline, getVisibleTimelineDuration } =
    useTimelineUtils({
      segmentDuration: zoomSettings.segmentDuration,
      timelineDuration,
      timelineRef: reviewTimelineRef,
    });

  const scrollLock = useScrollLockout(contentRef);

  const [minimap, setMinimap] = useState<string[]>([]);
  const minimapObserver = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const visibleTimestamps = new Set<string>();
    minimapObserver.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const start = (entry.target as HTMLElement).dataset.start;

          if (!start) {
            return;
          }

          if (entry.isIntersecting) {
            visibleTimestamps.add(start);
          } else {
            visibleTimestamps.delete(start);
          }

          setMinimap([...visibleTimestamps]);
        });
      },
      { root: contentRef.current, threshold: isDesktop ? 0.1 : 0.5 },
    );

    return () => {
      minimapObserver.current?.disconnect();
    };
  }, [contentRef, minimapObserver]);

  const minimapBounds = useMemo(() => {
    const data = {
      start: 0,
      end: 0,
    };
    const list = minimap.sort();

    if (list.length > 0) {
      data.end = parseFloat(list.at(-1) || "0");
      data.start = parseFloat(list[0]);
    }

    return data;
  }, [minimap]);

  // fork (S1): under the continuous grid the visible band is derived from the
  // virtualizer, not from the IntersectionObserver above — rows unmount as you scroll,
  // so the observed set churns and the observer's bounds jitter. Same contract.
  const [continuousVisible, setContinuousVisible] =
    useState<VisibleReviewRange>();
  const effectiveMinimapBounds = continuous.enabled
    ? (continuousVisible?.bounds ?? { start: 0, end: 0 })
    : minimapBounds;

  const minimapRef = useCallback(
    (node: HTMLElement | null) => {
      if (!minimapObserver.current) {
        return;
      }

      try {
        if (node) minimapObserver.current.observe(node);
      } catch (e) {
        // no op
      }
    },
    [minimapObserver],
  );

  const showMinimap = useMemo(() => {
    if (!contentRef.current) {
      return false;
    }

    // don't show minimap if the view is not scrollable
    if (contentRef.current.scrollHeight < contentRef.current.clientHeight) {
      return false;
    }

    const visibleTime = getVisibleTimelineDuration();
    const minimapTime =
      effectiveMinimapBounds.end - effectiveMinimapBounds.start;
    if (visibleTime && minimapTime >= visibleTime * 0.75) {
      return false;
    }

    return true;
    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentRef.current?.scrollHeight, effectiveMinimapBounds]);

  const visibleTimestamps = useMemo(
    () => minimap.map((str) => parseFloat(str)),
    [minimap],
  );
  const effectiveVisibleTimestamps = continuous.enabled
    ? (continuousVisible?.timestamps ?? [])
    : visibleTimestamps;

  // existing review item

  useEffect(() => {
    if (loading || currentItems == null || itemsToReview == undefined) {
      return;
    }

    if (currentItems.length == 0 && itemsToReview > 0) {
      pullLatestData();
    }
  }, [loading, currentItems, itemsToReview, pullLatestData]);

  useEffect(() => {
    if (!startTime || !currentItems || currentItems.length == 0) {
      return;
    }

    const element = contentRef.current?.querySelector(
      `[data-start="${startTime + REVIEW_PADDING}"]`,
    );
    if (element) {
      scrollIntoView(element, {
        scrollMode: "if-needed",
        behavior: "smooth",
      });
    }
    // only run when start time changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime]);

  // keyboard

  useKeyboardListener(
    ["a", "r", "Escape"],
    (key, modifiers) => {
      if (!modifiers.down) {
        return true;
      }

      switch (key) {
        case "a":
          if (modifiers.ctrl && !modifiers.repeat) {
            onSelectAllReviews();
            return true;
          }
          break;
        case "r":
          if (selectedReviews.length > 0 && !modifiers.repeat) {
            if (continuous.enabled) {
              // fork (D18): intersecting the selection with `currentItems` silently marked
              // only the last 24 h and then cleared the selection — with select-all-loaded
              // that is most of the selection quietly dropped. Act on the selection itself.
              // It is ALSO posted as ONE bulk call: at the review floor the selection can
              // be thousands of items, and a POST per item is thousands of requests
              // against the single API worker — the F12 starvation that gets the add-on
              // restarted. `markAllItemsAsReviewed` already batches the ids; its optimistic
              // severity-wide flip lands in the 24 h SWR cache, which nothing renders while
              // the continuous grid is on, and the provider is patched with the exact ids.
              const done = selectedReviews.filter((item) => item.end_time);
              done.forEach((item) => (item.has_been_reviewed = true));
              if (done.length > 0) {
                markAllItemsAsReviewed(done);
              }
            } else {
              const selectedIds = new Set(selectedReviews.map((r) => r.id));
              currentItems?.forEach((item) => {
                if (selectedIds.has(item.id)) {
                  item.has_been_reviewed = true;
                  markItemAsReviewed(item);
                }
              });
            }
            setSelectedReviews([]);
            return true;
          }
          break;
        case "Escape":
          setSelectedReviews([]);
          return true;
      }

      return false;
    },
    contentRef,
  );

  return (
    <>
      <div
        ref={contentRef}
        className="no-scrollbar flex flex-1 flex-wrap content-start gap-2 overflow-y-auto md:gap-4"
      >
        {/* fork (D17): one "new items" mechanism. Upstream's pill is hidden when the
            continuous panel is enabled; the fork's chip (§9.3) serves both pages. It is
            mounted in the same place so the positioning is upstream's. */}
        {filter?.before == undefined && continuous.enabled && (
          <ContinuousNewChip className="absolute left-1/2 z-[49] mr-[65px] mt-8 -translate-x-1/2 md:mr-[115px]" />
        )}
        {filter?.before == undefined && !continuous.enabled && (
          <NewReviewData
            className="pointer-events-none absolute left-1/2 z-[49] -translate-x-1/2"
            contentRef={contentRef}
            reviewItems={currentItems}
            itemsToReview={loading ? 0 : itemsToReview}
            pullLatestData={pullLatestData}
          />
        )}

        {!currentItems && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <ActivityIndicator />
          </div>
        )}

        {!loading && currentItems?.length === 0 && (
          <EmptyCard
            className="absolute left-[50%] top-[50%] -translate-x-1/2 -translate-y-1/2 items-center text-center"
            title={emptyCardData.title}
            titleHeading={false}
            description={emptyCardData.description}
            icon={<LuFolderCheck className="size-16" />}
          />
        )}

        {/* fork (continuous timeline seam, §8.4 / D4): S1. The upstream grid stays
            in the tree and is one toggle away.

            Deliberately NOT carried over: upstream's "Mark these items as reviewed" bulk
            button at the end of the grid. "These items" meant one 24 h page; under the
            continuous grid it would mean every loaded item — thousands of ids in one
            unconfirmed click, and `markAllItemsAsReviewed` additionally flips every
            same-severity segment in the cache. Ctrl+A then `r` does the same thing
            deliberately (D18) and is the supported path. If it comes back it needs a
            count in the label and a confirm step. */}
        {continuous.enabled ? (
          <ContinuousReviewGrid
            contentRef={contentRef}
            items={continuousItems ?? []}
            segmentDuration={zoomSettings.segmentDuration}
            selectedReviews={selectedReviews}
            relevantPreviews={relevantPreviews}
            timeRange={timeRange}
            scrollLock={scrollLock}
            markItemAsReviewed={markItemAsReviewed}
            onPreviewTimeUpdate={onPreviewTimeUpdate}
            onSelectReview={onSelectReview}
            onVisibleChange={setContinuousVisible}
          />
        ) : (
          <>
            {/* fork (F8): contentRef must point at the scroll container above, not this
              inner grid — every consumer (minimap observer root, scroll lock, the
              scrollHeight check, NewReviewData's scrollTo) expects the scroller. */}
            <div className="grid w-full gap-2 px-1 sm:grid-cols-2 md:mx-2 md:grid-cols-3 md:gap-4 3xl:grid-cols-4">
              {!loading && currentItems
                ? currentItems.map((value) => {
                    const selected = selectedReviews.some(
                      (r) => r.id === value.id,
                    );

                    return (
                      <div
                        key={value.id}
                        ref={minimapRef}
                        data-start={value.start_time}
                        data-segment-start={
                          alignStartDateToTimeline(value.start_time) -
                          zoomSettings.segmentDuration
                        }
                        className="review-item relative rounded-lg"
                      >
                        <div className="aspect-video overflow-hidden rounded-lg">
                          <PreviewThumbnailPlayer
                            review={value}
                            allPreviews={relevantPreviews}
                            timeRange={timeRange}
                            setReviewed={markItemAsReviewed}
                            scrollLock={scrollLock}
                            onTimeUpdate={onPreviewTimeUpdate}
                            onClick={(
                              review: ReviewSegment,
                              ctrl: boolean,
                              detail: boolean,
                            ) => {
                              onSelectReview(review, ctrl, detail);
                            }}
                          />
                        </div>
                        <div
                          className={cn(
                            "review-item-ring pointer-events-none absolute inset-0 z-10 size-full rounded-lg outline outline-[3px] -outline-offset-[2.8px]",
                            selected
                              ? `outline-severity_${value.severity} shadow-severity_${value.severity}`
                              : "outline-transparent duration-500",
                          )}
                        />
                      </div>
                    );
                  })
                : (itemsToReview ?? 0) > 0 &&
                  Array(itemsToReview)
                    .fill(0)
                    .map((_, idx) => (
                      <Skeleton key={idx} className="aspect-video size-full" />
                    ))}
              {!loading &&
                (currentItems?.filter((seg) => seg.end_time)?.length ?? 0) >
                  0 &&
                (itemsToReview ?? 0) > 0 && (
                  <div className="col-span-full flex items-center justify-center">
                    <Button
                      className="text-balance text-white"
                      aria-label={t("markTheseItemsAsReviewed")}
                      variant="select"
                      onClick={() => {
                        setSelectedReviews([]);
                        markAllItemsAsReviewed(currentItems ?? []);
                      }}
                    >
                      {t("markTheseItemsAsReviewed")}
                    </Button>
                  </div>
                )}
            </div>
          </>
        )}
      </div>
      <div className="flex w-[65px] flex-row md:w-[110px]">
        {/* fork: NOT a scroller. Upstream's class here is `relative` and both strips
            (upstream's EventReviewTimeline and the fork's ContinuousEventStrip) own their
            own `overflow-y-auto` scroller inside ReviewTimeline. Adding one here nests two
            scrollers and splits the wheel events between them. */}
        <div className="no-scrollbar relative w-[55px] md:w-[100px]">
          {loading ? (
            <Skeleton className="size-full" />
          ) : /* fork (§8.4 / D4): S2 */ continuous.enabled ? (
            <ContinuousEventStrip
              segmentDuration={zoomSettings.segmentDuration}
              timestampSpread={zoomSettings.timestampSpread}
              showMinimap={showMinimap && !previewTime}
              minimapStartTime={effectiveMinimapBounds.start}
              minimapEndTime={effectiveMinimapBounds.end}
              showHandlebar={previewTime != undefined}
              handlebarTime={previewTime}
              visibleTimestamps={effectiveVisibleTimestamps}
              events={continuous.reviews}
              severityType={severity}
              contentRef={contentRef}
              timelineRef={reviewTimelineRef}
              dense={isMobile}
              isZooming={isZooming}
              zoomDirection={zoomDirection}
              possibleZoomLevels={possibleZoomLevels}
              currentZoomLevel={currentZoomLevel}
            />
          ) : (
            <EventReviewTimeline
              segmentDuration={zoomSettings.segmentDuration}
              timestampSpread={zoomSettings.timestampSpread}
              timelineStart={timeRange.before}
              timelineEnd={timeRange.after}
              showMinimap={showMinimap && !previewTime}
              minimapStartTime={minimapBounds.start}
              minimapEndTime={minimapBounds.end}
              showHandlebar={previewTime != undefined}
              handlebarTime={previewTime}
              visibleTimestamps={visibleTimestamps}
              events={reviewItems?.all ?? []}
              severityType={severity}
              contentRef={contentRef}
              timelineRef={reviewTimelineRef}
              dense={isMobile}
              isZooming={isZooming}
              zoomDirection={zoomDirection}
              possibleZoomLevels={possibleZoomLevels}
              currentZoomLevel={currentZoomLevel}
            />
          )}
        </div>
        <div className="w-[10px]">
          {/* fork (Phase 9): SummaryTimeline is replaced, not dropped. Upstream's renders
              one <SummarySegment> per review over `timelineStart..End` — at the review
              floor that is thousands of DOM nodes AND the wrong span (24 h against a
              scroller holding a month), so it would be both slow and lying.
              ContinuousOverviewBar buckets the LOADED window instead: node count bounded by
              the bar's height, one O(reviews) pass, same drag-and-click interaction. */}
          {continuous.enabled ? (
            <ContinuousOverviewBar
              reviewTimelineRef={reviewTimelineRef}
              events={continuous.reviews}
              severityType={severity}
              newest={continuous.window.newest}
              oldest={continuous.window.oldest}
            />
          ) : loading ? (
            <Skeleton className="w-full" />
          ) : (
            <SummaryTimeline
              reviewTimelineRef={reviewTimelineRef}
              timelineStart={timeRange.before}
              timelineEnd={timeRange.after}
              segmentDuration={zoomSettings.segmentDuration}
              events={reviewItems?.all ?? []}
              severityType={severity}
            />
          )}
        </div>
      </div>
    </>
  );
}

type MotionReviewProps = {
  contentRef: MutableRefObject<HTMLDivElement | null>;
  reviewItems?: {
    all: ReviewSegment[];
    alert: ReviewSegment[];
    detection: ReviewSegment[];
    significant_motion: ReviewSegment[];
  };
  /** fork: the provider's already-bucketed list; null when the toggle is off. */
  continuousItems: ReviewSegment[] | null;
  relevantPreviews?: Preview[];
  timeRange: TimeRange;
  startTime?: number;
  filter?: ReviewFilter;
  motionOnly?: boolean;
  emptyCardData: EmptyCardData;
  onOpenRecording: (data: RecordingStartingPoint) => void;
};
function MotionReview({
  contentRef,
  reviewItems,
  continuousItems,
  relevantPreviews,
  timeRange,
  startTime,
  filter,
  motionOnly = false,
  emptyCardData,
  onOpenRecording,
}: MotionReviewProps) {
  const segmentDuration = 30;
  const { data: config } = useSWR<FrigateConfig>("config");
  const continuous = useContinuous();

  const reviewCameras = useMemo(() => {
    if (!config) {
      return [];
    }

    let cameras;
    if (!filter || !filter.cameras) {
      cameras = Object.values(config.cameras);
    } else {
      const filteredCams = filter.cameras;

      cameras = Object.values(config.cameras).filter((cam) =>
        filteredCams.includes(cam.name),
      );
    }

    return cameras.sort((a, b) => a.ui.order - b.ui.order);
  }, [config, filter]);

  const videoPlayersRef = useRef<{ [camera: string]: PreviewController }>({});

  // motion data

  const { alignStartDateToTimeline, alignEndDateToTimeline } = useTimelineUtils(
    {
      segmentDuration,
    },
  );

  const alignedAfter = alignStartDateToTimeline(timeRange.after);
  const alignedBefore = alignEndDateToTimeline(timeRange.before);

  // fork: upstream fetches motion for the 24 h `timeRange`, but with the continuous strip
  // the handlebar can be weeks back — and `getDetectionType` (the camera-tile severity
  // ring) and `useCameraMotionNextTimestamp` (play-through) both read this. Past 24 h they
  // simply went inert. Follow the playhead instead, in the SAME hour-aligned one-day window
  // the strip's own pages use (F2), so the key only changes when the day changes.
  const continuousTz = continuous.enabled ? continuous.tz : undefined;
  const continuousPlayhead = continuous.enabled
    ? continuous.playhead
    : undefined;
  const motionWindow = useMemo(() => {
    if (!continuousTz) return { after: alignedAfter, before: alignedBefore };
    return dayWindowFor(continuousPlayhead ?? timeRange.before, continuousTz);
  }, [
    continuousTz,
    continuousPlayhead,
    alignedAfter,
    alignedBefore,
    timeRange.before,
  ]);

  const { data: motionData } = useSWR<MotionData[]>([
    "review/activity/motion",
    {
      before: motionWindow.before,
      after: motionWindow.after,
      scale: segmentDuration / 2,
      cameras: filter?.cameras?.join(",") ?? null,
    },
  ]);

  // timeline time

  // fork (F1): with the continuous strip the preview players must be able to follow the
  // handlebar anywhere in the retained range, so the chunk list comes from the provider —
  // one-hour chunks over the whole range, never a multi-day span handed to nginx-vod.
  // Without this, scrubbing past the 24 h window makes `findIndex` return -1 and the
  // seek is silently dropped (§14.3).
  const continuousChunks = continuous.enabled ? continuous.chunks : undefined;
  const continuousWindow = continuous.enabled ? continuous.window : undefined;
  const timeRangeSegments = useMemo(
    () =>
      continuousChunks && continuousWindow
        ? {
            start: continuousWindow.oldest,
            end: continuousWindow.newest,
            ranges: continuousChunks,
          }
        : getChunkedTimeRange(timeRange.after, timeRange.before),
    [timeRange, continuousChunks, continuousWindow],
  );

  const initialIndex = useMemo(() => {
    if (!startTime) {
      return timeRangeSegments.ranges.length - 1;
    }

    return timeRangeSegments.ranges.findIndex(
      (seg) => seg.after <= startTime && seg.before >= startTime,
    );
    // only render once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [selectedRangeIdx, setSelectedRangeIdx] = useState(initialIndex);
  const [currentTime, setCurrentTime] = useState<number>(
    startTime ?? timeRangeSegments.ranges[selectedRangeIdx]?.before,
  );
  const currentTimeRange = useMemo(
    () => timeRangeSegments.ranges[selectedRangeIdx],
    [selectedRangeIdx, timeRangeSegments],
  );

  const [previewStart, setPreviewStart] = useState(startTime);

  const [scrubbing, setScrubbing] = useState(false);
  const [playing, setPlaying] = useState(false);

  // move to next clip

  useEffect(() => {
    if (
      currentTime > currentTimeRange.before + 60 ||
      currentTime < currentTimeRange.after - 60
    ) {
      const index = timeRangeSegments.ranges.findIndex(
        (seg) => seg.after <= currentTime && seg.before >= currentTime,
      );

      if (index != -1) {
        setPreviewStart(currentTime);
        setSelectedRangeIdx(index);
      }
      return;
    }

    Object.values(videoPlayersRef.current).forEach((controller) => {
      controller.scrubToTimestamp(currentTime);
    });
    // only refresh when current time or available segments changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, timeRangeSegments]);

  // playback

  const [playbackRate, setPlaybackRate] = useState(8);
  const [controlsOpen, setControlsOpen] = useState(false);

  const nextTimestamp = useCameraMotionNextTimestamp(
    timeRangeSegments.end,
    segmentDuration,
    motionOnly,
    reviewItems?.all ?? [],
    motionData ?? [],
    currentTime,
  );

  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (nextTimestamp) {
      if (!playing && timeoutIdRef.current != null) {
        clearTimeout(timeoutIdRef.current);
        return;
      }

      if (nextTimestamp >= timeRange.before - 4) {
        setPlaying(false);
        return;
      }

      const handleTimeout = () => {
        setCurrentTime(nextTimestamp);
        timeoutIdRef.current = setTimeout(handleTimeout, 500 / playbackRate);
      };

      timeoutIdRef.current = setTimeout(handleTimeout, 500 / playbackRate);

      return () => {
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
      };
    }
  }, [playing, playbackRate, nextTimestamp, setPlaying, timeRange]);

  const getDetectionType = useCallback(
    (cameraName: string) => {
      if (motionOnly) {
        const segmentStartTime = alignStartDateToTimeline(currentTime);
        const segmentEndTime = segmentStartTime + segmentDuration;
        const matchingItem = motionData?.find((item) => {
          const cameras = item.camera.split(",").map((camera) => camera.trim());
          return (
            item.start_time >= segmentStartTime &&
            item.start_time < segmentEndTime &&
            cameras.includes(cameraName)
          );
        });

        return matchingItem ? "significant_motion" : null;
      } else {
        const segmentStartTime = alignStartDateToTimeline(currentTime);
        const segmentEndTime = segmentStartTime + segmentDuration;
        const matchingItem = reviewItems?.all.find((item) => {
          const endTime = item.end_time ?? timeRange.before;

          return (
            ((item.start_time >= segmentStartTime &&
              item.start_time < segmentEndTime) ||
              (endTime > segmentStartTime && endTime <= segmentEndTime) ||
              (item.start_time <= segmentStartTime &&
                endTime >= segmentEndTime)) &&
            item.camera === cameraName
          );
        });

        return matchingItem ? matchingItem.severity : null;
      }
    },
    [
      reviewItems,
      motionData,
      currentTime,
      timeRange,
      motionOnly,
      alignStartDateToTimeline,
    ],
  );

  // fork: with the continuous strip, "no motion in the last 24 h" is not an empty page —
  // there are weeks of strip below it. Only upstream's 24 h view may bail out here.
  if (!continuous.enabled && motionData?.length === 0) {
    return (
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <EmptyCard
          title={emptyCardData.title}
          description={emptyCardData.description}
          icon={<LuFolderX className="size-16" />}
        />
      </div>
    );
  }

  if (relevantPreviews == undefined) {
    return <ActivityIndicator />;
  }

  return (
    <>
      <div className="no-scrollbar flex flex-1 flex-wrap content-start gap-2 overflow-y-auto md:gap-4">
        <div
          ref={contentRef}
          className={cn(
            "no-scrollbar grid w-full grid-cols-1",
            isMobile && "landscape:grid-cols-2",
            reviewCameras.length > 3 &&
              isMobile &&
              "portrait:md:grid-cols-2 landscape:md:grid-cols-3",
            isDesktop && "grid-cols-2 lg:grid-cols-3",
            "gap-2 overflow-auto px-1 md:mx-2 md:gap-4 xl:grid-cols-3 3xl:grid-cols-4",
          )}
        >
          {reviewCameras.map((camera) => {
            let grow;
            let spans;
            const aspectRatio = camera.detect.width / camera.detect.height;
            if (aspectRatio > 2) {
              grow = "aspect-wide";
              spans = "sm:col-span-2";
            } else if (aspectRatio < 1) {
              grow = "h-full aspect-tall";
              spans = "md:row-span-2";
            } else {
              grow = "aspect-video";
            }
            const detectionType = getDetectionType(camera.name);
            return (
              <div key={camera.name} className={`relative ${spans}`}>
                {motionData ? (
                  <>
                    <PreviewPlayer
                      className={`rounded-lg md:rounded-2xl ${spans} ${grow}`}
                      camera={camera.name}
                      timeRange={currentTimeRange}
                      startTime={previewStart}
                      cameraPreviews={relevantPreviews}
                      isScrubbing={scrubbing}
                      onControllerReady={(controller) => {
                        videoPlayersRef.current[camera.name] = controller;
                      }}
                      onClick={() =>
                        onOpenRecording({
                          camera: camera.name,
                          startTime: Math.min(
                            currentTime,
                            Date.now() / 1000 - 30,
                          ),
                          severity: "significant_motion",
                        })
                      }
                    />
                    <div
                      className={`review-item-ring pointer-events-none absolute inset-0 z-20 size-full rounded-lg outline outline-[3px] -outline-offset-[2.8px] ${detectionType ? `outline-severity_${detectionType} shadow-severity_${detectionType}` : "outline-transparent duration-500"}`}
                    />
                  </>
                ) : (
                  <Skeleton
                    className={`size-full rounded-lg md:rounded-2xl ${spans} ${grow}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div
        className={cn(
          "no-scrollbar w-[55px] md:w-[100px]",
          // Only the FORK strip owns its own scroller (K1 reads that element's scrollTop),
          // so nesting a second one here would split the wheel events. Upstream's
          // MotionReviewTimeline genuinely relies on this wrapper scrolling — leave its
          // branch exactly as upstream had it.
          continuous.enabled ? "relative" : "overflow-y-auto",
        )}
      >
        {/* fork (§8.4 / D4): S3 — the same K1 strip as S4, in `motionOnly` mode. */}
        {continuous.enabled ? (
          <ContinuousMotionStrip
            surface="motion"
            cameras={reviewCameras.map((c) => c.name).join(",")}
            events={continuousItems ?? []}
            segmentDuration={segmentDuration}
            timestampSpread={15}
            motionOnly={motionOnly}
            showHandlebar
            handlebarTime={currentTime}
            setHandlebarTime={setCurrentTime}
            contentRef={contentRef}
            onHandlebarDraggingChange={(dragging) => {
              if (playing && dragging) {
                setPlaying(false);
              }
              setScrubbing(dragging);
            }}
            dense={isMobileOnly}
            isZooming={false}
            zoomDirection={null}
            alwaysShowMotionLine={true}
          />
        ) : motionData ? (
          <MotionReviewTimeline
            segmentDuration={segmentDuration}
            timestampSpread={15}
            timelineStart={timeRangeSegments.end}
            timelineEnd={timeRangeSegments.start}
            motionOnly={motionOnly}
            showHandlebar
            handlebarTime={currentTime}
            setHandlebarTime={setCurrentTime}
            events={reviewItems?.all ?? []}
            motion_events={motionData ?? []}
            contentRef={contentRef}
            onHandlebarDraggingChange={(scrubbing) => {
              if (playing && scrubbing) {
                setPlaying(false);
              }

              setScrubbing(scrubbing);
            }}
            dense={isMobileOnly}
            isZooming={false}
            zoomDirection={null}
            alwaysShowMotionLine={true}
          />
        ) : (
          <Skeleton className="size-full" />
        )}
      </div>

      <VideoControls
        className="absolute bottom-16 left-1/2 -translate-x-1/2 bg-secondary"
        features={{
          volume: false,
          seek: true,
          playbackRate: true,
          fullscreen: false,
        }}
        isPlaying={playing}
        show={!scrubbing || controlsOpen}
        playbackRates={[4, 8, 12, 16]}
        playbackRate={playbackRate}
        setControlsOpen={setControlsOpen}
        onPlayPause={setPlaying}
        onSeek={(diff) => {
          const wasPlaying = playing;

          if (wasPlaying) {
            setPlaying(false);
          }

          setCurrentTime(currentTime + diff);

          if (wasPlaying) {
            setTimeout(() => setPlaying(true), 100);
          }
        }}
        onSetPlaybackRate={setPlaybackRate}
      />
    </>
  );
}
