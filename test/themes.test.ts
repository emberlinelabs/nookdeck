import "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-theme-home-"));
const cfg = await import("../src/config");
const { validateLook, validateTheme, validateLayout, LOOK_KEYS } = cfg;
const { parseThemeManifest, parseManifest, resolveVariant } = await import("../src/plugins/manifest");
const { scopeThemeCss, ThemeCssError } = await import("../src/plugins/theme-css");
const { checkSvg } = await import("../src/plugins/themes");
const { ThemeStore, applyLook, buildThemePackage, extractLook } = await import("../src/plugins/themes");
const { PluginStore } = await import("../src/plugins/store");
const { startServer } = await import("../src/server");
const { BUILTIN_THEMES } = await import("../src/plugins/builtin-themes");
const { themeExport } = await import("../src/plugins/theme-cli");

const tmp = (p = "pd-th-") => mkdtempSync(join(tmpdir(), p));
const THEME = (over: Record<string, unknown> = {}) => ({
  type: "theme", id: "dev.t.glass", name: "Glass", version: "1.0.0", preview: "preview.png",
  theme: { tileOpacity: 0.6, tileBlur: 12, backgroundImage: "bg.png", backgroundDim: 0.3, font: "rounded", palette: { ok: "#10b981", error: "#ef4444" }, chartColors: ["#38bdf8", "#f472b6"], accent: "#88ccff", tile: "#223344", kinds: { button: { tile: "#112233", states: { pressed: { tile: "#445566" } } } } },
  variants: [
    { id: "night", name: "Night", mode: "dark", theme: { background: "#0a0f1a" } },
    { id: "day", name: "Day", mode: "light", theme: { background: "#f0f4ff", tile: "#ffffff", accent: "#2563eb" } },
  ],
  options: [{ id: "accent", name: "Accent", values: [
    { id: "pink", name: "Pink", theme: { accent: "#ff66aa" }, variants: { day: { accent: "#d6336c" } } },
    { id: "green", name: "Green", theme: { accent: "#22c55e" } },
  ] }],
  auto: { light: "day", dark: "night" },
  ...over,
});
function themeDir(over: Record<string, unknown> = {}, extra: Record<string, string | Uint8Array> = {}): string {
  const d = tmp("pd-thdir-");
  writeFileSync(join(d, "nookdeck.json"), JSON.stringify(THEME(over)));
  writeFileSync(join(d, "bg.png"), new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
  writeFileSync(join(d, "preview.png"), new Uint8Array([137, 80, 78, 71, 9]));
  for (const [n, c] of Object.entries(extra)) { mkdirSync(join(d, n, ".."), { recursive: true }); writeFileSync(join(d, n), c); }
  return d;
}

describe("validateLook / validateTheme", () => {
  test("accepts every new field and keeps only valid ones", () => {
    const l: any = validateLook({ font: "mono", numberFont: "condensed", backgroundImage: "theme:dev.a.b/bg.jpg", backgroundFit: "tile", backgroundDim: 0.9, backgroundBlur: 30, gradient: { from: "#000", to: "#fff", angle: 90 }, tileOpacity: 0.2, tileBlur: 30, border: { width: 3, color: "#fff" }, shadow: "strong", labelPosition: "top", labelWeight: "bold", iconStyle: "filled", palette: { ok: "#0f0", info: "#00f" }, chartColors: ["#111", "#222", "#333", "#444", "#555", "#666"] });
    expect(l.font).toBe("mono");
    expect(l.gradient).toEqual({ from: "#000", to: "#fff", angle: 90 });
    expect(l.palette).toEqual({ ok: "#0f0", info: "#00f" });
    expect(l.chartColors).toHaveLength(6);
  });
  test("rejects out of range values and bad shapes", () => {
    for (const bad of [{ font: "comic" }, { backgroundDim: 0.95 }, { backgroundBlur: 31 }, { tileOpacity: 0.04 }, { tileBlur: -1 }, { border: { width: 4 } }, { shadow: "huge" }, { labelPosition: "left" }, { labelWeight: "black" }, { iconStyle: "duo" }, { chartColors: ["#1", "#2", "#3", "#4", "#5", "#6", "#7"].map(() => "#111") .concat(["#222"]) }, { backgroundImage: "https://evil.test/x.png" }, { backgroundImage: "theme:dev.a.b/../x.png" }, { gradient: { from: "#000" } }, { palette: { ok: "url(x)" } }]) {
      expect(() => validateLook(bad as any)).toThrow();
    }
  });
  test("theme.source and the LOOK key list", () => {
    expect(validateTheme({ source: { pack: "dev.a.b@1.2.3", variant: "x", options: { a: "b" } } })?.source).toEqual({ pack: "dev.a.b@1.2.3", variant: "x", options: { a: "b" } });
    expect(() => validateTheme({ source: "dev.a.b@1.2.3" })).toThrow(/source/);
    expect(() => validateTheme({ source: { pack: "nope" } })).toThrow(/pack/);
    expect(LOOK_KEYS).toContain("muted" as any);
    for (const k of ["font", "palette", "chartColors", "tileBlur", "accent"]) expect(LOOK_KEYS).toContain(k as any);
    for (const k of ["language", "orientation", "header", "screen", "updateCheck", "temperatureUnit"]) expect(LOOK_KEYS).not.toContain(k as any);
  });
  test("page.theme is a validated partial look", () => {
    const l = validateLayout({ pages: [{ id: "a", name: "A", theme: { mode: "dark", tileOpacity: 0.5, language: "vi" }, items: [] }] });
    expect(l.pages[0]!.theme).toEqual({ mode: "dark", tileOpacity: 0.5 }); // behaviour fields are dropped
    expect(() => validateLayout({ pages: [{ id: "a", name: "A", theme: { shadow: "x" }, items: [] }] })).toThrow(/pages\[0\]\.theme/);
  });
});

describe("theme manifest (a pack of variants)", () => {
  test("a valid pack: variants inherit the base, a package file in backgroundImage becomes theme:<id>/<file>", () => {
    const m = parseThemeManifest(THEME());
    expect(m.variants.map((v) => v.id)).toEqual(["night", "day"]);
    expect(m.base.backgroundImage).toBe("theme:dev.t.glass/bg.png");
    expect(m.preview).toBe("preview.png");
    const day: any = resolveVariant(m, "day");
    expect(day).toMatchObject({ background: "#f0f4ff", tile: "#ffffff", accent: "#2563eb", tileOpacity: 0.6, font: "rounded" }); // variant over base, base kept
    expect(day.kinds.button.states.pressed.tile).toBe("#445566");
  });
  test("a manifest with only a theme is one variant", () => {
    const m = parseThemeManifest({ type: "theme", id: "dev.t.one", name: "One", version: "1.0.0", theme: { mode: "light", accent: "#111111" } });
    expect(m.variants).toHaveLength(1);
    expect(m.variants[0]).toMatchObject({ id: "default", mode: "light" });
  });
  test("options patch look fields, with a per-variant patch over the fallback", () => {
    const m = parseThemeManifest(THEME());
    expect((resolveVariant(m, "night", { accent: "pink" }) as any).accent).toBe("#ff66aa");
    expect((resolveVariant(m, "day", { accent: "pink" }) as any).accent).toBe("#d6336c");
    expect((resolveVariant(m, "day", { accent: "green" }) as any).accent).toBe("#22c55e");
    expect(() => resolveVariant(m, "nope")).toThrow(/no variant/);
    expect(() => resolveVariant(m, "day", { size: "x" })).toThrow(/no option/);
    expect(() => resolveVariant(m, "day", { accent: "teal" })).toThrow(/no value/);
  });
  test("limits and invalid ids", () => {
    expect(() => parseThemeManifest(THEME({ variants: [] }))).toThrow(/1 to 12/);
    expect(() => parseThemeManifest(THEME({ variants: Array.from({ length: 13 }, (_, i) => ({ id: `v${i}`, name: "v", mode: "dark" })) }))).toThrow(/1 to 12/);
    expect(() => parseThemeManifest(THEME({ variants: [{ id: "a", name: "A", mode: "dark" }, { id: "a", name: "B", mode: "dark" }] }))).toThrow(/used twice/);
    expect(() => parseThemeManifest(THEME({ variants: [{ id: "a", name: "A", mode: "blue" }] }))).toThrow(/mode/);
    expect(() => parseThemeManifest(THEME({ auto: { light: "day", dark: "zzz" } }))).toThrow(/auto/);
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, name: "o", values: [{ id: "x", name: "x", theme: {} }] }));
    expect(() => parseThemeManifest(THEME({ options: five }))).toThrow(/up to 4/);
    const many = [{ id: "o", name: "o", values: Array.from({ length: 17 }, (_, i) => ({ id: `v${i}`, name: "v", theme: {} })) }];
    expect(() => parseThemeManifest(THEME({ options: many }))).toThrow(/1 to 16/);
    expect(() => parseThemeManifest(THEME({ options: [{ id: "o", name: "o", values: [{ id: "x", name: "x", theme: { kinds: { button: { tile: "#111" } } } }] }] }))).toThrow(/only patch look fields/);
    expect(() => parseThemeManifest(THEME({ options: [{ id: "o", name: "o", values: [{ id: "x", name: "x", variants: { ghost: { accent: "#111" } } }] }] }))).toThrow(/no variant "ghost"/);
  });
  test("rejects code, permissions and plugin parts", () => {
    for (const k of ["main", "permissions", "widgets", "actions", "settings"]) {
      expect(() => parseThemeManifest(THEME({ [k]: k === "main" ? "index.js" : k === "permissions" ? { network: ["x.y"] } : [{ id: "a" }] }))).toThrow(/cannot have/);
    }
    expect(() => parseThemeManifest(THEME({ type: "plugin" }))).toThrow();
  });
  test("a plugin install refuses a theme and the reverse", () => {
    expect(() => parseManifest(THEME() as any)).toThrow(/theme package/);
    expect(() => parseManifest({ id: "dev.a.b", name: "A", version: "1.0.0", type: "weird" } as any)).toThrow(/type must be/);
  });
});

