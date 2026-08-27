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
 *  - `onNearEnd` fires when less than one viewport of loaded content remains below the
 *    scroll position; the provider's page grid makes repeated calls idempotent (F12).
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

/**
 * Extend the window when less than this much loaded content is left below the viewport,
 * as a multiple of the viewport height. A PIXEL distance, deliberately not an item count.
 *
 * It used to be `last.index >= items.length - 12`, calibrated when this virtualized one
 * CARD per index (12 cards ≈ one screenful). The Review grid now virtualizes by ROW at a
 * measured ~256 px pitch (§9.2), so the same 12 became three screenfuls of lookahead: on a
 * plain page load, with nobody scrolling, the grid chained the shared window ~16 days deep
 * in under two seconds and spent five `/review` pages doing it. Distance-from-the-bottom is
 * the honest rule and it is unit-correct for both consumers — rows in the grid, cards in
 * `ContinuousEventList`.
 */
const LOOKAHEAD_VIEWPORTS = 1;
/** Before layout `clientHeight` is 0; without a floor, an empty list would never extend. */
const MIN_LOOKAHEAD_PX = 400;
export const STICK_THRESHOLD_PX = 24;

export function useItemWindow<T extends { id: string }>(params: {
  scrollRef: RefObject<HTMLDivElement>;
  items: T[];
  estimateSize: (index: number) => number;
  gap?: number;
  onNearEnd?: () => void;
  lanes?: number;
  /**
   * A value that changes when a page ARRIVES — callers pass `ctx.pagesLoaded`.
   *
   * It exists because `items.length` is not a reliable signal that one did: a 72 h page
   * whose reviews are all filtered out (`showReviewed` false over an already-reviewed
   * stretch, which is the DEFAULT view, or a detection-only stretch on the Alerts tab)
   * adds ZERO visible items. With only `[nearEnd, items.length]` in the deps, `nearEnd`
   * stayed true, nothing changed, the effect never re-fired, and the surface stopped asking
   * for older data while history was still there.
   *
   * It must be an ARRIVAL counter and not the window edge (`ctx.window.oldest`): the edge
   * is `loadOlder`'s own output, so keying the re-arm on it closes a feedback loop and the
   * window chains as fast as the in-flight cap allows — measured at eight pages requested
   * on a plain page load, which is the runaway the pixel rule above exists to prevent.
   */
  windowKey?: number;
}) {
  const {
    scrollRef,
    items,
    estimateSize,
    gap = 16,
    onNearEnd,
    lanes = 1,
    windowKey,
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
  // Fire in an effect, NOT during render: `onNearEnd` is `ctx.loadOlder`, which sets state
  // on the PROVIDER — a render-phase update of a different component, which React warns
  // about and which can drop the update. `nearEnd` stays true while the user sits at the
  // bottom, so the effect re-fires on every `items.length` change and the window keeps
  // chaining; repeated calls are idempotent against the provider's page grid (F12).
  const viewport = scrollRef.current?.clientHeight ?? 0;
  const remainingPx =
    virtualizer.getTotalSize() - (virtualizer.scrollOffset ?? 0) - viewport;
  /**
   * An EMPTY surface always asks for more, whatever the scroll position says.
   *
   * This used to be `items.length > 0 && …`, and that guard turned the most ordinary state
   * on the box into a dead page: the Review grid hides reviewed items by default, so once
   * you have cleared today's alerts — which is what the "Mark these items as reviewed"
   * button is for, and what anyone keeping up with their alerts does daily — the initial
   * 24 h window contains NOTHING to display. With nothing displayed there is no scroll, with
   * no scroll `nearEnd` never became true, and the window sat at 24 h for ever. Measured on
   * the live box with 420 unreviewed alerts two days back: "There are no alerts to review",
   * `.review-item` count 0, and not one further `/review` page requested.
   *
   * There is no runaway here, for two reasons that the earlier feedback-loop failures did
   * not have: it stops the moment ONE item is displayable, and `loadOlder` is a no-op at the
   * data floor, so a genuinely empty history terminates instead of chaining. "Load until you
   * can show me something, then stop" is the whole rule.
   */
  const nearEnd =
    items.length === 0 ||
    remainingPx <= Math.max(viewport * LOOKAHEAD_VIEWPORTS, MIN_LOOKAHEAD_PX);
  // The callback is held in a REF and kept out of the deps on purpose. Callers build it
  // from the context object (`() => ctx.loadOlder()`), whose identity changes on every
  // provider render — with it in the deps this effect re-ran on provider state that has
  // nothing to do with scrolling, and each re-run spent another page of the in-flight
  // allowance. Measured: seven extensions in 160 ms with `items`, `lastIndex` and the
  // scroll position all unchanged.
  const onNearEndRef = useRef(onNearEnd);
  onNearEndRef.current = onNearEnd;
  useEffect(() => {
    if (nearEnd) onNearEndRef.current?.();
  }, [nearEnd, items.length, windowKey]);

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
