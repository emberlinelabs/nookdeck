#!/usr/bin/env bun
// Generates src/assets.gen.ts: imports every file in web/deck/dist and web/manage/dist
// with `with { type: "file" }` so `bun build --compile` embeds them (binaries included).
import { readdirSync, statSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, dirname, extname, sep } from "node:path";
import { writeMraEmbed } from "./mra-assets";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Short id of a deck build: hash of index.html and the sorted asset paths. "none" without a dist. Phones compare it to know they run stale code. */
export function buildHash(distDir: string): string {
  if (!existsSync(distDir)) return "none";
  const h = createHash("sha256");
  const index = join(distDir, "index.html");
  if (existsSync(index)) h.update(readFileSync(index));
  for (const file of walk(distDir)) h.update("\0" + relative(distDir, file).split(sep).join("/"));
  return h.digest("hex").slice(0, 10);
}

/**
 * Build id the deck page carries (its <meta name="pd-build">), read from dist/build.json written by
 * web/deck/vite.config.ts. The agent sends it in hello and the page reloads when they differ, so the two must be the
 * same value; buildHash is only the fallback for a dist without build.json.
 */
export function deckBuildId(distDir: string): string {
  try {
    const j = JSON.parse(readFileSync(join(distDir, "build.json"), "utf8"));
    if (typeof j?.build === "string" && j.build) return j.build;
  } catch {}
  return buildHash(distDir);
}

function section(name: string, distDir: string, outDir: string): string {
  const entries: string[] = [];
  if (existsSync(distDir)) {
    for (const file of walk(distDir)) {
      const key = relative(distDir, file).split(sep).join("/");
      let imp = relative(outDir, file).split(sep).join("/");
      if (!imp.startsWith(".")) imp = "./" + imp;
      entries.push(`  ${JSON.stringify(key)}: { path: f(${JSON.stringify(imp)}), type: ${JSON.stringify(contentType(file))} },`);
    }
  }
  return `export const ${name}: Record<string, AssetFile> = {\n${entries.join("\n")}\n};\n`;
}

export interface BuildInfo { commit: string; dirty: boolean; builtAt: string }

/** Short git SHA of HEAD and whether the tree has uncommitted changes; empty commit when this is not a git checkout. */
export function gitInfo(root: string): BuildInfo {
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  try {
    const head = git("rev-parse", "--short", "HEAD");
    if (head.exitCode !== 0) return { commit: "", dirty: false, builtAt: new Date().toISOString() };
    const status = git("status", "--porcelain", "--untracked-files=no");
    return { commit: head.stdout.toString().trim(), dirty: status.stdout.toString().trim() !== "", builtAt: new Date().toISOString() };
  } catch {
    return { commit: "", dirty: false, builtAt: new Date().toISOString() };
  }
}

/** Writes the asset map module. Missing dist folders produce empty maps. */
export function generate(webDir: string, outFile: string, info: BuildInfo = { commit: "", dirty: false, builtAt: new Date().toISOString() }): { deck: number; manage: number } {
  const outDir = dirname(outFile);
  const deck = section("DECK", join(webDir, "deck", "dist"), outDir);
  const manage = section("MANAGE", join(webDir, "manage", "dist"), outDir);
  // Static imports must be literal for bun to embed them, so emit one import per file.
  const body = [deck, manage].join("\n");
  const imports: string[] = [];
  let n = 0;
  const rewritten = body.replace(/f\("([^"]+)"\)/g, (_m, p) => {
    const id = `a${n++}`;
    imports.push(`import ${id} from ${JSON.stringify(p)} with { type: "file" };`);
    return id;
  });
  // the full Tabler catalog (served at /api/icons/catalog)
  const catalogFile = join(webDir, "shared", "icon-catalog.json");
  let catalogLine = "export const CATALOG: AssetFile | null = null;";
  if (existsSync(catalogFile)) {
    let imp = relative(outDir, catalogFile).split(sep).join("/");
    if (!imp.startsWith(".")) imp = "./" + imp;
    imports.push(`import catalog from ${JSON.stringify(imp)} with { type: "file" };`);
    catalogLine = `export const CATALOG: AssetFile | null = { path: catalog, type: "application/json; charset=utf-8" };`;
  }
  const src = [
    "// @ts-nocheck - generated by scripts/gen-assets.ts, do not edit",
    ...imports,
    "",
    "export interface AssetFile { path: string; type: string }",
    "",
    rewritten,
    catalogLine,
    `export const DECK_BUILD = ${JSON.stringify(deckBuildId(join(webDir, "deck", "dist")))};`,
    `export const BUILD_INFO: { commit: string; dirty: boolean; builtAt: string } = ${JSON.stringify(info)};`,
    "",
  ].join("\n");
  writeFileSync(outFile, src);
  return { deck: (deck.match(/path:/g) ?? []).length, manage: (manage.match(/path:/g) ?? []).length };
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const r = generate(join(root, "web"), join(root, "src", "assets.gen.ts"), gitInfo(root));
  console.log(`assets.gen.ts: ${r.deck} deck files, ${r.manage} manage files`);
  writeMraEmbed(); // the Now Playing adapter, when build-mediaremote.ts has built it (else a stub)
}
