/**
 * Theme packs that are not installed yet, kept for a live preview on the manage page (the details sheet draws the user's own screen
 * in the pack). A pack is fetched the same way as an install from the registry (same source, same sha256 pin and version, same
 * package checks), written to ~/.nookdeck/cache/themes/<sha256>/ and never added to the installed themes. The last few packs stay,
 * and Install takes the files from here when they still hash to the registry's pin.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { HOME } from "../config";
import { parseThemeManifest, type ThemeManifest } from "./manifest";
import { MANIFEST_FILE, PluginError, packageHash, type Files } from "./store";
import { scopeThemeCss } from "./theme-css";
import { THEME_FILE_EXT, checkPackage } from "./themes";

export const PREVIEW_CACHE_MAX = 5;

/** What the registry pins: the pack id, its version and the hash of its files. */
export interface PreviewPin { id: string; version: string; repo: string; sha256: string }
interface Meta { id: string; version: string; sha256: string; shown: string; at: number; files: string[] }
interface Entry { meta: Meta; manifest: ThemeManifest }

export interface ThemePreviewOptions {
  dir?: string;
  max?: number;
  agentVersion?: string;
  /** Fetches a package (PluginStore.resolveSource), the same function an install uses. */
  resolve: (source: string) => Promise<{ files: Files; shown: string }>;
  now?: () => number;
}

const SHA_RE = /^[0-9a-f]{64}$/;

export class ThemePreviewCache {
  private dir: string;
  private max: number;
  private now: () => number;
  private entries = new Map<string, Entry>(); // by sha256
  private loaded = false;
  private inflight = new Map<string, Promise<Entry>>();
  constructor(private opts: ThemePreviewOptions) {
    this.dir = opts.dir ?? join(HOME, "cache", "themes");
    this.max = Math.max(1, opts.max ?? PREVIEW_CACHE_MAX);
    this.now = opts.now ?? Date.now;
  }

  /** Reads what an earlier run left (meta.json plus the manifest of each folder); a broken folder is deleted. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let names: string[] = [];
    try { names = await readdir(this.dir); } catch { return; }
    for (const name of names) {
      if (!SHA_RE.test(name)) { if (name.includes(".tmp-")) await rm(join(this.dir, name), { recursive: true, force: true }); continue; }
      try {
        const meta = JSON.parse(await readFile(join(this.dir, name, "meta.json"), "utf8")) as Meta;
        if (meta.sha256 !== name || !Array.isArray(meta.files)) throw new Error("bad meta");
        const manifest = parseThemeManifest(JSON.parse(await readFile(join(this.dir, name, "files", MANIFEST_FILE), "utf8")));
        if (manifest.id !== meta.id) throw new Error("bad manifest");
        this.entries.set(name, { meta, manifest });
      } catch { await rm(join(this.dir, name), { recursive: true, force: true }); }
    }
    await this.prune();
  }

  /** The newest cached copy of a pack (by id), whatever its version. */
  private latest(id: string): Entry | undefined {
    let best: Entry | undefined;
    for (const e of this.entries.values()) if (e.meta.id === id && (!best || e.meta.at > best.meta.at)) best = e;
    return best;
  }

  /** Keeps one copy per pack and the `max` most recently used packs. */
  private async prune(): Promise<void> {
    const byRecent = [...this.entries.values()].sort((a, b) => b.meta.at - a.meta.at);
    const seen = new Set<string>();
    let kept = 0;
    for (const e of byRecent) {
      const keep = !seen.has(e.meta.id) && kept < this.max;
      seen.add(e.meta.id);
      if (keep) { kept++; continue; }
      this.entries.delete(e.meta.sha256);
      await rm(join(this.dir, e.meta.sha256), { recursive: true, force: true });
    }
  }

  /** Checks a downloaded package against the pin: the manifest parses, ids and version match, the files hash to the pin. */
  private check(pin: PreviewPin, files: Files): ThemeManifest {
    const mf = files.get(MANIFEST_FILE);
    if (!mf) throw new PluginError(`there is no ${MANIFEST_FILE} in that package`);
    let m: ThemeManifest;
    try { m = parseThemeManifest(JSON.parse(new TextDecoder().decode(mf)), { agentVersion: this.opts.agentVersion }); }
    catch (e: any) { throw new PluginError(e instanceof SyntaxError ? `${MANIFEST_FILE} is not valid JSON: ${e.message}` : `${MANIFEST_FILE}: ${e?.message ?? e}`); }
    if (m.id !== pin.id || m.version !== pin.version || packageHash(files) !== pin.sha256.toLowerCase()) throw new PluginError("the theme files do not match the reviewed version", 409);
    checkPackage(m, files);
    return m;
  }

