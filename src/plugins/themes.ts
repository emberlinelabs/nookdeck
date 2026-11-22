/**
 * Theme packs (spec D14-D16): ~/.nookdeck/themes/<id>/ holds the files, ~/.nookdeck/themes.json the pins. A pack carries variants
 * (look fields only, never code), shared fonts / icons / backgrounds and optional CSS. Install goes through the same sources as
 * plugins (folder, GitHub tarball, registry pin). Apply copies a resolved look into layout.theme and keeps the behaviour fields.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { HOME, LOOK_KEYS, type Look, type PackLook, type Theme, type ThemeSource } from "../config";
import { THEME_PREVIEW_MAX, parseThemeManifest, resolveVariant, type ThemeManifest } from "./manifest";
import { MANIFEST_FILE, PluginError, packageHash, type Files } from "./store";
import { THEME_CSS_MAX_BYTES, ThemeCssError, scopeThemeCss } from "./theme-css";

export const THEME_FILE_EXT = /\.(json|png|jpe?g|webp|gif|svg|md|txt|css|woff2?)$|(^|\/)(LICEN[CS]E|NOTICE|COPYING|AUTHORS)([-._][A-Za-z0-9._-]*)?$/i;
/** License files ship as plain text, whatever their name ends with. */
export const isLicenseFile = (rel: string): boolean => /(^|\/)(LICEN[CS]E|NOTICE|COPYING|AUTHORS)([-._][A-Za-z0-9._-]*)?$/i.test(rel) && !/\.(png|jpe?g|webp|gif|svg|css|woff2?)$/i.test(rel);
const BEHAVIOUR_KEYS = ["language", "orientation", "header", "screen", "updateCheck", "temperatureUnit"] as const;
export const FONT_MAX_BYTES = 400 * 1024;
export const FONT_MAX_FILES = 4;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const ICON_MAX_BYTES = 20 * 1024;
export const PACK_MAX_BYTES = 5 * 1024 * 1024;

export interface ThemeState { version: string; sha256: string; source: string; installedAt: number; files: string[]; reviewed?: boolean; registryVersion?: string; builtin?: boolean }
export interface VariantSummary { id: string; name: string; mode: "light" | "dark"; look: PackLook; preview?: string; modeMismatch?: boolean }

/** Relative luminance (0 black .. 1 white) of a #rgb / #rrggbb / #rrggbbaa colour, or null when it is not one. */
export function luminance(c: unknown): number | null {
  const m = typeof c === "string" ? /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim()) : null;
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  const ch = (i: number) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

/** True when the variant's background says the opposite of its declared mode (a "light" variant on a dark background, or the reverse). */
export function modeMismatch(look: PackLook, mode: "light" | "dark"): boolean {
  const l = luminance((look as Record<string, unknown>).background);
  if (l === null) return false;
  return mode === "light" ? l < 0.18 : l > 0.5;
}
export interface ThemeSummary {
  id: string; name: string; version: string; author?: string; description?: string; nookdeck?: string;
  variants: VariantSummary[];
  options: Array<{ id: string; name: string; values: Array<{ id: string; name: string; theme: Look; variants?: Record<string, Look> }> }>;
  auto?: { light: string; dark: string };
  /** ids of variants whose background contradicts their declared mode (wrong metadata) */
  modeMismatch?: string[];
  preview?: string; hasCss: boolean; fonts: string[]; icons: string[];
  sha256: string; source: string; installedAt: number; reviewed: boolean; registryVersion?: string; builtin: boolean;
}

/** The look fields of a theme, plus kinds and fonts (what a pack carries); not behaviour fields, `source` or `auto`. */
export function extractLook(t: Theme | undefined | null): PackLook {
  const out: Record<string, unknown> = {};
  if (!t) return out as PackLook;
  for (const k of [...LOOK_KEYS, "kinds", "fonts"]) if ((t as Record<string, unknown>)[k] !== undefined) out[k] = (t as Record<string, unknown>)[k];
  return out as PackLook;
}

