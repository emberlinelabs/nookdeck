import { runCapture } from "../actions";
import { clampPercent, type ProviderQuota, type QuotaWindow } from "./types";
import { t as tr } from "../i18n";

export const AGY_TIMEOUT_MS = 20_000;

export function agyPath(): string | null {
  return process.env.NOOKDECK_AGY ?? Bun.which("agy");
}

const GROUP_SHORT = (name: string): string =>
  /^gemini models?$/i.test(name) ? "Gemini" : /claude.*gpt/i.test(name) ? "Claude/GPT" : name;

const WINDOWS: Record<string, { label: string; minutes: number }> = {
  weekly: { label: "7 days", minutes: 10080 },
  "5h": { label: "5 hours", minutes: 300 },
};

function windowOf(text: string): { label: string; minutes: number } | undefined {
  const k = text.toLowerCase();
  const w = WINDOWS[k] ?? (/five hour|5 ?h/.test(k) ? WINDOWS["5h"] : /week/.test(k) ? WINDOWS.weekly : undefined);
  return w ? { ...w, label: tr(w.label) } : undefined;
}

/**
 * Parses `agy -p /usage --output-format json`. Primary source: command.data.groups[].buckets[]
 * ({id, name, window, remaining_fraction, reset_time}); fallback: the tab separated `response` text
 * (group, name, "NN%", ISO time) where NN is the REMAINING percent.
 */
export function parseAgyUsage(stdout: string): QuotaWindow[] {
  let o: any;
  try {
    o = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out: QuotaWindow[] = [];
  const groups = o?.command?.data?.groups;
  if (Array.isArray(groups)) {
    for (const g of groups) {
      for (const b of g?.buckets ?? []) {
        if (typeof b?.remaining_fraction !== "number") continue;
        const w = windowOf(String(b.window ?? "")) ?? windowOf(String(b.name ?? ""));
        const reset = Date.parse(b.reset_time);
        out.push({
          id: String(b.id ?? `${g.name}-${b.window}`),
          label: `${GROUP_SHORT(String(g.name ?? ""))} · ${w?.label ?? String(b.name ?? "")}`,
          usedPercent: clampPercent((1 - b.remaining_fraction) * 100),
          ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
          ...(w ? { windowMinutes: w.minutes } : {}),
        });
      }
    }
    if (out.length) return out;
  }
  if (typeof o?.response === "string") {
    for (const [i, line] of o.response.split("\n").entries()) {
      const [group, name, pct, time] = line.split("\t");
      const remaining = /^(\d+(?:\.\d+)?)%$/.exec(pct ?? "")?.[1];
      if (!group || !name || remaining === undefined) continue;
      const w = windowOf(name);
      const reset = Date.parse(time ?? "");
      out.push({
        id: `${group}-${i}`.replace(/\s+/g, "-").toLowerCase(),
        label: `${GROUP_SHORT(group)} · ${w?.label ?? name}`,
        usedPercent: clampPercent(100 - Number(remaining)),
        ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
        ...(w ? { windowMinutes: w.minutes } : {}),
      });
    }
  }
  return out;
}

export async function fetchAntigravityQuota(
  run: (argv: string[], timeoutMs: number) => Promise<string> = (argv, t) => runCapture(argv, t),
  now = Date.now(),
  bin: string | null = agyPath(),
): Promise<ProviderQuota> {
  const fail = (error: string): ProviderQuota => ({ id: "antigravity", name: "Antigravity", windows: [], error, updatedAt: now });
  if (!bin) return fail(tr("agy (Antigravity CLI) is not installed"));
  try {
    const windows = parseAgyUsage(await run([bin, "-p", "/usage", "--output-format", "json"], AGY_TIMEOUT_MS));
    return windows.length ? { id: "antigravity", name: "Antigravity", windows, updatedAt: now } : fail(tr("Could not read the Antigravity quota"));
  } catch (err: any) {
    return fail(tr("Could not run agy: {msg}", { msg: err?.message ?? err }));
  }
}
