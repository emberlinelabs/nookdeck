/** `nookdeck theme export <dir>` and `nookdeck theme reset`. They work on the layout file, or through the running agent when there is one. */
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HOME, loadLayout, saveLayout, validateLayout, type Layout } from "../config";
import { parseThemeManifest, resolveVariant } from "./manifest";
import { scopeThemeCss } from "./theme-css";
import { THEME_FILE_EXT, applyLook, buildThemePackage } from "./themes";

const val = (args: string[], f: string): string | undefined => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

/** Reads the layout from the running agent (so a later save is not overwritten), else from disk. */
async function currentLayout(port: number): Promise<{ layout: Layout; viaAgent: boolean }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/layout`, { headers: { "x-nookdeck": "1" }, signal: AbortSignal.timeout(1500) });
    if (r.ok) return { layout: validateLayout(await r.json()), viaAgent: true };
  } catch { /* no agent */ }
  return { layout: await loadLayout(), viaAgent: false };
}

export async function themeExport(args: string[], port: number, log = console.log): Promise<string> {
  const dirArg = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--id" && args[i - 1] !== "--name" && args[i - 1] !== "--port");
  if (!dirArg) throw new Error("Usage: nookdeck theme export <dir> [--id dev.me.name] [--name \"My theme\"]");
  const dir = resolve(dirArg);
  const id = val(args, "--id") ?? "dev.me.my-theme";
  const { layout } = await currentLayout(port);
  const files = new Map<string, Uint8Array>();
  const bg = layout.theme?.backgroundImage;
  const m = typeof bg === "string" ? /^theme:([^/]+)\/(.+)$/.exec(bg) : null;
  if (m && THEME_FILE_EXT.test(m[2]!)) { try { files.set(m[2]!, new Uint8Array(await readFile(join(HOME, "themes", m[1]!, m[2]!)))); } catch { /* file gone: exported without it */ } }
  const pkg = buildThemePackage(layout.theme, { id, name: val(args, "--name") ?? id }, { files });
  for (const [name, bytes] of pkg) {
    const target = join(dir, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  log(`wrote ${pkg.size} file(s) to ${dir}`);
  return dir;
}

/** Puts the look back to the defaults and turns custom CSS off, keeping behaviour settings: for a theme that made the deck unreadable. */
export async function themeReset(port: number, log = console.log): Promise<void> {
  const { layout, viaAgent } = await currentLayout(port);
  const next = validateLayout({ ...layout, theme: applyLook(layout.theme, {}), pages: layout.pages.map(({ theme, ...p }) => p) }); // behaviour kept, look + kinds + fonts + source cleared
  if (viaAgent) {
    const r = await fetch(`http://127.0.0.1:${port}/api/layout`, { method: "PUT", headers: { "x-nookdeck": "1", "content-type": "application/json" }, body: JSON.stringify(next) });
    if (!r.ok) throw new Error(`the agent answered ${r.status}`);
  } else await saveLayout(next);
  log("look reset to the defaults (behaviour settings kept)");
}

/**
 * `nookdeck theme demo <dir> [--variant id] [--base URL] [--options a=b,c=d]` prints the message the demo deck (dist-demo) takes: the variant's
 * resolved look, the pack's css already checked and scoped (package files point at --base), the fonts and the icon pack. For a website that
 * previews a theme from source with the real deck.
 */
export async function themeDemo(args: string[], log = console.log): Promise<object> {
  const dirArg = args.find((a, i) => !a.startsWith("-") && !["--variant", "--base", "--options"].includes(args[i - 1] ?? ""));
  if (!dirArg) throw new Error("Usage: nookdeck theme demo <dir> [--variant id] [--base https://host/path/to/package/files] [--options accent=mauve]");
  const dir = resolve(dirArg);
  const raw = JSON.parse(await readFile(join(dir, "nookdeck.json"), "utf8"));
  const m = parseThemeManifest(raw);
  const variant = val(args, "--variant") ?? m.variants[0]!.id;
  const options: Record<string, string> = {};
  for (const kv of (val(args, "--options") ?? "").split(",").filter(Boolean)) { const [k, v] = kv.split("="); if (k && v) options[k] = v; }
  const base = (val(args, "--base") ?? ".").replace(/\/+$/, "");
  const look: Record<string, any> = { ...resolveVariant(m, variant, options) };
  if (!look.mode) look.mode = m.variants.find((v) => v.id === variant)!.mode;
  // package files, listed by walking the folder
  const names: string[] = [];
  const walk = async (d: string, pre: string): Promise<void> => {
    for (const e of await readdir(join(dir, d), { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name), `${pre}${e.name}/`); else names.push(`${pre}${e.name}`);
    }
  };
  await walk("", "");
  const files = new Set(names);
  const read = async (f: string) => new TextDecoder().decode(await readFile(join(dir, f)));
  let css = "";
  if (m.css) css += scopeThemeCss(await read(m.css), { id: m.id, files, urlBase: base }) + "\n";
  const v = m.variants.find((x) => x.id === variant)!;
  if (v.css) css += scopeThemeCss(await read(v.css), { id: m.id, variant, files, urlBase: base }) + "\n";
  const bg = typeof look.backgroundImage === "string" ? /^theme:[^/]+\/(.+)$/.exec(look.backgroundImage)?.[1] : undefined;
  const msg = {
    type: "nd-demo",
    theme: look,
    pkg: m.id,
    variant,
    css,
    fonts: (look.fonts ?? []).map((f: { family: string; file: string; weight?: number }) => ({ family: f.family, url: `${base}/${f.file}`, ...(f.weight ? { weight: f.weight } : {}) })),
    icons: Object.fromEntries(await Promise.all(names.filter((n) => /^icons\/[A-Za-z0-9._-]+\.svg$/i.test(n)).map(async (n) => [n.slice(6, -4).toLowerCase(), await read(n)] as const))),
    files: bg ? { [`theme:${m.id}/${bg}`]: `${base}/${bg}` } : {},
  };
  log(JSON.stringify(msg));
  return msg;
}

export async function runThemeCli(args: string[], parsePort: (a: string[]) => number): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "export") { await themeExport(rest, parsePort(rest)); return 0; }
    if (sub === "demo") { await themeDemo(rest); return 0; }
    if (sub === "reset") { await themeReset(parsePort(rest)); return 0; }
    console.error("Usage: nookdeck theme export <dir> [--id dev.me.name] [--name \"My theme\"] | reset | demo <dir> [--variant id] [--base URL]");
    return 1;
  } catch (e: any) {
    console.error(`nookdeck: ${e?.message ?? e}`);
    return 1;
  }
}
