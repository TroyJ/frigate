/**
 * fork/continuous — F19: mirrored reviews double the Review grid at depth.
 *
 * The fork's `review.alerts.mirror_from` makes a second camera raise its own review for the
 * same event: on this box `entrance_tele.review.alerts.mirror_from == ["entrance_high"]`,
 * because the dual-sensor entrance unit should alert on whichever sensor saw it. The
 * History tabs filter to ONE camera and never see this. The Review grid does not: measured
 * ~150 alerts/day where ~75 are mirrors of the other 75, i.e. roughly half of ~6,500 rows
 * over a year. Tolerable in a 24 h window, obtrusive once you scroll for months.
 *
 * **Matching is by configuration, not by guesswork.** A row is a mirror only if
 *   - its camera declares `mirror_from` containing the other row's camera, AND
 *   - the two rows have the same severity, AND
 *   - their `start_time`s are IDENTICAL.
 * The mirroring backend copies the source's `start_time`, so in practice the match is
 * exact — measured byte-identical (`1786636678.713004` on both `entrance_high` and
 * `entrance_tele`), which is also the twin trap the L2 harness has its own note about. The
 * tolerance exists so a future implementation that re-derives the timestamp does not
 * silently stop de-duplicating; it is small enough that two genuinely separate events on
 * the two sensors two seconds apart are still two rows.
 *
 * The SOURCE row is the one kept. It is the camera the event was actually detected on, its
 * thumbnail is the one with the detection in it, and keeping the mirror instead would make
 * the surviving row's camera depend on page arrival order.
 */
import { ReviewSegment } from "@/types/review";
import { FrigateConfig } from "@/types/frigateConfig";

/** camera → the cameras it mirrors FROM (i.e. its rows are copies of theirs). */
export type MirrorMap = Map<string, string[]>;

type AlertsWithMirror = { mirror_from?: string[] };

/**
 * Read the mirror relationships out of the config.
 *
 * `mirror_from` is a FORK field and is not in `FrigateConfig`'s hand-written types, so it
 * is read defensively: a box without the fork's backend simply yields an empty map and the
 * toggle never appears.
 */
export function mirrorMapFromConfig(
  config: FrigateConfig | undefined,
): MirrorMap {
  const map: MirrorMap = new Map();
  for (const [name, camera] of Object.entries(config?.cameras ?? {})) {
    const alerts = camera?.review?.alerts as AlertsWithMirror | undefined;
    const from = alerts?.mirror_from;
    if (Array.isArray(from) && from.length) map.set(name, [...from]);
  }
  return map;
}

/** Does this box mirror anything at all? Drives whether the F19 toggle is offered. */
export function hasMirrors(map: MirrorMap): boolean {
  return map.size > 0;
}

/**
 * Drop rows that are mirrors of another row PRESENT IN THE SAME LIST.
 *
 * The matching is per EVENT, not per camera, and the difference matters. "Drop every row
 * whose camera declares `mirror_from` when that source camera appears anywhere in the list"
 * is simpler and is stable by construction — but it loses events: a `entrance_tele` row
 * whose own `entrance_high` twin is hidden by the current filter (reviewed, wrong severity,
 * a label filter) would be dropped because SOME other `entrance_high` row is on the list,
 * and the event then appears nowhere at all. One row per event is the goal; zero is a
 * regression. So the comparison is against the twin — identical `start_time`, same severity
 * — and a mirror with no visible source is KEPT.
 *
 * **Count stability under the live tail, since it is not obvious.** The WS delivers the two
 * rows of a pair in write order, so a lone `entrance_tele` row can be kept and then dropped
 * a moment later when `entrance_high` lands. That looks like a mid-list removal, which is
 * the one shape K2's prepend compensation cannot absorb (it counts head arrivals). It is
 * not: the group holds exactly ONE displayed row before and after — the tele row is
 * replaced by the high row at the same instant on the axis — so the row COUNT the
 * virtualizer sees does not change. Only the identity does.
 *
 * O(n) over a list already sorted newest-first (D23): equal-ish timestamps are adjacent, so
 * only the run within the tolerance has to be considered.
 */
export type DedupeResult = {
  items: ReviewSegment[];
  /**
   * Kept review id → the ids it is standing in for.
   *
   * Suppression is a DISPLAY choice made downstream of the filter: the backend still has
   * both rows. Anything that acts on a visible card — mark, delete — has to act on the
   * hidden one too, or the hidden row un-suppresses the moment its source leaves the list
   * and pops back as an item the user has just dealt with. The caller needs this map to do
   * that, which is why dedup returns it rather than just a shorter list.
   */
  suppressed: Map<string, string[]>;
};

export function dedupeMirrors(
  items: ReviewSegment[],
  mirrors: MirrorMap,
): DedupeResult {
  const suppressed = new Map<string, string[]>();
  if (!mirrors.size || items.length < 2) return { items, suppressed };
  const out: ReviewSegment[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const sources = mirrors.get(item.camera);
    if (!sources) {
      out.push(item);
      continue;
    }
    // EXACT timestamp equality, not a tolerance. The mirroring backend copies the source's
    // `start_time`, so real twins are byte-identical (measured: `1786636678.713004` on
    // both). A ±2 s window bought nothing against that and could cross-match two genuinely
    // separate events two seconds apart — which loses one of them, the failure this whole
    // function is written to avoid.
    const twinOf = (j: number) =>
      items[j].start_time === item.start_time &&
      items[j].severity === item.severity &&
      sources.includes(items[j].camera);
    let keeper: ReviewSegment | undefined;
    // scan the neighbourhood BOTH ways: which twin leads is not a product property
    for (
      let j = i - 1;
      j >= 0 && items[j].start_time === item.start_time;
      j--
    ) {
      if (twinOf(j)) {
        keeper = items[j];
        break;
      }
    }
    for (
      let j = i + 1;
      !keeper && j < items.length && items[j].start_time === item.start_time;
      j++
    ) {
      if (twinOf(j)) {
        keeper = items[j];
        break;
      }
    }
    if (!keeper) {
      out.push(item);
      continue;
    }
    suppressed.set(keeper.id, [...(suppressed.get(keeper.id) ?? []), item.id]);
  }
  return { items: out, suppressed };
}
