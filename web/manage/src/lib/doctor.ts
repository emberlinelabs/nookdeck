import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/api";
import { getPlatform, type Platform } from "@/lib/platform";
import type { DoctorItem } from "@/types";

/** Permission checks; refreshed every 30 s and on demand. `missing` = the agent has no /api/doctor yet. */
export function useDoctor(): { items: DoctorItem[] | null; missing: boolean; error: string | null; reload: () => Promise<void> } {
  const [items, setItems] = useState<DoctorItem[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);
  // an explicit reload (and the first load) runs the checks now; the 30 s timer takes the agent's recent answer
  const reload = useCallback(async (fresh = true) => {
    try {
      setItems(await api.getDoctor(fresh));
      loaded.current = true;
      setMissing(false);
      setError(null);
    } catch (e) {
      if (!loaded.current) {
        setItems((cur) => cur ?? []);
        setMissing(e instanceof ApiError && e.status === 404);
      }
      // A refresh that fails after a good load keeps the rows and stays quiet; only a failed first load is an error.
      if (!loaded.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(false), 30000);
    return () => clearInterval(timer);
  }, [reload]);
  return { items, missing, error, reload };
}

/** Something needs the user's attention (denied or missing; unknown and n/a do not count). */
export const needsAttention = (items: DoctorItem[] | null, platform: Platform = getPlatform()): number =>
  (items ?? []).filter((i) => (i.status === "missing" || i.status === "denied") && !(platform === "win32" && MAC_ONLY_DOCTOR.has(i.id))).length;
export const MAC_ONLY_DOCTOR = new Set(["accessibility", "screen-recording", "automation", "input-monitoring"]);
