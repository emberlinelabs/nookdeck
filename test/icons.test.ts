import { describe, expect, test } from "bun:test";
import { WIN, MODE600, MODE644 } from "./_os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-icons-"));
const { Icons, imageKind, ASSETS_BUDGET } = await import("../src/icons");
const { QuotaHistory, downsample, HISTORY_SAMPLE_MS, HISTORY_KEEP_MS } = await import("../src/ai/history");
const { buildCommand } = await import("../src/actions");
const { ICONS, BRANDS, ICON_ALIASES } = await import("../web/shared/icons");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** A fake macOS: app folders whose Info.plist is already JSON (the fake plutil just prints it) and a fake sips. */
function fakeMac(apps: Record<string, any>, opts: { dims?: [number, number] } = {}) {
  const root = tmp("pd-apps-");
  for (const [dirName, info] of Object.entries(apps)) {
    const app = join(root, dirName);
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), JSON.stringify(info));
    if (info.CFBundleIconFile && !info.__noIcns) writeFileSync(join(app, "Contents", "Resources", info.CFBundleIconFile.endsWith(".icns") ? info.CFBundleIconFile : info.CFBundleIconFile + ".icns"), "icns");
  }
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[0] === "plutil") {
      const text = readFileSync(argv[5]!, "utf8");
      if (text.includes("BROKEN")) throw new Error("plutil: bad plist");
      return text;
    }
    if (argv[0] === "sips" && argv[1] === "-g") return `${argv.at(-1)}\n  pixelWidth: ${opts.dims?.[0] ?? 512}\n  pixelHeight: ${opts.dims?.[1] ?? 512}\n`;
    if (argv[0] === "sips") {
      writeFileSync(argv[argv.indexOf("--out") + 1]!, PNG);
      return "";
    }
    throw new Error("unexpected " + argv.join(" "));
  };
  return { root, calls, run };
}

