/**
 * fork/continuous — F19's toggle state, persisted per user.
 *
 * Same mechanism as the feature toggle itself (`useContinuousEnabled`): upstream's
 * `useUserPersistence`, so it needs no backend key and no config change on the box.
 *
 * Defaults ON. The duplicate rows are an artefact of how the fork RECORDS a mirrored alert,
 * not information the reader asked for, and the surface where they hurt — a grid you scroll
 * for months — is exactly the surface this feature creates. Anyone who wants to see both
 * rows (checking that mirroring is working, say) has one click to get them back.
 */
import { useUserPersistence } from "@/hooks/use-user-persistence";

export const DEDUPE_MIRRORS_KEY = "continuousDedupeMirrors";

export function useDedupeMirrors(): [boolean, (v: boolean) => void, boolean] {
  const [value, setValue, loaded] = useUserPersistence<boolean>(
    DEDUPE_MIRRORS_KEY,
    true,
  );
  return [loaded ? (value ?? true) : true, setValue, loaded];
}
