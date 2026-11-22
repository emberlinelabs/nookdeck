import { PLUGIN_ID_RE, STYLES, validateLayout, validateLook, validatePackLook, validateTheme, type Look, type PackLook, type MacroStep } from "../config";
import { macroSteps } from "../automation";
import { cleanRender } from "./sources";
import {
  RENDERERS, SETTING_TYPES, type ActionDef, type Manifest, type Permissions, type PluginActionRun, type Renderer, type SettingField, type WidgetDef, type WidgetSource,
} from "./types";

export const MANIFEST_MAX_BYTES = 256 * 1024;
const ID_PART_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$/;
const SIZE_RE = /^[1-9]\d?x[1-9]\d?$/;
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
export const EVERY_MIN = 5;
export const EVERY_MAX = 86_400;
export const EVERY_DEFAULT = 60;

const fail = (m: string): never => { throw new Error(m); };
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function text(v: unknown, where: string, max: number, required = true): string {
  if (typeof v !== "string") return required ? fail(`${where} must be a string`) : "";
  if (required && !v.trim()) fail(`${where} must not be empty`);
  if (v.length > max) fail(`${where} is too long (max ${max} characters)`);
  return v;
}

/** `>=1.2.3`, `1.2`, `^1.2.3` (treated as >=): is `have` at least that version? Only the numeric core is compared. */
export function versionAtLeast(have: string, range: string): boolean {
  if (/dev|dirty/i.test(have)) return true; // a development or modified build satisfies any minimum
  const nums = (s: string) => (/(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s) ?? []).slice(1).map((x) => Number(x ?? 0));
  const [a, b] = [nums(have), nums(range.replace(/^[>=^~\s]+/, ""))];
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

export const hostMatches = (host: string, allowed: string): boolean => {
  const h = host.toLowerCase();
  const a = allowed.toLowerCase();
  return a.startsWith("*.") ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a;
};

export function parsePermissions(v: unknown, where = "permissions"): Permissions {
  if (v === undefined || v === null) return { network: [] };
  if (!isObj(v)) return fail(`${where} must be an object`);
  const out: Permissions = { network: [] };
  for (const k of Object.keys(v)) if (!["network", "shell", "keyboard", "storage"].includes(k)) fail(`${where}.${k} is not a known permission (network, shell, keyboard, storage)`);
  if (v.network !== undefined) {
    if (!Array.isArray(v.network) || v.network.length > 20) fail(`${where}.network must be a list of up to 20 host names`);
    const hosts = (v.network as unknown[]).map((h, i) => {
      const s = text(h, `${where}.network[${i}]`, 253).toLowerCase();
      if (!HOST_RE.test(s)) fail(`${where}.network[${i}] "${s}" must be a host name like api.example.com or *.example.com`);
      return s;
    });
    out.network = [...new Set(hosts)];
  }
  for (const k of ["shell", "keyboard", "storage"] as const) {
    if (v[k] === undefined) continue;
    if (typeof v[k] !== "boolean") fail(`${where}.${k} must be true or false`);
    if (v[k]) out[k] = true;
  }
  return out;
}

const patternCovers = (pattern: string, host: string): boolean =>
  pattern.startsWith("*.") ? host.slice(host.startsWith("*") ? 1 : 0).endsWith(pattern.slice(1)) && host !== pattern.slice(2) : host === pattern;

/** Is everything in `asked` also in `have`? (a network host needs an equal or wider pattern) */
export function covers(have: Permissions | null | undefined, asked: Permissions): boolean {
  const h = have ?? { network: [] };
  for (const k of ["shell", "keyboard", "storage"] as const) if (asked[k] && !h[k]) return false;
  for (const host of asked.network) if (!h.network.some((p) => patternCovers(p, host))) return false;
  return true;
}

/** Human lines for the install dialog, one per permission. */
export function describePermissions(p: Permissions): string[] {
  const out: string[] = [];
  for (const h of p.network) out.push(`Connect to ${h}`);
  if (p.shell) out.push("Run commands on this computer");
  if (p.keyboard) out.push("Press keys and type text on this computer");
  if (p.storage) out.push("Keep its own saved data");
  return out;
}

export function settingFields(v: unknown, where: string): SettingField[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) return fail(`${where} must be a list of up to 20 fields`);
  const seen = new Set<string>();
  return v.map((f, i) => {
    const w = `${where}[${i}]`;
    if (!isObj(f)) return fail(`${w} must be an object`);
    const key = text(f.key, `${w}.key`, 48);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(key)) fail(`${w}.key must be letters, digits and _ (starting with a letter)`);
    if (seen.has(key)) fail(`${w}.key "${key}" is used twice`);
    seen.add(key);
    if (!(SETTING_TYPES as readonly string[]).includes(f.type)) fail(`${w}.type must be one of ${SETTING_TYPES.join(", ")}`);
    const out: SettingField = { key, type: f.type, label: text(f.label ?? key, `${w}.label`, 80) };
    if (f.type === "select") {
      if (!Array.isArray(f.options) || !f.options.length || f.options.length > 50 || f.options.some((o: unknown) => typeof o !== "string")) fail(`${w}.options must be a list of strings`);
      out.options = f.options;
    }
    if (f.default !== undefined) {
      const d = f.default;
      const ok = f.type === "number" ? typeof d === "number" && Number.isFinite(d) : f.type === "boolean" ? typeof d === "boolean" : typeof d === "string" && d.length <= 500;
      if (!ok) fail(`${w}.default does not match type ${f.type}`);
      if (f.type === "secret") fail(`${w}: a secret has no default`);
      if (f.type === "select" && !out.options!.includes(d as string)) fail(`${w}.default must be one of the options`);
      out.default = d;
    }
    return out;
  });
}

