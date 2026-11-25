/**
 * Installed plugins on disk: ~/.nookdeck/plugins/<id>/<version>/ (the files) and ~/.nookdeck/plugins.json (state: enabled,
 * pinned version and sha256, granted permissions, settings). Install from a local folder or manifest file, or from an https URL.
 */
import { osReason, type PluginOs } from "./os";
import { platform } from "../platform";
import { userHome } from "../home";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";

import { join, resolve } from "node:path";
import { HOME, PLUGIN_ID_RE } from "../config";
import { MANIFEST_MAX_BYTES, covers, describePermissions, parseManifest, parsePermissions } from "./manifest";
import { coerce } from "./sources";
import { TAR_MAX_COMPRESSED, TarError, readTarGz } from "./tar";
import { materializePreview } from "./core";
import type { Manifest, Permissions, PluginState, SettingField, Settings, StateFile } from "./types";

export const MAX_FILES = 200;
export const MAX_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);
export const MANIFEST_FILE = "nookdeck.json";

export type Files = Map<string, Uint8Array>;

/** sha256 over the sorted (path, bytes) of a package: the pin of an install. */
export function packageHash(files: Files): string {
  const h = createHash("sha256");
  for (const name of [...files.keys()].sort()) h.update(name).update("\0").update(files.get(name)!).update("\0");
  return h.digest("hex");
}

export async function readFolder(root: string): Promise<Files> {
  const files: Files = new Map();
  let total = 0;
  const walk = async (rel: string): Promise<void> => {
    for (const ent of await readdir(join(root, rel), { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { await walk(r); continue; }
      if (!ent.isFile()) continue;
      if (files.size >= MAX_FILES) throw new Error(`the plugin folder has more than ${MAX_FILES} files`);
      const bytes = new Uint8Array(await readFile(join(root, r)));
      total += bytes.length;
      if (total > MAX_BYTES) throw new Error("the plugin folder is larger than 5 MB");
      files.set(r, bytes);
    }
  };
  await walk("");
  return files;
}

/** A GitHub repository (or tree) address: owner, repo, the ref when given, and the plugin's folder inside the repo. */
export function githubRepo(url: string): { owner: string; repo: string; ref?: string; sub: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname !== "github.com") return null;
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(u.pathname);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3], sub: (m[4] ?? "").replace(/\/+$/, "") };
}

/** Raw manifest addresses to try for an https URL: the URL itself, or a GitHub repo page (main, then master). */
export function manifestUrls(url: string): string[] {
  const u = new URL(url);
  if (u.hostname === "github.com") {
    const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/.exec(u.pathname);
    if (m) {
      const [, owner, repo, branch, sub] = m;
      const dir = sub ? `${sub.replace(/\/$/, "")}/` : "";
      return (branch ? [branch] : ["main", "master"]).map((b) => `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${dir}${MANIFEST_FILE}`);
    }
  }
  return [url];
}

export interface StoreOptions {
  /** Where installs live (default ~/.nookdeck/plugins). */
  dir?: string;
  /** Where state lives (default ~/.nookdeck/plugins.json). */
  stateFile?: string;
  /** The running Nookdeck version, checked against a manifest's `nookdeck` range. */
  agentVersion?: string;
  fetch?: typeof fetch;
  /** Test hook: where GitHub packages come from (default https://codeload.github.com). */
  codeloadBase?: string;
  now?: () => number;
  /** Test hook: which system this computer is (default: the real one). */
  platform?: string;
}

export interface PluginSummary {
  id: string; name: string; version: string; author?: string; description?: string; icon?: string;
  source: string; sha256: string; installedAt: number;
  /** Not reviewed by the Nookdeck registry (every P1 install is). */
  unreviewed: boolean;
  /** Ships with Nookdeck (core.*): shown as "Built-in", can be disabled but not removed. */
  builtin?: boolean;
  /** The registry version these exact files were reviewed at (unreviewed is then false). */
  registryVersion?: string;
  enabled: boolean;
  permissions: Permissions;
  granted: Permissions;
  /** Something in `permissions` is missing from `granted`. */
  needsApproval: boolean;
  /** Human lines for the install dialog. */
  permissionLines: string[];
  /** Plugin-wide fields; a secret never has a value here, only `isSet`. */
  fields: Array<SettingField & { isSet?: boolean }>;
  /** Current plugin-wide values, secrets left out. */
  settings: Settings;
  widgets: Array<{ id: string; name: string; render: string; sizes: string[]; settings: SettingField[]; preview?: unknown; style?: string }>;
  actions: Array<{ id: string; name: string; settings: SettingField[] }>;
  themes: Array<{ id: string; name: string; theme: unknown }>;
  layouts: Array<{ id: string; name: string; layout: unknown }>;
  /** The systems it works on; missing = every one. */
  os?: PluginOs[];
  /** Why it cannot run (files changed since install, manifest unreadable, another operating system). */
  error?: string;
  /** The plugin runs code (`main`): trusted code, not a sandbox. */
  code: boolean;
  /** The entry file of a code plugin (relative), else null. */
  main: string | null;
  /** `nookdeck plugin dev`: read in place from the author's folder. */
  linked: boolean;
}

