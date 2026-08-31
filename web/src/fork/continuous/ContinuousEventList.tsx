/**
 * fork/continuous — S5: the History `events` tab as a virtualized, continuous list.
 * K2 + upstream's ReviewCard (imported unchanged, typed coupling only — §7.4). Each card
 * sits in an `aspect-video` box so its skeleton occupies real space before the thumbnail
 * lands (§11.2 P2 — the "no placeholders" Troy saw). `significant_motion` rows are
 * filtered BEFORE virtualizing (§14.11). D14: a day-jump lands on the day's earliest item.
 *
 * List A #17: the lane count is ONE decision (`eventListLanes.ts`) that drives the
 * virtualizer AND the item geometry. It used to be two — `lanes: isMobile ? 2 : 1` for the
 * virtualizer and a `sm:portrait:w-1/2` Tailwind class for the width — and on a phone in
 * portrait they disagreed: two full-width items per row, the second one clipped off the
 * right edge. There is deliberately no width/offset class left here; both come from
 * `lanes`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMobile } from "react-device-detect";
import { useTranslation } from "react-i18next";
import { REVIEW_PADDING, ReviewSegment } from "@/types/review";
import ReviewCard from "@/components/card/ReviewCard";
import { useContinuousStrict } from "./ContinuousProvider";
import { useItemWindow } from "./useItemWindow";
import { indexAtOrAfter } from "./dayNav";
import { lanesFor, SM_BREAKPOINT } from "./eventListLanes";

type Props = {
  items: ReviewSegment[];
  activeReviewItem?: ReviewSegment;
  onSelect: (review: ReviewSegment) => void;
};

const CARD_ESTIMATE = 220; // 16:9 thumb at ~20rem wide + the caption row

/** What `lanesFor` needs, read from the live document (SSR-safe). */
function readLaneInputs() {
  if (typeof window === "undefined")
    return { mobile: isMobile, width: 1280, portrait: false };
  return {
    mobile: isMobile,
    width: document.documentElement.clientWidth || window.innerWidth,
    portrait: window.matchMedia
      ? window.matchMedia("(orientation: portrait)").matches
      : false,
  };
}

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
  // `ctx.loadOlder`, not `ctx`: the context object is a new identity on every provider
  // render, and this callback's identity is what re-arms the near-end effect.
  const ctxLoadOlder = ctx.loadOlder;
  const onNearEnd = useCallback(() => ctxLoadOlder(), [ctxLoadOlder]);
  const estimate = useCallback(() => CARD_ESTIMATE, []);
  /**
   * One lane, or two — see `eventListLanes.ts` for the rule and the defect.
   *
   * Read from media queries rather than from a stored width: `(orientation: portrait)` is a
   * property of the device that no iframe sizing can distort, and `clientWidth` is the same
   * CSS viewport width a `min-width` query evaluates. The two MQLs are also the only events
   * that can change the answer (a rotation, or crossing `sm`), so they are the listeners.
   */
  const [lanes, setLanes] = useState(() => lanesFor(readLaneInputs()));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const queries = [
      window.matchMedia("(orientation: portrait)"),
      window.matchMedia(`(min-width: ${SM_BREAKPOINT}px)`),
    ];
    const onChange = () => setLanes(lanesFor(readLaneInputs()));
    onChange();
    // `addEventListener` on a MediaQueryList is the modern form; older iOS WebKit — the
    // engine this fix is for — only has `addListener`.
    for (const q of queries) {
      if (q.addEventListener) q.addEventListener("change", onChange);
      else q.addListener(onChange);
    }
    return () => {
      for (const q of queries) {
        if (q.removeEventListener) q.removeEventListener("change", onChange);
        else q.removeListener(onChange);
      }
    };
  }, []);
  const twoLanes = lanes === 2;
  const win = useItemWindow({
    scrollRef,
    items: list,
    estimateSize: estimate,
    onNearEnd,
    // a page can land with no items this list shows — see `windowKey`
    windowKey: ctx.pagesLoaded,
    // a filter change discards every page without remounting us — see `resetKey`
    resetKey: ctx.filterKey,
    lanes,
  });

  useEffect(
    () =>
      ctx.registerSurface("events", {
        scrollToTop: () => win.scrollToIndex(0, { align: "start" }),
        scrollToTime: (t, opts) => {
          if (opts?.selectId && win.scrollToId(opts.selectId)) return;
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
      // the lane count the list actually resolved. The geometry is inline, so "how many
      // cards per row" is not otherwise readable from a gate — and this attribute is what
      // the iOS Simulator run reads back after a ship (List A #17).
      data-continuous-lanes={lanes}
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
                // width and offset come from `lanes`, NOT from a Tailwind class: the class
                // (`sm:portrait:w-1/2`) and the virtualizer's lane count were two separate
                // rules and they disagreed on a portrait phone. One source now.
                className="absolute px-4"
                style={{
                  transform: `translateY(${v.start}px)`,
                  left: twoLanes && v.lane ? "50%" : 0,
                  width: twoLanes ? "50%" : "100%",
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