describe.skipIf(WIN)("apps", () => {
  const apps = {
    "Zed.app": { CFBundleIdentifier: "dev.zed.Zed", CFBundleName: "Zed", CFBundleIconFile: "app" },
    "Beta Tool.app": { CFBundleIdentifier: "com.x.beta", CFBundleDisplayName: "Beta", CFBundleName: "BetaName", CFBundleIconFile: "beta.icns" },
    "alpha.app": { CFBundleIdentifier: "com.x.alpha" },
    "NoId.app": { CFBundleName: "NoId" },
    "Evil.app": { CFBundleIdentifier: "bad id; rm -rf /", CFBundleName: "Evil" },
    "Broken.app": "BROKEN",
    "NoIcns.app": { CFBundleIdentifier: "com.x.assets", CFBundleName: "AssetsOnly", CFBundleIconFile: "AppIcon", __noIcns: true },
  };
  const make = () => {
    const f = fakeMac(apps as any);
    let t = 1000;
    const icons = new Icons({ appCatalog: null, home: tmp("pd-home-"), dirs: [f.root, join(f.root, "missing")], run: f.run, now: () => t });
    return { ...f, icons, advance: (ms: number) => { t += ms; } };
  };

  test("lists name/bundleId/path sorted by name, skips entries without a (valid) bundle id, name falls back", async () => {
    const { icons, root } = make();
    const list = await icons.listApps();
    expect(list.map((a) => [a.name, a.bundleId])).toEqual([["alpha", "com.x.alpha"], ["AssetsOnly", "com.x.assets"], ["Beta", "com.x.beta"], ["Zed", "dev.zed.Zed"]]);
    expect(list[0]!.path).toBe(join(root, "alpha.app"));
  });

  test("category: from Info.plist, mapped for Apple apps without one, else null; reaches GET /api/apps shape", async () => {
    const f = fakeMac({
      "Code.app": { CFBundleIdentifier: "com.x.code", CFBundleName: "Code", LSApplicationCategoryType: "public.app-category.developer-tools" },
      "Plain.app": { CFBundleIdentifier: "com.x.plain", CFBundleName: "Plain" },
      "Weird.app": { CFBundleIdentifier: "com.x.weird", CFBundleName: "Weird", LSApplicationCategoryType: "bad value; rm" },
      "Music.app": { CFBundleIdentifier: "com.apple.Music", CFBundleName: "Music" },
      "Photos.app": { CFBundleIdentifier: "com.apple.Photos", CFBundleName: "Photos" },
      "Safari.app": { CFBundleIdentifier: "com.apple.Safari", CFBundleName: "Safari" },
      "Finder.app": { CFBundleIdentifier: "com.apple.finder", CFBundleName: "Finder" },
      "Odd.app": { CFBundleIdentifier: "com.apple.SomethingNew", CFBundleName: "Odd" },
      "Mine.app": { CFBundleIdentifier: "com.apple.mine", CFBundleName: "Mine", LSApplicationCategoryType: "public.app-category.games" },
    } as any);
    const icons = new Icons({ appCatalog: null, home: tmp("pd-home-"), dirs: [f.root], run: f.run });
    const by = Object.fromEntries((await icons.listApps()).map((a) => [a.bundleId, a.category]));
    expect(by).toEqual({
      "com.x.code": "public.app-category.developer-tools", "com.x.plain": null, "com.x.weird": null,
      "com.apple.Music": "public.app-category.music", "com.apple.Photos": "public.app-category.photography",
      "com.apple.Safari": "public.app-category.utilities", "com.apple.finder": "public.app-category.utilities",
      "com.apple.SomethingNew": "public.app-category.utilities", "com.apple.mine": "public.app-category.games",
    });
  });

  test("apps under the system directories get category system (unless the plist declares one)", async () => {
    const f = fakeMac({
      "Finder.app": { CFBundleIdentifier: "com.apple.finder", CFBundleName: "Finder" },
      "Dock.app": { CFBundleIdentifier: "com.apple.dock", CFBundleName: "Dock" },
      "Declared.app": { CFBundleIdentifier: "com.apple.decl", CFBundleName: "Decl", LSApplicationCategoryType: "public.app-category.games" },
    } as any);
    const sys = new Icons({ appCatalog: null, home: tmp("pd-home-"), dirs: [f.root], systemDirs: [f.root], run: f.run });
    expect(Object.fromEntries((await sys.listApps()).map((a) => [a.bundleId, a.category]))).toEqual({ "com.apple.finder": "system", "com.apple.dock": "system", "com.apple.decl": "public.app-category.games" });
    const normal = new Icons({ appCatalog: null, home: tmp("pd-home-"), dirs: [f.root], systemDirs: [], run: f.run });
    expect((await normal.listApps()).find((a) => a.bundleId === "com.apple.finder")!.category).toBe("public.app-category.utilities");
    const { SYSTEM_APP_DIRS } = await import("../src/icons");
    expect(SYSTEM_APP_DIRS).toEqual(["/System/Library/CoreServices", "/System/Library/CoreServices/Applications"]);
  });

  test("cached for 60 s, rescanned after", async () => {
    const { icons, calls, advance } = make();
    await Promise.all([icons.listApps(), icons.listApps()]);
    const first = calls.length;
    await icons.listApps();
    expect(calls.length).toBe(first);
    advance(60_001);
    await icons.listApps();
    expect(calls.length).toBeGreaterThan(first);
  });

  test("app icon: sips from the .icns into icon-cache, cached, argv arrays only", async () => {
    const { icons, calls } = make();
    const png = await icons.appIcon("dev.zed.Zed");
    expect(imageKind(png!)).toBe("png");
    const sips = calls.filter((c) => c[0] === "sips");
    expect(sips.length).toBe(1);
    expect(sips[0]!.slice(0, 5)).toEqual(["sips", "-Z", "128", "-s", "format"]);
    expect(sips[0]![6]!.endsWith("Zed.app/Contents/Resources/app.icns")).toBe(true);
    expect(await icons.appIcon("dev.zed.Zed")).toEqual(png);
    expect(calls.filter((c) => c[0] === "sips").length).toBe(1); // second call served from the cache
    expect(existsSync(join((icons as any).cacheDir, "dev.zed.Zed.png"))).toBe(true);
    expect(imageKind((await icons.appIcon("com.x.beta"))!)).toBe("png"); // CFBundleIconFile already ends in .icns
  });

  test("no icon: asset-catalog-only app, unknown app, hostile ids", async () => {
    const { icons, calls } = make();
    expect(await icons.appIcon("com.x.assets")).toBeNull();
    expect(await icons.appIcon("com.x.alpha")).toBeNull(); // no CFBundleIconFile
    expect(await icons.appIcon("com.unknown")).toBeNull();
    for (const bad of ["../x", "a b", "a;b", "", "a/b", "-x"]) expect(await icons.appIcon(bad)).toBeNull();
    expect(calls.filter((c) => c[0] === "sips").length).toBe(0);
  });
});

