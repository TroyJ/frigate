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
   * Measured from the DOM, deliberately, after trying two cheaper things that do not work:
   *
   *  - counting inserted items is wrong on a multi-lane grid: `n` new cards shift the rest
   *    by `ceil((head + n) / lanes) - ceil(head / lanes)` ROWS, i.e. 0 or 1, never n/lanes;
   *  - asking the virtualizer (`getOffsetForIndex`) is wrong too, because a just-arrived
   *    card has not been measured, and its cached offsets lag the commit that inserted it —
   *    measured returning the pre-insert offset for the anchor on the very commit that
   *    added a row, i.e. exactly when compensation was needed.
   *
   * So the anchor is a real element: remember the first visible row's id and its offset
   * inside the scrolled content, and on the next commit put it back where it was. Truthful
   * by construction, independent of estimate accuracy and of the virtualizer's internals.
   * Rows must therefore carry `data-continuous-id`; a row that scrolled out of the rendered
   * set simply skips compensation for that commit rather than guessing.
   *
   * KNOWN LIMIT — a WRAPPING GRID REFLOWS, and no scroll offset can hide that. When one
   * card is inserted at the head of a `c`-column grid, every later card moves one position,
   * so roughly 1/c of them cross into the previous row while the rest do not move at all.
   * There is no single delta that holds them all still: the layout is not a translation
   * until a whole row's worth (`c` cards) has arrived, at which point it is, and this
   * compensation cancels it exactly. Measured: individual cards can move by up to one row
   * mid-burst; the drift does not accumulate.
   *
   * K1 — the strips, which is what §9.2 was actually written about — has no such problem:
   * one column, fixed 8 px rows, exact by arithmetic.
   */
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);

  const measureRow = useCallback(
    (id: string): number | null => {
      const el = scrollRef.current;
      if (!el) return null;
      const node = el.querySelector<HTMLElement>(
        `[data-continuous-id="${CSS.escape(id)}"]`,
      );
      if (!node) return null;
      return (
        node.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop
      );
    },
    [scrollRef],
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = anchorRef.current;
    // §9.3: pinned to now — let new items push in, do not fight them
    const stick = el.scrollTop < STICK_THRESHOLD_PX;
    if (prev && !stick) {
      const now = measureRow(prev.id);
      if (now != null && now !== prev.offset) {
        el.scrollTop += now - prev.offset;
      }
    }
    // re-anchor on whatever is at the top of the viewport now
    const top = el.scrollTop;
    let best: { id: string; offset: number } | null = null;
    for (const node of el.querySelectorAll<HTMLElement>(
      "[data-continuous-id]",
    )) {
      const id = node.dataset.continuousId;
      if (!id) continue;
      const offset =
        node.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop;
      if (offset + node.offsetHeight <= top) continue;
      if (!best || offset < best.offset) best = { id, offset };
    }
    anchorRef.current = best;
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
        behavior: opts?.behavior ?? "smooth",
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
        behavior: opts?.behavior ?? "smooth",
      }),
    [items.length, virtualizer],
  );

  return { virtualizer, virtualItems, scrollToId, scrollToIndex };
}
