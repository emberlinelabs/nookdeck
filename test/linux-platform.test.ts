import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  desktopCategory, desktopFileId, fileUrlPath, iconCandidates, imageMime, linuxAppId, parseDesktopEntry, parseMeminfo,
  parseNvidiaSmi, parseXprintidle, xdgDataDirs,
} from "../src/platform/linux-sys";
import { decodePng, encodePng, isPng, shrinkPng, shrinkRgba } from "../src/platform/png";
import { createLinuxApps } from "../src/platform/linux-apps";
import { createLinux, linuxArtwork, secretToolStore } from "../src/platform/linux";
import { BUNDLE_ID_RE } from "../src/icons";
import { deflateSync } from "node:zlib";

const has = (...tools: string[]) => (n: string) => (tools.includes(n) ? `/usr/bin/${n}` : null);

describe("readings", () => {
  test("meminfo", () => {
    expect(parseMeminfo("MemTotal:       16303428 kB\nMemFree:         1000000 kB\nMemAvailable:   12000000 kB\n")).toBe((16303428 - 12000000) * 1024);
    expect(parseMeminfo("MemTotal: 100 kB\n")).toBeUndefined(); // kernels before 3.14 have no MemAvailable
    expect(parseMeminfo("")).toBeUndefined();
  });
  test("nvidia-smi", () => {
    expect(parseNvidiaSmi("37, 1024, 16376, 45, Quadro RTX 5000\n")).toEqual({ util: 37, memUsed: 1024 * 1048576, memTotal: 16376 * 1048576, temp: 45, name: "Quadro RTX 5000" });
    expect(parseNvidiaSmi("[N/A], [N/A], 16376, [N/A], GPU\n")).toBeUndefined(); // no utilisation: no GPU reading
    expect(parseNvidiaSmi("")).toBeUndefined();
    // two GPUs: the first
    expect(parseNvidiaSmi("5, 1, 2, 30, A\n90, 1, 2, 80, B\n")!.name).toBe("A");
  });
  test("xprintidle", () => {
    expect(parseXprintidle("65432\n")).toBe(65);
    expect(parseXprintidle("couldn't open display")).toBeNull();
  });
  test("lanName is the host name's first label; memUsed reads /proc/meminfo", async () => {
    const p = createLinux("linux", has(), {}, { host: () => "huit-gpu.example.lan", readText: async () => "MemTotal: 2048 kB\nMemAvailable: 1024 kB\n" });
    expect(await p.lanName()).toBe("huit-gpu");
    expect(await p.memUsed()).toBe(1024 * 1024);
  });
  test("missing tools degrade quietly", async () => {
    const p = createLinux("linux", has(), { WAYLAND_DISPLAY: "w" }, { readText: async () => { throw new Error("ENOENT"); } });
    expect(await p.gpu()).toBeUndefined();
    expect(await p.memUsed()).toBeUndefined();
    expect(await p.idleSeconds()).toBeNull();
    expect(p.secrets).toBeNull();
  });
  test("gpu and idle call their tools", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]) => { calls.push(argv); return argv[0] === "nvidia-smi" ? "12, 100, 200, 50, T4\n" : "3000\n"; };
    const x11 = createLinux("linux", has("nvidia-smi", "xprintidle"), { XDG_SESSION_TYPE: "x11" }, { run });
    expect((await x11.gpu())!.util).toBe(12);
    expect(await x11.idleSeconds()).toBe(3);
    const wl = createLinux("linux", has("nvidia-smi", "xprintidle"), { XDG_SESSION_TYPE: "wayland" }, { run });
    expect(await wl.idleSeconds()).toBeNull();
    expect(calls.map((c) => c[0])).toEqual(["nvidia-smi", "xprintidle"]);
  });
});

