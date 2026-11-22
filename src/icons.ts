import { userHome } from "./home";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import { basename, join } from "node:path";
import { runCapture } from "./actions";
import { APP_ICON_RE, HOME, IMG_ICON_RE, LOBE_ICON_RE, type Layout } from "./config";
import { BRANDS, ICONS, ICON_ALIASES } from "../web/shared/icons";
import { platform } from "./platform";
import type { AppCatalog } from "./platform/types";

/** Runs a command and returns stdout. Tests pass a fake `sips`/`plutil`. */
export type Runner = (argv: string[], timeoutMs?: number) => Promise<string>;

export const APPS_CACHE_MS = 60_000;
export const ICON_PX = 128;
export const UPLOAD_MAX = 512 * 1024;
export const ASSETS_BUDGET = 1_500_000;

export const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,127}$/;
export const IMG_ID_RE = /^[a-f0-9]{16}$/;

export interface AppInfo {
  name: string;
  bundleId: string;
  path: string;
  /** LSApplicationCategoryType (e.g. public.app-category.developer-tools); Apple's own apps without one are mapped; otherwise null. */
  category: string | null;
}

const CAT = "public.app-category.";
/** Apple apps that ship without LSApplicationCategoryType. Anything else under com.apple. is "utilities". */
const APPLE_CATEGORIES: Record<string, string> = {
  "com.apple.Music": "music", "com.apple.Photos": "photography", "com.apple.PhotoBooth": "photography", "com.apple.TV": "entertainment",
  "com.apple.podcasts": "entertainment", "com.apple.iBooksX": "books", "com.apple.Maps": "navigation", "com.apple.mail": "productivity",
  "com.apple.iCal": "productivity", "com.apple.Notes": "productivity", "com.apple.reminders": "productivity", "com.apple.Preview": "productivity",
  "com.apple.dt.Xcode": "developer-tools", "com.apple.FaceTime": "social-networking", "com.apple.MobileSMS": "social-networking",
  "com.apple.QuickTimePlayerX": "video", "com.apple.Stocks": "finance", "com.apple.weather": "weather", "com.apple.Home": "lifestyle",
  "com.apple.Safari": "utilities", "com.apple.finder": "utilities",
};

/** Where the macOS system apps live; they get Nookdeck's own "system" category so "utilities" stays useful. */
export const SYSTEM_APP_DIRS = ["/System/Library/CoreServices", "/System/Library/CoreServices/Applications"];

export function appCategory(bundleId: string, fromPlist: unknown, system = false): string | null {
  if (typeof fromPlist === "string" && /^[a-z0-9.-]{1,80}$/i.test(fromPlist)) return fromPlist;
  if (system) return "system";
  if (!bundleId.startsWith("com.apple.")) return null;
  return CAT + (APPLE_CATEGORIES[bundleId] ?? "utilities");
}

export interface LayoutAsset {
  /** Inner markup of a catalog icon. */
  svg?: string;
  /** Which variant `svg` is: O = outline (stroke, needs fill=none stroke=currentColor), F = filled. */
  variant?: "O" | "F";
  /** lobe:<name> brand marks: draw `svg` with this viewBox; true for brands. */
  vb?: string;
  brand?: boolean;
  /** Brand mark that carries its own colours (not a mono glyph). */
  color?: boolean;
  img?: string;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function appDirs(home = userHome()): string[] {
  return ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", "/System/Library/CoreServices", "/System/Library/CoreServices/Applications", join(home, "Applications")];
}

/** Magic bytes of the two accepted upload types. */
export function imageKind(b: Uint8Array): "png" | "jpeg" | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

export interface IconsOptions {
  /** Defaults to ~/.nookdeck. */
  home?: string;
  /** Home directory used for ~/Applications. */
  userHome?: string;
  dirs?: string[];
  /** Directories whose apps count as "system" (default: /System/Library/CoreServices and its Applications). */
  systemDirs?: string[];
  run?: Runner;
  now?: () => number;
  /** Catalog JSON text provider (embedded in the binary). */
  catalog?: () => Promise<string | null>;
  /** Installed-app source for OSes that are not scanned as macOS bundles (Windows). Defaults to the platform's; null = macOS bundles. */
  appCatalog?: AppCatalog | null;
}

/** Installed apps, their icons, uploaded images and the layout `assets` (macOS tooling; nothing user-supplied reaches a shell). */
export class Icons {
  private home: string;
  private dirs: string[];
  private systemDirs: string[];
  private run: Runner;
  private now: () => number;
  private apps: { at: number; list: AppInfo[] } | undefined;
  private appsBusy: Promise<AppInfo[]> | undefined;
  private catalogIcons: Record<string, { O?: string; F?: string }> | null | undefined;
  private catalogBrands: Record<string, { vb?: string; body?: string; color?: boolean }> = {};

  constructor(private opts: IconsOptions = {}) {
    this.home = opts.home ?? HOME;
    this.dirs = opts.dirs ?? appDirs(opts.userHome);
    this.systemDirs = opts.systemDirs ?? SYSTEM_APP_DIRS;
    this.run = opts.run ?? ((argv, t) => runCapture(argv, t));
    this.now = opts.now ?? Date.now;
  }

