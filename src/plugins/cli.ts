/**
 * `nookdeck plugin new|dev|pack`: the author's tools (spec "Code plugin API").
 *   new <name> [--id dev.me.name] [--dir path]   scaffolds a TypeScript plugin
 *   dev [dir] [--port N]                         links the folder into the running agent and reloads it when a file changes
 *   pack [dir] [--out file.zip]                  a zip of the plugin and the sha256 the registry pins
 */
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { parseManifest } from "./manifest";
import { MANIFEST_FILE, packageHash, readFolder, type Files } from "./store";

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export interface Scaffold { dir: string; id: string; files: Record<string, string> }

/** The files of a new plugin. Pure (no disk), so tests can look at them. */
export function scaffold(name: string, o: { id?: string; user?: string } = {}): Scaffold {
  const s = slug(name);
  if (!s) throw new Error("give the plugin a name, e.g. nookdeck plugin new my-clock");
  const id = o.id ?? `dev.${slug(o.user ?? "me") || "me"}.${s}`;
  const manifest = {
    id, name: name.trim(), version: "0.1.0", nookdeck: ">=0.2.0", description: "A Nookdeck plugin",
    main: "index.ts",
    permissions: { storage: true, network: [] as string[] },
    widgets: [{ id: "clock", name: "Clock", render: "stat", sizes: ["2x1"] }],
    actions: [{ id: "ping", name: "Ping" }],
  };
  parseManifest(manifest); // fails here, with a message, rather than at install
  return {
    dir: s, id,
    files: {
      [MANIFEST_FILE]: JSON.stringify(manifest, null, 2) + "\n",
      "index.ts": `import type { PluginContext } from "@nookdeck/plugin";

export function activate(ctx: PluginContext) {
  ctx.log("hello from", ctx.id);

  // data for the "clock" widget: called every 30 seconds while a phone is connected
  ctx.widgets.provide("clock", async () => {
    const opened = Number((await ctx.storage.get("opened")) ?? 0);
    return { render: "stat", data: { value: new Date().toLocaleTimeString(), label: \`opened \${opened}x\` } };
  }, { every: 30 });

  // the "ping" button
  ctx.actions.handle("ping", async () => {
    const n = Number((await ctx.storage.get("opened")) ?? 0) + 1;
    await ctx.storage.set("opened", n);
    ctx.log("ping", n);
  });
}
`,
      "package.json": JSON.stringify({ name: s, private: true, type: "module", devDependencies: { "@nookdeck/plugin": "^0.1.0" } }, null, 2) + "\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, types: [] }, include: ["*.ts"] }, null, 2) + "\n",
      "README.md": `# ${name.trim()}\n\nA Nookdeck plugin.\n\n    nookdeck plugin dev .     # use this folder in the running Nookdeck, reload on every save\n    nookdeck plugin pack      # a zip and the sha256 to publish\n\nThen add a "Clock" tile on the Plugins tab of the manage page.\n`,
      ".gitignore": "node_modules\n*.zip\n",
    },
  };
}

export async function pluginNew(args: string[], log = console.log): Promise<void> {
  const name = args.find((a) => !a.startsWith("-") && a !== args[args.indexOf("--id") + 1] && a !== args[args.indexOf("--dir") + 1]) ?? "";
  const val = (f: string): string | undefined => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`${f}=`))?.slice(f.length + 1); };
  const sc = scaffold(name, { id: val("--id"), user: process.env.USER ?? process.env.USERNAME });
  const dir = resolve(val("--dir") ?? sc.dir);
  try { await stat(dir); throw new Error(`${dir} already exists`); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  await mkdir(dir, { recursive: true });
  for (const [f, text] of Object.entries(sc.files)) await writeFile(join(dir, f), text);
  log(`Created ${dir}\n  id: ${sc.id}\n\nNext:\n  cd ${dir}\n  nookdeck plugin dev .`);
}

