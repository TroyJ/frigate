/**
 * fork/continuous — S5: the History `events` tab as a virtualized, continuous list.
 * K2 + upstream's ReviewCard (imported unchanged, typed coupling only — §7.4). Each card
 * sits in an `aspect-video` box so its skeleton occupies real space before the thumbnail
 * lands (§11.2 P2 — the "no placeholders" Troy saw). `significant_motion` rows are
 * filtered BEFORE virtualizing (§14.11). D14: a day-jump lands on the day's earliest item.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isMobile } from "react-device-detect";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { REVIEW_PADDING, ReviewSegment } from "@/types/review";
import ReviewCard from "@/components/card/ReviewCard";
import { useContinuousStrict } from "./ContinuousProvider";
import { useItemWindow } from "./useItemWindow";
import { indexAtOrAfter } from "./dayNav";

type Props = {
  items: ReviewSegment[];
  activeReviewItem?: ReviewSegment;
  onSelect: (review: ReviewSegment) => void;
};

const CARD_ESTIMATE = 220; // 16:9 thumb at ~20rem wide + the caption row

export function ContinuousEventList({
  items,
  activeReviewItem,
  onSelect,
}: Props) {
  const { t } = useTranslation(["views/events"]);
  const ctx = useContinuousStrict();
  const scrollRef = useRef<HTMLDivElement>(null);
  const list = useMemo(
    () => items.filter((r) => r.severity !== "significant_motion"),
    [items],
  );
  const onNearEnd = useCallback(() => ctx.loadOlder(), [ctx]);
  const estimate = useCallback(() => CARD_ESTIMATE, []);
  const win = useItemWindow({
    scrollRef,
    items: list,
    estimateSize: estimate,
    onNearEnd,
    lanes: isMobile ? 2 : 1,
  });

  useEffect(
    () =>
      ctx.registerSurface("events", {
        scrollToTop: () => win.scrollToIndex(0, { align: "start" }),
        scrollToTime: (t, selectId) => {
          if (selectId && win.scrollToId(selectId)) return;
          // one primitive for both callers (see dayNav.ts): a segment click passes the
          // moment, a calendar day-jump passes 00:00 box time and gets D14's "the day's
          // earliest review" from the same scan.
          const idx = indexAtOrAfter(list, t);
          if (idx >= 0) win.scrollToIndex(idx, { align: "start" });
        },
      }),
    [ctx, win, list],
  );

  return (
    <div
      ref={scrollRef}
      className="scrollbar-container h-full overflow-auto bg-secondary"
    >
      {list.length === 0 ? (
        <div className="mt-5 text-center text-primary">
          {t("events.noFoundForTimePeriod")}
        </div>
      ) : (
        <div
          className="relative w-full p-4"
          style={{ height: `${win.virtualizer.getTotalSize()}px` }}
        >
          {win.virtualItems.map((v) => {
            const review = list[v.index];
            return (
              <div
                key={v.key}
                ref={win.virtualizer.measureElement}
                data-index={v.index}
                data-continuous-id={review.id}
                className={cn(
                  "absolute left-0 w-full px-4",
                  isMobile && "sm:portrait:w-1/2",
                )}
                style={{
                  transform: `translateY(${v.start}px)`,
                  left: v.lane ? "50%" : 0,
                }}
              >
                <div className="aspect-video w-full">
                  <ReviewCard
                    event={review}
                    activeReviewItem={activeReviewItem}
                    onClick={() => onSelect(review)}
                  />
                </div>
              </div>
            );
          })}
          {ctx.isLoadingOlder && (
            <div className="absolute inset-x-0 bottom-0 py-2 text-center text-xs text-muted-foreground">
              …
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const CONTINUOUS_EVENT_PADDING = REVIEW_PADDING;
