import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HOME } from "../config";
import type { ProviderQuota, QuotaWindow } from "./types";

export const HISTORY_SAMPLE_MS = 5 * 60_000;
export const HISTORY_KEEP_MS = 24 * 3600_000;
export const HISTORY_MAX_POINTS = 48;
/** Account key for the provider-level windows (the chosen account's). */
const TOP = "_";

export type HistoryPoint = [number, number];
export const quotaHistoryPath = () => join(HOME, "quota-history.json");

/** Evenly thins a series to at most `max` points, always keeping the first and the last. */
export function downsample(points: HistoryPoint[], max = HISTORY_MAX_POINTS): HistoryPoint[] {
  if (points.length <= max) return points;
  const out: HistoryPoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]!);
  return out;
}

/**
 * usedPercent per provider/account/window, one sample every 5 minutes for 24 hours, in memory and in
 * ~/.nookdeck/quota-history.json (0600). Only fresh readings are sampled.
 */
export class QuotaHistory {
  private series = new Map<string, HistoryPoint[]>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private file = quotaHistoryPath(), private now: () => number = Date.now) {}

  private key = (provider: string, account: string, window: string) => `${provider}/${account}/${window}`;

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      const cutoff = this.now() - HISTORY_KEEP_MS;
      for (const [k, pts] of Object.entries(raw?.series ?? {})) {
        if (!Array.isArray(pts)) continue;
        const ok = pts.filter((p: any) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= cutoff) as HistoryPoint[];
        if (ok.length) this.series.set(k, ok);
      }
    } catch {
      /* none yet */
    }
  }

  private sample(provider: string, account: string, w: QuotaWindow, t: number): boolean {
    if (w.usedPercent === null) return false; // nothing to chart
    const k = this.key(provider, account, w.id);
    const pts = this.series.get(k) ?? [];
    const last = pts[pts.length - 1];
    if (last && t - last[0] < HISTORY_SAMPLE_MS) return false;
    pts.push([t, Math.round(w.usedPercent * 10) / 10]);
    const cutoff = t - HISTORY_KEEP_MS;
    while (pts.length && pts[0]![0] < cutoff) pts.shift();
    this.series.set(k, pts);
    return true;
  }

  /** Samples what is due. Returns true when anything was added (and schedules a save). */
  record(providers: ProviderQuota[]): boolean {
    const t = this.now();
    let added = false;
    for (const p of providers) {
      // a stale reading is the last good one again: sampling it would chart old numbers as new points
      if (!p.stale && !(p.error && p.windows.length === 0)) for (const w of p.windows) added = this.sample(p.id, TOP, w, t) || added;
      for (const a of p.accounts ?? []) if (!a.stale) for (const w of a.windows) added = this.sample(p.id, a.id, w, t) || added;
    }
    if (added) void this.save();
    return added;
  }

  get(provider: string, account: string | undefined, windowId: string): HistoryPoint[] {
    return downsample(this.series.get(this.key(provider, account ?? TOP, windowId)) ?? []);
  }

  /** The providers with `history` on every window that has samples . */
  decorate(providers: ProviderQuota[]): ProviderQuota[] {
    const withHist = (provider: string, account: string | undefined, ws: QuotaWindow[]) =>
      ws.map((w) => {
        const h = this.get(provider, account, w.id);
        return h.length ? { ...w, history: h } : w;
      });
    return providers.map((p) => ({
      ...p,
      windows: withHist(p.id, undefined, p.windows),
      ...(p.accounts ? { accounts: p.accounts.map((a) => ({ ...a, windows: withHist(p.id, a.id, a.windows) })) } : {}),
    }));
  }

  save(): Promise<void> {
    const body = JSON.stringify({ series: Object.fromEntries(this.series) });
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, body + "\n", { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, this.file);
      } catch {
        /* best effort */
      }
    });
    return this.chain.then(() => {});
  }
}