const mkStore = (builtin: any[] = []) => { const d = tmp(); const ps = new PluginStore({ dir: join(d, "p"), stateFile: join(d, "p.json") }); return { d, store: new ThemeStore({ dir: join(d, "themes"), stateFile: join(d, "themes.json"), resolve: (s) => ps.resolveSource(s), builtin }) }; };

describe("ThemeStore", () => {
  test("installs from a folder, serves files with a path guard, removes", async () => {
    const { store } = mkStore();
    await store.load();
    const r = await store.install(themeDir());
    expect(r.theme).toMatchObject({ id: "dev.t.glass", version: "1.0.0", reviewed: false, builtin: false, preview: "/api/themes/dev.t.glass/files/preview.png", auto: { light: "day", dark: "night" } });
    expect(r.theme.variants.map((v) => v.id)).toEqual(["night", "day"]);
    expect(r.theme.options[0]).toMatchObject({ id: "accent", values: [{ id: "pink" }, { id: "green" }] });
    expect(await store.file("dev.t.glass", "bg.png")).not.toBeNull();
    for (const bad of ["../themes.json", "../../x", "/etc/passwd", "a/../bg.png", "nookdeck.json", "x.exe", ""]) expect(await store.file("dev.t.glass", bad)).toBeNull();
    expect((await store.install(themeDir())).unchanged).toBe(true);
    await store.remove("dev.t.glass");
    expect(store.list()).toHaveLength(0);
  });
  test("a registry pin must match", async () => {
    const { store } = mkStore();
    await store.load();
    await expect(store.install(themeDir(), { sha256: "0".repeat(64), version: "1.0.0" })).rejects.toThrow(/do not match/);
    expect(store.list()).toHaveLength(0);
  });
  test("a missing background or preview is refused; a bad file type too", async () => {
    const { store } = mkStore();
    await store.load();
    const d = themeDir(); writeFileSync(join(d, "run.sh"), "x");
    await expect(store.install(d)).rejects.toThrow(/not an allowed theme file/);
    const d2 = tmp(); writeFileSync(join(d2, "nookdeck.json"), JSON.stringify(THEME()));
    await expect(store.install(d2)).rejects.toThrow(/not in the package/);
  });
  test("fonts: at most 4 files, 400 KB each, only woff/woff2, and declared files must exist", async () => {
    const { store } = mkStore();
    await store.load();
    const f = (n: string) => ({ family: `F${n}`, file: `fonts/f${n}.woff2` });
    const ok = themeDir({ theme: { fonts: [f("1")] } }, { "fonts/f1.woff2": new Uint8Array(100) });
    expect((await store.install(ok)).theme.fonts).toEqual(["F1"]);
    await store.remove("dev.t.glass");
    await expect(store.install(themeDir({ theme: { fonts: [f("1")] } }, { "fonts/f1.woff2": new Uint8Array(400 * 1024 + 1) }))).rejects.toThrow(/400 KB/);
    await expect(store.install(themeDir({}, { "fonts/a.woff2": "x", "fonts/b.woff2": "x", "fonts/c.woff2": "x", "fonts/d.woff2": "x", "fonts/e.woff2": "x" }))).rejects.toThrow(/at most 4 font/);
    await expect(store.install(themeDir({}, { "fonts/a.ttf": "x" }))).rejects.toThrow(/not an allowed|woff/);
    await expect(store.install(themeDir({ theme: { fonts: [f("9")] } }))).rejects.toThrow(/font file/);
  });
  test("icons are checked: a script, foreignObject or external href is refused", async () => {
    const { store } = mkStore();
    await store.load();
    const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
    const good = themeDir({}, { "icons/home.svg": svg('<path d="M3 12l9-9 9 9"/>') });
    expect((await store.install(good)).theme.icons).toEqual(["home"]);
    await store.remove("dev.t.glass");
    for (const bad of ["<script>alert(1)</script>", '<foreignObject><div/></foreignObject>', '<image href="https://evil.test/x.png"/>', '<path onclick="x()" d="M0 0"/>', '<use xlink:href="https://evil.test/a.svg#x"/>', '<rect style="fill:url(https://evil.test/x)"/>']) {
      await expect(store.install(themeDir({}, { "icons/home.svg": svg(bad) }))).rejects.toThrow(/icons\/home\.svg/);
    }
    expect(() => checkSvg("a.svg", svg('<use href="#x"/>'))).not.toThrow();
  });
  test("a built-in pack is listed, served, and cannot be removed or replaced", async () => {
    const files = new Map([["nookdeck.json", new TextEncoder().encode(JSON.stringify({ type: "theme", id: "dev.t.builtin", name: "B", version: "1.0.0", variants: [{ id: "a", name: "A", mode: "dark", theme: {} }] }))]]);
    const { store } = mkStore([files]);
    await store.load();
    expect(store.list()[0]).toMatchObject({ id: "dev.t.builtin", builtin: true });
    await expect(store.remove("dev.t.builtin")).rejects.toThrow(/cannot be removed/);
  });
});

