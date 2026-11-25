/**
 * Runs the declared data sources of no-code plugins: templates ({{setting}}), dot paths ($.a.b[0]), the renderer data checks,
 * the host-limited HTTP client and the command runner. Network and shell go through `deps`, so tests use fakes.
 */
import { hostMatches, EVERY_DEFAULT } from "./manifest";
import { cleanRender } from "./render";
export { cleanRender };
import type { ActionDef, Permissions, Renderer, SettingField, Settings, SettingValue, TileItem, WidgetDef } from "./types";

export interface SourceDeps {
  fetch: typeof fetch;
  /** Runs a shell command line on this computer; resolves with the exit code and stdout. */
  shell: (command: string, timeoutMs: number, env?: Record<string, string>) => Promise<{ code: number; stdout: string }>;
}

export const HTTP_TIMEOUT_MS = 10_000;
export const HTTP_MAX_BYTES = 1024 * 1024;
export const COMMAND_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;

// ---------- templates and paths ----------

/** Replaces {{key}} with the setting's value (missing = empty). `encode` URL-encodes the values (for URLs). */
export function expand(template: string, values: Settings, encode = false): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_, k: string) => {
    const v = values[k];
    const s = v === undefined ? "" : String(v);
    return encode ? encodeURIComponent(s) : s;
  });
}

/** `$` is the root, `.name` and `[0]` step down. Returns undefined when any step is missing. Never reads inherited properties. */
export function jsonPath(root: unknown, path: string): unknown {
  if (!path.startsWith("$")) return undefined;
  let cur: unknown = root;
  const re = /\.([^.[\]]+)|\[(\d+)\]/g;
  const rest = path.slice(1);
  let pos = 0;
  for (let m = re.exec(rest); m; m = re.exec(rest)) {
    if (m.index !== pos) return undefined; // junk between steps
    pos = re.lastIndex;
    if (cur === null || typeof cur !== "object") return undefined;
    const key = m[1] ?? Number(m[2]);
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as any)[key];
  }
  return pos === rest.length ? cur : undefined;
}

/** A map value: a path when it (after templates) starts with "$", otherwise literal text. Non-strings stay as they are. */
function mapValue(v: unknown, root: unknown, settings: Settings): unknown {
  if (typeof v !== "string") return v;
  const s = expand(v, settings);
  return s.startsWith("$") ? jsonPath(root, s) : s;
}

/** The renderer's data from a response: through `map` when the widget has one, otherwise the response itself (or the text as the main field). */
export function mapResponse(w: WidgetDef, root: unknown, settings: Settings): Record<string, unknown> {
  const map = "map" in w.source ? w.source.map : undefined;
  if (!map) {
    if (root !== null && typeof root === "object" && !Array.isArray(root)) return root as Record<string, unknown>;
    const main = w.render === "text" ? "body" : w.render === "image" ? "url" : "value";
    return { [main]: root };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k === "itemMap") continue;
    out[k] = mapValue(v, root, settings);
  }
  const itemMap = map.itemMap;
  if (w.render === "list" && Array.isArray(out.items) && itemMap && typeof itemMap === "object") {
    out.items = (out.items as unknown[]).slice(0, 20).map((el) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(itemMap as Record<string, unknown>)) o[k] = mapValue(v, el, settings);
      return o;
    });
  }
  return out;
}

// ---------- settings ----------

/** Plugin-wide settings < this widget's defaults < tile settings; only declared keys, values coerced to the field type. */
export function resolveSettings(fields: SettingField[], layers: Array<Record<string, SettingValue> | undefined>): Settings {
  const out: Settings = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.key] = f.default;
    // a secret lives only in the plugin's own settings: a tile's settings travel to phones with the layout
    for (const layer of f.type === "secret" ? layers.slice(0, 1) : layers) {
      const raw = layer?.[f.key];
      if (raw === undefined) continue;
      const v = coerce(f, raw);
      if (v !== undefined) out[f.key] = v;
    }
  }
  return out;
}

export function coerce(f: SettingField, raw: unknown): SettingValue | undefined {
  switch (f.type) {
    case "number": { const n = typeof raw === "number" ? raw : raw === "" ? NaN : Number(raw); return Number.isFinite(n) ? n : undefined; }
    case "boolean": return typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : undefined;
    case "select": return typeof raw === "string" && f.options?.includes(raw) ? raw : undefined;
    default: return typeof raw === "string" ? raw.slice(0, 2000) : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : undefined;
  }
}

// ---------- network ----------