  private get cacheDir() { return join(this.home, "icon-cache"); }
  private get uploadDir() { return join(this.home, "icons"); }

  // ----- apps -----

  private async plist(file: string): Promise<Record<string, any> | null> {
    try {
      return JSON.parse(await this.run(["plutil", "-convert", "json", "-o", "-", file], 4000));
    } catch {
      return null;
    }
  }

  private get osApps(): AppCatalog | null {
    return this.opts.appCatalog === undefined ? platform.apps : this.opts.appCatalog;
  }

  private async scan(): Promise<AppInfo[]> {
    const os = this.osApps;
    if (os) return (await os.list()).sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.bundleId.localeCompare(b.bundleId));
    const seen = new Map<string, AppInfo>();
    for (const dir of this.dirs) {
      let names: string[];
      try { names = await readdir(dir); } catch { continue; }
      const found = await Promise.all(
        names.filter((n) => n.endsWith(".app")).map(async (n): Promise<AppInfo | null> => {
          const path = join(dir, n);
          const info = await this.plist(join(path, "Contents", "Info.plist"));
          const id = info?.CFBundleIdentifier;
          if (typeof id !== "string" || !BUNDLE_ID_RE.test(id)) return null; // no bundle id (or one we would not accept): skip
          const name = [info?.CFBundleDisplayName, info?.CFBundleName].find((x) => typeof x === "string" && x.trim()) ?? basename(n, ".app");
          return { name: String(name).trim(), bundleId: id, path, category: appCategory(id, info?.LSApplicationCategoryType, this.systemDirs.includes(dir)) };
        }),
      );
      for (const a of found) if (a && !seen.has(a.bundleId)) seen.set(a.bundleId, a);
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.bundleId.localeCompare(b.bundleId));
  }

  /** Cached for 60 s; concurrent callers share one scan. */
  async listApps(): Promise<AppInfo[]> {
    if (this.apps && this.now() - this.apps.at < APPS_CACHE_MS) return this.apps.list;
    this.appsBusy ??= this.scan().then((list) => {
      this.apps = { at: this.now(), list };
      return list;
    }).finally(() => { this.appsBusy = undefined; });
    return this.appsBusy;
  }