describe("package files and versions", () => {
  test("license files are accepted and served as text; a missing preview is not an error", async () => {
    const { store } = mkStore();
    await store.load();
    const d = themeDir({ preview: "nope.png", variants: [{ id: "night", name: "A", mode: "dark", preview: "gone.png" }, { id: "day", name: "D", mode: "light" }] }, { LICENSE: "MIT", "LICENSE.md": "x", "LICENSE-APACHE": "x", NOTICE: "n", COPYING: "c" });
    const r = await store.install(d);
    expect(r.theme.preview).toBeUndefined();
    expect(r.theme.variants[0]!.preview).toBeUndefined();
    for (const f of ["LICENSE", "LICENSE.md", "LICENSE-APACHE", "NOTICE", "COPYING"]) expect(await store.file("dev.t.glass", f)).not.toBeNull();
  });
  test("a dev or dirty build satisfies a minimum version", async () => {
    const { versionAtLeast } = await import("../src/plugins/manifest");
    expect(versionAtLeast("0.3.1", ">=0.4.0")).toBe(false);
    expect(versionAtLeast("0.3.1-dirty", ">=0.4.0")).toBe(true);
    expect(versionAtLeast("0.0.0-dev", ">=0.4.0")).toBe(true);
  });
  test("option values carry their patches in the summary", async () => {
    const { store } = mkStore();
    await store.load();
    const r = await store.install(themeDir());
    expect(r.theme.options[0]!.values[0]).toMatchObject({ id: "pink", theme: { accent: "#ff66aa" }, variants: { day: { accent: "#d6336c" } } });
  });
});

