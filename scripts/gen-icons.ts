// Regenerates web/shared/icons.ts (built-in set) and web/shared/icon-catalog.json (full catalog) from Tabler Icons
// (MIT, https://tabler.io/icons) plus official AI brand marks from @lobehub/icons-static-svg (MIT).
// Usage: bun run gen-icons   (reads node_modules/@tabler/icons and node_modules/@lobehub/icons-static-svg)
import { existsSync, readFileSync } from "node:fs";

const NM = process.argv[2] ?? "node_modules";
const OUT = process.argv[3] ?? "web/shared/icons.ts";
const CATALOG = process.argv[4] ?? "web/shared/icon-catalog.json";
const T = `${NM}/@tabler/icons`;

/** Inner markup of a Tabler SVG file without the invisible 24x24 bounding path. */
function inner(style: "outline" | "filled", name: string): string | undefined {
  const f = `${T}/icons/${style}/${name}.svg`;
  if (!existsSync(f)) return undefined;
  const svg = readFileSync(f, "utf8");
  return svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*\/>/g, "")
    .replace(/\s*\n\s*/g, "")
    .trim();
}

const lobe = (file: string) => {
  const svg = readFileSync(`${NM}/@lobehub/icons-static-svg/icons/${file}.svg`, "utf8");
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 24 24";
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title>[\s\S]*?<\/title>/, "").trim();
  return { vb, body };
};

// Built-in set shipped in the phone bundle (picker groups, English keys the UIs translate). Tabler names.
const groups: Record<string, string[]> = {
  "Media": ["player-play", "player-pause", "player-skip-back", "player-skip-forward", "player-track-prev", "player-track-next", "repeat", "arrows-shuffle", "music", "radio", "microphone", "microphone-off", "headphones", "device-speaker"],
  "Volume": ["volume", "volume-2", "volume-3", "bell-off"],
  "Apps": ["world", "terminal-2", "code", "mail", "message", "message-circle", "calendar", "calendar-event", "calendar-check", "folder", "folder-open", "file", "file-text", "photo", "camera", "video", "device-gamepad-2", "shopping-cart"],
  "Actions": ["copy", "clipboard", "scissors", "arrow-back-up", "arrow-forward-up", "device-floppy", "search", "trash", "download", "upload", "refresh", "maximize", "minimize", "zoom-in", "zoom-out", "keyboard", "mouse", "typography", "command", "arrow-down-left", "arrow-left", "arrow-right", "arrow-up", "arrow-down", "plus", "minus", "x", "check", "circle-check"],
  "System": ["device-desktop", "device-laptop", "cpu", "server", "wifi", "bluetooth", "battery-4", "power", "lock", "lock-open", "moon", "sun", "brightness", "settings", "adjustments-horizontal", "screen-share", "bell", "clock", "alarm", "activity", "gauge"],
  "Navigation": ["home", "layout-grid", "layout-dashboard", "chevron-left", "chevron-right", "stack-2", "star", "heart", "bolt", "rocket", "flag", "bookmark", "link", "external-link", "coffee", "bulb", "sparkles", "robot"],
  "Other brands": ["brand-github", "brand-slack", "brand-youtube", "brand-x", "brand-twitch", "brand-figma", "brand-apple", "brand-google", "brand-discord", "brand-telegram", "brand-notion", "brand-vscode", "brand-spotify", "brand-chrome"],
};
const UI_ONLY = ["alert-triangle", "ban", "circle-x", "player-stop"];