  /**
   * 128 px PNG of an app icon (from CFBundleIconFile, an .icns), cached in icon-cache/<bundleId>.png.
   * Null when the id is invalid, the app is unknown, or it only has an asset catalog (sips cannot read Assets.car).
   */
  async appIcon(bundleId: string): Promise<Uint8Array | null> {
    if (!BUNDLE_ID_RE.test(bundleId)) return null;
    const os = this.osApps;
    // Icons from the OS catalog (Windows) before 0.2 were cached upside down; ".v2" makes them extract again.
    const cached = join(this.cacheDir, os ? `${bundleId}.v2.png` : `${bundleId}.png`);
    try { return new Uint8Array(await readFile(cached)); } catch { /* extract */ }
    const app = (await this.listApps()).find((a) => a.bundleId === bundleId);
    if (!app) return null;
    if (os) {
      const png = await os.icon(bundleId);
      if (!png || imageKind(png) !== "png") return null;
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const tmp = `${cached}.${randomBytes(4).toString("hex")}.tmp`;
      try { await writeFile(tmp, png, { mode: 0o600 }); await rename(tmp, cached); } finally { await rm(tmp, { force: true }).catch(() => {}); }
      return png;
    }
    const info = await this.plist(join(app.path, "Contents", "Info.plist"));
    let file = info?.CFBundleIconFile ?? (Array.isArray(info?.CFBundleIconFiles) ? info.CFBundleIconFiles[0] : undefined);
    if (typeof file !== "string" || !file || file.includes("/") || file.includes("..")) return null;
    if (!file.endsWith(".icns")) file += ".icns";
    const src = join(app.path, "Contents", "Resources", file);
    try { await stat(src); } catch { return null; }
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const tmp = `${cached}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await this.run(["sips", "-Z", String(ICON_PX), "-s", "format", "png", src, "--out", tmp], 8000);
      const png = new Uint8Array(await readFile(tmp));
      if (imageKind(png) !== "png") return null;
      await rename(tmp, cached);
      return png;
    } catch {
      return null;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  // ----- uploads -----

  /** Validates (magic bytes, size), shrinks to at most 128 px as PNG, stores icons/<16 hex>.png. Returns the id. */
  async saveUpload(bytes: Uint8Array): Promise<string> {
    if (bytes.length === 0) throw new Error("empty image");
    if (bytes.length > UPLOAD_MAX) throw new Error("image is larger than 512 KB");
    const kind = imageKind(bytes);
    if (!kind) throw new Error("only PNG or JPEG images are accepted");
    await mkdir(this.uploadDir, { recursive: true, mode: 0o700 });
    const id = randomBytes(8).toString("hex");
    const tmpIn = join(this.uploadDir, `.${id}.in.${kind === "png" ? "png" : "jpg"}`);
    const out = join(this.uploadDir, `${id}.png`);
    try {
      const os = this.osApps;
      if (os) {
        const png = await os.resizeImage(bytes, kind === "png" ? "png" : "jpg", ICON_PX);
        if (imageKind(png) !== "png") throw new Error("cannot convert the image");
        await writeFile(out, png, { mode: 0o600 });
        return id;
      }
      await writeFile(tmpIn, bytes, { mode: 0o600 });
      const dims = await this.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", tmpIn], 5000);
      const w = Number(/pixelWidth:\s*(\d+)/.exec(dims)?.[1]);
      const h = Number(/pixelHeight:\s*(\d+)/.exec(dims)?.[1]);
      if (!(w > 0 && h > 0)) throw new Error("cannot read the image");
      // never enlarge: -Z would scale a small image up
      const args = Math.max(w, h) > ICON_PX ? ["-Z", String(ICON_PX)] : [];
      await this.run(["sips", ...args, "-s", "format", "png", tmpIn, "--out", out], 8000);
      const png = new Uint8Array(await readFile(out));
      if (imageKind(png) !== "png") throw new Error("cannot convert the image");
      return id;
    } catch (err) {
      await rm(out, { force: true }).catch(() => {});
      throw err;
    } finally {
      await rm(tmpIn, { force: true }).catch(() => {});
    }
  }

  async upload(id: string): Promise<Uint8Array | null> {
    if (!IMG_ID_RE.test(id)) return null;
    try { return new Uint8Array(await readFile(join(this.uploadDir, `${id}.png`))); } catch { return null; }
  }

  async deleteUpload(id: string): Promise<boolean> {
    if (!IMG_ID_RE.test(id)) return false;
    const file = join(this.uploadDir, `${id}.png`);
    try { await stat(file); } catch { return false; }
    await rm(file, { force: true });
    return true;
  }

  // ----- layout assets -----

  private async catalog(): Promise<Record<string, { O?: string; F?: string }> | null> {
    if (this.catalogIcons !== undefined) return this.catalogIcons;
    try {
      const text = await this.opts.catalog?.();
      const parsed = text ? JSON.parse(text) : null;
      this.catalogIcons = parsed ? (parsed.icons ?? null) : null;
      this.catalogBrands = parsed?.brands ?? {};
    } catch {
      this.catalogIcons = null;
    }
    return this.catalogIcons ?? null;
  }

  /** Every icon value used by the layout's items (buttons, folders, anything with an `icon` string). */
  static usedIcons(layout: Layout): string[] {
    const out = new Set<string>();
    for (const page of layout.pages) for (const it of page.items as any[]) if (typeof it.icon === "string" && it.icon) out.add(it.icon);
    return [...out];
  }

  /**
   * What the phone does not have built in: catalog icons outside the deck's ICONS/BRANDS ({svg}), app icons and uploaded
   * images ({img: data URL}). Skips (and logs) anything that would push the total past ~1.5 MB.
   */
  async layoutAssets(layout: Layout, budget = ASSETS_BUDGET): Promise<Record<string, LayoutAsset>> {
    const out: Record<string, LayoutAsset> = {};
    let total = 0;
    const add = (key: string, asset: LayoutAsset) => {
      const size = (asset.svg ?? asset.img ?? "").length + key.length;
      if (total + size > budget) {
        console.warn(`layout assets: skipped ${key} (over the ${budget} byte budget)`);
        return;
      }
      total += size;
      out[key] = asset;
    };
    for (const v of Icons.usedIcons(layout)) {
      if (v.startsWith("app:")) {
        if (!APP_ICON_RE.test(v)) continue;
        const png = await this.appIcon(v.slice(4)).catch(() => null);
        if (png) add(v, { img: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });
      } else if (v.startsWith("lobe:")) {
        if (!LOBE_ICON_RE.test(v)) continue;
        await this.catalog();
        const b = has(this.catalogBrands, v.slice(5)) ? this.catalogBrands[v.slice(5)] : undefined;
        if (b?.body) add(v, { svg: b.body, vb: b.vb ?? "0 0 24 24", brand: true, ...(b.color ? { color: true } : {}) });
      } else if (v.startsWith("img:")) {
        if (!IMG_ICON_RE.test(v)) continue;
        const png = await this.upload(v.slice(4));
        if (png) add(v, { img: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });
      } else {
        const name = has(ICON_ALIASES, v) ? ICON_ALIASES[v]! : v;
        if (has(ICONS, name) || has(BRANDS, name)) continue; // the deck has it built in
        const cat = await this.catalog();
        const entry = cat && has(cat, name) ? cat[name]! : undefined;
        // some Tabler icons only exist filled: draw those with variant F
        if (entry?.O) add(v, { svg: entry.O, variant: "O" });
        else if (entry?.F) add(v, { svg: entry.F, variant: "F" });
      }
    }
    return out;
  }
}