describe.skipIf(WIN)("uploaded images", () => {
  test("PNG and JPEG are accepted, shrunk to <= 128 px, stored as <16hex>.png; get and delete", async () => {
    const f = fakeMac({}, { dims: [800, 400] });
    const home = tmp("pd-home-");
    const icons = new Icons({ appCatalog: null, home, run: f.run });
    const id = await icons.saveUpload(PNG);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(statSync(join(home, "icons", `${id}.png`)).isFile()).toBe(true);
    const convert = f.calls.filter((c) => c[0] === "sips" && c[1] !== "-g")[0]!;
    expect(convert.slice(0, 4)).toEqual(["sips", "-Z", "128", "-s"]);
    expect(imageKind((await icons.upload(id))!)).toBe("png");
    const jid = await icons.saveUpload(JPG);
    expect(jid).not.toBe(id);
    expect(await icons.deleteUpload(id)).toBe(true);
    expect(await icons.deleteUpload(id)).toBe(false);
    expect(await icons.upload(id)).toBeNull();
    expect(await icons.upload("../../etc/passwd")).toBeNull();
    expect(existsSync(join(home, "icons", `.${id}.in.png`))).toBe(false); // temp input cleaned
  });
  test("small images are not enlarged", async () => {
    const f = fakeMac({}, { dims: [64, 48] });
    await new Icons({ appCatalog: null, home: tmp("pd-home-"), run: f.run }).saveUpload(PNG);
    const convert = f.calls.filter((c) => c[0] === "sips" && c[1] !== "-g")[0]!;
    expect(convert).not.toContain("-Z");
  });
  test("rejects wrong magic bytes, empty and oversized", async () => {
    const icons = new Icons({ appCatalog: null, home: tmp("pd-home-"), run: fakeMac({}).run });
    await expect(icons.saveUpload(new TextEncoder().encode("<svg onload=x>"))).rejects.toThrow("PNG or JPEG");
    await expect(icons.saveUpload(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0]))).rejects.toThrow("PNG or JPEG");
    await expect(icons.saveUpload(new Uint8Array())).rejects.toThrow("empty");
    await expect(icons.saveUpload(new Uint8Array(512 * 1024 + 1).fill(1))).rejects.toThrow("512 KB");
    expect(imageKind(PNG)).toBe("png");
    expect(imageKind(JPG)).toBe("jpeg");
    expect(imageKind(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  test("a failing sips leaves nothing behind", async () => {
    const home = tmp("pd-home-");
    const icons = new Icons({ appCatalog: null, home, run: async () => { throw new Error("sips: boom"); } });
    await expect(icons.saveUpload(PNG)).rejects.toThrow("boom");
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(home, "icons"))).toEqual([]);
  });
});

describe.skipIf(WIN)("layout assets", () => {
  const catalog = JSON.stringify({ icons: { "zz-new-icon": { c: "ui", t: [], O: "<path d='M0 0'/>", F: "<path d='M1 1'/>" }, "zz-filled-only": { c: "ui", t: [], F: "<path d='M2 2'/>" }, ac: { O: "<g/>" } } });
  const layoutOf = (...icons: (string | undefined)[]) => ({ pages: [{ id: "p", name: "P", columns: 4, items: icons.map((icon, i) => ({ id: `i${i}`, kind: "button", label: "x", ...(icon ? { icon } : {}) })) }] }) as any;
  const builtin = Object.keys(ICONS)[0]!;
  const brand = Object.keys(BRANDS)[0]!;
  const alias = Object.keys(ICON_ALIASES)[0]!;

  test("only what the phone lacks: catalog svg, app img, upload img", async () => {
    const f = fakeMac({ "Zed.app": { CFBundleIdentifier: "dev.zed.Zed", CFBundleIconFile: "app" } });
    const icons = new Icons({ appCatalog: null, home: tmp("pd-home-"), dirs: [f.root], run: f.run, catalog: async () => catalog });
    const id = await icons.saveUpload(PNG);
    const a = await icons.layoutAssets(layoutOf(builtin, brand, alias, "zz-new-icon", "app:dev.zed.Zed", `img:${id}`, "app:com.none", "img:0123456789abcdef", "🙂", undefined, "not-anywhere"));
    expect(Object.keys(a).sort()).toEqual(["app:dev.zed.Zed", `img:${id}`, "zz-new-icon"].sort());
    expect(a["zz-new-icon"]).toEqual({ svg: "<path d='M0 0'/>", variant: "O" });
    expect(a["app:dev.zed.Zed"]!.img).toStartWith("data:image/png;base64,");
    expect(a[`img:${id}`]!.img).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  });
  test("entries that only exist filled are sent as variant F", async () => {
    const icons = new Icons({ appCatalog: null, home: tmp("pd-home-"), run: fakeMac({}).run, catalog: async () => catalog });
    expect(await icons.layoutAssets(layoutOf("zz-filled-only"))).toEqual({ "zz-filled-only": { svg: "<path d='M2 2'/>", variant: "F" } });
  });
  test("lobe: brand marks are sent with their viewBox and brand flag", async () => {
    const cat = JSON.stringify({ icons: {}, brands: { ace: { vb: "0 0 24 24", body: "<path d='M0'/>", color: false }, rainbow: { vb: "0 0 32 32", body: "<g/>", color: true } } });
    const icons = new Icons({ appCatalog: null, home: tmp("pd-home-"), run: fakeMac({}).run, catalog: async () => cat });
    expect(await icons.layoutAssets(layoutOf("lobe:ace", "lobe:rainbow", "lobe:nope", "lobe:BAD!"))).toEqual({
      "lobe:ace": { svg: "<path d='M0'/>", vb: "0 0 24 24", brand: true },
      "lobe:rainbow": { svg: "<g/>", vb: "0 0 32 32", brand: true, color: true },
    });
  });
  test("works without a catalog; budget skips extras and logs", async () => {
    const none = new Icons({ appCatalog: null, home: tmp("pd-home-"), run: fakeMac({}).run });
    expect(await none.layoutAssets(layoutOf("zz-new-icon"))).toEqual({});
    const icons = new Icons({ appCatalog: null, home: tmp("pd-home-"), run: fakeMac({}).run, catalog: async () => JSON.stringify({ icons: { aa1: { O: "x".repeat(100) }, aa2: { O: "y".repeat(100) } } }) });
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (m: string) => warned.push(m);
    try {
      const a = await icons.layoutAssets(layoutOf("aa1", "aa2"), 150);
      expect(Object.keys(a)).toEqual(["aa1"]);
    } finally {
      console.warn = warn;
    }
    expect(warned.join()).toContain("aa2");
    expect(ASSETS_BUDGET).toBeLessThanOrEqual(1_500_000);
  });
});

