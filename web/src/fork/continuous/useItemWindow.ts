/**
 * fork/continuous — K2: the variable-height, item-indexed virtualizer kernel (§4A.5).
 *
 * A thin wrapper over `@tanstack/react-virtual` (D22 / Q6: headless, ~4 KB, keeps the
 * upstream cell DOM and Tailwind untouched). Adds what the continuous surfaces need:
 *  - items are newest-first; growth at the END (older) is free, growth at the HEAD (the
 *    live tail) is compensated in a `useLayoutEffect` by the estimated height of the
 *    prepended items so nothing on screen moves (§9.2) unless the user is stuck to the
 *    top (§9.3). TanStack then corrects estimate→measured deltas for items above the
 *    viewport itself (`shouldAdjustScrollPositionOnItemSizeChange`).
 *  - `onNearEnd` fires when the last rendered index is within LOAD_OLDER_ITEMS of the end;
 *    the provider's page grid makes repeated calls idempotent (F12).
 *  - Family C cells (ReviewGroup) change height after mount; `measureElement` on each row
 *    handles it — callers must attach `virtualizer.measureElement` as the row ref.
 */
import {
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

export const LOAD_OLDER_ITEMS = 12;
export const STICK_THRESHOLD_PX = 24;

export function useItemWindow<T extends { id: string }>(params: {
  scrollRef: RefObject<HTMLDivElement>;
  items: T[];
  estimateSize: (index: number) => number;
  gap?: number;
  onNearEnd?: () => void;
  lanes?: number;
}) {
  const {
    scrollRef,
    items,
    estimateSize,
    gap = 16,
    onNearEnd,
    lanes = 1,
  } = params;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 6,
    gap,
    lanes,
    getItemKey: (i) => items[i]?.id ?? i,
  });

  /**
   * §9.2 — keep what the user is looking at exactly where it is.
   *
   * Measured from the DOM, deliberately, after three cheaper things that do not work:
   *
   *  - counting inserted items is wrong on a multi-column grid: `n` new cards shift the
   *    rest by `ceil((head + n) / columns) - ceil(head / columns)` ROWS, i.e. 0 or 1,
   *    never n/columns;
   *  - asking the virtualizer (`getOffsetForIndex`) is wrong too — a just-arrived card has
   *    not been measured, and its cached offsets lag the commit that inserted it;
   *  - re-choosing the anchor on every commit is worst of all, because it looks like it
   *    works: cards shift one position per arrival, so the card at the scroll position is a
   *    different card each time and the new anchor is always exactly where expected. The
   *    correction never fires and nothing says so.
   *
   * So: a STICKY anchor. Adopt the first row at the scroll position when the user scrolls,
   * then hold that row and put it back where it was on every commit. Exact — measured with
   * two full rows of arrivals: anchor moved 0 px, `scrollTop` corrected by 512 px.
   *
   * Rows must carry `data-continuous-id`, and it must be on the CARD, not on a row wrapper:
   * row groupings are derived from their first card, so every insertion renames every row
   * and the anchor could never be found again.
   */
  const anchorRef = useRef<{ id: string; viewportY: number } | null>(null);
  /** Set while WE move the scroller, so the scroll listener does not re-anchor on it. */
  const selfScroll = useRef(false);

  const measureRow = useCallback(
    (id: string): number | null => {
      const el = scrollRef.current;
      if (!el) return null;
      const node = el.querySelector<HTMLElement>(
        `[data-continuous-id="${CSS.escape(id)}"]`,
      );
      if (!node) return null;
      // VIEWPORT position, not content offset. Storing where the row sits on screen makes
      // the correction self-levelling: every commit measures the CURRENT error and removes
      // it, so a missed or doubled shift cannot accumulate. Deltas against a stored content
      // offset do accumulate, and did — measured over-correcting by a full row.
      return node.getBoundingClientRect().top - el.getBoundingClientRect().top;
    },
    [scrollRef],
  );

  /** Adopt the first row at or below the current scroll position as the anchor. */
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    let best: { id: string; viewportY: number } | null = null;
    for (const node of el.querySelectorAll<HTMLElement>(
      "[data-continuous-id]",
    )) {
      const id = node.dataset.continuousId;
      if (!id) continue;
      const rect = node.getBoundingClientRect();
      const viewportY = rect.top - box.top;
      if (viewportY + rect.height <= 0) continue; // fully above the viewport
      if (!best || viewportY < best.viewportY) best = { id, viewportY };
    }
    anchorRef.current = best;
  }, [scrollRef]);

  /**
   * The anchor is STICKY — chosen when the user scrolls, and then held.
   *
   * Re-choosing it on every commit (the obvious thing, and what this did first) silently
   * disables the whole mechanism: cards shift one position per arrival, so the card sitting
   * at the scroll position is a DIFFERENT card each time, and a freshly chosen anchor is by
   * definition exactly where it was expected to be. Measured: `prev.id` changing on every
   * commit, `now === prev.offset` every time, `scrollTop` never corrected, and the view
   * walking down two full rows when two rows' worth of items arrived.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      // Our own compensation writes `scrollTop`, which fires this. Re-capturing on that
      // adopts a position mid-shift and the NEXT shift then measures as zero — measured as
      // exactly one row of drift out of two rows' worth of arrivals, intermittently.
      if (selfScroll.current) {
        selfScroll.current = false;
        return;
      }
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        captureAnchor();
      });
    };
    captureAnchor();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollRef, captureAnchor]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = anchorRef.current;
    if (!prev) {
      captureAnchor();
      return;
    }
    // §9.3: pinned to now — let new items push in, do not fight them
    if (el.scrollTop < STICK_THRESHOLD_PX) {
      captureAnchor();
      return;
    }
    const now = measureRow(prev.id);
    if (now == null) {
      // the anchor row is no longer rendered (a big jump, or it was deleted) — nothing
      // trustworthy to compensate against, so adopt a new one rather than guess
      captureAnchor();
      return;
    }
    // put the row back on the same line of the screen; `now - viewportY` is the CURRENT
    // error, not an accumulated delta, so nothing compounds and the anchor is kept as-is
    if (Math.round(now) !== Math.round(prev.viewportY)) {
      selfScroll.current = true;
      el.scrollTop += now - prev.viewportY;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  /**
   * Chrome's CSS scroll anchoring also moves `scrollTop` when content above the viewport
   * resizes, with no JS involved — measured drifting the view by ~20 px per inserted card
   * while our own compensation was running, so the two fought and the result was neither.
   * Turn it off and own the behaviour; restored on unmount so the upstream grid (toggle
   * off) is untouched.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const previous = el.style.overflowAnchor;
    el.style.overflowAnchor = "none";
    return () => {
      el.style.overflowAnchor = previous;
    };
  }, [scrollRef]);

  const virtualItems = virtualizer.getVirtualItems();
  const last = virtualItems[virtualItems.length - 1];
  // Fire in an effect, NOT during render: `onNearEnd` is `ctx.loadOlder`, which sets state
  // on the PROVIDER — a render-phase update of a different component, which React warns
  // about and which can drop the update. `nearEnd` stays true while the user sits at the
  // bottom, so the effect re-fires on every `items.length` change and the window keeps
  // chaining; repeated calls are idempotent against the provider's page grid (F12).
  const nearEnd = !!(last && last.index >= items.length - LOAD_OLDER_ITEMS);
  useEffect(() => {
    if (nearEnd) onNearEnd?.();
  }, [nearEnd, items.length, onNearEnd]);

  const scrollToId = useCallback(
    (
      id: string,
      opts?: { align?: "start" | "center"; behavior?: ScrollBehavior },
    ) => {
      const idx = items.findIndex((it) => it.id === id);
      if (idx === -1) return false;
      virtualizer.scrollToIndex(idx, {
        align: opts?.align ?? "center",
        // NOT smooth by default: the §9.2 compensation above writes `scrollTop` directly,
        // and any such write cancels an in-flight smooth scroll — a navigation that lands
        // mid-animation just stops wherever it got to. The chip's scroll-to-top already
        // avoids smooth for the same reason.
        behavior: opts?.behavior ?? "auto",
      });
      return true;
    },
    [items, virtualizer],
  );

  /** Index of the newest item whose start_time <= t (items are newest-first). */
  const scrollToIndex = useCallback(
    (
      idx: number,
      opts?: { align?: "start" | "center"; behavior?: ScrollBehavior },
    ) =>
      virtualizer.scrollToIndex(Math.max(0, Math.min(items.length - 1, idx)), {
        align: opts?.align ?? "start",
        behavior: opts?.behavior ?? "auto", // see scrollToId
      }),
    [items.length, virtualizer],
  );

  return { virtualizer, virtualItems, scrollToId, scrollToIndex };
}