/** `{{key}}` names used in a string. */
export const templateKeys = (s: string): string[] => [...s.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!);

function checkTemplates(strs: string[], fields: SettingField[], where: string): void {
  const known = new Set(fields.map((f) => f.key));
  for (const s of strs) for (const k of templateKeys(s)) if (!known.has(k)) fail(`${where} uses {{${k}}} but no setting named "${k}" is declared`);
}

/**
 * A command line never carries {{settings}}: a value with a quote or a `;` would become code. A command reads its settings from the
 * environment instead: $NOOKDECK_SETTING_<KEY> (macOS/Linux sh) or $env:NOOKDECK_SETTING_<KEY> (PowerShell), key upper-cased.
 */
function noTemplates(command: string, where: string): void {
  if (/\{\{/.test(command)) fail(`${where} must not use {{settings}}: a value could contain quotes and run as code. Read it from the environment instead: "$NOOKDECK_SETTING_<KEY>" in sh, or $env:NOOKDECK_SETTING_<KEY> in PowerShell (key in capitals)`);
}

/** The host a URL template calls. It must be fixed text (no {{...}}), so the install dialog can show it and the permission can be checked. */
export function urlHost(urlTemplate: string, where: string): string {
  const m = /^(https?):\/\/([^/?#]+)/i.exec(urlTemplate);
  if (!m) return fail(`${where} must start with http:// or https://`);
  const authority = m[2]!;
  if (authority.includes("{{")) fail(`${where}: the host part must not use {{settings}} (the permission lists fixed hosts)`);
  if (authority.includes("@")) fail(`${where} must not contain credentials`);
  return authority.replace(/:\d+$/, "").toLowerCase();
}

function headers(v: unknown, where: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v) || Object.keys(v).length > 10) return fail(`${where} must be an object with at most 10 headers`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!/^[A-Za-z0-9-]{1,40}$/.test(k)) fail(`${where}: "${k}" is not a valid header name`);
    out[k] = text(val, `${where}.${k}`, 500);
  }
  return out;
}

const everyField = (v: unknown, where: string): { every?: number } => {
  if (v === undefined) return {};
  const n = Number(v);
  if (!Number.isFinite(n) || n < EVERY_MIN || n > EVERY_MAX) fail(`${where} must be ${EVERY_MIN}-${EVERY_MAX} seconds`);
  return { every: Math.round(n) };
};

/** Which permissions a widget source needs (checked against the manifest's declaration). */
function need(perms: Permissions, host: string | null, shell: boolean, keyboard: boolean, where: string): void {
  if (host && !perms.network.some((h) => hostMatches(host, h))) fail(`${where} calls ${host}, so permissions.network must list it`);
  if (shell && !perms.shell) fail(`${where} runs a command, so permissions.shell must be true`);
  if (keyboard && !perms.keyboard) fail(`${where} presses keys or types, so permissions.keyboard must be true`);
}

function parseSource(v: unknown, fields: SettingField[], perms: Permissions, where: string, hasMain = false): WidgetSource {
  if (v === undefined && hasMain) return { agent: {} };
  if (!isObj(v)) return fail(`${where} must be an object`);
  const map = v.map === undefined ? undefined : isObj(v.map) ? v.map : fail(`${where}.map must be an object`);
  if (map) for (const [k, val] of Object.entries(map)) if (typeof val === "string") checkTemplates([val], fields, `${where}.map.${k}`);
  if (v.http !== undefined) {
    if (!isObj(v.http)) fail(`${where}.http must be an object`);
    const url = text(v.http.url, `${where}.http.url`, 1000);
    need(perms, urlHost(url, `${where}.http.url`), false, false, where);
    const h = headers(v.http.headers, `${where}.http.headers`);
    checkTemplates([url, ...Object.values(h ?? {})], fields, `${where}.http`);
    return { http: { url, ...everyField(v.http.every, `${where}.http.every`), ...(h ? { headers: h } : {}) }, ...(map ? { map } : {}) };
  }
  if (v.command !== undefined) {
    if (!isObj(v.command)) fail(`${where}.command must be an object`);
    const run = text(v.command.run, `${where}.command.run`, 2000);
    need(perms, null, true, false, where);
    noTemplates(run, `${where}.command.run`);
    if (v.command.parse !== undefined && !["json", "text"].includes(v.command.parse)) fail(`${where}.command.parse must be json or text`);
    return { command: { run, ...everyField(v.command.every, `${where}.command.every`), ...(v.command.parse ? { parse: v.command.parse } : {}) }, ...(map ? { map } : {}) };
  }
  if (v.agent !== undefined) {
    if (!hasMain) return fail(`${where}.agent needs a code plugin: set "main" to the entry file`);
    const a = v.agent === true ? {} : isObj(v.agent) ? v.agent : fail(`${where}.agent must be true or an object`);
    return { agent: { ...everyField(a.every, `${where}.agent.every`) } };
  }
  return fail(`${where} needs "http" or "command"`);
}

/** Permissions a macro needs. hass and item steps are not available to plugins. */
function macroNeeds(steps: MacroStep[], perms: Permissions, where: string): void {
  steps.forEach((st, i) => {
    const w = `${where}[${i}]`;
    if (st.kind === "hass" || st.kind === "item") fail(`${w}: "${st.kind}" steps are not available to plugins`);
    if (st.kind === "shell" || st.kind === "open") need(perms, null, true, false, `${w} (${st.kind})`);
    if (st.kind === "hotkey" || st.kind === "type") need(perms, null, false, true, `${w} (${st.kind})`);
  });
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function parseAction(a: unknown, perms: Permissions, shared: SettingField[], i: number, hasMain = false): ActionDef {
  const where = `actions[${i}]`;
  if (!isObj(a)) return fail(`${where} must be an object`);
  const id = text(a.id, `${where}.id`, 48);
  if (!ID_PART_RE.test(id)) fail(`${where}.id must be lowercase letters, digits, - and _`);
  const settings = settingFields(a.settings, `${where}.settings`);
  const r = a.run === undefined && hasMain ? { agent: true } : a.run;
  if (!isObj(r)) return fail(`${where}.run must be an object with "macro" or "http"`);
  let run: PluginActionRun;
  if (r.agent !== undefined) {
    if (!hasMain) return fail(`${where}.run.agent needs a code plugin: set "main" to the entry file`);
    run = { agent: true };
  } else if (r.macro !== undefined) {
    const steps = macroSteps(r.macro, `${where}.run.macro`);
    macroNeeds(steps, perms, `${where}.run.macro`);
    steps.forEach((s, i) => { if (s.kind === "shell") noTemplates(s.command, `${where}.run.macro[${i}].command`); });
    checkTemplates(steps.filter((s) => s.kind !== "shell").flatMap((s) => Object.values(s).filter((x): x is string => typeof x === "string")), [...shared, ...settings], `${where}.run.macro`);
    run = { macro: steps };
  } else if (r.http !== undefined) {
    if (!isObj(r.http)) return fail(`${where}.run.http must be an object`);
    const url = text(r.http.url, `${where}.run.http.url`, 1000);
    need(perms, urlHost(url, `${where}.run.http.url`), false, false, where);
    const method = r.http.method === undefined ? undefined : (HTTP_METHODS as readonly string[]).includes(r.http.method) ? r.http.method : fail(`${where}.run.http.method must be one of ${HTTP_METHODS.join(", ")}`);
    const h = headers(r.http.headers, `${where}.run.http.headers`);
    const body = r.http.body === undefined ? undefined : text(r.http.body, `${where}.run.http.body`, 5000);
    checkTemplates([url, ...Object.values(h ?? {}), body ?? ""], [...shared, ...settings], `${where}.run.http`);
    run = { http: { url, ...(method ? { method } : {}), ...(h ? { headers: h } : {}), ...(body !== undefined ? { body } : {}) } };
  } else return fail(`${where}.run needs "macro" or "http"`);
  return { id, name: text(a.name ?? id, `${where}.name`, 60), settings, run };
}

function parseWidget(w: unknown, perms: Permissions, shared: SettingField[], i: number, hasMain = false): WidgetDef {
  const where = `widgets[${i}]`;
  if (!isObj(w)) return fail(`${where} must be an object`);
  const id = text(w.id, `${where}.id`, 48);
  if (!ID_PART_RE.test(id)) fail(`${where}.id must be lowercase letters, digits, - and _`);
  if (!(RENDERERS as readonly string[]).includes(w.render)) fail(`${where}.render must be one of ${RENDERERS.join(", ")}`);
  const sizes = w.sizes === undefined ? ["2x1"] : Array.isArray(w.sizes) && w.sizes.length && w.sizes.length <= 12 && w.sizes.every((s: unknown) => typeof s === "string" && SIZE_RE.test(s)) ? (w.sizes as string[]) : fail(`${where}.sizes must be a list like ["2x1","2x2"]`);
  const settings = settingFields(w.settings, `${where}.settings`);
  // `preview`: sample data (the renderer's `data` object) shown before install. Checked with the same rules as live data; never fetched.
  let preview: unknown;
  if (w.preview !== undefined) {
    if (!isObj(w.preview)) return fail(`${where}.preview must be an object with sample data for the "${w.render}" renderer`);
    const cleaned = cleanRender(w.render as Renderer, w.preview);
    if ("error" in cleaned) return fail(`${where}.preview is not valid ${w.render} data: ${cleaned.error}`);
    preview = cleaned.data;
  }
  if (w.style !== undefined && (typeof w.style !== "string" || !(STYLES[w.render as string] ?? []).includes(w.style))) return fail(`${where}.style must be one of: ${(STYLES[w.render as string] ?? []).join(", ") || "(none)"}`);
  return { id, name: text(w.name ?? id, `${where}.name`, 60), render: w.render as Renderer, sizes, settings, ...(w.style !== undefined && w.style !== (STYLES[w.render as string] ?? [])[0] ? { style: w.style as string } : {}), ...(preview !== undefined ? { preview } : {}), source: parseSource(w.source, [...shared, ...settings], perms, `${where}.source`, hasMain) };
}

const MAIN_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,98}\.(?:js|mjs|cjs|ts|mts)$/;
/** `main`: a relative path to the entry module inside the plugin folder, normalized (no "..", no leading "/", forward slashes). */
export function parseMain(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return fail("main must be a path like \"index.ts\"");
  const p = v.replace(/^\.\//, "");
  if (!MAIN_RE.test(p) || p.split("/").some((s) => s === ".." || s === "." || s === "")) return fail('main must be a relative path to a .js, .mjs, .cjs, .ts or .mts file inside the plugin folder, like "index.ts"');
  return p;
}

/**
 * Validates untrusted nookdeck.json and returns a normalized copy. Throws an Error with a message the owner can act on.
 * `agentVersion` (when given) is checked against the manifest's `nookdeck` range.
 */
export function parseManifest(raw: unknown, opts: { agentVersion?: string; allowCore?: boolean } = {}): Manifest {
  if (!isObj(raw)) return fail("nookdeck.json must be a JSON object");
  if (raw.type === "theme") return fail("this is a theme package, not a plugin: install it from the Themes page");
  if (raw.type !== undefined && raw.type !== "plugin") return fail('type must be "plugin" or "theme"');
  const id = text(raw.id, "id", 100);
  if (!PLUGIN_ID_RE.test(id)) fail('id must look like "dev.author.name" (lowercase letters, digits, - and _, at least two parts separated by dots)');
  if (id.startsWith("core.") && !opts.allowCore) fail('ids starting with "core." are reserved for the plugins that ship with Nookdeck');
  const version = text(raw.version, "version", 40);
  if (!VERSION_RE.test(version)) fail('version must look like "1.2.3"');
  let nookdeck: string | undefined;
  if (raw.nookdeck !== undefined) {
    nookdeck = text(raw.nookdeck, "nookdeck", 40);
    if (!/^[>=^~\s]*\d+(\.\d+){0,2}\s*$/.test(nookdeck)) fail('nookdeck must look like ">=0.2.0"');
    if (opts.agentVersion && !versionAtLeast(opts.agentVersion, nookdeck)) fail(`this plugin needs Nookdeck ${nookdeck}, you have ${opts.agentVersion}. Update Nookdeck first.`);
  }
  const main = parseMain(raw.main);
  const permissions = parsePermissions(raw.permissions);
  const settings = settingFields(raw.settings, "settings");
  const widgets = (raw.widgets === undefined ? [] : Array.isArray(raw.widgets) && raw.widgets.length <= 20 ? raw.widgets : fail("widgets must be a list of up to 20 widgets")).map((w: unknown, i: number) => parseWidget(w, permissions, settings, i, main !== null));
  const actions = (raw.actions === undefined ? [] : Array.isArray(raw.actions) && raw.actions.length <= 20 ? raw.actions : fail("actions must be a list of up to 20 actions")).map((a: unknown, i: number) => parseAction(a, permissions, settings, i, main !== null));
  for (const [name, list] of [["widgets", widgets], ["actions", actions]] as const) {
    const seen = new Set<string>();
    for (const x of list) { if (seen.has(x.id)) fail(`${name}: id "${x.id}" is used twice`); seen.add(x.id); }
  }
  const themes = (raw.themes === undefined ? [] : Array.isArray(raw.themes) && raw.themes.length <= 20 ? raw.themes : fail("themes must be a list")).map((t: any, i: number) => {
    if (!isObj(t)) fail(`themes[${i}] must be an object`);
    const tid = text(t.id, `themes[${i}].id`, 48);
    if (!ID_PART_RE.test(tid)) fail(`themes[${i}].id must be lowercase letters, digits, - and _`);
    let theme;
    try { theme = validateTheme(t.theme); } catch (e: any) { return fail(`themes[${i}].theme: ${e?.message ?? e}`); }
    if (!theme) fail(`themes[${i}].theme is required`);
    return { id: tid, name: text(t.name ?? tid, `themes[${i}].name`, 60), theme: theme! };
  });
  const layouts = (raw.layouts === undefined ? [] : Array.isArray(raw.layouts) && raw.layouts.length <= 10 ? raw.layouts : fail("layouts must be a list")).map((l: any, i: number) => {
    if (!isObj(l)) fail(`layouts[${i}] must be an object`);
    const lid = text(l.id, `layouts[${i}].id`, 48);
    if (!ID_PART_RE.test(lid)) fail(`layouts[${i}].id must be lowercase letters, digits, - and _`);
    let layout;
    try { layout = validateLayout(l.layout); } catch (e: any) { return fail(`layouts[${i}].layout: ${e?.message ?? e}`); }
    return { id: lid, name: text(l.name ?? lid, `layouts[${i}].name`, 60), layout };
  });
  return {
    id, name: text(raw.name, "name", 60), version,
    ...(nookdeck ? { nookdeck } : {}),
    ...(raw.author !== undefined ? { author: text(raw.author, "author", 80, false) } : {}),
    ...(raw.description !== undefined ? { description: text(raw.description, "description", 300, false) } : {}),
    ...(raw.icon !== undefined ? { icon: text(raw.icon, "icon", 140, false) } : {}),
    permissions, settings, widgets, actions, themes, layouts, main,
  };
}

/** A theme package manifest ("type": "theme"): a pack of variants, look fields only, never code or permissions (spec D14-D16). */
export interface ThemeVariant { id: string; name: string; mode: "light" | "dark"; theme: PackLook; css?: string; preview?: string }
/** An option value patches look fields: `theme` for every variant, and `variants.<id>` replaces it for one variant (Catppuccin accents differ per flavour). */
export interface ThemeOption { id: string; name: string; values: Array<{ id: string; name: string; theme: Look; variants?: Record<string, Look> }> }
export interface ThemeManifest {
  type: "theme";
  id: string; name: string; version: string; nookdeck?: string; author?: string; description?: string;
  /** Shared base look every variant inherits (a package file in backgroundImage is already "theme:<id>/<file>"). */
  base: PackLook;
  /** Shared base CSS file. */
  css?: string;
  variants: ThemeVariant[];
  options: ThemeOption[];
  /** The light and dark variants Auto uses by default. */
  auto?: { light: string; dark: string };
  /** A png/jpg in the package (at most 1 MB). */
  preview?: string;
}
export const THEME_PREVIEW_MAX = 1024 * 1024;
export const THEME_CSS_MAX = 64 * 1024;
const THEME_REJECT = ["main", "permissions", "widgets", "actions", "settings", "layouts", "themes"];
const PKG_FILE_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function parseThemeManifest(raw: unknown, opts: { agentVersion?: string } = {}): ThemeManifest {
  if (!isObj(raw)) return fail("nookdeck.json must be a JSON object");
  if (raw.type !== "theme") return fail('a theme package needs "type": "theme"');
  for (const k of THEME_REJECT) if (raw[k] !== undefined && raw[k] !== null && !(Array.isArray(raw[k]) && raw[k].length === 0)) fail(`a theme cannot have "${k}": themes carry look fields only, no code and no permissions`);
  const id = text(raw.id, "id", 100);
  if (!PLUGIN_ID_RE.test(id)) fail('id must look like "dev.author.name" (lowercase letters, digits, - and _, at least two parts separated by dots)');
  if (id.startsWith("core.")) fail('ids starting with "core." are reserved');
  const version = text(raw.version, "version", 40);
  if (!VERSION_RE.test(version)) fail('version must look like "1.2.3"');
  let nookdeck: string | undefined;
  if (raw.nookdeck !== undefined) {
    nookdeck = text(raw.nookdeck, "nookdeck", 40);
    if (!/^[>=^~\s]*\d+(\.\d+){0,2}\s*$/.test(nookdeck)) fail('nookdeck must look like ">=0.3.1"');
    if (opts.agentVersion && !versionAtLeast(opts.agentVersion, nookdeck)) fail(`this theme needs Nookdeck ${nookdeck}, you have ${opts.agentVersion}. Update Nookdeck first.`);
  }
  // a package file is written as a plain relative path in the manifest; the agent keeps it as "theme:<id>/<path>"
  const look = (v: unknown, where: string): PackLook => {
    if (v === undefined || v === null) return {};
    if (!isObj(v)) return fail(`${where} must be an object with look fields`);
    const src: Record<string, any> = { ...v };
    if (typeof src.backgroundImage === "string" && PKG_FILE_RE.test(src.backgroundImage) && !src.backgroundImage.includes("..")) src.backgroundImage = `theme:${id}/${src.backgroundImage}`;
    try { return validatePackLook(src, where); } catch (e: any) { return fail(e?.message ?? String(e)); }
  };
  const file = (v: unknown, where: string, ext: RegExp, what: string): string | undefined => {
    if (v === undefined || v === null) return undefined;
    const f = text(v, where, 140);
    if (!PKG_FILE_RE.test(f) || f.includes("..") || !ext.test(f)) fail(`${where} must be ${what} in the package`);
    return f;
  };
  const base = look(raw.theme, "theme");
  const css = file(raw.css, "css", /\.css$/i, "a .css file");
  let variants: ThemeVariant[];
  if (raw.variants === undefined) {
    if (raw.theme === undefined) fail("a theme needs variants, or a theme with the look fields");
    const mode = base.mode === "light" ? "light" : "dark";
    variants = [{ id: "default", name: text(raw.name, "name", 60), mode, theme: {} }];
  } else {
    if (!Array.isArray(raw.variants) || raw.variants.length < 1 || raw.variants.length > 12) fail("variants must be a list of 1 to 12 variants");
    const seen = new Set<string>();
    variants = (raw.variants as unknown[]).map((v, i) => {
      if (!isObj(v)) return fail(`variants[${i}] must be an object`);
      const vid = text(v.id, `variants[${i}].id`, 48);
      if (!ID_PART_RE.test(vid)) fail(`variants[${i}].id must be lowercase letters, digits, - and _`);
      if (seen.has(vid)) fail(`variants: id "${vid}" is used twice`);
      seen.add(vid);
      if (v.mode !== "light" && v.mode !== "dark") fail(`variants[${i}].mode must be "light" or "dark"`);
      return { id: vid, name: text(v.name ?? vid, `variants[${i}].name`, 60), mode: v.mode as "light" | "dark", theme: look(v.theme, `variants[${i}].theme`), ...(file(v.css, `variants[${i}].css`, /\.css$/i, "a .css file") ? { css: file(v.css, `variants[${i}].css`, /\.css$/i, "a .css file")! } : {}), ...(file(v.preview, `variants[${i}].preview`, /\.(png|jpe?g)$/i, "a .png or .jpg file") ? { preview: file(v.preview, `variants[${i}].preview`, /\.(png|jpe?g)$/i, "a .png or .jpg file")! } : {}) };
    });
  }
  const options: ThemeOption[] = [];
  if (raw.options !== undefined) {
    if (!Array.isArray(raw.options) || raw.options.length > 4) fail("options must be a list of up to 4 options");
    const seen = new Set<string>();
    for (const [i, o] of (raw.options as unknown[]).entries()) {
      if (!isObj(o)) return fail(`options[${i}] must be an object`);
      const oid = text(o.id, `options[${i}].id`, 48);
      if (!ID_PART_RE.test(oid)) fail(`options[${i}].id must be lowercase letters, digits, - and _`);
      if (seen.has(oid)) fail(`options: id "${oid}" is used twice`);
      seen.add(oid);
      if (!Array.isArray(o.values) || o.values.length < 1 || o.values.length > 16) fail(`options[${i}].values must be a list of 1 to 16 values`);
      const vs = new Set<string>();
      options.push({ id: oid, name: text(o.name ?? oid, `options[${i}].name`, 60), values: (o.values as unknown[]).map((val, j) => {
        if (!isObj(val)) return fail(`options[${i}].values[${j}] must be an object`);
        const vid = text(val.id, `options[${i}].values[${j}].id`, 48);
        if (!ID_PART_RE.test(vid)) fail(`options[${i}].values[${j}].id must be lowercase letters, digits, - and _`);
        if (vs.has(vid)) fail(`options[${i}]: value id "${vid}" is used twice`);
        vs.add(vid);
        const patch = look(val.theme, `options[${i}].values[${j}].theme`);
        if ((patch as any).kinds || (patch as any).fonts) fail(`options[${i}].values[${j}].theme can only patch look fields`);
        let per: Record<string, Look> | undefined;
        if (val.variants !== undefined) {
          if (!isObj(val.variants)) return fail(`options[${i}].values[${j}].variants must be an object keyed by variant id`);
          per = {};
          for (const [kv, pv] of Object.entries(val.variants)) {
            if (!variants.some((x) => x.id === kv)) fail(`options[${i}].values[${j}].variants: there is no variant "${kv}"`);
            const pl = look(pv, `options[${i}].values[${j}].variants.${kv}`);
            if ((pl as any).kinds || (pl as any).fonts) fail(`options[${i}].values[${j}].variants.${kv} can only patch look fields`);
            per[kv] = pl;
          }
        }
        return { id: vid, name: text(val.name ?? vid, `options[${i}].values[${j}].name`, 60), theme: patch, ...(per ? { variants: per } : {}) };
      }) });
    }
  }
  let auto: { light: string; dark: string } | undefined;
  if (raw.auto !== undefined) {
    if (!isObj(raw.auto) || typeof raw.auto.light !== "string" || typeof raw.auto.dark !== "string") fail("auto must be { light, dark } variant ids");
    const l = variants.find((v) => v.id === raw.auto.light), d = variants.find((v) => v.id === raw.auto.dark);
    if (!l || !d) fail("auto names a variant that does not exist");
    auto = { light: raw.auto.light, dark: raw.auto.dark };
  }
  const preview = file(raw.preview, "preview", /\.(png|jpe?g)$/i, "a .png or .jpg file");
  return {
    type: "theme", id, name: text(raw.name, "name", 60), version,
    ...(nookdeck ? { nookdeck } : {}),
    ...(raw.author !== undefined ? { author: text(raw.author, "author", 80, false) } : {}),
    ...(raw.description !== undefined ? { description: text(raw.description, "description", 300, false) } : {}),
    base, ...(css ? { css } : {}), variants, options, ...(auto ? { auto } : {}), ...(preview ? { preview } : {}),
  };
}

/** The look for one variant with option values applied: base, then variant, then each chosen option value. Throws on an unknown id. */
export function resolveVariant(m: ThemeManifest, variantId: string, options: Record<string, string> = {}): PackLook {
  const v = m.variants.find((x) => x.id === variantId);
  if (!v) throw new Error(`this theme has no variant "${variantId}"`);
  const out: Record<string, any> = { ...m.base, ...v.theme };
  if (m.base.kinds || v.theme.kinds) out.kinds = { ...(m.base.kinds ?? {}), ...(v.theme.kinds ?? {}) }; // a variant's fonts replace the pack's list; kinds merge per kind
  for (const [oid, vid] of Object.entries(options)) {
    const o = m.options.find((x) => x.id === oid);
    if (!o) throw new Error(`this theme has no option "${oid}"`);
    const val = o.values.find((x) => x.id === vid);
    if (!val) throw new Error(`option "${oid}" has no value "${vid}"`);
    Object.assign(out, val.variants && val.variants[variantId] ? val.variants[variantId] : val.theme);
  }
  return out as PackLook;
}
