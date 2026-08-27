/**
 * fork/continuous — the deep-link param vocabulary (§2A.4 / D11), pure and testable.
 *
 * A link is a STORED reference (§2A.5): it is written by Node-RED into an iOS/Android push
 * and then sits on a phone for days. By the time it is opened the review may have been
 * deleted, its footage may have aged out, the tab name may have been retired, or the
 * timestamp may be garbage from a hand-edited URL. None of those may crash the page (D9)
 * and none of them may land the user silently at "now" with no explanation — that is the
 * failure D11 exists to remove.
 *
 * **Do not change the URL shape here without changing `frigate-notifications-handover.md`
 * (§2A.7).** The Node-RED side builds `<slug>/ingress/review?id=<review_id>` today, and
 * pushes already delivered must keep resolving. Everything this module adds — `t`,
 * `surface` — is OPTIONAL and defaults to exactly today's behaviour.
 *
 * Why this is not just `Number(param)`: a deep link's `t` arrives from whatever produced
 * the link. Milliseconds are the obvious mistake (`Date.now()` rather than `/1000`), and a
 * 1000× wrong timestamp is not a visible error — it silently asks the provider to page back
 * to the year 58000, which it will dutifully try to do. Normalise it, and reject anything
 * that cannot be a real recording moment rather than passing it on.
 */
import { TimelineType } from "@/types/timeline";

/** The literal list `pages/Events.tsx` validates `?tab=` against (§2A.4/§2A.5). */
export const TIMELINE_TABS: TimelineType[] = ["timeline", "events", "detail"];
export const DEFAULT_TAB: TimelineType = "timeline";

/** Which page an alert wants to be shown on. `history` is today's behaviour (§2A.4). */
export type DeepLinkView = "history" | "review";
export const DEFAULT_VIEW: DeepLinkView = "history";

/**
 * Everything worth SAYING about a stored link, as an enumerated state rather than a silent
 * `.catch(() => {})`. The UI turns these into one sentence (see `ContinuousDeepLinkNotice`);
 * the L2 gates assert on the value, not on the sentence.
 *
 * Not every entry is a failure — `filters-adjusted` is D19, where reaching the target meant
 * relaxing what the page was showing and the user is owed an explanation for why the view
 * changed under them.
 */
export type DeepLinkProblem =
  | "review-missing" // 404 — deleted since the push was sent
  | "review-unavailable" // the lookup itself failed (offline, 5xx)
  | "footage-expired" // resolved, but older than the recording horizon
  | "filters-adjusted" // D19 — the view was relaxed to reach the target
  | "invalid-tab"
  | "invalid-time"
  | "invalid-surface";

export type DeepLinkRequest = {
  /** Review id to land on and highlight, if the link named one. */
  id?: string;
  /** A bare moment (`?t=`), already normalised to epoch SECONDS. */
  t?: number;
  tab: TimelineType;
  view: DeepLinkView;
  /** Everything that was wrong with the link, in the order it was found. */
  problems: DeepLinkProblem[];
};

/** Earliest timestamp a real recording could carry — 2000-01-01T00:00:00Z. */
const MIN_PLAUSIBLE = 946_684_800;
/**
 * Anything at or past this is milliseconds, not seconds: 1e11 SECONDS is the year 5138, so
 * a value that large cannot be an epoch-seconds recording moment, while as milliseconds it
 * is 1973 — i.e. every plausible ms timestamp is above it and every plausible s timestamp is
 * below it.
 */
const MS_THRESHOLD = 1e11;
/** A link may point a little into the future (clock skew); a year is not skew. */
const MAX_FUTURE_SKEW = 86_400;

export function parseTab(raw?: string | null): {
  tab: TimelineType;
  valid: boolean;
} {
  if (raw == null || raw === "") return { tab: DEFAULT_TAB, valid: true };
  const hit = TIMELINE_TABS.find((v) => v === raw);
  // §2A.5: upstream "falls through, keeps last tab" for an unknown value, which on a fresh
  // deep link is indistinguishable from the link having worked. Fall back explicitly.
  return hit ? { tab: hit, valid: true } : { tab: DEFAULT_TAB, valid: false };
}

export function parseView(raw?: string | null): {
  view: DeepLinkView;
  valid: boolean;
} {
  if (raw == null || raw === "") return { view: DEFAULT_VIEW, valid: true };
  if (raw === "history" || raw === "review") return { view: raw, valid: true };
  return { view: DEFAULT_VIEW, valid: false };
}

/**
 * `?t=` → epoch seconds, or undefined if it cannot be one.
 *
 * Accepts milliseconds because that is the mistake every caller makes once, and a link that
 * works is worth more than a link that is pedantically right.
 */
export function parseMoment(
  raw?: string | null,
  now: number = Date.now() / 1000,
): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const seconds = n >= MS_THRESHOLD ? n / 1000 : n;
  if (seconds < MIN_PLAUSIBLE) return undefined;
  if (seconds > now + MAX_FUTURE_SKEW) return undefined;
  return seconds;
}

/**
 * Parse the whole vocabulary in one pass.
 *
 * Returns `undefined` when the URL carries nothing this handler owns, so the caller can
 * leave the page alone — `?cameras=`/`?labels=`/`?zones=`/`?group=` are upstream's and are
 * applied BEFORE the window loads (§2A.4: a filter change discards loaded pages, F14.4).
 */
export function parseDeepLink(
  raw: {
    id?: string | null;
    t?: string | null;
    tab?: string | null;
    surface?: string | null;
  },
  now: number = Date.now() / 1000,
): DeepLinkRequest | undefined {
  const id = raw.id?.trim() || undefined;
  const hasT = raw.t != null && raw.t !== "";
  const t = parseMoment(raw.t, now);
  const { tab, valid: tabValid } = parseTab(raw.tab);
  const { view, valid: viewValid } = parseView(raw.surface);

  const problems: DeepLinkProblem[] = [];
  if (!tabValid) problems.push("invalid-tab");
  if (!viewValid) problems.push("invalid-surface");
  if (hasT && t === undefined) problems.push("invalid-time");

  // Present, not merely useful. A `?tab=`/`?surface=` on its own is not a navigation — it is
  // a preference for what the page does next — but it IS in §2A.4's must-not-regress table
  // and upstream consumed it unconditionally, so the handler that took ownership of the
  // param has to return it (and strip it from the URL) rather than leave it dangling.
  const present =
    !!id ||
    hasT ||
    (raw.tab != null && raw.tab !== "") ||
    (raw.surface != null && raw.surface !== "");
  if (!present) return undefined;

  return { id, t, tab, view, problems };
}

/** English strings, rendered as-is — see the note in `footage.ts` on why not via i18n. */
export const DEEP_LINK_PROBLEM_TEXT: Record<DeepLinkProblem, string> = {
  "review-missing": "This alert no longer exists — it has been deleted.",
  "review-unavailable":
    "This alert could not be loaded. It may have been removed.",
  "footage-expired":
    "This alert is older than the recordings we keep, so there is no video for it.",
  // Deliberately covers both halves of D19 (severity mode and `showReviewed`) in one
  // sentence: the reveal can be either or both, and a message that names the wrong one is
  // worse than one that names neither.
  "filters-adjusted":
    "This page's filters were adjusted so the linked item is visible.",
  "invalid-tab": "That view no longer exists — showing the timeline instead.",
  "invalid-time": "That link's timestamp is not valid, so it was ignored.",
  "invalid-surface":
    "That link's page name is not valid — showing History instead.",
};
