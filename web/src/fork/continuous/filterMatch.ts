/**
 * fork/continuous — does a live WebSocket item belong in the current view?
 *
 * The page fetches are filtered server-side (`/review?cameras=&labels=&zones=`), but the
 * live tail is not: `useFrigateReviews` is a firehose of every review on the box. Without
 * this check a filtered view showed items it had explicitly excluded, counted them in the
 * "N new" chip, and — because an override beats page data unconditionally — could never
 * get rid of them, since no refetch returns an item the server filtered out.
 *
 * The predicate mirrors `frigate/api/review.py`:
 *   cameras → `ReviewSegment.camera` in the list
 *   labels  → matches `data.objects` OR `data.audio` (the API ORs the two)
 *   zones   → matches `data.zones`
 * The backend does a JSON substring match (`data["objects"] % '*"person"*'`); exact
 * membership is the honest client-side equivalent for real label names. If a filter value
 * ever becomes a prefix of another label, this diverges — and the fix is to widen this,
 * not to drop the check.
 */
import { ReviewSegment } from "@/types/review";
import { ContinuousFilter } from "./ContinuousProvider";

const csv = (v: string | undefined): string[] | undefined =>
  v && v !== "all"
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

export function matchesFilter(
  item: ReviewSegment,
  filter: ContinuousFilter,
): boolean {
  const cameras = csv(filter.cameras);
  if (cameras && !cameras.includes(item.camera)) return false;

  const labels = csv(filter.labels);
  if (labels) {
    const have = [...(item.data?.objects ?? []), ...(item.data?.audio ?? [])];
    if (!have.some((l) => labels.includes(l))) return false;
  }

  const zones = csv(filter.zones);
  if (zones) {
    const have = item.data?.zones ?? [];
    if (!have.some((z) => zones.includes(z))) return false;
  }

  return true;
}