/** Applies a look: every look field is replaced (a field the pack leaves out goes back to its default), behaviour fields stay. */
export function applyLook(current: Theme | undefined, look: PackLook, source?: ThemeSource, auto?: { light: PackLook; dark: PackLook }): Theme {
  const next: Record<string, unknown> = {};
  for (const k of BEHAVIOUR_KEYS) if (current && (current as Record<string, unknown>)[k] !== undefined) next[k] = (current as Record<string, unknown>)[k];
  Object.assign(next, look);
  if (auto) next.auto = auto;
  if (source) next.source = source;
  return next as Theme;
}

/** An SVG icon of a pack is checked, never cleaned: scripts, foreignObject and anything that can load from elsewhere are refused. */
export function checkSvg(name: string, svg: string): void {
  const bad = (why: string): never => { throw new PluginError(`icons/${name}: ${why}`); };
  if (new TextEncoder().encode(svg).length > ICON_MAX_BYTES) bad("larger than 20 KB");
  if (!/<svg[\s>]/i.test(svg)) bad("not an SVG");
  if (/<\s*(script|foreignObject|iframe|object|embed|audio|video|animate|set)\b/i.test(svg)) bad("scripts, foreignObject and active content are not allowed");
  if (/<!\s*(ENTITY|DOCTYPE)/i.test(svg) || /<\?xml-stylesheet/i.test(svg)) bad("entities and doctypes are not allowed");
  if (/\son[a-z]+\s*=/i.test(svg)) bad("event handlers are not allowed");
  if (/javascript:|data:text|vbscript:/i.test(svg)) bad("scripting urls are not allowed");
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) if (!(m[1] ?? m[2] ?? "").trim().startsWith("#")) bad("external references (href) are not allowed");
  for (const m of svg.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) if (!(m[1] ?? m[2] ?? m[3] ?? "").trim().startsWith("#")) bad("external urls are not allowed");
  if (/@import/i.test(svg)) bad("@import is not allowed");
}