/** GET/POST to a host the plugin may call. Redirects are followed by hand and every hop is checked. Throws a short message. */
export async function guardedRequest(
  url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, perms: Permissions, deps: SourceDeps,
): Promise<string> {
  let target = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try { u = new URL(target); } catch { throw new Error("bad address"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("only http and https addresses are allowed");
    if (!perms.network.some((h) => hostMatches(u.hostname, h))) throw new Error(`${u.hostname} is not in this plugin's allowed hosts`);
    const res = await deps.fetch(target, {
      method: hop === 0 ? init.method ?? "GET" : "GET", headers: init.headers, ...(hop === 0 && init.body !== undefined ? { body: init.body } : {}),
      redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      target = new URL(res.headers.get("location")!, target).toString();
      continue;
    }
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    const text = await res.text();
    if (text.length > HTTP_MAX_BYTES) throw new Error("the answer is too large");
    return text;
  }
  throw new Error("too many redirects");
}

const parseBody = (text: string): unknown => {
  try { return JSON.parse(text); } catch { return text.trim(); }
};

// ---------- widgets and actions ----------

export const widgetEvery = (w: WidgetDef): number => ("http" in w.source ? w.source.http.every : "command" in w.source ? w.source.command.every : w.source.agent.every) ?? EVERY_DEFAULT;

/** Fetches (or runs) the widget's source once and returns what the deck shows. Never throws: a failure is `{error}`. */
export async function evaluateWidget(w: WidgetDef, settings: Settings, perms: Permissions, deps: SourceDeps): Promise<TileItem> {
  if (w.render.startsWith("custom:")) return { error: "plugin widget missing" }; // core plugins are served by the core host, never by a source
  if ("agent" in w.source) return { error: "plugin host unavailable" }; // code plugins are served by the plugin host (runtime.ts)
  try {
    let root: unknown;
    if ("http" in w.source) {
      const h = w.source.http;
      const headers = h.headers ? Object.fromEntries(Object.entries(h.headers).map(([k, v]) => [k, expand(v, settings)])) : undefined;
      root = parseBody(await guardedRequest(expand(h.url, settings, true), { headers }, perms, deps));
    } else {
      if (!perms.shell) throw new Error("this plugin has not been allowed to run commands");
      const c = w.source.command;
      const r = await deps.shell(c.run, COMMAND_TIMEOUT_MS, settingsEnv(settings)); // never {{templates}} in a command: values go in the environment
      if (r.code !== 0) throw new Error(`the command failed (exit ${r.code})`);
      const out = r.stdout.slice(0, HTTP_MAX_BYTES);
      root = c.parse === "text" ? out.trim() : c.parse === "json" ? JSON.parse(out) : parseBody(out);
    }
    const cleaned = cleanRender(w.render as Renderer, mapResponse(w, root, settings));
    return "error" in cleaned ? { error: cleaned.error } : { render: w.render as Renderer, data: cleaned.data };
  } catch (e: any) {
    const name = e?.name === "TimeoutError" ? "the request timed out" : String(e?.message ?? e);
    return { error: name.slice(0, 120) };
  }
}

/** Runs a no-code http action. Macro actions are handed to the server's macro runner (see `actionSteps`). */
export async function runHttpAction(a: ActionDef, settings: Settings, perms: Permissions, deps: SourceDeps): Promise<void> {
  if (!("http" in a.run)) throw new Error("not an http action");
  const h = a.run.http;
  const headers = h.headers ? Object.fromEntries(Object.entries(h.headers).map(([k, v]) => [k, expand(v, settings)])) : undefined;
  await guardedRequest(expand(h.url, settings, true), { method: h.method ?? "GET", headers, ...(h.body !== undefined ? { body: expand(h.body, settings) } : {}) }, perms, deps);
}

/**
 * The settings a command may read: NOOKDECK_SETTING_<KEY> (key upper-cased). A command line never contains a setting's value
 * itself ({{key}} is refused in commands at install), so a value with a quote, a `;` or a `$(...)` cannot become code.
 */
export function settingsEnv(settings: Settings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings)) out[`NOOKDECK_SETTING_${k.toUpperCase()}`] = String(v);
  return out;
}

/** The macro steps of an action with {{settings}} filled into every text field (a shell step gets its settings as environment instead). */
export function actionSteps(a: ActionDef, settings: Settings) {
  if (!("macro" in a.run)) throw new Error("not a macro action");
  return a.run.macro.map((st) => {
    if (st.kind === "shell") return { kind: "shell" as const, command: st.command, env: settingsEnv(settings) };
    return Object.fromEntries(Object.entries(st).map(([k, v]) => [k, typeof v === "string" ? expand(v, settings) : v])) as typeof st;
  });
}