describe("secret-tool", () => {
  test("lookup, store with the value on stdin, clear", async () => {
    const calls: Array<{ argv: string[]; stdin?: string }> = [];
    const s = secretToolStore(async (argv, _ms, stdin) => {
      calls.push({ argv, stdin });
      if (argv[1] === "lookup") { if (argv[5] === "none") throw new Error("exit 1"); return "tok"; }
      return "";
    });
    expect(await s.get("nookdeck-hass", "me")).toBe("tok");
    expect(await s.get("nookdeck-hass", "none")).toBeUndefined();
    expect(await s.set("nookdeck-hass", "me", "secret")).toBe(true);
    await s.remove("nookdeck-hass", "me");
    expect(calls[2]).toEqual({ argv: ["secret-tool", "store", "--label=Nookdeck nookdeck-hass", "service", "nookdeck-hass", "account", "me"], stdin: "secret" });
    expect(calls[3]!.argv).toEqual(["secret-tool", "clear", "service", "nookdeck-hass", "account", "me"]);
    expect(calls.some((c) => c.argv.includes("secret"))).toBe(false); // never on the command line
  });
  test("store failure is false, not a throw", async () => {
    const s = secretToolStore(async () => { throw new Error("no keyring"); });
    expect(await s.set("a", "b", "c")).toBe(false);
    expect(await s.get("a", "b")).toBeUndefined();
  });
});

describe("desktop entries", () => {
  const text = [
    "[Desktop Entry]", "Type=Application", "Name=Visual Studio Code", "Name[vi]=Mã", "Exec=/usr/share/code/code %F",
    "Icon=vscode", "Categories=TextEditor;Development;IDE;", "", "[Desktop Action new-window]", "Name=New Window", "Exec=code --new-window",
  ].join("\n");
  test("reads the main group only", () => {
    expect(parseDesktopEntry(text)).toEqual({ name: "Visual Studio Code", exec: "/usr/share/code/code %F", icon: "vscode", categories: ["TextEditor", "Development", "IDE"], terminal: false });
  });
  test("hidden, NoDisplay, non-apps and OnlyShowIn / NotShowIn", () => {
    expect(parseDesktopEntry("[Desktop Entry]\nType=Application\nName=X\nNoDisplay=true")).toBeNull();
    expect(parseDesktopEntry("[Desktop Entry]\nType=Link\nName=X")).toBeNull();
    expect(parseDesktopEntry("[Desktop Entry]\nType=Application\nName=X\nOnlyShowIn=KDE;", ["ubuntu", "GNOME"])).toBeNull();
    expect(parseDesktopEntry("[Desktop Entry]\nType=Application\nName=X\nOnlyShowIn=GNOME;", ["ubuntu", "GNOME"])).not.toBeNull();
    expect(parseDesktopEntry("[Desktop Entry]\nType=Application\nName=X\nNotShowIn=GNOME;", ["GNOME"])).toBeNull();
  });
  test("ids, categories, dirs", () => {
    expect(desktopFileId("kde/konsole.desktop")).toBe("kde-konsole.desktop");
    expect(linuxAppId("firefox_firefox.desktop")).toBe("firefox-firefox");
    expect(BUNDLE_ID_RE.test(linuxAppId("org.gnome.Nautilus.desktop")!)).toBe(true);
    expect(desktopCategory(["TextEditor", "Development"])).toBe("public.app-category.developer-tools");
    expect(desktopCategory(["GNOME", "GTK"])).toBeNull();
    expect(xdgDataDirs({}, "/home/u")).toEqual(["/home/u/.local/share", "/usr/local/share", "/usr/share", "/home/u/.local/share/flatpak/exports/share", "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"]);
    expect(xdgDataDirs({ XDG_DATA_DIRS: "/usr/share/:/var/lib/flatpak/exports/share:relative" }, "/h")).toEqual(["/h/.local/share", "/usr/share", "/var/lib/flatpak/exports/share", "/h/.local/share/flatpak/exports/share", "/var/lib/snapd/desktop"]);
  });
  test("icon candidates", () => {
    const c = iconCandidates("vscode", ["/usr/share"], "/h");
    expect(c[0]).toBe("/h/.icons/hicolor/128x128/apps/vscode.png");
    expect(c).toContain("/usr/share/icons/hicolor/scalable/apps/vscode.svg");
    expect(c.indexOf("/usr/share/icons/hicolor/256x256/apps/vscode.png")).toBeLessThan(c.indexOf("/usr/share/icons/hicolor/scalable/apps/vscode.svg"));
    expect(c.at(-1)).toBe("/usr/share/pixmaps/vscode.svg");
    expect(iconCandidates("/opt/app/icon.png", [], "/h")).toEqual(["/opt/app/icon.png"]);
    expect(iconCandidates("../../etc/passwd", ["/usr/share"], "/h")).toEqual([]);
  });
});

// ---------- PNG ----------

