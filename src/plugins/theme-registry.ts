/** The theme registry: themes.json next to plugins.json (separate, so agents that only know plugins never see themes). */
import { PLUGIN_ID_RE } from "../config";
import { REGISTRY_MAX_BYTES, REGISTRY_MAX_ENTRIES, REGISTRY_TTL_MS } from "./registry";

export interface RegistryTheme {
  id: string; name: string; version: string; repo: string; sha256: string;
  author?: string; description?: string; license?: string; credit?: string;
  variants: Array<{ id: string; name: string; mode: "light" | "dark"; preview?: string }>;
}
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length && v.length <= max ? v : undefined);

export function parseThemeRegistry(raw: unknown): RegistryTheme[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as any).themes) ? (raw as any).themes : null;
  if (!list) throw new Error("themes.json must be a list of themes");
  const out: RegistryTheme[] = [], seen = new Set<string>();
  for (const e of list.slice(0, REGISTRY_MAX_ENTRIES)) {
    if (!e || typeof e !== "object") continue;
    const id = str(e.id, 100), name = str(e.name, 80), version = str(e.version, 40), repo = str(e.repo, 300), sha = str(e.sha256, 64);
    if (!id || !PLUGIN_ID_RE.test(id) || seen.has(id) || !name || !version || !/^\d+\.\d+\.\d+/.test(version)) continue;
    if (!repo || !/^https:\/\//i.test(repo) || !sha || !/^[0-9a-f]{64}$/i.test(sha)) continue;
    seen.add(id);
    const o: RegistryTheme = { id, name, version, repo, sha256: sha.toLowerCase(), variants: [] };
    for (const k of ["author", "description", "license", "credit"] as const) { const v = str(e[k], 300); if (v) o[k] = v; }
    if (Array.isArray(e.variants)) for (const v of e.variants.slice(0, 12)) {
      const vid = str(v?.id, 48), vn = str(v?.name, 60);
      if (!vid || !vn || (v.mode !== "light" && v.mode !== "dark")) continue;
      const pv = str(v.preview, 400);
      o.variants.push({ id: vid, name: vn, mode: v.mode, ...(pv && /^https:\/\//i.test(pv) ? { preview: pv } : {}) });
    }
    out.push(o);
  }
  return out;
}

export class ThemeRegistry {
  private cache: { themes: RegistryTheme[]; at: number } | null = null;
  readonly url: string;
  constructor(pluginsUrl: string, private f: typeof fetch = fetch, private now: () => number = Date.now) {
    this.url = pluginsUrl.replace(/[^/]*$/, "themes.json");
  }
  /** From cache while fresh; offline or failing, the last copy (or an empty list when there never was one: themes are optional). */
  async get(force = false): Promise<{ themes: RegistryTheme[]; stale?: true }> {
    const c = this.cache;
    if (c && !force && this.now() - c.at < REGISTRY_TTL_MS) return { themes: c.themes };
    try {
      const res = await this.f(this.url, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`the registry answered ${res.status}`);
      const text = await res.text();
      if (text.length > REGISTRY_MAX_BYTES) throw new Error("themes.json is larger than 1 MB");
      const themes = parseThemeRegistry(JSON.parse(text));
      this.cache = { themes, at: this.now() };
      return { themes };
    } catch {
      return c ? { themes: c.themes, stale: true } : { themes: [], stale: true };
    }
  }
}
