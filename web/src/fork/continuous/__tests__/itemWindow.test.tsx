/**
 * fork/continuous — L1 for `useItemWindow`'s re-arm rule (the `windowKey` param).
 *
 * Rendered rather than pure, because the defect lives in an effect's dependency array and
 * nothing else can see it: a 72 h page can land with ZERO items this surface displays
 * (`showReviewed=false` over an already-reviewed stretch, which is the default view), so
 * `items.length` does not move, `nearEnd` is already true, and the effect never re-fires —
 * the grid stops asking for older data while history is still there.
 *
 * `windowKey` here stands for `ctx.pagesLoaded`, the provider's count of RESOLVED pages.
 * The third assertion is the reason it counts arrivals rather than the window edge.
 *
 * No @testing-library/react in this workspace (and adding a dependency for one test is not
 * worth it), so this drives react-dom directly.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act, useRef } from "react";
import { createRoot, Root } from "react-dom/client";
import { MAX_EMPTY_EXTENSIONS, useItemWindow } from "../useItemWindow";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

type Item = { id: string };

/** Items the surface would RENDER — deliberately few, so `nearEnd` is true throughout. */
const ITEMS: Item[] = [{ id: "a" }, { id: "b" }];

/**
 * jsdom reports every element as 0x0, which makes `remainingPx <= max(viewport, 400)` true
 * for ANY list — so without a viewport the pixel rule can never say "no" and a test claiming
 * to see it stop is measuring nothing. `clientHeight` is defined on the scroller so the
 * distance rule has real numbers to work with: 400 items x 100 px against a 500 px viewport
 * leaves ~39,000 px below, far past the lookahead, so `nearEnd` is genuinely false there.
 */
const VIEWPORT = 500;

function Probe({
  items,
  windowKey,
  onNearEnd,
  resetKey,
}: {
  items: Item[];
  windowKey: number;
  onNearEnd: () => void;
  resetKey?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useItemWindow({
    scrollRef: scrollRef as React.RefObject<HTMLDivElement>,
    items,
    estimateSize: () => 100,
    onNearEnd,
    windowKey,
    resetKey,
  });
  return (
    <div
      ref={(el) => {
        if (el && el.clientHeight !== VIEWPORT) {
          Object.defineProperty(el, "clientHeight", { value: VIEWPORT });
        }
        (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current =
          el;
      }}
    />
  );
}

/** A list far longer than the viewport — the pixel rule must say "no" for this one. */
const MANY: Item[] = Array.from({ length: 400 }, (_, i) => ({ id: `x${i}` }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useItemWindow re-arm", () => {
  it("asks for older data again when a page lands with no visible items", () => {
    let calls = 0;
    const render = (windowKey: number) =>
      act(() => {
        root.render(
          <Probe
            items={ITEMS}
            windowKey={windowKey}
            onNearEnd={() => calls++}
          />,
        );
      });

    render(1_000);
    const afterFirst = calls;
    expect(
      afterFirst,
      "near the end on mount, so it asks once",
    ).toBeGreaterThan(0);

    // a re-render that changes NOTHING must not re-ask (that was its own defect: the
    // callback identity used to re-arm this on every provider render)
    render(1_000);
    expect(calls, "an unrelated re-render must not spend a page").toBe(
      afterFirst,
    );

    // the page landed: the window is 72 h older, and not one item of it is displayable
    render(1_000 - 72 * 3600);
    expect(calls, "same items.length, older window — it must ask again").toBe(
      afterFirst + 1,
    );
  });

  it("an EMPTY surface keeps asking — the cleared-alerts dead page", () => {
    // The Review grid hides reviewed items, so the day after you clear your alerts the
    // initial 24 h window holds nothing to display. With `items.length > 0` guarding the
    // trigger there was no scroll, no `nearEnd`, and no further page: measured on the box as
    // "There are no alerts to review" with 420 unreviewed alerts two days back.
    let calls = 0;
    const render = (items: Item[], windowKey: number) =>
      act(() => {
        root.render(
          <Probe
            items={items}
            windowKey={windowKey}
            onNearEnd={() => calls++}
          />,
        );
      });

    render([], 1);
    expect(calls, "nothing to show — it must go looking").toBeGreaterThan(0);

    const afterFirstPage = calls;
    render([], 2); // another page landed, still nothing displayable
    expect(calls, "and keep looking while it still has nothing").toBe(
      afterFirstPage + 1,
    );

    // …and STOP once a screenful is displayable. This is the half that has to discriminate:
    // with the old `items.length > 0` guard restored, the empty renders above ask ZERO times
    // and those assertions fail; without a real viewport, this one could never fail at all.
    const before = calls;
    render(MANY, 3);
    expect(calls, "a full list far from its end must not ask at all").toBe(
      before,
    );
  });

  it("stops looking after MAX_EMPTY_EXTENSIONS, and resets once refilled", () => {
    // Three surfaces share this hook AND the window: an empty `ContinuousDetailStream` on a
    // quiet camera would otherwise walk the shared window to the ~31-day floor on its own,
    // spending a dozen `/review` pages nobody asked for.
    let calls = 0;
    const render = (items: Item[], windowKey: number, resetKey?: string) =>
      act(() => {
        root.render(
          <Probe
            items={items}
            windowKey={windowKey}
            onNearEnd={() => calls++}
            resetKey={resetKey}
          />,
        );
      });

    for (let i = 0; i < MAX_EMPTY_EXTENSIONS + 4; i++) render([], i + 1);
    expect(calls, "bounded, not one page per arriving page for ever").toBe(
      MAX_EMPTY_EXTENSIONS,
    );

    // something to show → the budget is restored for the next time it empties (a filter
    // change, a severity switch), because that is a new search, not a continuation
    render(MANY, 99);
    const afterRefill = calls;
    for (let i = 0; i < MAX_EMPTY_EXTENSIONS + 2; i++) render([], 200 + i);
    expect(calls, "the budget resets once the surface has been refilled").toBe(
      afterRefill + MAX_EMPTY_EXTENSIONS,
    );
  });

  it("a filter change restores the budget without a remount", () => {
    // §14.4: changing cameras/labels/zones makes the provider discard every page and reset
    // the window — WITHOUT unmounting the surface. A budget that only resets on
    // `items.length > 0` therefore stays spent, and a grid that was empty before the filter
    // change is dead for the rest of the session: "no alerts to review" over a window that
    // has just been thrown away, which is the parent regression this whole rule exists for.
    let calls = 0;
    const render = (items: Item[], windowKey: number, resetKey: string) =>
      act(() => {
        root.render(
          <Probe
            items={items}
            windowKey={windowKey}
            onNearEnd={() => calls++}
            resetKey={resetKey}
          />,
        );
      });

    for (let i = 0; i < MAX_EMPTY_EXTENSIONS + 3; i++)
      render([], i + 1, "cams=");
    expect(calls, "budget spent while empty").toBe(MAX_EMPTY_EXTENSIONS);

    // the user narrows the filter: same surface, brand-new window, nothing loaded yet
    const spent = calls;
    for (let i = 0; i < MAX_EMPTY_EXTENSIONS; i++) {
      render([], 100 + i, "cams=driveway");
    }
    expect(calls, "the new filter's window gets its own search").toBe(
      spent + MAX_EMPTY_EXTENSIONS,
    );
  });
});
