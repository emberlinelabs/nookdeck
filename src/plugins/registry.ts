/**
 * The community registry (spec D8): plugins.json in the GitHub repo howznguyen/nookdeck-plugins. The agent reads it, caches it
 * (10 minutes, ETag, last good copy kept on disk for offline use) and checks every install against the entry's sha256.
 * NOOKDECK_REGISTRY_URL overrides the address (tests, a mirror).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HOME, PLUGIN_ID_RE } from "../config";
import { parseManifest, describePermissions } from "./manifest";
import { PluginError, manifestUrls, MANIFEST_FILE } from "./store";
import type { Manifest } from "./types";

export const DEFAULT_REGISTRY_URL = "https://raw.githubusercontent.com/howznguyen/nookdeck-plugins/main/plugins.json";
export const REGISTRY_TTL_MS = 10 * 60_000;
export const REGISTRY_MAX_BYTES = 1_000_000;
export const REGISTRY_MAX_ENTRIES = 500;
export const README_MAX_BYTES = 200 * 1024;

/** One reviewed plugin in the registry. `repo` is what the installer takes; `sha256` is the pin the files must match. */
export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  repo: string;
  sha256: string;
  description?: string;
  author?: string;
  icon?: string;
  screenshot?: string;
  tier?: string;
  /** "theme" for a theme package; missing means plugin. */
  type?: "plugin" | "theme";
  permissions?: unknown;
}
/** What the UI shows about a registry plugin before it is installed (parsed from its nookdeck.json in the repo). */
export interface RegistryManifest {
  id: string; name: string; version: string; nookdeck?: string; author?: string; description?: string; icon?: string;
  permissions: Manifest["permissions"];
  /** Human lines for the permissions, as in the install dialog. */
  permissionLines: string[];
  settings: Manifest["settings"];
  widgets: Array<{ id: string; name: string; render: string; sizes: string[]; settings: Manifest["settings"]; preview?: unknown }>;
  actions: Array<{ id: string; name: string; settings: Manifest["settings"] }>;
  themes: Array<{ id: string; name: string }>;
  layouts: Array<{ id: string; name: string }>;
  /** The entry module of a code plugin, or null for a no-code one. */
  main: string | null;
  /** The version the registry lists; `version` above is what the repo's manifest says now (they can differ until the entry is updated). */
  registryVersion: string;
}
export interface RegistryResult { plugins: RegistryEntry[]; fetchedAt: number; stale?: true }

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length && v.length <= max ? v : undefined);