describe("open bundle:", () => {
  test("open -b with an argv array; ids are validated; macOS only", () => {
    expect(buildCommand({ type: "open", target: "bundle:com.apple.Safari" }, "darwin")).toEqual(["open", "-b", "com.apple.Safari"]);
    expect(() => buildCommand({ type: "open", target: "bundle:x; rm -rf /" }, "darwin")).toThrow("invalid bundle id");
    expect(() => buildCommand({ type: "open", target: "bundle:" }, "darwin")).toThrow();
    expect(() => buildCommand({ type: "open", target: "bundle:com.x" }, "linux")).toThrow("macOS");
  });
});

describe("QuotaHistory", () => {
  const file = () => join(tmp("pd-qh-"), "sub", "quota-history.json");
  const q = (pct: number, over: any = {}) => ({
    id: "claude", name: "Claude", updatedAt: 1, windows: [{ id: "five_hour", label: "5 hours", usedPercent: pct }],
    ...over,
  }) as any;

  test("one sample per 5 minutes per provider/window; errors are not sampled", () => {
    let t = 1_000_000;
    const h = new QuotaHistory(file(), () => t);
    expect(h.record([q(10)])).toBe(true);
    t += HISTORY_SAMPLE_MS - 1;
    expect(h.record([q(11)])).toBe(false);
    t += 1;
    expect(h.record([q(12)])).toBe(true);
    expect(h.get("claude", undefined, "five_hour")).toEqual([[1_000_000, 10], [1_000_000 + HISTORY_SAMPLE_MS, 12]]);
    expect(h.record([{ id: "codex", name: "Codex", windows: [], error: "x", updatedAt: 0 } as any])).toBe(false);
  });

  test("keeps 24 h, downsamples to <= 48 points keeping the ends", () => {
    let t = 0;
    const h = new QuotaHistory(file(), () => t);
    for (let i = 0; i < 300; i++) { h.record([q(i % 100)]); t += HISTORY_SAMPLE_MS; }
    const pts = h.get("claude", undefined, "five_hour");
    expect(pts.length).toBe(48);
    const raw = (h as any).series.get("claude/_/five_hour");
    expect(raw.length).toBe(HISTORY_KEEP_MS / HISTORY_SAMPLE_MS + 1); // 24 h, both ends included
    expect(pts[0]).toEqual(raw[0]);
    expect(pts.at(-1)).toEqual(raw.at(-1));
    expect(downsample([[1, 1], [2, 2]])).toEqual([[1, 1], [2, 2]]);
    expect(downsample(Array.from({ length: 100 }, (_, i) => [i, i] as [number, number])).length).toBe(48);
  });

  test("decorate adds history to provider windows; persists 0600 and reloads, dropping old points", async () => {
    const f = file();
    let t = 5_000_000;
    const h = new QuotaHistory(f, () => t);
    h.record([q(40)]);
    await h.save();
    expect(statSync(f).mode & 0o777).toBe(MODE600);
    const out = h.decorate([q(40)])[0]!;
    expect(out.windows[0]!.history).toEqual([[5_000_000, 40]]);
    const again = new QuotaHistory(f, () => t);
    await again.load();
    expect(again.get("claude", undefined, "five_hour")).toEqual([[5_000_000, 40]]);
    const later = new QuotaHistory(f, () => t + HISTORY_KEEP_MS + 1);
    await later.load();
    expect(later.get("claude", undefined, "five_hour")).toEqual([]);
    writeFileSync(f, "{ broken");
    const bad = new QuotaHistory(f);
    await bad.load();
    expect(bad.get("claude", undefined, "five_hour")).toEqual([]);
  });
});
