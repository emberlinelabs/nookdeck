/**
 * Installed apps on Linux (L5 of specs/linux-support): the .desktop files under <data dir>/applications, icons from the
 * hicolor theme and pixmaps, opened with `gio launch` or `gtk-launch`. PNG icons are shrunk in TS (png.ts); SVG icons
 * need `rsvg-convert` (librsvg2-bin) and are skipped without it.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppInfo } from "../icons";
import type { AppCatalog } from "./types";
import { t } from "../i18n";
import { desktopCategory, desktopFileId, iconCandidates, linuxAppId, parseDesktopEntry, xdgDataDirs, type DesktopEntry } from "./linux-sys";
import { isPng, shrinkPng } from "./png";

export interface LinuxAppsDeps {
  env: Record<string, string | undefined>;
  home: string;
  which: (n: string) => string | null;
  run: (argv: string[], timeoutMs?: number, stdin?: string) => Promise<string>;
  /** Run and return stdout as bytes (rsvg-convert, convert). */
  runBytes?: (argv: string[], timeoutMs?: number) => Promise<Uint8Array>;
  /** Data dirs instead of the XDG ones (tests). */
  dataDirs?: string[];
}

const ICON_PX = 128;
const MAX_ICON_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 2000;

interface Found { info: AppInfo; desktopId: string; entry: DesktopEntry }

async function spawnBytes(argv: string[], timeoutMs = 8000): Promise<Uint8Array> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  const code = await p.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${argv[0]} exited with code ${code}`);
  return out;
}

/** Every .desktop file under dir (subfolders give ids like "kde-foo.desktop"), as [desktop id, path]. */
async function desktopFiles(dir: string, prefix = "", depth = 0, out: Array<[string, string]> = []): Promise<Array<[string, string]>> {
  let names: import("node:fs").Dirent[];
  try { names = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    if (out.length >= MAX_FILES) break;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory() && depth < 3) await desktopFiles(join(dir, d.name), rel, depth + 1, out);
    else if ((d.isFile() || d.isSymbolicLink()) && d.name.endsWith(".desktop")) out.push([desktopFileId(rel), join(dir, d.name)]);
  }
  return out;
}

export function createLinuxApps(deps: LinuxAppsDeps): AppCatalog {
  const dirs = () => deps.dataDirs ?? xdgDataDirs(deps.env, deps.home);
  const desktops = () => (deps.env.XDG_CURRENT_DESKTOP ?? "").split(":").filter(Boolean);
  const runBytes = deps.runBytes ?? spawnBytes;
  let byId = new Map<string, Found>();

  const catalog: AppCatalog = {
    async list() {
      const seenDesktop = new Set<string>();
      const next = new Map<string, Found>();
      for (const d of dirs()) {
        for (const [desktopId, path] of await desktopFiles(join(d, "applications"))) {
          // the first data dir that has a desktop id wins, even when that copy hides the app
          if (seenDesktop.has(desktopId)) continue;
          seenDesktop.add(desktopId);
          let entry: DesktopEntry | null = null;
          try { entry = parseDesktopEntry(await readFile(path, "utf8"), desktops()); } catch { /* unreadable */ }
          const id = linuxAppId(desktopId);
          if (!entry || !id || next.has(id)) continue;
          next.set(id, { desktopId, entry, info: { name: entry.name, bundleId: id, path, category: desktopCategory(entry.categories) } });
        }
      }
      byId = next;
      return [...next.values()].map((f) => f.info);
    },

    async icon(id) {
      if (!byId.has(id)) await catalog.list();
      const icon = byId.get(id)?.entry.icon;
      if (!icon) return null;
      for (const file of iconCandidates(icon, dirs(), deps.home)) {
        try {
          const s = await stat(file);
          if (!s.isFile() || s.size > MAX_ICON_BYTES) continue;
        } catch { continue; }
        if (file.endsWith(".svg")) {
          if (!deps.which("rsvg-convert")) continue; // no pure SVG renderer: skip SVG icons without librsvg
          try {
            const png = await runBytes(["rsvg-convert", "-w", String(ICON_PX), "-h", String(ICON_PX), "-a", "-f", "png", file]);
            if (isPng(png)) return png;
          } catch { /* try the next file */ }
          continue;
        }
        try {
          const png = shrinkPng(new Uint8Array(await readFile(file)), ICON_PX);
          if (png) return png;
        } catch { /* try the next file */ }
      }
      return null;
    },

    async open(id) {
      if (!byId.has(id)) await catalog.list();
      const f = byId.get(id);
      if (!f) throw new Error("unknown app");
      if (deps.which("gio")) { await deps.run(["gio", "launch", f.info.path], 10_000); return; }
      if (deps.which("gtk-launch")) { await deps.run(["gtk-launch", f.desktopId.replace(/\.desktop$/, "")], 10_000); return; }
      throw new Error(t("opening apps needs gio (libglib2.0-bin) or gtk-launch (libgtk-3-bin)"));
    },

    async resizeImage(bytes, ext, max) {
      if (ext === "png") {
        const png = shrinkPng(bytes, max);
        if (png) return png;
        throw new Error("cannot read the image");
      }
      // no pure JPEG decoder: ImageMagick when it is there
      const tool = deps.which("magick") ? "magick" : deps.which("convert") ? "convert" : null;
      if (!tool) throw new Error("cannot read the image");
      const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(join(tmpdir(), "nd-img-"));
      try {
        const src = join(dir, "in.jpg");
        await writeFile(src, bytes, { mode: 0o600 });
        const png = await runBytes([tool, src, "-resize", `${max}x${max}>`, "png:-"], 8000);
        if (!isPng(png)) throw new Error("cannot read the image");
        return png;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
  return catalog;
}
