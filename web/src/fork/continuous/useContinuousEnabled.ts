/**
 * fork/continuous — the toggle (§8.5, Q7 → D22: kept forever).
 *
 * localStorage/IndexedDB-backed via upstream's own `useUserPersistence`, so it is
 * per-user and needs no backend key. Defaults ON. Flip it from the console during
 * bring-up with `frigateContinuous(false)` (installed by ContinuousProvider) — the
 * original upstream panels are one toggle away and stay reachable for rollback.
 */
import { useUserPersistence } from "@/hooks/use-user-persistence";

export const CONTINUOUS_KEY = "continuousTimeline";

export function useContinuousEnabled(): [boolean, (v: boolean) => void, boolean] {
  const [value, setValue, loaded] = useUserPersistence<boolean>(
    CONTINUOUS_KEY,
    true,
  );
  return [loaded ? (value ?? true) : false, setValue, loaded];
}
