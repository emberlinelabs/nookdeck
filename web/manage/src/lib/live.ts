/** On Air for the manage page: GET /api/onair and PUT /api/onair/settings (the On Air settings card). Shapes from web/shared/onair.ts, the one contract with the agent and the deck. */
import { ApiError } from "@/api";
import { t } from "@/lib/i18n";
import { parseOnAir, parseOnAirSettings, type OnAirMsg, type OnAirSettings } from "@shared/onair";

async function call(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(t("Cannot reach the Nookdeck agent"), 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return data;
}

export interface OnAirStatus {
  state: OnAirMsg;
  settings: OnAirSettings;
}

const status = (raw: unknown): OnAirStatus | null => {
  const state = parseOnAir(raw);
  return state ? { state, settings: parseOnAirSettings((raw as { settings?: unknown }).settings) } : null;
};

export const liveApi = {
  getOnAir: async (): Promise<OnAirStatus | null> => status(await call("/api/onair")),
  putOnAirSettings: async (s: OnAirSettings): Promise<OnAirStatus | null> =>
    status(await call("/api/onair/settings", { method: "PUT", headers: { "Content-Type": "application/json", "X-Nookdeck": "1" }, body: JSON.stringify(s) })),
};