// Names saved by layouts made with Lucide (before 2026-11-17 afternoon) or Reicon (until the Tabler switch).
const aliases: Record<string, string> = {
  // Lucide
  "play": "player-play", "pause": "player-pause", "skip-back": "player-skip-back", "skip-forward": "player-skip-forward",
  "rewind": "player-track-prev", "fast-forward": "player-track-next", "shuffle": "arrows-shuffle", "disc-3": "music", "music-2": "music",
  "podcast": "microphone", "mic": "microphone", "mic-off": "microphone-off", "volume-1": "volume-2", "volume-x": "volume-3", "speaker": "device-speaker",
  "globe": "world", "chrome": "brand-chrome", "terminal": "terminal-2", "square-terminal": "terminal-2", "message-square": "message",
  "image": "photo", "gamepad-2": "device-gamepad-2", "clipboard-paste": "clipboard", "undo-2": "arrow-back-up", "redo-2": "arrow-forward-up",
  "save": "device-floppy", "trash-2": "trash", "refresh-cw": "refresh", "type": "typography", "corner-down-left": "arrow-down-left",
  "monitor": "device-desktop", "laptop": "device-laptop", "memory-stick": "cpu", "hard-drive": "server", "battery": "battery-4", "unlock": "lock-open",
  "sun-dim": "brightness", "sliders": "adjustments-horizontal", "timer": "alarm", "house": "home", "panels-top-left": "layout-dashboard",
  "layers": "stack-2", "zap": "bolt", "lightbulb": "bulb", "bot": "robot", "github": "brand-github", "slack": "brand-slack",
  "twitter": "brand-x", "youtube": "brand-youtube", "twitch": "brand-twitch", "figma": "brand-figma",
  // Reicon
  "skip-prev": "player-skip-back", "skip-next": "player-skip-forward", "music3": "music", "volume-low": "volume-2", "volume-high": "volume",
  "browser-terminal": "terminal-2", "terminal-square": "terminal-2", "envelope": "mail", "gamepad2": "device-gamepad-2", "undo": "arrow-back-up",
  "redo": "arrow-forward-up", "floppy": "device-floppy", "search-zoom-in": "zoom-in", "search-zoom-out": "zoom-out", "text": "typography",
  "ram": "cpu", "autobrightness": "brightness", "screencast2": "screen-share", "grid": "layout-grid", "layout": "layout-dashboard",
  "lightning": "bolt", "arrow-up-right": "external-link", "forbidden": "ban",
};

// Official AI marks (Tabler has no Claude / Codex / Antigravity logos).
const brands: Record<string, string> = { claude: "claude-color", "claude-code": "claudecode-color", codex: "codex-color", antigravity: "antigravity-color", gemini: "gemini-color", opencode: "opencode", grok: "grok" };

const icons: Record<string, { O: string; F?: string }> = {};
const missing: string[] = [];
for (const n of [...Object.values(groups).flat(), ...UI_ONLY]) {
  const O = inner("outline", n), F = inner("filled", n);
  if (!O && !F) { missing.push(n); continue; }
  icons[n] = O ? (F ? { O, F } : { O }) : { O: F! };
}
for (const k of Object.keys(groups)) groups[k] = groups[k]!.filter((n) => icons[n]);
const brandOut: Record<string, { vb: string; body: string }> = {};
for (const [k, f] of Object.entries(brands)) { try { brandOut[k] = lobe(f); } catch { missing.push("brand:" + k); } }

// Full catalog for the management page picker (and for the agent to send phones the icons a layout uses).
const meta = JSON.parse(readFileSync(`${T}/icons.json`, "utf8")) as Record<string, { category?: string; tags?: string[] }>;
const catalog: Record<string, { c: string; t: string[]; O?: string; F?: string }> = {};
for (const [name, m] of Object.entries(meta)) {
  const O = inner("outline", name), F = inner("filled", name);
  if (!O && !F) continue;
  catalog[name] = { c: m.category || "Other", t: (m.tags ?? []).map(String).slice(0, 8), ...(O ? { O } : {}), ...(F ? { F } : {}) };
}
for (const [k, v] of Object.entries(aliases)) if (!icons[v] && !catalog[v] && !brandOut[v]) missing.push(`alias ${k}->${v}`);
if (missing.length) console.error("MISSING:", missing.join(", "));

// Every LobeHub brand mark (AI providers, models, apps) for the picker's "AI brands" tab: value "lobe:<name>".
// Colour variant when it exists, else the mono mark (drawn with currentColor). Text-only variants are skipped.
import { readdirSync } from "node:fs";
const lobeDir = `${NM}/@lobehub/icons-static-svg/icons`;
const lobeFiles = new Set(readdirSync(lobeDir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)));
const lobeNames = [...new Set([...lobeFiles].map((f) => f.replace(/-(color|text|text-cn|brand|brand-color)$/, "")))].filter((n) => lobeFiles.has(n) || lobeFiles.has(n + "-color")).sort();
const lobeCatalog: Record<string, { vb: string; body: string; color: boolean }> = {};
for (const n of lobeNames) {
  const file = lobeFiles.has(n + "-color") ? n + "-color" : n;
  const b = lobe(file);
  lobeCatalog[n] = { vb: b.vb, body: b.body.replace(/\s*\n\s*/g, ""), color: file.endsWith("-color") };
}

const tv = JSON.parse(readFileSync(`${T}/package.json`, "utf8")).version;
const lv = JSON.parse(readFileSync(`${NM}/@lobehub/icons-static-svg/package.json`, "utf8")).version;
const categories = [...new Set(Object.values(catalog).map((e) => e.c))].sort();
await Bun.write(CATALOG, JSON.stringify({ source: `@tabler/icons ${tv} (MIT, https://tabler.io/icons); brands: @lobehub/icons-static-svg (MIT)`, categories, icons: catalog, brands: lobeCatalog }));