/** A single-look pack from the current look (one variant "default"), plus any package files it needs. */
export function buildThemePackage(theme: Theme | undefined, meta: { id: string; name: string; version?: string; author?: string; description?: string }, extra: { files?: Files; preview?: Uint8Array; previewName?: string } = {}): Files {
  const look = { ...extractLook(theme) } as Record<string, any>;
  const files: Files = new Map(extra.files ?? []);
  const bg = look.backgroundImage;
  if (typeof bg === "string") {
    const m = /^theme:[^/]+\/(.+)$/.exec(bg);
    if (m && files.has(m[1]!)) look.backgroundImage = m[1]; else delete look.backgroundImage; // an uploaded (img:) background cannot travel in a package
  }
  if (Array.isArray(look.fonts)) { look.fonts = look.fonts.filter((f: any) => files.has(f.file)); if (!look.fonts.length) delete look.fonts; }
  const manifest: Record<string, unknown> = {
    type: "theme", id: meta.id, name: meta.name, version: meta.version ?? "1.0.0",
    ...(meta.author ? { author: meta.author } : {}), ...(meta.description ? { description: meta.description } : {}),
    nookdeck: ">=0.3.1", theme: look,
  };
  if (extra.preview && extra.preview.length <= THEME_PREVIEW_MAX) {
    const name = extra.previewName && /\.(png|jpe?g)$/i.test(extra.previewName) ? extra.previewName : "preview.png";
    files.set(name, extra.preview);
    manifest.preview = name;
  }
  files.set(MANIFEST_FILE, new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"));
  return files;
}

const bgFileOf = (l: Look): string | undefined => (typeof l.backgroundImage === "string" ? /^theme:[^/]+\/(.+)$/.exec(l.backgroundImage)?.[1] : undefined);

/** Every look a pack can produce (base, variants, option patches), to check the files they name. */
function allLooks(m: ThemeManifest): PackLook[] {
  return [m.base, ...m.variants.map((v) => v.theme), ...m.options.flatMap((o) => o.values.flatMap((v) => [v.theme, ...Object.values(v.variants ?? {})]))];
}

/** Checks a package's files against its manifest and the limits (fonts, icons, images, css). Throws PluginError. */
export function checkPackage(m: ThemeManifest, files: Files): void {
  let total = 0;
  const fonts = [...files.keys()].filter((n) => /^fonts\//.test(n));
  if (fonts.length > FONT_MAX_FILES) throw new PluginError(`a theme can ship at most ${FONT_MAX_FILES} font files`);
  for (const [name, bytes] of files) {
    total += bytes.length;
    if (name !== MANIFEST_FILE && !THEME_FILE_EXT.test(name)) throw new PluginError(`"${name}" is not an allowed theme file (images, fonts, css, text only)`);
    if (/^fonts\//.test(name)) {
      if (!/\.woff2?$/i.test(name)) throw new PluginError(`"${name}": fonts must be .woff or .woff2`);
      if (bytes.length > FONT_MAX_BYTES) throw new PluginError(`"${name}" is larger than 400 KB`);
    } else if (/\.(png|jpe?g|webp|gif)$/i.test(name) && bytes.length > IMAGE_MAX_BYTES) throw new PluginError(`"${name}" is larger than 2 MB`);
    if (/^icons\//.test(name)) {
      if (!/^icons\/[A-Za-z0-9._-]+\.svg$/i.test(name)) throw new PluginError(`"${name}": icons are icons/<name>.svg`);
      checkSvg(name.slice(6), new TextDecoder().decode(bytes));
    }
  }
  if (total > PACK_MAX_BYTES) throw new PluginError("the package is larger than 5 MB");
  const need = (f: string | undefined, what: string) => { if (f && !files.has(f)) throw new PluginError(`${what} "${f}" is not in the package`); };
  // previews are optional: a missing one is just not shown
  need(m.css, "the css file");
  for (const v of m.variants) need(v.css, `the css of "${v.id}"`);
  for (const l of allLooks(m)) {
    need(bgFileOf(l), "the background image");
    for (const f of l.fonts ?? []) need(f.file, "the font file");
  }
  if (m.preview && files.has(m.preview) && files.get(m.preview)!.length > THEME_PREVIEW_MAX) throw new PluginError("the preview is larger than 1 MB");
  // css is validated now (a bad theme is refused at install, not at first use)
  const set = new Set(files.keys());
  const css = (f: string | undefined, variant?: string) => { if (f) try { scopeThemeCss(new TextDecoder().decode(files.get(f)!), { id: m.id, variant, files: set }); } catch (e) { throw e instanceof ThemeCssError ? new PluginError(`${f}: ${e.message}`) : e; } };
  css(m.css);
  for (const v of m.variants) css(v.css, v.id);
}

export interface ThemeStoreOptions {
  dir?: string;
  stateFile?: string;
  agentVersion?: string;
  /** Fetches a package from a folder, GitHub address or manifest URL (PluginStore.resolveSource). */
  resolve: (source: string) => Promise<{ files: Files; shown: string }>;
  /** Packs that ship inside the binary (files in memory). */
  builtin?: Files[];
  now?: () => number;
}

export class ThemeStore {
  private dir: string;
  private stateFile: string;
  private state: Record<string, ThemeState> = {};
  private manifests = new Map<string, ThemeManifest>();
  private mem = new Map<string, Files>(); // built-in packs
  private now: () => number;
  constructor(private opts: ThemeStoreOptions) {
    this.dir = opts.dir ?? join(HOME, "themes");
    this.stateFile = opts.stateFile ?? join(HOME, "themes.json");
    this.now = opts.now ?? Date.now;
  }

  async load(): Promise<void> {
    let raw: any = null;
    try { raw = JSON.parse(await readFile(this.stateFile, "utf8")); } catch { /* none yet */ }
    this.state = raw && typeof raw === "object" && raw.themes && typeof raw.themes === "object" ? raw.themes : {};
    this.manifests.clear();
    this.mem.clear();
    for (const id of Object.keys(this.state)) {
      try { this.manifests.set(id, parseThemeManifest(JSON.parse(await readFile(join(this.dir, id, MANIFEST_FILE), "utf8")))); }
      catch { delete this.state[id]; } // files gone or broken: forget it
    }
    for (const files of this.opts.builtin ?? []) {
      const m = parseThemeManifest(JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE)!)));
      checkPackage(m, files);
      this.manifests.set(m.id, m);
      this.mem.set(m.id, files);
      this.state[m.id] = { version: m.version, sha256: packageHash(files), source: "built in", installedAt: 0, files: [...files.keys()], builtin: true, reviewed: true };
    }
  }

  private async save(): Promise<void> {
    await mkdir(resolve(this.stateFile, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.tmp`;
    const disk = Object.fromEntries(Object.entries(this.state).filter(([, s]) => !s.builtin));
    await writeFile(tmp, JSON.stringify({ themes: disk }, null, 2), { mode: 0o600 });
    await rename(tmp, this.stateFile);
  }

  has(id: string): boolean { return !!this.state[id]; }
  isBuiltin(id: string): boolean { return !!this.state[id]?.builtin; }
  dirOf(id: string): string { return join(this.dir, id); }
  manifest(id: string): ThemeManifest | null { return this.manifests.get(id) ?? null; }

  summary(id: string): ThemeSummary | null {
    const m = this.manifests.get(id), s = this.state[id];
    if (!m || !s) return null;
    const url = (f: string) => `/api/themes/${id}/files/${f}`;
    const has = (f: string | undefined): f is string => !!f && s.files.includes(f);
    const fonts = new Set<string>();
    for (const l of allLooks(m)) for (const f of l.fonts ?? []) fonts.add(f.family);
    return {
      id, name: m.name, version: m.version, ...(m.author ? { author: m.author } : {}), ...(m.description ? { description: m.description } : {}),
      ...(m.nookdeck ? { nookdeck: m.nookdeck } : {}),
      variants: m.variants.map((v) => { const look = resolveVariant(m, v.id); return { id: v.id, name: v.name, mode: v.mode, look, ...(modeMismatch(look, v.mode) ? { modeMismatch: true } : {}), ...(has(v.preview) ? { preview: url(v.preview) } : {}) }; }),
      options: m.options.map((o) => ({ id: o.id, name: o.name, values: o.values.map((v) => ({ id: v.id, name: v.name, theme: v.theme, ...(v.variants ? { variants: v.variants } : {}) })) })),
      ...(m.auto ? { auto: m.auto } : {}),
      ...(m.variants.some((v) => modeMismatch(resolveVariant(m, v.id), v.mode)) ? { modeMismatch: m.variants.filter((v) => modeMismatch(resolveVariant(m, v.id), v.mode)).map((v) => v.id) } : {}),
      ...(has(m.preview) ? { preview: url(m.preview) } : {}),
      hasCss: !!m.css || m.variants.some((v) => !!v.css), fonts: [...fonts],
      icons: s.files.filter((f) => /^icons\/.+\.svg$/i.test(f)).map((f) => f.slice(6, -4)),
      sha256: s.sha256, source: s.source, installedAt: s.installedAt, reviewed: !!s.reviewed, ...(s.registryVersion ? { registryVersion: s.registryVersion } : {}), builtin: !!s.builtin,
    };
  }
  list(): ThemeSummary[] { return Object.keys(this.state).sort().map((id) => this.summary(id)!).filter(Boolean); }

  /**
   * What to write into layout.theme for an Apply request. `current` is the theme in force: an empty request re-applies it when it
   * came from this pack (same variant or auto pair, same options), and otherwise picks the pack's first variant.
   */
  resolveApply(id: string, req: { variant?: unknown; auto?: unknown; options?: unknown }, current?: ThemeSource): { look: PackLook; auto?: { light: PackLook; dark: PackLook }; source: ThemeSource } {
    const m = this.manifests.get(id), s = this.state[id];
    if (!m || !s) throw new PluginError("that theme is not installed", 404);
    const same = current && current.pack.split("@")[0] === id ? current : undefined;
    const bad = (msg: string): never => { throw new PluginError(msg, 400); };
    let options: Record<string, string> = {};
    if (req.options !== undefined) {
      if (!req.options || typeof req.options !== "object" || Array.isArray(req.options)) bad("options must be an object like { accent: \"mauve\" }");
      for (const [k, v] of Object.entries(req.options as Record<string, unknown>)) { if (typeof v !== "string") bad(`option "${k}" must name a value`); options[k] = v as string; }
    } else if (same?.options) options = { ...same.options };
    const pack = `${id}@${m.version}`;
    const lookOf = (variant: string): PackLook => {
      let l: PackLook;
      try { l = resolveVariant(m, variant, options); } catch (e: any) { return bad(e?.message ?? String(e)); }
      const v = m.variants.find((x) => x.id === variant)!;
      return { ...l, mode: v.mode }; // the variant's declared mode always wins: a light variant never leaves the deck dark
    };
    let autoReq: { light: string; dark: string } | undefined;
    if (req.auto !== undefined) {
      const a = req.auto as any;
      if (!a || typeof a.light !== "string" || typeof a.dark !== "string") bad("auto must be { light, dark } variant ids");
      autoReq = { light: a.light, dark: a.dark };
    } else if (req.variant === undefined && same?.auto) autoReq = same.auto;
    if (autoReq) {
      const light = lookOf(autoReq.light), dark = lookOf(autoReq.dark);
      return { look: { ...dark, mode: "auto" }, auto: { light, dark }, source: { pack, auto: autoReq, ...(Object.keys(options).length ? { options } : {}) } };
    }
    let variant: string;
    if (req.variant !== undefined) { if (typeof req.variant !== "string") bad("variant must be a variant id"); variant = req.variant as string; }
    else variant = same?.variant && m.variants.some((v) => v.id === same.variant) ? same.variant : m.variants[0]!.id;
    return { look: lookOf(variant), source: { pack, variant, ...(Object.keys(options).length ? { options } : {}) } };
  }

  /** Installs or updates. `from` pins a registry install: the files must hash to exactly that. */
  async install(source: string, from?: { sha256: string; version: string }): Promise<{ theme: ThemeSummary; updated: boolean; unchanged: boolean }> {
    const { files, shown } = await this.opts.resolve(source);
    return this.installFiles(files, shown, from);
  }

  /** The files of every file in an installed pack (a fork copies the ones its look needs). */
  async packFiles(id: string): Promise<Files> {
    const s = this.state[id];
    if (!s) throw new PluginError("that theme is not installed", 404);
    const out: Files = new Map();
    for (const f of s.files) { const b = await this.read(id, f); if (b) out.set(f, b); }
    return out;
  }

  /** Installs a package that is already in memory (a fork, or the result of resolve). */
  async installFiles(files: Files, shown: string, from?: { sha256: string; version: string }): Promise<{ theme: ThemeSummary; updated: boolean; unchanged: boolean }> {
    const mf = files.get(MANIFEST_FILE);
    if (!mf) throw new PluginError(`there is no ${MANIFEST_FILE} in that package`);
    let m: ThemeManifest;
    try { m = parseThemeManifest(JSON.parse(new TextDecoder().decode(mf)), { agentVersion: this.opts.agentVersion }); }
    catch (e: any) { throw new PluginError(e instanceof SyntaxError ? `${MANIFEST_FILE} is not valid JSON: ${e.message}` : `${MANIFEST_FILE}: ${e?.message ?? e}`); }
    if (this.state[m.id]?.builtin) throw new PluginError("that theme ships with Nookdeck and cannot be replaced", 409);
    checkPackage(m, files);
    for (const v of m.variants) if (modeMismatch(resolveVariant(m, v.id), v.mode)) console.warn(`theme ${m.id}: variant "${v.id}" is declared ${v.mode} but its background looks ${v.mode === "light" ? "dark" : "light"}; check its mode`);
    const sha = packageHash(files);
    if (from && (sha !== from.sha256.toLowerCase() || m.version !== from.version)) throw new PluginError("the theme files do not match the reviewed version", 409);
    const prev = this.state[m.id];
    if (prev && prev.version === m.version && prev.sha256 === sha) {
      if (from && !prev.reviewed) { prev.reviewed = true; prev.registryVersion = from.version; await this.save(); }
      return { theme: this.summary(m.id)!, updated: false, unchanged: true };
    }
    const dest = this.dirOf(m.id), tmp = `${dest}.tmp-${process.pid}`;
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
    this.state[m.id] = { version: m.version, sha256: sha, source: shown, installedAt: prev?.installedAt ?? this.now(), files: [...files.keys()], ...(from ? { reviewed: true, registryVersion: from.version } : {}) };
    this.manifests.set(m.id, m);
    await this.save();
    return { theme: this.summary(m.id)!, updated: !!prev, unchanged: false };
  }

  async remove(id: string): Promise<void> {
    if (!this.state[id]) throw new PluginError("that theme is not installed", 404);
    if (this.state[id]!.builtin) throw new PluginError("that theme ships with Nookdeck and cannot be removed", 409);
    delete this.state[id];
    this.manifests.delete(id);
    await rm(this.dirOf(id), { recursive: true, force: true });
    await this.save();
  }

  private async read(id: string, rel: string): Promise<Uint8Array | null> {
    const mem = this.mem.get(id);
    if (mem) return mem.get(rel) ?? null;
    const root = this.dirOf(id) + sep;
    const full = resolve(this.dirOf(id), rel);
    if (!full.startsWith(root)) return null;
    try { return new Uint8Array(await readFile(full)); } catch { return null; }
  }

  /** A file of an installed theme, or null. The path may not leave the theme folder; the manifest itself is not served. */
  async file(id: string, rel: string): Promise<{ bytes: Uint8Array; name: string } | null> {
    if (!this.state[id] || !rel || rel.includes("\0") || rel.includes("\\") || rel.split("/").some((s) => s === ".." || s === "." || s === "")) return null;
    if (!THEME_FILE_EXT.test(rel) || /^nookdeck\.json$/i.test(rel)) return null;
    const bytes = await this.read(id, rel);
    return bytes ? { bytes, name: rel } : null;
  }

  /** The icon pack of an installed theme as deck icon assets: key `pack:<name>`, the svg's inner markup and viewBox (brand style: own colours, currentColor ok). */
  async packIcons(id: string): Promise<Record<string, { svg?: string; vb?: string; brand?: true; img?: string }>> {
    const s = this.state[id];
    const out: Record<string, { svg?: string; vb?: string; brand?: true; img?: string }> = {};
    if (!s) return out;
    // standby clock face: standby/face.<png|jpg|webp> (the analog dial) and standby/background.<...>
    for (const f of s.files) {
      const sb = /^standby\/(face|background)\.(png|jpe?g|webp)$/i.exec(f);
      if (sb) out[`pack:standby-${sb[1]!.toLowerCase()}`] = { img: `/api/themes/${id}/files/${f}` };
    }
    for (const f of s.files) {
      const m = /^icons\/([A-Za-z0-9._-]+)\.svg$/i.exec(f);
      if (!m) continue;
      const b = await this.read(id, f);
      if (!b) continue;
      const text = new TextDecoder().decode(b);
      const inner = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i.exec(text);
      if (!inner) continue;
      const vb = /viewBox\s*=\s*"([\d.\s-]+)"/i.exec(text)?.[1] ?? "0 0 24 24";
      out[`pack:${m[1]!.toLowerCase()}`] = { svg: inner[1]!.trim(), vb: vb.trim(), brand: true };
    }
    return out;
  }

  /** The scoped, checked CSS for a variant (base file plus the variant's file), or "" when the pack has none. */
  async css(id: string, variant?: string): Promise<string> {
    const m = this.manifests.get(id), s = this.state[id];
    if (!m || !s) throw new PluginError("that theme is not installed", 404);
    const v = variant ? m.variants.find((x) => x.id === variant) : undefined;
    if (variant && !v) throw new PluginError(`this theme has no variant "${variant}"`, 400);
    const set = new Set(s.files);
    let out = "";
    if (m.css) { const b = await this.read(id, m.css); if (b) out += scopeThemeCss(new TextDecoder().decode(b), { id, files: set }) + "\n"; }
    if (v?.css) { const b = await this.read(id, v.css); if (b) out += scopeThemeCss(new TextDecoder().decode(b), { id, variant: v.id, files: set }) + "\n"; }
    return out;
  }
}

export { THEME_CSS_MAX_BYTES };
export const THEME_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", css: "text/css; charset=utf-8", woff: "font/woff", woff2: "font/woff2", json: "application/json", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8" };