function rawPng(w: number, h: number, ctype: number, depth: number, rows: number[][], extra: Array<[string, number[]]> = []): Uint8Array {
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    return out; // the decoder does not check CRCs
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = depth; ihdr[9] = ctype;
  const raw = new Uint8Array(rows.flatMap((r) => [0, ...r]));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), ...extra.map(([t, b]) => chunk(t, new Uint8Array(b))), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

describe("png", () => {
  test("round trip RGBA", () => {
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
    const png = encodePng({ w: 2, h: 2, data });
    expect(isPng(png)).toBe(true);
    expect(decodePng(png)).toEqual({ w: 2, h: 2, data });
  });
  test("palette with tRNS, grey 1-bit, RGB 16-bit", () => {
    const pal = decodePng(rawPng(2, 1, 3, 8, [[0, 1]], [["PLTE", [255, 0, 0, 0, 0, 255]], ["tRNS", [255, 0]]]))!;
    expect([...pal.data]).toEqual([255, 0, 0, 255, 0, 0, 255, 0]);
    const g1 = decodePng(rawPng(3, 1, 0, 1, [[0b10100000]]))!;
    expect([...g1.data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const rgb16 = decodePng(rawPng(1, 1, 2, 16, [[0x12, 0x34, 0xab, 0xcd, 0xff, 0x00]]))!;
    expect([...rgb16.data]).toEqual([0x12, 0xab, 0xff, 255]);
  });
  test("filters (Sub, Up, Average, Paeth)", () => {
    // 2x2 grey 8-bit; row 0 Sub: 10, +5 -> 10, 15; row 1 Up: +1, +1 -> 11, 16
    const png = rawPng(2, 2, 0, 8, []);
    const ihdrEnd = 8 + 25;
    const raw = new Uint8Array([1, 10, 5, 2, 1, 1]);
    const body = new Uint8Array(deflateSync(raw));
    const idat = new Uint8Array(12 + body.length);
    new DataView(idat.buffer).setUint32(0, body.length);
    idat.set(new TextEncoder().encode("IDAT"), 4);
    idat.set(body, 8);
    const fixed = new Uint8Array([...png.slice(0, ihdrEnd), ...idat, ...png.slice(png.length - 12)]);
    const img = decodePng(fixed)!;
    expect([0, 4, 8, 12].map((i) => img.data[i])).toEqual([10, 15, 11, 16]);
  });
  test("shrink averages with alpha weighting and never enlarges", () => {
    const big = { w: 4, h: 4, data: new Uint8Array(64).fill(0) };
    for (let i = 0; i < 16; i++) if (i % 2 === 0) big.data.set([200, 100, 50, 255], i * 4);
    const s = shrinkRgba(big, 2);
    expect(s.w).toBe(2);
    expect([...s.data.slice(0, 4)]).toEqual([200, 100, 50, 128]); // transparent pixels do not darken the colour
    const small = encodePng({ w: 2, h: 2, data: new Uint8Array(16) });
    expect(shrinkPng(small, 128)).toBe(small);
    expect(decodePng(shrinkPng(encodePng(big), 2)!)!.w).toBe(2);
    expect(shrinkPng(new Uint8Array([1, 2, 3]), 10)).toBeNull();
  });
});

// ---------- apps ----------

describe("app catalog", () => {
  let root: string;
  const icon = encodePng({ w: 256, h: 256, data: new Uint8Array(256 * 256 * 4).fill(200) });
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "nd-apps-"));
    const user = join(root, "user"), sys = join(root, "sys");
    await mkdir(join(user, "applications"), { recursive: true });
    await mkdir(join(sys, "applications", "kde"), { recursive: true });
    await mkdir(join(sys, "icons", "hicolor", "256x256", "apps"), { recursive: true });
    await mkdir(join(sys, "icons", "hicolor", "scalable", "apps"), { recursive: true });
    await writeFile(join(sys, "icons", "hicolor", "256x256", "apps", "term.png"), icon);
    await writeFile(join(sys, "icons", "hicolor", "scalable", "apps", "vec.svg"), "<svg/>");
    await writeFile(join(sys, "applications", "org.example.Term.desktop"), "[Desktop Entry]\nType=Application\nName=Terminal\nIcon=term\nCategories=System;\n");
    await writeFile(join(sys, "applications", "kde", "vec.desktop"), "[Desktop Entry]\nType=Application\nName=Vector\nIcon=vec\n");
    await writeFile(join(sys, "applications", "hidden.desktop"), "[Desktop Entry]\nType=Application\nName=Hidden\n");
    // the user's copy hides the system one
    await writeFile(join(user, "applications", "hidden.desktop"), "[Desktop Entry]\nType=Application\nName=Hidden\nHidden=true\n");
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  const apps = (which = has(), runs: string[][] = []) => createLinuxApps({
    env: {}, home: join(root, "home"), which, dataDirs: [join(root, "user"), join(root, "sys")],
    run: async (argv) => { runs.push(argv); return ""; },
    runBytes: async (argv) => { runs.push(argv); return encodePng({ w: 1, h: 1, data: new Uint8Array(4) }); },
  });

  test("lists apps, user dirs first", async () => {
    const list = await apps().list();
    expect(list.map((a) => [a.name, a.bundleId, a.category]).sort()).toEqual([
      ["Terminal", "org.example.Term", "public.app-category.system"],
      ["Vector", "kde-vec", null],
    ]);
    expect(list).toHaveLength(2);
  });
  test("PNG icons are shrunk to 128 px; SVG needs rsvg-convert", async () => {
    const a = apps();
    const png = await a.icon("org.example.Term");
    expect(decodePng(png!)!.w).toBe(128);
    expect(await a.icon("kde-vec")).toBeNull();
    const runs: string[][] = [];
    expect(await apps(has("rsvg-convert"), runs).icon("kde-vec")).not.toBeNull();
    expect(runs[0]!.slice(0, 5)).toEqual(["rsvg-convert", "-w", "128", "-h", "128"]);
  });
  test("open with gio, else gtk-launch, else a clear error", async () => {
    const runs: string[][] = [];
    await apps(has("gio", "gtk-launch"), runs).open("org.example.Term");
    await apps(has("gtk-launch"), runs).open("kde-vec");
    expect(runs[0]).toEqual(["gio", "launch", join(root, "sys", "applications", "org.example.Term.desktop")]);
    expect(runs[1]).toEqual(["gtk-launch", "kde-vec"]);
    await expect(apps().open("org.example.Term")).rejects.toThrow("gio");
    await expect(apps(has("gio")).open("nope")).rejects.toThrow("unknown app");
  });
  test("resizeImage: PNG in TS, JPEG needs ImageMagick", async () => {
    expect(decodePng(await apps().resizeImage(icon, "png", 64))!.w).toBe(64);
    await expect(apps().resizeImage(new Uint8Array([0xff, 0xd8, 0xff, 0]), "jpg", 64)).rejects.toThrow("cannot read the image");
    const runs: string[][] = [];
    await apps(has("convert"), runs).resizeImage(new Uint8Array([0xff, 0xd8, 0xff, 0]), "jpg", 64);
    expect(runs[0]![0]).toBe("convert");
    expect(runs[0]!.slice(2)).toEqual(["-resize", "64x64>", "png:-"]);
  });
});

