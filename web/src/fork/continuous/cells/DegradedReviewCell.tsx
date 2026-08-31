/**
 * fork/continuous/cells — D9 / F15 / F17: the degraded review cell.
 *
 * **Deep history is strata, not an archive** (F18). Scroll back far enough and a row
 * references a camera that has since left the config, or a thumbnail file the expiry sweep
 * reaped. Measured on this box at scoping time: **14 `reviewsegment` rows name cameras that
 * are no longer in `config.cameras`** (`porch_ezviz` ×11, `entrance_low`, `porch_ezviz_high`,
 * `porch_ezviz_low`) and **16 of 6,512 rows have no thumbnail file** — 14 of them the same
 * orphans. Upstream's `expire_review_segments()` iterates `config.cameras.items()`, so rows
 * belonging to a departed camera are never expired: they sit there for ever, and tomorrow's
 * retired camera makes more. This is the NORMAL condition at depth, not an anomaly.
 *
 * So a page must never break because a row points at something that is gone. F15's crash
 * was `RecordingView.tsx:524` dereferencing `config.cameras[mainCamera].review` through a
 * chain whose optional stopped one link short (guarded at the seam in Phase 1f); this is
 * the other half — the CELL. Two states, both ordinary:
 *
 *   camera-missing  the camera has left the config. Nothing can play it, no preview exists,
 *                   and upstream's cell would ask for both. Non-interactive, and it says
 *                   which camera and when, because that is the only useful thing left.
 *   thumb-missing   the review is fine, only its thumbnail file was reaped. STILL
 *                   CLICKABLE — the recording may well be there — with an icon and the
 *                   timestamp where the image would be. Upstream renders no `onError` at
 *                   all: the img stays `invisible` and `ImageLoadingIndicator` spins for
 *                   ever, which reads as "still loading" rather than "gone".
 *
 * `data-continuous-degraded` carries the reason so a gate can assert WHICH degradation
 * happened rather than merely that something rendered.
 */
import { LuCameraOff, LuImageOff } from "react-icons/lu";
import { cn } from "@/lib/utils";
import { ReviewSegment } from "@/types/review";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

export type DegradedReason = "camera-missing" | "thumb-missing";

export type DegradedReviewCellProps = {
  review: ReviewSegment;
  reason: DegradedReason;
  tz: string;
  /** Omitted for `camera-missing`: there is nothing to open. */
  onClick?: () => void;
};

export function DegradedReviewCell({
  review,
  reason,
  tz,
  onClick,
}: DegradedReviewCellProps) {
  const Icon = reason === "camera-missing" ? LuCameraOff : LuImageOff;
  // `date_style`/`time_style`, not `date_format`: the latter is a date-fns pattern applied
  // through `formatInTimeZone`, and hard-coding one here would ignore the user's locale for
  // the sake of a fallback cell. `timezone` is the provider's display tz (D13).
  const when = formatUnixTimestampToDateTime(review.start_time, {
    timezone: tz,
    date_style: "medium",
    time_style: "short",
  });
  const label =
    reason === "camera-missing"
      ? `${review.camera.replaceAll("_", " ")} — camera no longer configured`
      : `${review.camera.replaceAll("_", " ")} — thumbnail no longer stored`;

  return (
    <div
      data-continuous-degraded={reason}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={`${label}, ${when}`}
      title={`${label}\n${when}`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) onClick();
      }}
      className={cn(
        "flex size-full flex-col items-center justify-center gap-1 bg-secondary text-muted-foreground",
        onClick ? "cursor-pointer hover:bg-secondary-highlight" : "opacity-60",
      )}
    >
      <Icon className="size-6" />
      <div className="px-2 text-center text-[11px] leading-tight">{when}</div>
      <div className="px-2 text-center text-[10px] leading-tight opacity-80">
        {label}
      </div>
    </div>
  );
}