/** Keeps the entries that are usable and drops the rest: a bad row must not hide the good ones. */
export function parseRegistry(raw: unknown): RegistryEntry[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as any).plugins) ? (raw as any).plugins : null;
  if (!list) throw new Error("plugins.json must be a list of plugins");
  const out: RegistryEntry[] = [];
  const seen = new Set<string>();
  for (const e of list.slice(0, REGISTRY_MAX_ENTRIES)) {
    if (!e || typeof e !== "object") continue;
    const id = str(e.id, 100), name = str(e.name, 80), version = str(e.version, 40), repo = str(e.repo, 300), sha = str(e.sha256, 64);
    if (!id || !PLUGIN_ID_RE.test(id) || id.startsWith("core.") || seen.has(id) || !name || !version || !/^\d+\.\d+\.\d+/.test(version)) continue;
    if (!repo || !/^https:\/\//i.test(repo) || !sha || !/^[0-9a-f]{64}$/i.test(sha)) continue;
    seen.add(id);
    const o: RegistryEntry = { id, name, version, repo, sha256: sha.toLowerCase(), ...(e.type === "theme" ? { type: "theme" as const } : {}) };
    for (const k of ["description", "author", "tier"] as const) { const v = str(e[k], 300); if (v) o[k] = v; }
    for (const k of ["icon", "screenshot"] as const) { const v = str(e[k], 400); if (v && /^https:\/\//i.test(v)) o[k] = v; }
    if (e.permissions && typeof e.permissions === "object") o.permissions = e.permissions;
    out.push(o);
  }
  return out;
}

/** > 0 when a is newer than b. Numeric x.y.z; a release is newer than its own prerelease. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?/.exec(v.trim()); return m ? { n: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)], pre: m[4] ?? "" } : { n: [0, 0, 0], pre: "" }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! > y.n[i]! ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

export interface RegistryOptions {
  url?: string;
  fetch?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
  /** Last good copy on disk (default ~/.nookdeck/plugins-registry.json). */
  file?: string;
}

interface Cached { plugins: RegistryEntry[]; fetchedAt: number; etag?: string }

export class Registry {
  private cache: Cached | null = null;
  private loaded = false;
  private inflight: Promise<RegistryResult> | null = null;
  readonly url: string;
  private readonly f: typeof fetch;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly file: string;

  constructor(o: RegistryOptions = {}) {
    this.url = o.url ?? process.env.NOOKDECK_REGISTRY_URL ?? DEFAULT_REGISTRY_URL;
    this.f = o.fetch ?? fetch;
    this.ttl = o.ttlMs ?? REGISTRY_TTL_MS;
    this.now = o.now ?? Date.now;
    this.file = o.file ?? join(HOME, "plugins-registry.json");
  }

  private async loadDisk(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      const plugins = parseRegistry(raw.plugins);
      if (!this.cache) this.cache = { plugins, fetchedAt: Number(raw.fetchedAt) || 0, ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}) };
    } catch { /* no copy yet */ }
  }

  private async saveDisk(c: Cached): Promise<void> {
    try {
      await mkdir(resolve(this.file, ".."), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(c));
      await rename(tmp, this.file);
    } catch { /* a cache that cannot be written is only a missing cache */ }
  }

  /** The registry, from cache while it is fresh. Offline or failing: the last good copy with `stale: true`. */
  get(force = false): Promise<RegistryResult> {
    if (!this.inflight) this.inflight = this.load(force).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(force: boolean): Promise<RegistryResult> {
    await this.loadDisk();
    const c = this.cache;
    if (c && !force && this.now() - c.fetchedAt < this.ttl && c.fetchedAt > 0) return { plugins: c.plugins, fetchedAt: c.fetchedAt };
    try {
      const res = await this.f(this.url, {
        redirect: "follow", signal: AbortSignal.timeout(10_000),
        headers: { accept: "application/json", ...(c?.etag ? { "if-none-match": c.etag } : {}) },
      });
      if (res.status === 304 && c) {
        this.cache = { ...c, fetchedAt: this.now() };
        await this.saveDisk(this.cache);
        return { plugins: c.plugins, fetchedAt: this.cache.fetchedAt };
      }
      if (!res.ok) throw new Error(`the registry answered ${res.status}`);
      const text = await res.text();
      if (text.length > REGISTRY_MAX_BYTES) throw new Error("the registry is larger than 1 MB");
      const plugins = parseRegistry(JSON.parse(text));
      this.cache = { plugins, fetchedAt: this.now(), ...(res.headers.get("etag") ? { etag: res.headers.get("etag")! } : {}) };
      await this.saveDisk(this.cache);
      return { plugins, fetchedAt: this.cache.fetchedAt };
    } catch (e: any) {
      if (c) return { plugins: c.plugins, fetchedAt: c.fetchedAt, stale: true };
      throw new PluginError(`could not read the plugin registry: ${String(e?.message ?? e).slice(0, 120)}`, 502);
    }
  }

  private manifests = new Map<string, { at: number; m: RegistryManifest }>();

  /** The plugin's nookdeck.json from its repo, parsed and trimmed for display. Cached for the registry ttl. Never installs anything. */
  async manifest(entry: RegistryEntry): Promise<RegistryManifest> {
    const key = `${entry.id}@${entry.repo}`;
    const hit = this.manifests.get(key);
    if (hit && this.now() - hit.at < this.ttl && hit.at > 0) return hit.m;
    let text: string | null = null;
    let urls: string[];
    try { urls = manifestUrls(entry.repo); } catch { throw new PluginError("the registry entry has a bad repo address", 502); }
    try {
      for (const u of urls) {
        const res = await this.f(u, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json, text/plain" } });
        if (res.status === 404) continue;
        if (!res.ok) throw new PluginError(`could not read the plugin: the server answered ${res.status}`, 502);
        const body = await res.text();
        if (body.length > 256 * 1024) throw new PluginError("the manifest is larger than 256 KB", 502);
        text = body;
        break;
      }
    } catch (e: any) {
      if (hit) return hit.m; // offline: the last copy
      throw e instanceof PluginError ? e : new PluginError(`could not read the plugin: ${String(e?.message ?? e).slice(0, 120)}`, 502);
    }
    if (text === null) throw new PluginError(`no ${MANIFEST_FILE} found in the plugin's repo`, 502);
    let m: Manifest;
    try { m = parseManifest(JSON.parse(text)); } catch (e: any) { throw new PluginError(`the plugin's ${MANIFEST_FILE} is not valid: ${String(e?.message ?? e).slice(0, 160)}`, 502); }
    const out: RegistryManifest = {
      id: m.id, name: m.name, version: m.version, ...(m.nookdeck ? { nookdeck: m.nookdeck } : {}), ...(m.author ? { author: m.author } : {}),
      ...(m.description ? { description: m.description } : {}), ...(m.icon ? { icon: m.icon } : {}),
      permissions: m.permissions, permissionLines: describePermissions(m.permissions), settings: m.settings,
      widgets: m.widgets.map((w) => ({ id: w.id, name: w.name, render: w.render, sizes: w.sizes, settings: w.settings, ...(w.preview !== undefined ? { preview: w.preview } : {}) })),
      actions: m.actions.map((a) => ({ id: a.id, name: a.name, settings: a.settings })),
      themes: m.themes.map((t) => ({ id: t.id, name: t.name })), layouts: m.layouts.map((l) => ({ id: l.id, name: l.name })),
      main: m.main, registryVersion: entry.version,
    };
    this.manifests.set(key, { at: this.now(), m: out });
    return out;
  }

  async entry(id: string): Promise<RegistryEntry | undefined> {
    return (await this.get()).plugins.find((p) => p.id === id);
  }

  /** README.md of a registry plugin, raw, from its repo. Null when the repo has none. Too big = error. */
  async readme(entry: RegistryEntry): Promise<string | null> {
    let urls: string[];
    try { urls = manifestUrls(entry.repo).map((u) => u.endsWith(MANIFEST_FILE) ? `${u.slice(0, -MANIFEST_FILE.length)}README.md` : u); } catch { return null; }
    for (const u of urls) {
      const res = await this.f(u, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { accept: "text/plain, text/markdown" } });
      if (res.status === 404) continue;
      if (!res.ok) throw new PluginError(`could not read the README: the server answered ${res.status}`, 502);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > README_MAX_BYTES) throw new PluginError("the README is larger than 200 KB", 413);
      return new TextDecoder().decode(buf);
    }
    return null;
  }
}