describe("theme registry (themes.json)", () => {
  test("derives the address, keeps good rows, tolerates a missing file", async () => {
    const { ThemeRegistry, parseThemeRegistry } = await import("../src/plugins/theme-registry");
    const row = { id: "dev.a.b", name: "B", version: "1.0.0", repo: "https://github.com/x/y/tree/abc/themes/b", sha256: "a".repeat(64), license: "MIT", credit: "c", variants: [{ id: "d", name: "D", mode: "dark", preview: "https://x/p.png" }, { id: "bad", name: "x", mode: "red" }] };
    expect(parseThemeRegistry([row, { id: "nope" }])).toHaveLength(1);
    expect(parseThemeRegistry([row])[0]!.variants).toHaveLength(1);
    const ok = new ThemeRegistry("https://raw.example/x/plugins.json", (async (u: string) => { expect(u).toBe("https://raw.example/x/themes.json"); return new Response(JSON.stringify([row])); }) as any);
    expect((await ok.get()).themes[0]!.id).toBe("dev.a.b");
    const none = new ThemeRegistry("https://raw.example/x/plugins.json", (async () => new Response("", { status: 404 })) as any);
    expect((await none.get()).themes).toEqual([]);
  });
});

describe("deck theming hooks", () => {
  test(".pd-root stays position: fixed with full size, and no theme code sets position or height on it", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(join(import.meta.dir, "../web/deck/src/deck.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let pos = "";
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = m[1]!.split(",").map((x) => x.trim());
      if (!sels.includes(".pd-root")) continue;
      const p = /(?:^|;)\s*position\s*:\s*([a-z-]+)/.exec(m[2]!);
      if (p) pos = p[1]!;
      const h = /(?:^|;)\s*(height|min-height)\s*:\s*([^;]+)/.exec(m[2]!);
      if (h) expect(h[2]).not.toMatch(/^(0|auto)/);
    }
    expect(pos).toBe("fixed"); // the last rule that sets position on .pd-root alone
    const theme = readFileSync(join(import.meta.dir, "../web/deck/src/theme.ts"), "utf8");
    expect(theme).not.toMatch(/style\.(position|height|minHeight|top|bottom)\b/);
    expect(theme).not.toMatch(/setProperty\(\s*['"](position|height|min-height|top|bottom)['"]/);
  });
  test("every documented hook and variable exists in the deck source", async () => {
    const { readFileSync } = await import("node:fs");
    const src = ["Deck.tsx", "theme.ts"].map((f) => readFileSync(join(import.meta.dir, "../web/deck/src", f), "utf8")).join("\n");
    for (const h of ['data-part="tile"', 'data-part="header"', 'data-part="page-dots"', 'data-part="sheet"', "data-kind=", "data-size=", "data-theme-pkg", "data-theme-variant"]) expect(src).toContain(h);
    for (const v of ["accent", "bg", "tile-bg", "tile-opacity", "text", "muted", "radius", "gap", "font", "number-font", "border-width", "border-color", "shadow", "tile-blur", "ok", "warn", "error", "info", "chart-1", "chart-6"]) expect(src).toContain(`--nd-${v}`);
    expect(src).toContain("theme=off");
    const all = ["Deck.tsx", "widgets.tsx", "plugin.tsx", "entity.tsx", "charts.tsx", "metric-charts.tsx", "screen.tsx", "icon.tsx", "clocks.tsx"].map((f) => readFileSync(join(import.meta.dir, "../web/deck/src", f), "utf8")).join("\n");
    for (const part of ["tile-icon", "tile-label", "tile-value", "tile-sub", "chart", "gauge", "button", "standby", "background", "clock-digit", "clock-card"]) expect(all).toContain(`data-part="${part}"`);
    expect(all).toContain("data-state={dstate}");
    // a pack always gets the background layer and a transparent panel and sheet over it
    const css = readFileSync(join(import.meta.dir, "../web/deck/src/deck.css"), "utf8");
    // every clock style's digits take the theme's numberFont (font as the fallback) without extra css
    const num = /([^{}]+)\{ font-family: var\(--pd-ff-num, var\(--pd-ff, inherit\)\); \}/.exec(css)![1]!;
    for (const sel of [".pd-clock__t", ".pd-clk__min", ".pd-fl__h span", "[data-part='clock-digit'] span", ".pd-wd__t", ".pd-sb__time"]) expect(num).toContain(sel);
    expect(css).toMatch(/\.pd-root\[data-theme-pkg\] \.pd-bgimg \{ display: block/);
    expect(css).toMatch(/\.pd-root\[data-theme-pkg\] \.pd-sheet, \.pd-root\[data-theme-pkg\] \.pd-panel \{ background: transparent/);
    // every hook the docs table lists exists in the source
    const docs = readFileSync(join(import.meta.dir, "../docs/themes.md"), "utf8");
    const row = /\| `data-part` \| ([^\n]+) \|/.exec(docs)![1]!;
    for (const m of row.matchAll(/`([a-z-]+)`/g)) expect(all + css).toContain(`data-part="${m[1]}"`);
  });
});

describe("apply resolution", () => {
  const apply = async (req: any, current?: any) => { const { store } = mkStore(); await store.load(); await store.install(themeDir()); return store.resolveApply("dev.t.glass", req, current); };
  test("a variant, with options", async () => {
    const r: any = await apply({ variant: "day", options: { accent: "pink" } });
    expect(r.source).toEqual({ pack: "dev.t.glass@1.0.0", variant: "day", options: { accent: "pink" } });
    expect(r.look).toMatchObject({ accent: "#d6336c", mode: "light", background: "#f0f4ff" });
  });
  test("auto: the dark look is the base, the pair is kept, mode is auto", async () => {
    const r: any = await apply({ auto: { light: "day", dark: "night" } });
    expect(r.source.auto).toEqual({ light: "day", dark: "night" });
    expect(r.look.mode).toBe("auto");
    expect(r.auto.light.mode).toBe("light");
    expect(r.auto.dark.mode).toBe("dark");
    expect(r.look.background).toBe("#0a0f1a");
  });
  test("an empty request re-applies the current source, or picks the first variant", async () => {
    const cur = { pack: "dev.t.glass@0.9.0", variant: "day", options: { accent: "green" } };
    const r: any = await apply({}, cur);
    expect(r.source).toEqual({ pack: "dev.t.glass@1.0.0", variant: "day", options: { accent: "green" } }); // re-resolved at the new version
    expect(r.look.accent).toBe("#22c55e");
    expect(((await apply({})) as any).source.variant).toBe("night");
    const a: any = await apply({}, { pack: "dev.t.glass@0.9.0", auto: { light: "day", dark: "night" } });
    expect(a.auto).toBeDefined();
    expect(((await apply({}, { pack: "dev.other.x@1.0.0", variant: "day" })) as any).source.variant).toBe("night"); // another pack's source is not reused
  });
  test("unknown variant, option or value ids are refused", async () => {
    await expect(apply({ variant: "x" })).rejects.toThrow(/no variant/);
    await expect(apply({ variant: "day", options: { zzz: "a" } })).rejects.toThrow(/no option/);
    await expect(apply({ variant: "day", options: { accent: "zzz" } })).rejects.toThrow(/no value/);
    await expect(apply({ auto: { light: "day", dark: "x" } })).rejects.toThrow(/no variant/);
    await expect(apply({ auto: { light: "day" } })).rejects.toThrow(/light, dark/);
  });
});

describe("applyLook / package export", () => {
  test("apply replaces look fields, keeps behaviour fields, records the source", () => {
    const cur: any = { accent: "#111111", radius: 30, tileStyle: "solid", language: "vi", header: "minimal", orientation: "portrait", temperatureUnit: "f", screen: { lite: "on" }, kinds: { button: { tile: "#000000" } } };
    const n: any = applyLook(cur, { accent: "#88ccff", font: "mono" }, { pack: "dev.t.glass@1.0.0", variant: "night" });
    expect(n).toMatchObject({ accent: "#88ccff", font: "mono", language: "vi", header: "minimal", orientation: "portrait", temperatureUnit: "f", source: { pack: "dev.t.glass@1.0.0", variant: "night" } });
    expect(n.radius).toBeUndefined();
    expect(n.kinds).toBeUndefined(); // the old pack's per-kind tokens do not linger
    expect(n.screen).toEqual({ lite: "on" });
  });
  test("export builds a one-variant pack that installs back to the same look", async () => {
    const look = { accent: "#abcdef", tileOpacity: 0.7, palette: { ok: "#0f0" }, font: "serif", muted: "#888888", kinds: { clock: { numberFont: "mono" } } };
    const files = buildThemePackage({ ...look, language: "vi", source: { pack: "x.y@1.0.0", variant: "a" } } as any, { id: "dev.me.mine", name: "Mine" }, { preview: new Uint8Array([1, 2, 3]) });
    const man = JSON.parse(new TextDecoder().decode(files.get("nookdeck.json")!));
    expect(man.type).toBe("theme");
    expect(man.theme.language).toBeUndefined();
    expect(man.theme.source).toBeUndefined();
    expect(man.preview).toBe("preview.png");
    const d = tmp(); for (const [n, b] of files) writeFileSync(join(d, n), b);
    const { store } = mkStore();
    await store.load();
    const r = await store.install(d);
    expect(r.theme.variants).toHaveLength(1);
    expect(r.theme.variants[0]!.look).toEqual(look);
    const ap = store.resolveApply("dev.me.mine", {});
    expect(extractLook(applyLook(undefined, ap.look, ap.source))).toMatchObject(look);
  });
});

describe("theme css", () => {
  const files = new Set(["bg.png", "fonts/a.woff2"]);
  const scope = (css: string, variant?: string) => scopeThemeCss(css, { id: "dev.t.glass", variant, files });
  test("scopes every selector under the pack (and the variant), rewrites package urls", () => {
    const out = scope(`.a, [data-part="tile"] > b { background: url("bg.png"); }\n@media (max-width: 600px) { [data-kind=clock] { color: red } }\n:root { --x: 1 }\n@keyframes spin { from { opacity: 0 } to { opacity: 1 } }\n@font-face { font-family: "F"; src: url(fonts/a.woff2) format("woff2"); }`, "night");
    const sc = '.pd-root[data-theme-pkg="dev.t.glass"][data-theme-variant="night"]';
    expect(out).toContain(`${sc} .a, ${sc} [data-part="tile"] > b`);
    expect(out).toContain(`${sc} [data-kind=clock]`);
    expect(out).toContain(`${sc} { --x: 1 }`);
    expect(out).toContain('url("/api/themes/dev.t.glass/files/bg.png")');
    expect(out).toContain('url("/api/themes/dev.t.glass/files/fonts/a.woff2")');
    expect(out).toContain("from { opacity: 0 }"); // keyframe steps are not scoped
    expect(scope(".a{color:red}")).toContain('.pd-root[data-theme-pkg="dev.t.glass"] .a');
  });
  test("rejects @import, @namespace, @charset and other at-rules", () => {
    for (const bad of ['@import "x.css";', '@import url(https://evil.test/x.css);', '@namespace svg url(http://x);', '@charset "utf-8";', '@page { margin: 0 }', '@property --x { syntax: "*"; inherits: false }']) expect(() => scope(bad)).toThrow(ThemeCssError);
  });
  test("rejects external and unknown urls", () => {
    for (const bad of ['a { background: url(https://evil.test/x.png) }', 'a { background: url("//evil.test/x") }', 'a { background: url(/etc/passwd) }', 'a { background: url(data:image/png;base64,AAAA) }', 'a { background: url(../secret.png) }', 'a { background: url(missing.png) }', 'a { background: image-set("bg.png" 1x) }', '@font-face { src: local(Arial) }']) expect(() => scope(bad)).toThrow(ThemeCssError);
  });
  test("rejects attribute exfiltration patterns", () => {
    for (const bad of ['input[value^="a"] { background: red }', '[data-secret] { color: red }', '[data-token*="x"] { color: red }', 'a[href^="https://x"] { color: red }', '[\\76alue] { color: red }']) expect(() => scope(bad)).toThrow(ThemeCssError);
    expect(() => scope('[data-part="tile"][data-state^="o"] { color: red }')).not.toThrow(); // the documented hooks are fine
  });
  test("rejects position: fixed, a high z-index, expression/behavior and html/body", () => {
    for (const bad of ['a { position: fixed }', 'a { z-index: 9999 }', 'a { z-index: 101 }', 'a { width: expression(alert(1)) }', 'a { behavior: url(x.htc) }', 'a { -moz-binding: url(x) }', 'body { color: red }', 'html a { color: red }']) expect(() => scope(bad)).toThrow(ThemeCssError);
    expect(() => scope('a { position: absolute; z-index: 5 }')).not.toThrow();
  });
  test("the pack's own root attributes are not a descendant of the scope", () => {
    const sc = '.pd-root[data-theme-pkg="dev.t.glass"]';
    expect(scope('[data-theme-variant="neon"] .a { color: red }')).toContain(`${sc}[data-theme-variant="neon"] .a`);
    expect(scope('[data-theme-variant="neon"] .a { color: red }')).not.toContain(`${sc} [data-theme-variant`);
    expect(scope('[data-theme-variant="neon"][data-theme-pkg="x"] { color: red }')).toContain(`${sc}[data-theme-variant="neon"][data-theme-pkg="x"] {`);
    expect(scope('[data-theme-variant="neon"] { color: red }', "neon")).toContain(`${sc}[data-theme-variant="neon"][data-theme-variant="neon"]`);
  });
  test("a comment before a node does not skip it", () => {
    expect(scope("/* c */ .a{color:red}")).toContain('[data-theme-pkg="dev.t.glass"] .a');
    expect(scope("/* c */ :root::after{content:'x'}")).toContain('[data-theme-pkg="dev.t.glass"]::after');
    for (const bad of ["/* c */ body{color:red}", "/* c */ @import 'x';", "/* c */ a{/* c */ position:fixed}", "a{color:red; /* c */ z-index:9999}", "a{/* c */ background:url(https://evil.test/x)}", "/* c */ @media x { /* c */ body{color:red} }"]) expect(() => scope(bad)).toThrow(ThemeCssError);
  });
  test("size limit and invalid css", () => {
    expect(() => scope("a{color:red}\n" + "/*" + "x".repeat(64 * 1024) + "*/")).toThrow(/64 KB/);
    expect(() => scope("a { color: red")).toThrow(ThemeCssError);
  });
  test("a pack with a bad css file is refused at install, a good one is served scoped", async () => {
    const { store } = mkStore();
    await store.load();
    await expect(store.install(themeDir({ css: "theme.css" }, { "theme.css": "@import 'x';" }))).rejects.toThrow(/theme\.css/);
    await store.install(themeDir({ css: "theme.css", variants: [{ id: "night", name: "N", mode: "dark", css: "night.css" }, { id: "day", name: "D", mode: "light" }] }, { "theme.css": ".a{color:red}", "night.css": ".b{color:blue}" }));
    const night = await store.css("dev.t.glass", "night");
    expect(night).toContain('[data-theme-pkg="dev.t.glass"] .a');
    expect(night).toContain('[data-theme-variant="night"] .b');
    expect(await store.css("dev.t.glass", "day")).not.toContain(".b");
    await expect(store.css("dev.t.glass", "zzz")).rejects.toThrow(/no variant/);
  });
});

describe("theme endpoints", () => {
  let app: any, base = "", original: any;
  const H = { "x-nookdeck": "1", "content-type": "application/json" };
  const api = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { ...H, ...(init.headers as any) } });
  const d = tmp();
  beforeAll(async () => {
    const ps = new PluginStore({ dir: join(d, "p"), stateFile: join(d, "p.json") });
    const themes = new ThemeStore({ dir: join(d, "t"), stateFile: join(d, "t.json"), resolve: (s) => ps.resolveSource(s), builtin: BUILTIN_THEMES });
    app = await startServer({
      port: 0, pin: "123456", hostName: async () => "my-mac", themes, plugins: ps,
      webhookKeyFile: join(process.env.NOOKDECK_HOME!, "webhook-key"), layoutHistoryDir: mkdtempSync(join(tmpdir(), "pd-th-hist-")),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null },
      aiSources: { claude: async () => ({ id: "claude", name: "c", windows: [], updatedAt: 1 }), codex: async () => ({ id: "codex", name: "c", windows: [], updatedAt: 1 }), antigravity: async () => ({ id: "antigravity", name: "c", windows: [], updatedAt: 1 }), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
    original = await (await api("/api/layout")).json(); // these tests save layouts (one with language "vi") into the shared test home
  });
  afterAll(async () => {
    // put the layout back and reset the agent language, or the next file that starts a server inherits "vi"
    if (original) await api("/api/layout", { method: "PUT", body: JSON.stringify(original) });
    app?.stop();
    (await import("../src/i18n")).setLanguage(undefined);
  });

  test("install, list, apply keeps behaviour and per-tile colours, undo restores", async () => {
    const lay: any = { pages: [{ id: "p", name: "P", items: [{ id: "b", kind: "button", label: "Go", color: "#ff0000" }] }], theme: { language: "vi", header: "minimal", accent: "#111111", radius: 33 } };
    expect((await api("/api/layout", { method: "PUT", body: JSON.stringify(lay) })).status).toBe(200);
    const inst = await api("/api/themes/install", { method: "POST", body: JSON.stringify({ source: themeDir() }) });
    expect(inst.status).toBe(201);
    const list: any = await (await api("/api/themes")).json();
    const mine = list.themes.find((t: any) => t.id === "dev.t.glass");
    expect(mine).toMatchObject({ applied: false, builtin: false });
    const ap: any = await (await api("/api/themes/dev.t.glass/apply", { method: "POST", body: JSON.stringify({ variant: "night", options: { accent: "pink" } }) })).json();
    expect(ap.ok).toBe(true);
    expect(ap.previous).toMatchObject({ accent: "#111111", radius: 33, language: "vi" });
    const now: any = await (await api("/api/layout")).json();
    expect(now.theme).toMatchObject({ accent: "#ff66aa", language: "vi", header: "minimal", source: { pack: "dev.t.glass@1.0.0", variant: "night", options: { accent: "pink" } }, backgroundImage: "theme:dev.t.glass/bg.png", mode: "dark" });
    expect(now.theme.kinds.button.tile).toBe("#112233");
    expect(now.theme.radius).toBeUndefined();
    expect(now.pages[0].items[0].color).toBe("#ff0000"); // per-tile colour kept
    expect(((await (await api("/api/themes")).json()) as any).themes.find((t: any) => t.id === "dev.t.glass").applied).toBe(true);
    // undo through the history, and through `previous`
    expect((await api("/api/layout/undo", { method: "POST" })).status).toBe(200);
    expect(((await (await api("/api/layout")).json()) as any).theme.accent).toBe("#111111");
    const put = { ...now, theme: ap.previous };
    expect((await api("/api/layout", { method: "PUT", body: JSON.stringify(put) })).status).toBe(200);
    expect(((await (await api("/api/layout")).json()) as any).theme.radius).toBe(33);
  });
  test("auto apply stores both looks; bad ids give 400; the css route serves the scoped sheet; built-in cannot be deleted", async () => {
    const auto: any = await (await api("/api/themes/dev.t.glass/apply", { method: "POST", body: JSON.stringify({ auto: { light: "day", dark: "night" } }) })).json();
    expect(auto.theme).toMatchObject({ mode: "auto", source: { auto: { light: "day", dark: "night" } } });
    expect(auto.theme.auto.light.background).toBe("#f0f4ff");
    expect((await api("/api/themes/dev.t.glass/apply", { method: "POST", body: JSON.stringify({ variant: "zzz" }) })).status).toBe(400);
    const css = await fetch(`${base}/api/themes/dev.t.glass/css?variant=night`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const list: any = await (await api("/api/themes")).json();
    expect(list.themes.some((t: any) => t.builtin)).toBe(true);
    const b = list.themes.find((t: any) => t.builtin);
    expect((await api(`/api/themes/${b.id}`, { method: "DELETE" })).status).toBe(409);
  });
  test("fork: a local one-variant copy with the look and its files", async () => {
    const r = await api("/api/themes/dev.t.glass/fork", { method: "POST", body: JSON.stringify({ name: "My Glass", variant: "day", options: { accent: "pink" } }) });
    expect(r.status).toBe(201);
    const s: any = await r.json();
    expect(s.id).toMatch(/^local\.fork\.my-glass-/);
    expect(s.variants).toHaveLength(1);
    expect(s.variants[0].look).toMatchObject({ accent: "#d6336c", background: "#f0f4ff", mode: "light" });
  });
  test("fork copies the css and the files it names; icon packs reach the deck as pack: assets", async () => {
    const d2 = themeDir({ id: "dev.t.sty", css: "theme.css", theme: {} }, { "theme.css": '.a{background:url("bg.png")}', "icons/home.svg": '<svg viewBox="0 0 10 10"><path d="M0 0h10"/></svg>' });
    expect((await api("/api/themes/install", { method: "POST", body: JSON.stringify({ source: d2 }) })).status).toBe(201);
    const f: any = await (await api("/api/themes/dev.t.sty/fork", { method: "POST", body: JSON.stringify({ name: "Sty" }) })).json();
    expect(f.hasCss).toBe(true);
    const css = await (await fetch(`${base}/api/themes/${f.id}/css`)).text();
    expect(css).toContain(`/api/themes/${f.id}/files/bg.png`);
    await api("/api/themes/dev.t.sty/apply", { method: "POST", body: JSON.stringify({ variant: "night" }) });
    const assets: any = await (await api("/api/layout/assets", { method: "POST", body: JSON.stringify({ layout: { ...(await (await api("/api/layout")).json()), theme: { source: { pack: "dev.t.sty@1.0.0", variant: "night" } } } }) })).json();
    expect(JSON.stringify(assets)).toContain("pack:home");
  });
  test("files: served with safe headers, path guard holds", async () => {
    const ok = await fetch(`${base}/api/themes/dev.t.glass/files/bg.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/api/themes/dev.t.glass/files/..%2Fthemes.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/themes/dev.t.glass/files/nookdeck.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/themes/nope.x/files/bg.png`)).status).toBe(404);
  });
  test("export returns a zip with the manifest; a bad id is refused", async () => {
    const r = await api("/api/themes/export", { method: "POST", body: JSON.stringify({ id: "dev.me.out", name: "Out" }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await api("/api/themes/export", { method: "POST", body: JSON.stringify({ id: "bad" }) })).status).toBe(400);
  });
  test("a theme with code is refused over the API, and delete works", async () => {
    const bad = themeDir({ main: "index.js" });
    const r = await api("/api/themes/install", { method: "POST", body: JSON.stringify({ source: bad }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/cannot have/);
    expect((await api("/api/themes/dev.t.glass", { method: "DELETE" })).status).toBe(200);
    expect((await api("/api/themes/dev.t.glass", { method: "DELETE" })).status).toBe(404);
  });
});

describe("nookdeck theme export <dir>", () => {
  test("writes a folder package from the layout file", async () => {
    const out = join(tmp(), "pkg");
    mkdirSync(out, { recursive: true });
    await themeExport([out, "--id", "dev.me.cli", "--name", "CLI"], 1, () => {}); // no agent on port 1: reads the layout file (defaults)
    const man = JSON.parse(readFileSync(join(out, "nookdeck.json"), "utf8"));
    expect(man).toMatchObject({ type: "theme", id: "dev.me.cli", name: "CLI" });
  });
});
