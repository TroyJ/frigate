/**
 * fork/continuous — S6: the History `detail` tab as a virtualized, continuous list of
 * upstream's ReviewGroup (Family C: height changes after mount when a group expands, so
 * every row is measured via `measureElement`). The container logic mirrors upstream's
 * DetailStream (active-review tracking, auto-scroll during playback via
 * useUserInteraction, the settings drawer) — that component is not reused because it
 * owns the unvirtualized map (F4). ReviewGroup itself is imported (typed coupling, §7.4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import { isDesktop } from "react-device-detect";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { PiSlidersHorizontalBold } from "react-icons/pi";
import { cn } from "@/lib/utils";
import { FrigateConfig } from "@/types/frigateConfig";
import { ReviewSegment } from "@/types/review";
import { Event } from "@/types/event";
import { useDetailStream } from "@/context/detail-stream-context";
import { useUserPersistence } from "@/hooks/use-user-persistence";
import useUserInteraction from "@/hooks/use-user-interaction";
import { ReviewGroup } from "@/components/timeline/DetailStream";
import AnnotationOffsetSlider from "@/components/overlay/detail/AnnotationOffsetSlider";
import { FrigatePlusDialog } from "@/components/overlay/dialog/FrigatePlusDialog";
import { Switch } from "@/components/ui/switch";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { useContinuousStrict } from "./ContinuousProvider";
import { useItemWindow } from "./useItemWindow";
import { startOfNextDayInTz } from "./timeAlign";

type Props = {
  items: ReviewSegment[];
  currentTime: number;
  isPlaying?: boolean;
  onSeek: (timestamp: number, play?: boolean) => void;
};

const GROUP_ESTIMATE = 72; // collapsed header row

export function ContinuousDetailStream({
  items,
  currentTime,
  isPlaying = false,
  onSeek,
}: Props) {
  const { data: config } = useSWR<FrigateConfig>("config");
  const { t } = useTranslation("views/events");
  const { annotationOffset } = useDetailStream();
  const ctx = useContinuousStrict();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { userInteracting } = useUserInteraction({ elementRef: scrollRef });
  const effectiveTime = currentTime - annotationOffset / 1000;

  const [activeId, setActiveId] = useState<string>();
  const [upload, setUpload] = useState<Event | undefined>(undefined);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [alwaysExpandActive, setAlwaysExpandActive] = useUserPersistence(
    "detailStreamActiveExpanded",
    true,
  );

  const list = useMemo(
    () => items.filter((r) => r.severity !== "significant_motion"),
    [items],
  );
  const onNearEnd = useCallback(() => ctx.loadOlder(), [ctx]);
  const estimate = useCallback(() => GROUP_ESTIMATE, []);
  const win = useItemWindow({
    scrollRef,
    items: list,
    estimateSize: estimate,
    onNearEnd,
    gap: 16,
  });

  // active review follows effectiveTime (upstream behaviour)
  useEffect(() => {
    const hit = list.find(
      (r) =>
        effectiveTime >= r.start_time &&
        effectiveTime <= (r.end_time ?? r.start_time),
    );
    if (hit) setActiveId(hit.id);
  }, [effectiveTime, list]);

  // auto-scroll during playback unless the user is interacting
  useEffect(() => {
    if (!activeId || userInteracting || !isPlaying) return;
    win.scrollToId(activeId, { align: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, isPlaying]);

  useEffect(
    () =>
      ctx.registerSurface("detail", {
        scrollToTime: (t, selectId) => {
          if (selectId) {
            setActiveId(selectId);
            if (win.scrollToId(selectId)) return;
          }
          const nextDay = startOfNextDayInTz(t, ctx.tz);
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].start_time < nextDay) {
              win.scrollToIndex(i, { align: "start" });
              return;
            }
          }
        },
      }),
    [ctx, win, list],
  );

  if (!config) return <ActivityIndicator />;

  return (
    <>
      <FrigatePlusDialog
        upload={upload}
        onClose={() => setUpload(undefined)}
        onEventUploaded={() => {
          if (upload) upload.plus_id = "new_upload";
        }}
      />
      <div className="relative flex h-full flex-col">
        <div
          ref={scrollRef}
          className="scrollbar-container flex-1 overflow-y-auto overflow-x-hidden pb-14"
        >
          {list.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {t("detail.noDataFound")}
            </div>
          ) : (
            <div
              className="relative w-full py-2"
              style={{ height: `${win.virtualizer.getTotalSize()}px` }}
            >
              {win.virtualItems.map((v) => {
                const review = list[v.index];
                const id = `review-${review.id}`;
                return (
                  <div
                    key={v.key}
                    ref={win.virtualizer.measureElement}
                    data-index={v.index}
                    className="absolute left-0 w-full"
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    <ReviewGroup
                      id={id}
                      review={review}
                      config={config}
                      onSeek={(ts, play) => onSeek(ts, play ?? isPlaying)}
                      effectiveTime={effectiveTime}
                      annotationOffset={annotationOffset}
                      isActive={activeId === review.id}
                      onActivate={() => setActiveId(review.id)}
                      onOpenUpload={(e) => setUpload(e)}
                      alwaysExpandActive={alwaysExpandActive}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div
          className={cn(
            "absolute bottom-0 left-0 right-0 z-30 rounded-t-md border border-secondary-highlight bg-background_alt shadow-md",
            isDesktop && "border-b-0",
          )}
        >
          <button
            onClick={() => setControlsExpanded(!controlsExpanded)}
            className="flex w-full items-center justify-between p-3"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <PiSlidersHorizontalBold className="size-4" />
              <span>{t("detail.settings")}</span>
            </div>
            {controlsExpanded ? (
              <LuChevronDown className="size-4 text-primary-variant" />
            ) : (
              <LuChevronRight className="size-4 text-primary-variant" />
            )}
          </button>
          {controlsExpanded && (
            <div className="space-y-3 px-3 pb-3">
              <AnnotationOffsetSlider />
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">
                    {t("detail.alwaysExpandActive.title")}
                  </label>
                  <Switch
                    checked={alwaysExpandActive}
                    onCheckedChange={setAlwaysExpandActive}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("detail.alwaysExpandActive.desc")}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