export class PluginError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

interface Loaded { manifest: Manifest; error?: string }

export class PluginStore {
  private state: StateFile = { version: 1, plugins: {} };
  private manifests = new Map<string, Loaded>();
  private builtin = new Set<string>();
  private coreSaved: NonNullable<StateFile["core"]> = {};
  private listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  readonly dir: string;
  private readonly stateFile: string;
  private readonly now: () => number;

  constructor(private opts: StoreOptions = {}) {
    this.dir = opts.dir ?? join(HOME, "plugins");
    this.stateFile = opts.stateFile ?? join(HOME, "plugins.json");
    this.now = opts.now ?? Date.now;
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(): void { for (const fn of this.listeners) { try { fn(); } catch { /* a listener must not break the store */ } } }

  /** Reads state and every installed manifest; a plugin whose files changed since install is kept but disabled. */
  async load(): Promise<void> {
    let raw: any;
    try { raw = JSON.parse(await readFile(this.stateFile, "utf8")); } catch { raw = null; }
    this.state = { version: 1, plugins: {} };
    this.manifests.clear();
    this.builtin.clear();
    this.coreSaved = {};
    if (raw && typeof raw === "object" && raw.core && typeof raw.core === "object") {
      for (const [id, c] of Object.entries<any>(raw.core)) {
        if (!id.startsWith("core.") || !c || typeof c !== "object") continue;
        this.coreSaved[id] = { enabled: c.enabled !== false, settings: c.settings && typeof c.settings === "object" ? c.settings : {} };
      }
    }
    const plugins = raw && typeof raw === "object" && raw.plugins && typeof raw.plugins === "object" ? raw.plugins : {};
    for (const [id, s] of Object.entries<any>(plugins)) {
      if (id.startsWith("core.") || !PLUGIN_ID_RE.test(id) || !s || typeof s.version !== "string" || typeof s.sha256 !== "string") continue;
      const st: PluginState = {
        version: s.version, sha256: s.sha256, source: String(s.source ?? ""), installedAt: Number(s.installedAt) || 0,
        enabled: s.enabled === true, granted: s.granted ? parsePermissionsSafe(s.granted) : null,
        settings: s.settings && typeof s.settings === "object" ? s.settings : {},
        ...(s.linked === true ? { linked: true } : {}),
        ...(s.reviewed === true && typeof s.registryVersion === "string" ? { reviewed: true, registryVersion: s.registryVersion } : {}),
      };
      this.state.plugins[id] = st;
      try {
        const files = await readFolder(this.dirOf(id));
        const manifest = parseManifest(JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE))), { allowCore: false });
        if (st.linked) { st.sha256 = packageHash(files); st.version = manifest.version; this.manifests.set(id, { manifest }); }
        else if (packageHash(files) !== st.sha256) { st.enabled = false; this.manifests.set(id, { manifest, error: "the plugin's files changed after install: reinstall it" }); }
        else this.manifests.set(id, { manifest });
        // D3: copied from another computer, or updated by hand: kept, shown disabled with the reason
        const wrongOs = this.osReason(manifest);
        if (wrongOs && !this.manifests.get(id)!.error) this.manifests.set(id, { manifest, error: wrongOs });
      } catch (e: any) {
        st.enabled = false;
        this.manifests.set(id, { manifest: placeholder(id, st.version), error: `cannot read the plugin: ${String(e?.message ?? e).slice(0, 120)}` });
      }
    }
  }

  /**
   * Adds the plugins that ship with the agent (call after load()). They are enabled unless the user turned one off, hold every
   * permission they declare, and keep their enabled flag and settings in plugins.json under `core`.
   */
  registerCore(manifests: Manifest[]): void {
    for (const m of manifests) {
      const saved = this.coreSaved[m.id];
      this.builtin.add(m.id);
      this.manifests.set(m.id, { manifest: m });
      this.state.plugins[m.id] = { version: m.version, sha256: "", source: "built-in", installedAt: 0, enabled: saved ? saved.enabled : true, granted: m.permissions, settings: saved ? saved.settings : {} };
    }
    this.changed();
  }

  /** Why this computer cannot run the plugin, if it is made for other systems. */
  osReason(m: { os?: PluginOs[] }): string | undefined { return osReason(m.os, this.opts.platform ?? platform.id); }

  isBuiltin(id: string): boolean { return this.builtin.has(id); }

  private versionDir(id: string, version: string): string { return join(this.dir, id, version); }

  /** Where a plugin's files are: its install folder, or (a linked dev plugin) the author's own folder. */
  dirOf(id: string): string {
    const s = this.state.plugins[id];
    return s?.linked ? s.source : this.versionDir(id, s?.version ?? "");
  }

  private save(): Promise<void> {
    const plugins: Record<string, PluginState> = {};
    const core: NonNullable<StateFile["core"]> = { ...this.coreSaved };
    for (const [id, st] of Object.entries(this.state.plugins)) {
      if (this.builtin.has(id)) core[id] = { enabled: st.enabled, settings: st.settings };
      else plugins[id] = st;
    }
    const snapshot = JSON.stringify({ version: 1, plugins, ...(Object.keys(core).length ? { core } : {}) }, null, 2);
    this.chain = this.chain.then(async () => {
      await mkdir(resolve(this.stateFile, ".."), { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.tmp`;
      await writeFile(tmp, snapshot + "\n", { mode: 0o600 });
      await chmod(tmp, 0o600).catch(() => {});
      await rename(tmp, this.stateFile);
    });
    return this.chain as Promise<void>;
  }

  ids(): string[] { return Object.keys(this.state.plugins); }
  has(id: string): boolean { return id in this.state.plugins; }

  /** What the runtime needs to run a plugin, or undefined when it is not installed. */
  entry(id: string): { manifest: Manifest; state: PluginState; error?: string } | undefined {
    const state = this.state.plugins[id];
    const m = this.manifests.get(id);
    return state && m ? { manifest: m.manifest, state, ...(m.error ? { error: m.error } : {}) } : undefined;
  }

  /** The plugin may run: enabled, files intact, and every declared permission granted. */
  runnable(id: string): "ok" | "missing" | "disabled" | "not-granted" {
    const e = this.entry(id);
    if (!e) return "missing";
    if (!e.state.enabled || e.error) return "disabled";
    return covers(e.state.granted, e.manifest.permissions) ? "ok" : "not-granted";
  }

  summary(id: string): PluginSummary | undefined {
    const e = this.entry(id);
    if (!e) return undefined;
    const { manifest: m, state: s } = e;
    const values: Settings = {};
    const fields = m.settings.map((f) => {
      if (f.type === "secret") return { ...f, ...(typeof s.settings[f.key] === "string" && s.settings[f.key] !== "" ? { isSet: true } : {}) };
      const v = s.settings[f.key] ?? f.default;
      if (v !== undefined) values[f.key] = v;
      return f;
    });
    return {
      id, name: m.name, version: s.version, ...(m.author ? { author: m.author } : {}), ...(m.description ? { description: m.description } : {}), ...(m.icon ? { icon: m.icon } : {}), ...(m.os ? { os: m.os } : {}),
      source: s.source, sha256: s.sha256, installedAt: s.installedAt, unreviewed: !this.builtin.has(id) && !s.reviewed, ...(this.builtin.has(id) ? { builtin: true } : {}), ...(s.reviewed ? { registryVersion: s.registryVersion } : {}), enabled: s.enabled && !e.error,
      permissions: m.permissions, granted: s.granted ?? { network: [] }, needsApproval: !covers(s.granted, m.permissions),
      permissionLines: describePermissions(m.permissions), fields, settings: values,
      widgets: m.widgets.map((w) => ({ id: w.id, name: w.name, render: w.render, sizes: w.sizes, settings: w.settings, ...(w.style ? { style: w.style } : {}), ...(w.preview !== undefined ? { preview: this.builtin.has(id) ? materializePreview(String(w.render), w.preview) : w.preview } : {}) })),
      actions: m.actions.map((a) => ({ id: a.id, name: a.name, settings: a.settings })),
      themes: m.themes, layouts: m.layouts, ...(e.error ? { error: e.error } : {}), code: m.main !== null, main: m.main, linked: s.linked === true,
    };
  }

  list(): PluginSummary[] {
    return this.ids().sort().map((id) => this.summary(id)!);
  }

  // ----- install / remove -----

  private async fetchText(url: string): Promise<string | null> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(url, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json, text/plain" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new PluginError(`could not download the plugin: the server answered ${res.status}`);
    const text = await res.text();
    if (text.length > MANIFEST_MAX_BYTES) throw new PluginError("the manifest is larger than 256 KB");
    return text;
  }

  /** Downloads a GitHub package (codeload tar.gz) and extracts only the plugin's folder. */
  private async fetchGithubPackage(g: { owner: string; repo: string; ref?: string; sub: string }): Promise<Files | null> {
    const f = this.opts.fetch ?? fetch;
    const base = this.opts.codeloadBase ?? "https://codeload.github.com";
    for (const ref of g.ref ? [g.ref] : ["main", "master"]) {
      const res = await f(`${base}/${g.owner}/${g.repo}/tar.gz/${ref}`, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) continue;
      if (!res.ok) throw new PluginError(`could not download the plugin: the server answered ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > TAR_MAX_COMPRESSED) throw new PluginError("the package is larger than 10 MB");
      // read with a cap, so a server that lies about the length cannot fill the memory
      const chunks: Uint8Array[] = [];
      let got = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new PluginError("could not download the plugin");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > TAR_MAX_COMPRESSED) { await reader.cancel().catch(() => {}); throw new PluginError("the package is larger than 10 MB"); }
        chunks.push(value);
      }
      const gz = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { gz.set(c, o); o += c.length; }
      try { return readTarGz(gz, g.sub); } catch (e: any) { throw new PluginError(e instanceof TarError ? e.message : String(e?.message ?? e)); }
    }
    return null;
  }

  /** The package behind a folder, GitHub address or manifest URL (also used by theme packages). */
  async resolveSource(source: string): Promise<{ files: Files; shown: string }> {
    const src = source.trim();
    if (!src) throw new PluginError("give a folder path or an https address");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
      if (!/^https:\/\//i.test(src)) throw new PluginError("only https addresses can be installed from the web");
      let urls: string[];
      try { urls = manifestUrls(src); } catch { throw new PluginError("that is not a valid web address"); }
      for (const u of urls) {
        const text = await this.fetchText(u);
        if (text === null) continue;
        // a plugin with code needs its other files: fetch the repository package (a no-code plugin stays manifest-only, as before)
        const g = githubRepo(src);
        let main: unknown, isTheme = false;
        try { const j = JSON.parse(text); main = j?.main; isTheme = j?.type === "theme"; } catch { /* reported later as invalid JSON */ }
        if (g && ((typeof main === "string" && main) || isTheme)) {
          const pkg = await this.fetchGithubPackage(g);
          if (!pkg || !pkg.has(MANIFEST_FILE)) throw new PluginError(`could not download the plugin files from that repository`);
          return { files: pkg, shown: src };
        }
        return { files: new Map([[MANIFEST_FILE, new TextEncoder().encode(text)]]), shown: src };
      }
      throw new PluginError(`no ${MANIFEST_FILE} found at that address`);
    }
    const path = resolve(src.startsWith("~") ? join(userHome(), src.slice(1)) : src);
    let st;
    try { st = await stat(path); } catch { throw new PluginError("that path does not exist"); }
    if (st.isDirectory()) {
      const files = await readFolder(path).catch((e) => { throw new PluginError(String(e?.message ?? e)); });
      if (!files.has(MANIFEST_FILE)) throw new PluginError(`there is no ${MANIFEST_FILE} in that folder`);
      return { files, shown: path };
    }
    if (st.size > MANIFEST_MAX_BYTES) throw new PluginError("the manifest is larger than 256 KB");
    return { files: new Map([[MANIFEST_FILE, new Uint8Array(await readFile(path))]]), shown: path };
  }

  /**
   * Installs (or updates) from a folder, a manifest file or an https address. A new install starts disabled. An update keeps
   * settings and the enabled flag, unless it asks for permissions the user has not granted: then it is disabled until granted.
   */
  async install(source: string, from?: { sha256: string; version: string }): Promise<{ plugin: PluginSummary; updated: boolean; unchanged: boolean }> {
    const { files, shown } = await this.resolveSource(source);
    let manifest: Manifest;
    try { manifest = parseManifest(JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE))), { agentVersion: this.opts.agentVersion }); }
    catch (e: any) { throw new PluginError(e instanceof SyntaxError ? `${MANIFEST_FILE} is not valid JSON: ${e.message}` : `${MANIFEST_FILE}: ${e?.message ?? e}`); }
    const wrongOs = this.osReason(manifest);
    if (wrongOs) throw new PluginError(wrongOs, 409);
    if (manifest.main && files.size === 1 && /^https?:/i.test(source.trim()) && !githubRepo(source.trim())) throw new PluginError("a plugin with code cannot be installed from a single manifest address: install code plugins from a GitHub repository URL or a folder");
    if (manifest.main && !files.has(manifest.main)) throw new PluginError(`${MANIFEST_FILE}: main is "${manifest.main}", but that file is not in the plugin`);
    const sha = packageHash(files);
    // a registry install must be exactly what was reviewed: nothing is written when the files differ
    if (from && (sha !== from.sha256.toLowerCase() || manifest.version !== from.version)) throw new PluginError("the plugin files do not match the reviewed version", 409);
    const prev = this.state.plugins[manifest.id];
    if (prev && prev.version === manifest.version && prev.sha256 === sha && !this.manifests.get(manifest.id)?.error) {
      if (from && !prev.reviewed) { prev.reviewed = true; prev.registryVersion = from.version; await this.save(); this.changed(); }
      return { plugin: this.summary(manifest.id)!, updated: false, unchanged: true };
    }
    const dest = this.versionDir(manifest.id, manifest.version);
    const tmp = `${dest}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of files) {
      const target = join(tmp, name);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, bytes);
    }
    await rm(dest, { recursive: true, force: true });
    await mkdir(resolve(dest, ".."), { recursive: true, mode: 0o700 });
    await rename(tmp, dest);
    if (prev && prev.version !== manifest.version) await rm(this.versionDir(manifest.id, prev.version), { recursive: true, force: true });
    const granted = prev?.granted ?? null;
    this.state.plugins[manifest.id] = {
      version: manifest.version, sha256: sha, source: shown, installedAt: this.now(),
      enabled: prev ? prev.enabled && covers(granted, manifest.permissions) : false,
      granted, settings: prev?.settings ?? {},
      ...(from ? { reviewed: true, registryVersion: from.version } : {}),
    };
    this.manifests.set(manifest.id, { manifest });
    await this.save();
    this.changed();
    return { plugin: this.summary(manifest.id)!, updated: !!prev, unchanged: false };
  }

  /**
   * `nookdeck plugin dev`: uses a folder in place (nothing is copied, no hash pin). Granted and enabled at once with exactly what
   * the manifest declares: this is the author's own code on the author's own computer.
   */
  async link(folder: string): Promise<{ plugin: PluginSummary; updated: boolean }> {
    const path = resolve(folder.startsWith("~") ? join(userHome(), folder.slice(1)) : folder);
    let files: Files;
    try { files = await readFolder(path); } catch (e: any) { throw new PluginError(e?.code === "ENOENT" ? "that folder does not exist" : String(e?.message ?? e)); }
    if (!files.has(MANIFEST_FILE)) throw new PluginError(`there is no ${MANIFEST_FILE} in that folder`);
    let manifest: Manifest;
    try { manifest = parseManifest(JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE))), { agentVersion: this.opts.agentVersion }); }
    catch (e: any) { throw new PluginError(e instanceof SyntaxError ? `${MANIFEST_FILE} is not valid JSON: ${e.message}` : `${MANIFEST_FILE}: ${e?.message ?? e}`); }
    const wrongOs = this.osReason(manifest);
    if (wrongOs) throw new PluginError(wrongOs, 409);
    if (manifest.main && !files.has(manifest.main)) throw new PluginError(`${MANIFEST_FILE}: main is "${manifest.main}", but that file is not in the folder`);
    const prev = this.state.plugins[manifest.id];
    if (prev && !prev.linked) throw new PluginError(`${manifest.id} is already installed from a package: remove it first, then link the folder`, 409);
    this.state.plugins[manifest.id] = {
      version: manifest.version, sha256: packageHash(files), source: path, installedAt: prev?.installedAt ?? this.now(), enabled: true,
      granted: manifest.permissions, settings: prev?.settings ?? {}, linked: true,
    };
    this.manifests.set(manifest.id, { manifest });
    await this.save();
    this.changed();
    return { plugin: this.summary(manifest.id)!, updated: !!prev };
  }

  /** A linked plugin changed on disk: reads it again (manifest, hash) and tells the runtime, which restarts its process. */
  async reload(id: string): Promise<PluginSummary> {
    const s = this.state.plugins[id];
    if (!s) throw new PluginError("that plugin is not installed", 404);
    if (!s.linked) throw new PluginError("only a plugin linked with `nookdeck plugin dev` can be reloaded", 409);
    const files = await readFolder(s.source).catch((e) => { throw new PluginError(String(e?.message ?? e)); });
    let manifest: Manifest;
    try { manifest = parseManifest(JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE))), { agentVersion: this.opts.agentVersion }); }
    catch (e: any) {
      this.manifests.set(id, { manifest: this.manifests.get(id)?.manifest ?? placeholder(id, s.version), error: `${MANIFEST_FILE}: ${String(e?.message ?? e).slice(0, 160)}` });
      this.changed();
      throw new PluginError(`${MANIFEST_FILE}: ${e?.message ?? e}`);
    }
    if (manifest.id !== id) throw new PluginError(`the id changed to ${manifest.id}; link the folder again`);
    s.version = manifest.version; s.sha256 = packageHash(files); s.granted = manifest.permissions; s.enabled = true;
    const wrongOs = this.osReason(manifest);
    this.manifests.set(id, { manifest, ...(wrongOs ? { error: wrongOs } : {}) });
    await this.save();
    this.changed();
    return this.summary(id)!;
  }

  async remove(id: string): Promise<void> {
    if (!this.state.plugins[id]) throw new PluginError("that plugin is not installed", 404);
    if (this.builtin.has(id)) throw new PluginError("a built-in plugin cannot be removed, only turned off", 409);
    const linked = this.state.plugins[id]?.linked === true;
    delete this.state.plugins[id];
    this.manifests.delete(id);
    if (!linked) await rm(join(this.dir, id), { recursive: true, force: true });
    await this.save();
    this.changed();
  }

  // ----- grant / enable / settings -----

  /** Records what the user allowed. It cannot be wider than what the manifest declares. */
  async grant(id: string, permissions: unknown): Promise<PluginSummary> {
    const e = this.entry(id);
    if (!e) throw new PluginError("that plugin is not installed", 404);
    let asked: Permissions;
    try { asked = parsePermissions(permissions); } catch (err: any) { throw new PluginError(String(err?.message ?? err)); }
    if (!covers(e.manifest.permissions, asked)) throw new PluginError("a plugin cannot be granted more than it declares");
    e.state.granted = asked;
    if (!covers(asked, e.manifest.permissions)) e.state.enabled = false; // a partial grant cannot keep it running
    await this.save();
    this.changed();
    return this.summary(id)!;
  }

  async setEnabled(id: string, enabled: unknown): Promise<PluginSummary> {
    const e = this.entry(id);
    if (!e) throw new PluginError("that plugin is not installed", 404);
    if (typeof enabled !== "boolean") throw new PluginError("enabled must be true or false");
    if (enabled) {
      if (e.error) throw new PluginError(e.error, 409);
      if (!covers(e.state.granted, e.manifest.permissions)) throw new PluginError("grant the plugin's permissions first", 409);
    }
    e.state.enabled = enabled;
    await this.save();
    this.changed();
    return this.summary(id)!;
  }

  /** Plain {key: value} for the plugin-wide fields. A secret that is absent keeps its value; "" or null clears a value. */
  async setSettings(id: string, body: unknown): Promise<PluginSummary> {
    const e = this.entry(id);
    if (!e) throw new PluginError("that plugin is not installed", 404);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new PluginError("settings must be an object like {key: value}");
    const next: Settings = { ...e.state.settings };
    for (const f of e.manifest.settings) {
      if (!(f.key in (body as object))) continue;
      const raw = (body as Record<string, unknown>)[f.key];
      if (raw === null || raw === "") { delete next[f.key]; continue; }
      const v = coerce(f, raw);
      if (v === undefined) throw new PluginError(`${f.key}: that is not a valid ${f.type}`);
      next[f.key] = v;
    }
    e.state.settings = next;
    await this.save();
    this.changed();
    return this.summary(id)!;
  }
}

function parsePermissionsSafe(v: unknown): Permissions {
  try { return parsePermissions(v); } catch { return { network: [] }; }
}

const placeholder = (id: string, version: string): Manifest => ({
  id, name: id, version, permissions: { network: [] }, settings: [], widgets: [], actions: [], themes: [], layouts: [], main: null,
});
