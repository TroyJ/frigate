/**
 * fork/continuous — the "N new" chip (§9.3), and the second half of D17.
 *
 * D17 says ONE new-items mechanism: upstream's `NewReviewData` pill is hidden whenever the
 * continuous panel is enabled, and this serves both pages instead. Until this existed the
 * toggle removed the only new-items indicator and put nothing back.
 *
 * Why a chip and not an auto-scroll: growth at the newest edge is compensated exactly
 * (§9.2), so while the user is reading history nothing on screen moves and new items
 * arrive silently below the fold. The chip is the only signal that they did. It is
 * deliberately absent while the surface is pinned to the top — there the items are already
 * on screen, so the provider clears the counter instead (see `reportAtTop`).
 *
 * It borrows upstream's `NewReviewData` look on purpose (same idiom, same page).
 */
import { LuRefreshCcw } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useContinuousStrict } from "./ContinuousProvider";

export function ContinuousNewChip({ className }: { className?: string }) {
  const { t } = useTranslation(["views/events"]);
  const ctx = useContinuousStrict();
  const count = ctx.pendingNew;

  return (
    <div className={cn("pointer-events-none", className)}>
      <div className="pointer-events-auto flex items-center justify-center">
        <Button
          className={cn(
            count > 0
              ? "duration-500 animate-in slide-in-from-top"
              : "invisible",
            "mx-auto bg-gray-400 text-center text-white",
          )}
          aria-label={t("newReviewItems.label")}
          onClick={() => {
            ctx.scrollToTop();
            ctx.clearPendingNew();
          }}
        >
          <LuRefreshCcw className="mr-2 size-4" />
          {count === 1
            ? t("newReviewItems.button")
            : `${count} ${t("newReviewItems.button")}`}
        </Button>
      </div>
    </div>
  );
}
