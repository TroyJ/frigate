/**
 * fork/continuous — the one sentence a deep link owes the user (§2A.5 / D9 / D19).
 *
 * Deliberately a PERSISTENT banner and not a toast. Every case this renders for is a link
 * that did not do what the person tapping it expected — the alert has been deleted, its
 * footage has aged out, the view had to be changed to reach it — and a message that fades
 * after four seconds while a 30-day-old page is still loading its thumbnails is the same
 * silent failure with extra steps. It is dismissible; it does not block the page.
 *
 * `data-continuous-notice` carries the machine-readable reason so an L2 gate can assert the
 * OUTCOME ("this said the alert is gone") rather than matching translated prose.
 */
import { LuX } from "react-icons/lu";
import { cn } from "@/lib/utils";
import { DEEP_LINK_PROBLEM_TEXT, DeepLinkProblem } from "./deepLink";

type Props = {
  problem?: DeepLinkProblem;
  onDismiss: () => void;
  className?: string;
};

export function ContinuousDeepLinkNotice({
  problem,
  onDismiss,
  className,
}: Props) {
  if (!problem) return null;

  return (
    <div
      role="status"
      data-continuous-notice={problem}
      // `fixed`, so it can be a plain sibling of the page in `pages/Events.tsx` — a
      // positioned wrapper around `RecordingView` / `EventView` would change their layout,
      // and both are built on `size-full` inside a flex column.
      className={cn(
        "pointer-events-auto fixed left-1/2 top-4 z-50 flex w-fit max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-lg bg-secondary-foreground px-4 py-2 text-sm text-secondary shadow-lg",
        className,
      )}
    >
      {/* NOT `t(…, { defaultValue })`. Upstream installs a `parseMissingKeyHandler`
          (`utils/i18n.ts`) which takes precedence over `defaultValue`, so a fork string
          with no entry in the locale bundles renders as a HUMANISED KEY — measured here
          as the literal word "Review-missing" where a sentence belonged. The fork keeps
          its strings in its own files (§8.3) and `footage.ts` already works this way. */}
      <span>{DEEP_LINK_PROBLEM_TEXT[problem]}</span>
      <button
        aria-label="Close"
        className="opacity-70 hover:opacity-100"
        onClick={onDismiss}
      >
        <LuX />
      </button>
    </div>
  );
}
