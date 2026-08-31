/**
 * fork/continuous — K1: the fixed-pitch, time-indexed virtualizer kernel (§4A.5, §9.2).
 *
 * Rows are SEGMENT_HEIGHT (8 px) tall and row i's time is pure arithmetic:
 *   time(i) = startAligned - i * segmentDuration
 * so no measurement is needed — a virtualization library would add weight and remove
 * exactness (§12.2). What this kernel adds over upstream's VirtualizedMotionSegments is
 * bidirectional growth with exact scroll compensation:
 *
 *  - Growing at the BOTTOM (older) is free: the pixel origin is the newest edge, so
 *    existing rows keep their y (§3.4).
 *  - Growing at the TOP (newer, the live tail) moves every row down by k * 8 px. In the
 *    same frame (`useLayoutEffect`, NOT `useEffect`, or the user sees a jump) we add
 *    k * SEGMENT_HEIGHT to scrollTop — unless the user is "stuck to top", in which case the
 *    view stays pinned to now (§9.3, chat-log behaviour inverted).
 *
 * SEGMENT_HEIGHT = 8 is duplicated in upstream's use-timeline-utils.ts (`segmentHeight`)
 * and VirtualizedMotionSegments.tsx; if one changes the others must (§3.4).
 *
 * `loadOlder` is fired from a sentinel distance, debounced by the provider's page grid —
 * repeated calls while a page is loading are no-ops (F12).
 */
