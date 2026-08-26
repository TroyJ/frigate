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

  // prepend compensation (§9.2): detect new items at the head by id
  const headId = useRef<string | undefined>(items[0]?.id);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prevHead = headId.current;
    headId.current = items[0]?.id;
    if (!el || !prevHead || items[0]?.id === prevHead) return;
    const idx = items.findIndex((it) => it.id === prevHead);
    if (idx <= 0) return; // head removed or unknown — nothing to compensate
    const stick = el.scrollTop < STICK_THRESHOLD_PX;
    if (stick) return;
    let added = 0;
    for (let i = 0; i < idx; i++) added += estimateSize(i) + gap;
    el.scrollTop += added / lanes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

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