describe("artwork", () => {
  test("file:// paths only, local host", () => {
    expect(fileUrlPath("file:///home/u/.cache/art%20x.jpg")).toBe("/home/u/.cache/art x.jpg");
    expect(fileUrlPath("file://localhost/tmp/a.png")).toBe("/tmp/a.png");
    expect(fileUrlPath("file://other/tmp/a.png")).toBeNull();
    expect(fileUrlPath("https://x/a.png")).toBeNull();
    expect(imageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  });
  test("data URL from a file, http passes through, junk is undefined", async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(await linuxArtwork("file:///nonexistent-nd/a.jpg", async () => jpg)).toBe(`data:image/jpeg;base64,${Buffer.from(jpg).toString("base64")}`);
    expect(await linuxArtwork("https://i.scdn.co/image/x")).toBe("https://i.scdn.co/image/x");
    expect(await linuxArtwork("file:///nonexistent-nd/a.txt", async () => new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(await linuxArtwork("file:///nonexistent-nd/a.jpg", async () => { throw new Error("ENOENT"); })).toBeUndefined();
    const big = encodePng({ w: 600, h: 600, data: new Uint8Array(600 * 600 * 4).fill(9) });
    const url = (await linuxArtwork("file:///nonexistent-nd/a.png", async () => big))!;
    expect(decodePng(new Uint8Array(Buffer.from(url.split(",")[1]!, "base64")))!.w).toBe(300);
  });
});
