/**
 * fork/continuous — L1 for K1's arrival re-arm (`useFixedPitchWindow`'s `windowKey`).
 *
 * The defect this pins is a surface that stops asking for older data FOR GOOD. `onNearBottom`
 * is only evaluated from the scroll handler, and a scroller already at its maximum emits no
 * scroll events — so when `loadOlder` no-ops (it does exactly that while MAX_INFLIGHT_PAGES
 * are in flight), nothing re-tries once those pages land. Measured on the History strip
 * against a live box: thirty pulls, 744 h every time against a 763 h floor, and only 8
 * `/review` requests in 51 seconds. The transport was healthy; the app had stopped asking.
 *
 * jsdom has no layout, so `count`/`end` are both zero and the near-bottom condition is
 * trivially true — which is fine for THIS claim, because what is under test is whether a
 * page arrival re-evaluates the trigger at all when nothing else changes.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act, useRef } from "react";
import { createRoot, Root } from "react-dom/client";
import { useFixedPitchWindow } from "../useFixedPitchWindow";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

function Probe({
  windowKey,
  onNearBottom,
}: {
  windowKey: number;
  onNearBottom: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useFixedPitchWindow({
    scrollRef: scrollRef as React.RefObject<HTMLDivElement>,
    count: 100,
    startAligned: 1_787_000_000,
    segmentDuration: 30,
    onNearBottom,
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

describe("useFixedPitchWindow arrival re-arm", () => {
  it("re-asks when a page ARRIVES, with no scroll event to prompt it", () => {
    let calls = 0;
    // ONE callback identity for the whole test, deliberately. A fresh closure per render
    // changes `update`'s identity, which re-runs the listener effect and re-evaluates the
    // trigger — so an inline arrow would make this test pass with the arrival re-arm
    // removed. The real surfaces hold `onNearBottom` stable (`useCallback` on
    // `ctx.loadOlder`), which is why they could stall.
    const onNearBottom = () => {
      calls++;
    };
    const render = (windowKey: number) =>
      act(() => {
        root.render(
          <Probe windowKey={windowKey} onNearBottom={onNearBottom} />,
        );
      });

    render(1);
    const atMount = calls;
    expect(atMount, "evaluated once on mount").toBeGreaterThan(0);

    // a re-render that carries no new page must not spend a request
    render(1);
    expect(calls, "an unrelated re-render is not an arrival").toBe(atMount);

    // the in-flight pages landed: the trigger must be re-evaluated, because the scroller is
    // pinned at its bottom and will never emit another scroll event on its own
    render(2);
    expect(calls, "a page arrival re-arms the load").toBe(atMount + 1);
    render(3);
    expect(calls, "and again for the next one").toBe(atMount + 2);
  });
});