// ---------- pack ----------

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A zip (deflate) of the files, sorted by name with a fixed date, so the same files always give the same bytes. */
export function zipFiles(files: Files): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const name of [...files.keys()].sort()) {
    const data = Buffer.from(files.get(name)!);
    const comp = deflateRawSync(data, { level: 9 });
    const useDeflate = comp.length < data.length;
    const body = useDeflate ? comp : data;
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(useDeflate ? 8 : 0, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE((0o100644 << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export async function pluginPack(args: string[], log = console.log): Promise<{ file: string; zipSha256: string; packageSha256: string }> {
  const dir = resolve(args.find((a) => !a.startsWith("-") && a !== args[args.indexOf("--out") + 1]) ?? ".");
  const files = await readFolder(dir);
  const raw = files.get(MANIFEST_FILE);
  if (!raw) throw new Error(`there is no ${MANIFEST_FILE} in ${dir}`);
  const m = parseManifest(JSON.parse(new TextDecoder().decode(raw)));
  if (m.main && !files.has(m.main)) throw new Error(`main is "${m.main}", but that file is not in the folder`);
  for (const f of [...files.keys()]) if (f.endsWith(".zip")) files.delete(f); // an old pack is not part of the plugin
  const zip = zipFiles(files);
  const oi = args.indexOf("--out");
  const file = resolve(oi >= 0 ? args[oi + 1]! : `${m.id}-${m.version}.zip`);
  await writeFile(file, zip);
  const zipSha256 = createHash("sha256").update(zip).digest("hex");
  const packageSha256 = packageHash(files);
  log(`${file}\n  files:          ${files.size}\n  package sha256: ${packageSha256}   (what the registry pins)\n  zip sha256:     ${zipSha256}`);
  return { file, zipSha256, packageSha256 };
}

// ---------- dev ----------

export interface DevDeps {
  fetch?: typeof fetch;
  watch?: typeof watch;
  log?: (s: string) => void;
  debounceMs?: number;
}

/** Links `dir` into the agent on `port` and reloads it on every change. Resolves with a function that stops watching. */
export async function pluginDev(dir: string, port: number, d: DevDeps = {}): Promise<{ id: string; stop: () => void }> {
  const f = d.fetch ?? fetch;
  const log = d.log ?? console.log;
  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body?: unknown) => {
    const r = await f(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-nookdeck": "1" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(10_000) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ?? `the agent answered ${r.status}`);
    return j;
  };
  const abs = resolve(dir);
  let linked: any;
  try { linked = await post("/api/plugins", { source: abs, link: true }); }
  catch (e: any) { throw new Error(/fetch failed|ECONNREFUSED|Unable to connect/i.test(String(e?.message)) ? `no Nookdeck answered on port ${port}. Start it first (nookdeck).` : String(e?.message ?? e)); }
  log(`Linked ${linked.id} ${linked.version} from ${abs}${linked.code ? " (it runs code)" : ""}.\nIt reloads when you save a file. Logs: nookdeck plugin logs ${linked.id}  |  Ctrl+C to stop watching (the plugin stays linked).`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = async () => {
    try { const r = await post(`/api/plugins/${linked.id}/reload`); log(`Reloaded ${r.id} ${r.version}`); }
    catch (e: any) { log(`Could not reload: ${e?.message ?? e}`); }
  };
  const watcher = (d.watch ?? watch)(abs, { recursive: true }, (_ev, name) => {
    if (name && /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(String(name))) return;
    clearTimeout(timer);
    timer = setTimeout(() => void reload(), d.debounceMs ?? 300);
  });
  return { id: linked.id, stop: () => { clearTimeout(timer); watcher.close(); } };
}

/** `nookdeck plugin <new|dev|pack|logs>`; returns the exit code. `dev` does not return until Ctrl+C. */
export async function runPluginCli(args: string[], parsePort: (a: string[]) => number): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "new") { await pluginNew(rest); return 0; }
    if (sub === "pack") { await pluginPack(rest); return 0; }
    if (sub === "dev") {
      const dir = rest.find((a) => !a.startsWith("-") && a !== rest[rest.indexOf("--port") + 1] && a !== rest[rest.indexOf("-p") + 1]) ?? ".";
      await pluginDev(dir, parsePort(rest));
      await new Promise(() => {}); // watching until Ctrl+C
    }
    if (sub === "logs") {
      const id = rest.find((a) => !a.startsWith("-"));
      if (!id) { console.error("Usage: nookdeck plugin logs <id> [--port N]"); return 1; }
      const r = await fetch(`http://127.0.0.1:${parsePort(rest)}/api/plugins/${encodeURIComponent(id)}/logs?lines=100`);
      const j: any = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `the agent answered ${r.status}`);
      console.log((j.lines as string[]).join("\n"));
      return 0;
    }
    console.error("Usage: nookdeck plugin new <name> [--id dev.me.name] | dev [dir] [--port N] | pack [dir] [--out file.zip] | logs <id>");
    return 1;
  } catch (e: any) {
    console.error(`nookdeck: ${e?.message ?? e}`);
    return 1;
  }
}