import {
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const SEGMENT_HEIGHT = 8;
export const OVERSCAN_COUNT = 20;
/** ≈2 rows: within this of the top the view is considered pinned to "now" (§9.3). */
export const STICK_THRESHOLD_PX = 2 * SEGMENT_HEIGHT;
/** Ask for older data when within this many rows of the bottom. */
export const LOAD_OLDER_ROWS = 120;

export type FixedPitchWindow = {
  /** Index range of rows to render, [start, end). */
  visible: { start: number; end: number };
  stickToTop: boolean;
  /** Programmatic scroll to a row index (centred unless `align`). */
  scrollToIndex: (
    index: number,
    opts?: {
      align?: "start" | "center";
      behavior?: ScrollBehavior;
      ifNeeded?: boolean;
      /**
       * Skip the scroll when the target is NOT already near the viewport.
       *
       * Strictly it is "only if NEARBY" — the target must be within one viewport of the
       * viewport, not literally on screen — and it is NOT the inverse of `ifNeeded`: both
       * suppress a scroll, they just disagree about which ones deserve it. `ifNeeded` asks
       * "is it already comfortably on screen, so moving would be a pointless yank?".
       * `onlyIfVisible` asks "is the caller allowed to drag the viewport somewhere the user
       * did not ask to go?" — for an automatic follow the answer is no. See the strip-reset
       * comment in `ContinuousMotionStrip`.
       */
      onlyIfVisible?: boolean;
    },
  ) => void;
  refresh: () => void;
};

type Params = {
  scrollRef: RefObject<HTMLDivElement>;
  /** Total row count (loaded span / segmentDuration). */
  count: number;
  /** Aligned newest time (row 0). When this moves forward, rows were prepended. */
  startAligned: number;
  segmentDuration: number;
  onNearBottom?: () => void;
  /**
   * A value that changes when a review page ARRIVES — callers pass `ctx.pagesLoaded`.
   *
   * Without it this surface can stop extending for good. `onNearBottom` is only evaluated
   * from `update()`, which runs on SCROLL events — and a scroller already pinned at its
   * maximum emits none, whether the user is pushing against the bottom or a gate is setting
   * `scrollTop = scrollHeight` again. So when `loadOlder` happens to no-op (it does exactly
   * that while `MAX_INFLIGHT_PAGES` are in flight), nothing re-tries once those pages land:
   * measured on the History strip as 30 pulls at 744 h against a 763 h floor with only 8
   * `/review` requests in 51 s — the app had stopped asking, one page short of the bottom.
   *
   * It must be an ARRIVAL counter, never the window edge: the edge is `loadOlder`'s own
   * output, and keying a load-more trigger on its own side effect is the runaway this build
   * has already paid for twice (see `useItemWindow`).
   */
  windowKey?: number;
};

export function useFixedPitchWindow({
  scrollRef,
  count,
  startAligned,
  segmentDuration,
  onNearBottom,
  windowKey,
}: Params): FixedPitchWindow {
  const [visible, setVisible] = useState({ start: 0, end: 0 });
  const stickRef = useRef(true);
  const [stickToTop, setStick] = useState(true);
  const prevStart = useRef(startAligned);
  const prevDuration = useRef(segmentDuration);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, clientHeight } = el;
    const start = Math.max(
      0,
      Math.floor(scrollTop / SEGMENT_HEIGHT) - OVERSCAN_COUNT,
    );
    const end = Math.min(
      count,
      Math.ceil((scrollTop + clientHeight) / SEGMENT_HEIGHT) + OVERSCAN_COUNT,
    );
    setVisible((v) =>
      v.start === start && v.end === end ? v : { start, end },
    );
    const stick = scrollTop < STICK_THRESHOLD_PX;
    if (stick !== stickRef.current) {
      stickRef.current = stick;
      setStick(stick);
    }
    if (onNearBottom && end >= count - LOAD_OLDER_ROWS) onNearBottom();
  }, [scrollRef, count, onNearBottom]);

  // Re-evaluate when a page ARRIVES, not only when the user scrolls — see `windowKey`. The
  // callback is held in a ref so this effect fires on arrivals alone; `update`'s identity
  // changes with `count` and `onNearBottom`, and depending on it would re-arm the trigger on
  // renders that have nothing to do with new data.
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(() => {
    updateRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey]);

  // scroll + resize listeners, rAF-throttled and passive (upstream's pattern)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", update);
    };
  }, [scrollRef, update]);

  // §9.2: exact prepend compensation, before paint
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (prevDuration.current !== segmentDuration) {
      // zoom change: the caller re-scrolls to the handlebar (§14.5); just resync
      prevDuration.current = segmentDuration;
      prevStart.current = startAligned;
      return;
    }
    const delta = startAligned - prevStart.current;
    prevStart.current = startAligned;
    if (!el || delta <= 0) return;
    const rows = Math.round(delta / segmentDuration);
    if (rows > 0 && !stickRef.current) {
      el.scrollTop += rows * SEGMENT_HEIGHT;
    }
    update();
  }, [startAligned, segmentDuration, scrollRef, update]);

  const scrollToIndex = useCallback<FixedPitchWindow["scrollToIndex"]>(
    (index, opts) => {
      const el = scrollRef.current;
      if (!el) return;
      const target = index * SEGMENT_HEIGHT;
      const top =
        opts?.align === "start"
          ? target
          : target - el.clientHeight / 2 + SEGMENT_HEIGHT / 2;
      if (opts?.ifNeeded) {
        const { scrollTop, clientHeight } = el;
        if (
          target > scrollTop + OVERSCAN_COUNT * SEGMENT_HEIGHT &&
          target < scrollTop + clientHeight - OVERSCAN_COUNT * SEGMENT_HEIGHT
        ) {
          return;
        }
      }
      // One viewport of slack on each side, so a playhead that has just drifted off the edge
      // is still followed — that is the case the follow exists for — while one that is days
      // away is not chased.
      if (opts?.onlyIfVisible) {
        const { scrollTop, clientHeight } = el;
        if (
          target < scrollTop - clientHeight ||
          target > scrollTop + 2 * clientHeight
        ) {
          return;
        }
      }
      el.scrollTo({
        top: Math.max(0, top),
        behavior: opts?.behavior ?? "smooth",
      });
      update();
    },
    [scrollRef, update],
  );

  return { visible, stickToTop, scrollToIndex, refresh: update };
}