  private async write(meta: Meta, files: Files): Promise<void> {
    const dest = join(this.dir, meta.sha256), tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(join(tmp, "files"), { recursive: true, mode: 0o700 });
    for (const [name, bytes] of files) {
      const target = join(tmp, "files", name);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
    await writeFile(join(tmp, "meta.json"), JSON.stringify(meta));
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  }

  private async touch(e: Entry): Promise<void> {
    e.meta.at = Math.max(this.now(), e.meta.at + 1);
    await writeFile(join(this.dir, e.meta.sha256, "meta.json"), JSON.stringify(e.meta)).catch(() => {});
  }

  /** The pack at the registry's pin: from the cache, or downloaded, checked and cached. Throws PluginError when it cannot be had. */
  async get(pin: PreviewPin): Promise<{ manifest: ThemeManifest; meta: Meta; cached: boolean }> {
    await this.load();
    const sha = pin.sha256.toLowerCase();
    const have = this.entries.get(sha);
    if (have && have.meta.id === pin.id && have.meta.version === pin.version) { await this.touch(have); return { ...have, cached: true }; }
    let p = this.inflight.get(sha);
    if (!p) {
      p = (async () => {
        const { files, shown } = await this.opts.resolve(pin.repo);
        const manifest = this.check(pin, files);
        const meta: Meta = { id: manifest.id, version: manifest.version, sha256: sha, shown, at: this.now(), files: [...files.keys()] };
        await this.write(meta, files);
        const e = { meta, manifest };
        this.entries.set(sha, e);
        await this.prune();
        return e;
      })().finally(() => this.inflight.delete(sha));
      this.inflight.set(sha, p);
    }
    const e = await p;
    return { ...e, cached: false };
  }

  /** The cached files at this pin for an install, re-hashed from disk; null when there is no good copy (then download as usual). */
  async take(pin: PreviewPin): Promise<{ files: Files; shown: string } | null> {
    await this.load();
    const e = this.entries.get(pin.sha256.toLowerCase());
    if (!e || e.meta.id !== pin.id || e.meta.version !== pin.version) return null;
    const files: Files = new Map();
    try { for (const f of e.meta.files) files.set(f, new Uint8Array(await readFile(join(this.dir, e.meta.sha256, "files", f)))); }
    catch { return null; }
    if (packageHash(files) !== e.meta.sha256) return null; // changed on disk: do not trust it
    return { files, shown: e.meta.shown };
  }

  /** The id has a cached copy (the file and css routes answer for it, to this computer only). */
  async has(id: string): Promise<boolean> { await this.load(); return !!this.latest(id); }

  /** A file of the newest cached copy of a pack, with the same path rules as an installed pack. */
  async file(id: string, rel: string): Promise<{ bytes: Uint8Array; name: string } | null> {
    await this.load();
    const e = this.latest(id);
    if (!e || !rel || rel.includes("\0") || rel.includes("\\") || rel.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
    if (!THEME_FILE_EXT.test(rel) || /^nookdeck\.json$/i.test(rel) || !e.meta.files.includes(rel)) return null;
    const root = join(this.dir, e.meta.sha256, "files") + sep, full = resolve(root, rel);
    if (!full.startsWith(root)) return null;
    try { return { bytes: new Uint8Array(await readFile(full)), name: rel }; } catch { return null; }
  }

  /** The scoped, checked CSS of a cached pack's variant, built exactly as for an installed pack. */
  async css(id: string, variant?: string): Promise<string> {
    await this.load();
    const e = this.latest(id);
    if (!e) throw new PluginError("that theme is not installed", 404);
    const m = e.manifest;
    const v = variant ? m.variants.find((x) => x.id === variant) : undefined;
    if (variant && !v) throw new PluginError(`this theme has no variant "${variant}"`, 400);
    const set = new Set(e.meta.files);
    const read = async (f: string) => (await this.file(id, f))?.bytes;
    let out = "";
    if (m.css) { const b = await read(m.css); if (b) out += scopeThemeCss(new TextDecoder().decode(b), { id, files: set }) + "\n"; }
    if (v?.css) { const b = await read(v.css); if (b) out += scopeThemeCss(new TextDecoder().decode(b), { id, variant: v.id, files: set }) + "\n"; }
    return out;
  }
}
