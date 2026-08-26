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
};

export function useFixedPitchWindow({
  scrollRef,
  count,
  startAligned,
  segmentDuration,
  onNearBottom,
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
