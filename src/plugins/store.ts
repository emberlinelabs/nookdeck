/**
 * Installed plugins on disk: ~/.phonedesk/plugins/<id>/<version>/ (the files) and ~/.phonedesk/plugins.json (state: enabled,
 * pinned version and sha256, granted permissions, settings). Install from a local folder or manifest file, or from an https URL.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HOME, PLUGIN_ID_RE } from "../config";
import { MANIFEST_MAX_BYTES, covers, describePermissions, parseManifest, parsePermissions } from "./manifest";
import { coerce } from "./sources";
import type { Manifest, Permissions, PluginState, SettingField, Settings, StateFile } from "./types";

export const MAX_FILES = 200;
export const MAX_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);
export const MANIFEST_FILE = "phonedesk.json";

export type Files = Map<string, Uint8Array>;

/** sha256 over the sorted (path, bytes) of a package: the pin of an install. */
export function packageHash(files: Files): string {
  const h = createHash("sha256");
  for (const name of [...files.keys()].sort()) h.update(name).update("\0").update(files.get(name)!).update("\0");
  return h.digest("hex");
}

async function readFolder(root: string): Promise<Files> {
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
  /** Where installs live (default ~/.phonedesk/plugins). */
  dir?: string;
  /** Where state lives (default ~/.phonedesk/plugins.json). */
  stateFile?: string;
  /** The running PhoneDesk version, checked against a manifest's `phonedesk` range. */
  agentVersion?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PluginSummary {
  id: string; name: string; version: string; author?: string; description?: string; icon?: string;
  source: string; sha256: string; installedAt: number;
  /** Not reviewed by the PhoneDesk registry (every P1 install is). */
  unreviewed: boolean;
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
  widgets: Array<{ id: string; name: string; render: string; sizes: string[]; settings: SettingField[] }>;
  actions: Array<{ id: string; name: string; settings: SettingField[] }>;
  themes: Array<{ id: string; name: string; theme: unknown }>;
  layouts: Array<{ id: string; name: string; layout: unknown }>;
  /** Why it cannot run (files changed since install, manifest unreadable). */
  error?: string;
}

export class PluginError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

interface Loaded { manifest: Manifest; error?: string }

export class PluginStore {
  private state: StateFile = { version: 1, plugins: {} };
  private manifests = new Map<string, Loaded>();
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
    const plugins = raw && typeof raw === "object" && raw.plugins && typeof raw.plugins === "object" ? raw.plugins : {};
    for (const [id, s] of Object.entries<any>(plugins)) {
      if (!PLUGIN_ID_RE.test(id) || !s || typeof s.version !== "string" || typeof s.sha256 !== "string") continue;
      const st: PluginState = {
        version: s.version, sha256: s.sha256, source: String(s.source ?? ""), installedAt: Number(s.installedAt) || 0,
        enabled: s.enabled === true, granted: s.granted ? parsePermissionsSafe(s.granted) : null,
        settings: s.settings && typeof s.settings === "object" ? s.settings : {},
      };
      this.state.plugins[id] = st;
      try {
        const files = await readFolder(this.versionDir(id, st.version));
        const manifest = parseManifest(JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE))), { allowCore: false });
        if (packageHash(files) !== st.sha256) { st.enabled = false; this.manifests.set(id, { manifest, error: "the plugin's files changed after install: reinstall it" }); }
        else this.manifests.set(id, { manifest });
      } catch (e: any) {
        st.enabled = false;
        this.manifests.set(id, { manifest: placeholder(id, st.version), error: `cannot read the plugin: ${String(e?.message ?? e).slice(0, 120)}` });
      }
    }
  }

  private versionDir(id: string, version: string): string { return join(this.dir, id, version); }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
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
      id, name: m.name, version: s.version, ...(m.author ? { author: m.author } : {}), ...(m.description ? { description: m.description } : {}), ...(m.icon ? { icon: m.icon } : {}),
      source: s.source, sha256: s.sha256, installedAt: s.installedAt, unreviewed: true, enabled: s.enabled && !e.error,
      permissions: m.permissions, granted: s.granted ?? { network: [] }, needsApproval: !covers(s.granted, m.permissions),
      permissionLines: describePermissions(m.permissions), fields, settings: values,
      widgets: m.widgets.map((w) => ({ id: w.id, name: w.name, render: w.render, sizes: w.sizes, settings: w.settings })),
      actions: m.actions.map((a) => ({ id: a.id, name: a.name, settings: a.settings })),
      themes: m.themes, layouts: m.layouts, ...(e.error ? { error: e.error } : {}),
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

  private async resolveSource(source: string): Promise<{ files: Files; shown: string }> {
    const src = source.trim();
    if (!src) throw new PluginError("give a folder path or an https address");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
      if (!/^https:\/\//i.test(src)) throw new PluginError("only https addresses can be installed from the web");
      let urls: string[];
      try { urls = manifestUrls(src); } catch { throw new PluginError("that is not a valid web address"); }
      for (const u of urls) {
        const text = await this.fetchText(u);
        if (text !== null) return { files: new Map([[MANIFEST_FILE, new TextEncoder().encode(text)]]), shown: src };
      }
      throw new PluginError(`no ${MANIFEST_FILE} found at that address`);
    }
    const path = resolve(src.startsWith("~") ? join(homedir(), src.slice(1)) : src);
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
  async install(source: string): Promise<{ plugin: PluginSummary; updated: boolean; unchanged: boolean }> {
    const { files, shown } = await this.resolveSource(source);
    let manifest: Manifest;
    try { manifest = parseManifest(JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE))), { agentVersion: this.opts.agentVersion }); }
    catch (e: any) { throw new PluginError(e instanceof SyntaxError ? `${MANIFEST_FILE} is not valid JSON: ${e.message}` : `${MANIFEST_FILE}: ${e?.message ?? e}`); }
    const sha = packageHash(files);
    const prev = this.state.plugins[manifest.id];
    if (prev && prev.version === manifest.version && prev.sha256 === sha && !this.manifests.get(manifest.id)?.error) {
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
    };
    this.manifests.set(manifest.id, { manifest });
    await this.save();
    this.changed();
    return { plugin: this.summary(manifest.id)!, updated: !!prev, unchanged: false };
  }

  async remove(id: string): Promise<void> {
    if (!this.state.plugins[id]) throw new PluginError("that plugin is not installed", 404);
    delete this.state.plugins[id];
    this.manifests.delete(id);
    await rm(join(this.dir, id), { recursive: true, force: true });
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
