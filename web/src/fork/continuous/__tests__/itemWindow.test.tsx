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
import { useItemWindow } from "../useItemWindow";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

type Item = { id: string };

/** Items the surface would RENDER — deliberately few, so `nearEnd` is true throughout. */
const ITEMS: Item[] = [{ id: "a" }, { id: "b" }];

function Probe({
  items,
  windowKey,
  onNearEnd,
}: {
  items: Item[];
  windowKey: number;
  onNearEnd: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useItemWindow({
    scrollRef: scrollRef as React.RefObject<HTMLDivElement>,
    items,
    estimateSize: () => 100,
    onNearEnd,
    windowKey,
  });
  return <div ref={scrollRef} />;
}

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

    // …and STOP once something is displayable and the viewport is not near its end.
    // jsdom reports every element as 0×0, so `remainingPx` cannot be exercised here; what
    // this pins is that the empty-list branch is what did the asking above.
    const before = calls;
    render(ITEMS, 3);
    expect(calls, "one ask for the arriving page, not a chain").toBe(before + 1);
  });
});
