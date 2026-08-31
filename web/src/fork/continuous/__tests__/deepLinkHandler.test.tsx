/**
 * fork/continuous — L1 for the deep-link HANDLER (`useContinuousDeepLink`), as opposed to
 * the pure vocabulary in `deepLink.test.ts`.
 *
 * Two `.23` changes only exist here, in the effect that turns a resolved review into a
 * player position, and neither is observable from the pure matrix:
 *   1. the landing is `start_time` EXACTLY — no `REVIEW_PADDING` lead-in (`seekTarget.ts`)
 *   2. `?camera=` chooses WHICH camera the moment opens on, with an explicit notice when
 *      the link names a camera this config does not have
 *
 * `axios` is mocked at the module boundary because the handler's whole shape is "one GET,
 * then a decision": stubbing the transport is what makes the decision testable, and the
 * request URL is asserted so the mock cannot drift from the real endpoint.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import axios from "axios";
import { ReviewSegment } from "@/types/review";
import { REVIEW_PADDING } from "@/types/review";
import { useContinuousDeepLink, DeepLinkOpen } from "../useDeepLink";
import { DeepLinkNav } from "../ContinuousProvider";
import { DeepLinkProblem } from "../deepLink";

vi.mock("axios", () => {
  const get = vi.fn();
  return { default: { get }, get };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const REVIEW: ReviewSegment = {
  id: "1788166705.391357-3rk76l",
  camera: "entrance_high",
  start_time: 1_788_166_705.391357,
  end_time: 1_788_166_735.5,
  severity: "alert",
  thumb_path: "",
  has_been_reviewed: false,
  data: { detections: [], objects: ["person"], sub_labels: [], zones: [] },
} as unknown as ReviewSegment;

const CAMERAS = ["entrance_high", "entrance_tele"];

type Out = {
  opens: DeepLinkOpen[];
  nav?: DeepLinkNav;
  problem?: DeepLinkProblem;
  reveals: ReviewSegment[];
};

let container: HTMLDivElement;
let root: Root;

/** A handle on the router, so a test can change the LINK without remounting the hook. */
let goTo: ((to: string) => void) | null = null;
function Navigator() {
  goTo = useNavigate();
  return null;
}

function Harness({
  out,
  knownCameras,
  cameraForMoment,
  reveal,
}: {
  out: Out;
  knownCameras?: string[];
  cameraForMoment?: string;
  reveal?: boolean;
}) {
  const res = useContinuousDeepLink({
    ready: true,
    openRecording: (o) => out.opens.push(o),
    cameraForMoment,
    knownCameras,
    revealOnReviewPage: (r) => {
      out.reveals.push(r);
      return !!reveal;
    },
  });
  out.nav = res.nav;
  out.problem = res.problem;
  return null;
}