const src = `// Generated by scripts/gen-icons.ts: do not edit by hand. Icons from Tabler Icons ${tv} (MIT, https://tabler.io/icons),
// AI brand marks from @lobehub/icons-static-svg ${lv} (MIT, https://icons.lobehub.com). 24x24 viewBox.
// An item's \`icon\` is a Tabler name (this built-in set, or any name in web/shared/icon-catalog.json that the agent sends
// with the layout), a BRANDS key, an old Lucide/Reicon name listed in ICON_ALIASES, "app:<bundleId>", "img:<id>",
// or any short text/emoji.
// Style (user choice 2026-11-17): Tabler OUTLINE glyphs with a heavier stroke on coloured tiles; the FILLED variant,
// when Tabler has one, is used for active states (e.g. play while playing).

/** Inner SVG markup per variant: O = outline (stroke), F = filled (fill). Wrap with wrapIcon(). */
export const ICONS: Record<string, { O: string; F?: string }> = ${JSON.stringify(icons)};

/** Official AI brand marks (colour). */
export const BRANDS: Record<string, { vb: string; body: string }> = ${JSON.stringify(brandOut)};

/** Old Lucide / Reicon names stored in existing layouts -> Tabler names. */
export const ICON_ALIASES: Record<string, string> = ${JSON.stringify(aliases, null, 2)};

/** Picker groups (English labels the UIs translate). "Brands" lists BRANDS. */
export const ICON_GROUPS: Record<string, string[]> = ${JSON.stringify({ ...groups, "Brands": Object.keys(brandOut) }, null, 2)};

export const DEFAULT_STROKE = 2.25;

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Wraps inner markup into a full SVG. Outline glyphs are stroked with currentColor, filled ones are filled. */
export function wrapIcon(innerMarkup: string, opts: { variant?: "O" | "F"; size?: number; stroke?: number } = {}): string {
  const size = opts.size ?? 24;
  const paint = opts.variant === "F"
    ? 'fill="currentColor" stroke="none"'
    : \`fill="none" stroke="currentColor" stroke-width="\${opts.stroke ?? DEFAULT_STROKE}" stroke-linecap="round" stroke-linejoin="round"\`;
  return \`<svg xmlns="http://www.w3.org/2000/svg" width="\${size}" height="\${size}" viewBox="0 0 24 24" \${paint} aria-hidden="true">\${innerMarkup}</svg>\`;
}

/** Maps an item's icon value to what to draw. */
export function resolveIcon(value: string | undefined): { kind: "icon"; name: string } | { kind: "brand"; name: string } | { kind: "text"; text: string } | null {
  if (!value) return null;
  const name = has(ICON_ALIASES, value) ? ICON_ALIASES[value]! : value;
  if (has(ICONS, name)) return { kind: "icon", name };
  if (has(BRANDS, name)) return { kind: "brand", name };
  return { kind: "text", text: value };
}

/** True when the value draws as a built-in SVG (Tabler, brand, or an old alias). */
export const isIconName = (s: string | undefined): s is string => { const r = resolveIcon(s); return !!r && r.kind !== "text"; };

/**
 * Full SVG markup for a built-in icon or brand. weight "Filled" uses Tabler's filled variant when it exists
 * (for active states), otherwise the outline glyph. stroke = outline stroke width (theme.iconStroke).
 */
export function iconSvg(value: string, opts: { size?: number; weight?: "Outline" | "Filled"; stroke?: number } = {}): string | null {
  const r = resolveIcon(value);
  if (!r || r.kind === "text") return null;
  const size = opts.size ?? 24;
  if (r.kind === "brand") { const b = BRANDS[r.name]!; return \`<svg xmlns="http://www.w3.org/2000/svg" width="\${size}" height="\${size}" viewBox="\${b.vb}" fill="currentColor" aria-hidden="true">\${b.body}</svg>\`; }
  const i = ICONS[r.name]!;
  const filled = opts.weight === "Filled" && !!i.F;
  return wrapIcon(filled ? i.F! : i.O, { variant: filled ? "F" : "O", size, stroke: opts.stroke });
}
`;
await Bun.write(OUT, src);
console.log("lobe brands", Object.keys(lobeCatalog).length, "built-in", Object.keys(icons).length, "brands", Object.keys(brandOut).length, "aliases", Object.keys(aliases).length, "catalog", Object.keys(catalog).length);
