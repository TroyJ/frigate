/**
 * fork/continuous — F14 / D20: the export handles need a cap that never had to exist.
 *
 * In the History scrubber, Export → "select on timeline" seeds a 60 s range around the
 * playhead and turns the strip into two draggable blue bars. `use-draggable-element.ts`
 * clamps those bars to `timelineStartAligned` and `timelineDuration` — i.e. to whatever the
 * strip currently spans. Upstream that is one 24 h window, so the longest export anyone can
 * construct through the timeline UI is ~24 h, and it is capped purely as a SIDE EFFECT of
 * the window being small. Nothing enforces it: not `ExportDialog.tsx`, not
 * `frigate/api/export.py` (`export_recording` takes arbitrary start/end and queries every
 * `Recordings` row in range).
 *
 * Make the strip continuous and that accidental clamp disappears with it — the handles
 * could be dragged across fifteen months, and a slip of the mouse would start an ffmpeg job
 * that occupies the Pi for hours and can fill the disk. This is a risk the FEATURE creates,
 * so containing it belongs here. The cap is 24 h to match the preset list
 * ("last 1 / 4 / 8 / 12 / 24 hours"), which is the designed maximum stated in upstream's
 * own UI.
 *
 * D20 scope, stated so nobody thinks this covers more than it does: this clamps the
 * TIMELINE HANDLES only. `ExportDialog`'s "Custom" date-picker path is a pre-existing,
 * unguarded hazard — recorded in `known-anomalies.md` and an upstream-PR candidate, not
 * fixed here.
 *
 * **Clamped, not truncated silently.** The handle that moved is pulled back to the cap and
 * the caller is told, so the UI can say why the bar stopped following the mouse. A silent
 * truncation would look like the drag simply broke.
 */
import { TimeRange } from "@/types/timeline";

export const MAX_EXPORT_SPAN_S = 24 * 3600;

export const EXPORT_CLAMP_TEXT =
  "Export is limited to 24 hours — the selection was trimmed";

export type ExportClampResult = {
  range: TimeRange;
  /** True when the requested span exceeded the cap and the range below is the trimmed one. */
  clamped: boolean;
};

/**
 * @param requested  the range the handles are asking for (`after` = older edge)
 * @param moved      which handle the user dragged. The OTHER one is the anchor: dragging
 *                   the start bar down must not teleport the end bar, and vice versa.
 */
export function clampExportRange(
  requested: TimeRange,
  moved: "after" | "before",
): ExportClampResult {
  const after = Math.min(requested.after, requested.before);
  const before = Math.max(requested.after, requested.before);
  if (before - after <= MAX_EXPORT_SPAN_S) {
    return { range: { after, before }, clamped: false };
  }
  return {
    range:
      moved === "after"
        ? { after: before - MAX_EXPORT_SPAN_S, before }
        : { after, before: after + MAX_EXPORT_SPAN_S },
    clamped: true,
  };
}

/**
 * Which handle moved, comparing the incoming pair against the range currently applied.
 *
 * Both can differ on the first frame after "select on timeline" seeds the range; the older
 * edge is then treated as the moved one, which is also the edge a user drags first (you
 * drag BACK from the playhead to bracket footage that has already happened).
 */
/**
 * Which handle moved, from the handle STATE rather than from a diff against a previous
 * applied range.
 *
 * `movedHandle(undefined, …)` answers "after", so on the very first drag of the END handle
 * the clamp anchored on the end and pulled the START handle to it — the anchor teleported,
 * which is exactly what `clampExportRange`'s contract forbids. Upstream sets each handle's
 * time only when that handle is dragged, so "the other one is still 0" is the reliable
 * signal and it is available on the first frame.
 */
export function movedHandleFromState(
  exportStart: number,
  exportEnd: number,
  previous: TimeRange | undefined,
  next: TimeRange,
): "after" | "before" {
  if (exportStart === 0 && exportEnd !== 0) return "before";
  if (exportEnd === 0 && exportStart !== 0) return "after";
  return movedHandle(previous, next);
}

export function movedHandle(
  previous: TimeRange | undefined,
  next: TimeRange,
): "after" | "before" {
  if (!previous) return "after";
  if (previous.before !== next.before && previous.after === next.after)
    return "before";
  return "after";
}