async function run(
  search: string,
  opts: {
    knownCameras?: string[];
    cameraForMoment?: string;
    reveal?: boolean;
  } = {},
): Promise<Out> {
  const out: Out = { opens: [], reveals: [] };
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/review${search}`]}>
        <Navigator />
        <Harness out={out} {...opts} />
      </MemoryRouter>,
    );
  });
  // let the mocked GET's continuation land
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return out;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(axios.get).mockResolvedValue({ status: 200, data: REVIEW });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("?id= lands AT the detection (`.23`)", () => {
  it("opens the recording at start_time exactly, not 4 s before it", async () => {
    const out = await run(`?id=${REVIEW.id}`, { knownCameras: CAMERAS });
    expect(vi.mocked(axios.get).mock.calls[0][0]).toBe(`review/${REVIEW.id}`);
    expect(out.opens).toHaveLength(1);
    expect(out.opens[0].startTime).toBe(REVIEW.start_time);
    expect(out.opens[0].startTime).not.toBe(REVIEW.start_time - REVIEW_PADDING);
    expect(out.opens[0].camera).toBe("entrance_high");
    expect(out.opens[0].severity).toBe("alert");
  });

  it("and hands the provider the same moment to navigate to", async () => {
    // the scrubber and the window must agree, or the strip shows a different second than
    // the player is at
    const out = await run(`?id=${REVIEW.id}`, { knownCameras: CAMERAS });
    expect(out.nav?.t).toBe(REVIEW.start_time);
    expect(out.nav?.selectId).toBe(REVIEW.id);
  });

  it("is unchanged for the review surface, which has no player", async () => {
    const out = await run(`?id=${REVIEW.id}&surface=review`, {
      knownCameras: CAMERAS,
    });
    expect(out.opens).toHaveLength(0);
    expect(out.nav?.t).toBe(REVIEW.start_time);
  });
});

describe("?camera= chooses the lens (`.23`)", () => {
  it("opens the named camera at the review's own moment", async () => {
    // the notification case: the push carries the WIDE camera's review id, the useful
    // picture is the telephoto's mirror of it
    const out = await run(`?id=${REVIEW.id}&camera=entrance_tele`, {
      knownCameras: CAMERAS,
    });
    expect(out.opens[0].camera).toBe("entrance_tele");
    expect(out.opens[0].startTime).toBe(REVIEW.start_time);
    expect(out.problem).toBeUndefined();
    // the review itself is still resolved exactly as before
    expect(out.nav?.selectId).toBe(REVIEW.id);
  });

  it("falls back to the review's own camera when the link names one we do not have, AND says so", async () => {
    const out = await run(`?id=${REVIEW.id}&camera=side_gate`, {
      knownCameras: CAMERAS,
    });
    expect(out.opens[0].camera).toBe("entrance_high");
    expect(out.opens[0].startTime).toBe(REVIEW.start_time);
    expect(out.problem).toBe("camera-missing");
  });

  it("trusts the link while the config is still loading", async () => {
    // `knownCameras: undefined` is "not known yet", not "no cameras" — silently ignoring
    // the one thing the link asked for would be the worse answer
    const out = await run(`?id=${REVIEW.id}&camera=entrance_tele`);
    expect(out.opens[0].camera).toBe("entrance_tele");
    expect(out.problem).toBeUndefined();
  });

  it("is ignored on the review surface, unknown camera included", async () => {
    // the card the link selects belongs to the camera the review is on; there is nothing
    // for `camera=` to override, so there is nothing to report either
    const out = await run(`?id=${REVIEW.id}&surface=review&camera=side_gate`, {
      knownCameras: CAMERAS,
    });
    expect(out.opens).toHaveLength(0);
    expect(out.problem).toBeUndefined();
    expect(out.nav?.selectId).toBe(REVIEW.id);
  });

  it("overrides cameraForMoment on a bare ?t=", async () => {
    const moment = 1_788_100_000;
    const out = await run(`?t=${moment}&camera=entrance_tele`, {
      knownCameras: CAMERAS,
      cameraForMoment: "entrance_high",
    });
    expect(out.opens[0].camera).toBe("entrance_tele");
    expect(out.opens[0].startTime).toBe(moment);
    expect(out.nav?.t).toBe(moment);
    expect(out.problem).toBeUndefined();
    expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
  });

  it("falls back to cameraForMoment for an unknown camera on ?t=, and says so", async () => {
    const moment = 1_788_100_000;
    const out = await run(`?t=${moment}&camera=side_gate`, {
      knownCameras: CAMERAS,
      cameraForMoment: "entrance_high",
    });
    expect(out.opens[0].camera).toBe("entrance_high");
    expect(out.problem).toBe("camera-missing");
  });

  it("is part of the de-dupe key: the same id with a NEW camera resolves again", async () => {
    // `handled` keys the once-per-link guard on the request. If `camera` were left out of
    // it, `?id=X` followed by `?id=X&camera=entrance_tele` — the same review, a different
    // lens, which is exactly what a second push or a hand-edited link looks like — would be
    // silently dropped as "already handled". Same MOUNTED hook throughout: a remount would
    // reset the guard and prove nothing. (Reviewer item on `.23`.)
    const out = await run(`?id=${REVIEW.id}`, { knownCameras: CAMERAS });
    expect(out.opens.map((o) => o.camera)).toEqual(["entrance_high"]);
    await act(async () => {
      goTo?.(`/review?id=${REVIEW.id}&camera=entrance_tele`);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      out.opens.map((o) => o.camera),
      "the second link must resolve, on the camera it named",
    ).toEqual(["entrance_high", "entrance_tele"]);
    expect(out.opens[1].startTime).toBe(REVIEW.start_time);
  });

  it("alone is inert — it names a lens, it is not a destination", async () => {
    const out = await run(`?camera=entrance_tele`, { knownCameras: CAMERAS });
    expect(out.opens).toHaveLength(0);
    expect(out.nav).toBeUndefined();
    expect(out.problem).toBeUndefined();
    expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
  });
});
