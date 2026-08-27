/**
 * fork/continuous — F19's toggle.
 *
 * Renders NOTHING unless this box actually mirrors reviews (`review.alerts.mirror_from` on
 * some camera). On a stock Frigate that is every box, so the Review header is unchanged for
 * anyone who does not have the duplicate problem — which is also why this is a fork control
 * rather than a general setting.
 */
import useSWR from "swr";
import { LuCopy, LuCopyX } from "react-icons/lu";
import { FrigateConfig } from "@/types/frigateConfig";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { hasMirrors, mirrorMapFromConfig } from "./mirrors";
import { useContinuous } from "./ContinuousProvider";

export function ContinuousDedupToggle({ className }: { className?: string }) {
  const continuous = useContinuous();
  const { data: config } = useSWR<FrigateConfig>("config");

  if (!continuous.enabled) return null;
  const dedupe = continuous.dedupeMirrors;
  const setDedupe = continuous.setDedupeMirrors;
  if (!hasMirrors(mirrorMapFromConfig(config))) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          aria-label={
            dedupe ? "Show mirrored reviews" : "Hide mirrored reviews"
          }
          data-dedupe-mirrors={dedupe ? "on" : "off"}
          className={cn("px-2", className)}
          onClick={() => setDedupe(!dedupe)}
        >
          {dedupe ? (
            <LuCopyX className="size-4 text-primary-variant" />
          ) : (
            <LuCopy className="size-4 text-muted-foreground" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {dedupe
          ? "Mirrored reviews are hidden — one row per event"
          : "Showing every camera's row for the same event"}
      </TooltipContent>
    </Tooltip>
  );
}
