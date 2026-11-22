import "./_fetch";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-mode-home-"));
const { ThemeStore, luminance, modeMismatch } = await import("../src/plugins/themes");
const { PluginStore } = await import("../src/plugins/store");
const { parseThemeManifest } = await import("../src/plugins/manifest");

const tmp = () => mkdtempSync(join(tmpdir(), "pd-mode-"));
const pack = (id: string, variants: unknown[], extra: Record<string, unknown> = {}) =>
  new Map([["nookdeck.json", new TextEncoder().encode(JSON.stringify({ type: "theme", id, name: id, version: "1.0.0", variants, ...extra }))]]);
const store = () => { const d = tmp(); const ps = new PluginStore({ dir: join(d, "p"), stateFile: join(d, "p.json") }); return new ThemeStore({ dir: join(d, "t"), stateFile: join(d, "t.json"), resolve: (s) => ps.resolveSource(s) }); };
const src = (f: string) => readFileSync(join(import.meta.dir, "..", f), "utf8");

describe("light and dark are part of every variant", () => {
  test("mode is required on every variant", () => {
    expect(() => parseThemeManifest({ type: "theme", id: "dev.a.b", name: "x", version: "1.0.0", variants: [{ id: "a", name: "A", theme: { background: "#000000" } }] })).toThrow(/mode/);
  });
  test("applying a variant sets layout theme mode to the variant's, even if its look says otherwise; auto sets both", async () => {
    const s = store();
    await s.installFiles(pack("dev.a.modes", [
      { id: "day", name: "Day", mode: "light", theme: { background: "#f5f5f7", mode: "dark" } },
      { id: "night", name: "Night", mode: "dark", theme: { background: "#101018" } },
    ]), "t");
    expect(s.resolveApply("dev.a.modes", { variant: "day" }).look.mode).toBe("light");
    expect(s.resolveApply("dev.a.modes", { variant: "night" }).look.mode).toBe("dark");
    const auto = s.resolveApply("dev.a.modes", { auto: { light: "day", dark: "night" } });
    expect(auto.look.mode).toBe("auto");
    expect(auto.auto!.light.mode).toBe("light");
    expect(auto.auto!.dark.mode).toBe("dark");
  });
  test("a background that contradicts the declared mode is reported (summary + warning); matching ones are not", async () => {
    const s = store();
    const warn: string[] = [];
    const w = console.warn; console.warn = (m: string) => { warn.push(String(m)); };
    try {
      await s.installFiles(pack("dev.a.wrong", [
        { id: "a", name: "A", mode: "light", theme: { background: "#0b0d10" } },
        { id: "b", name: "B", mode: "dark", theme: { background: "#fafafa" } },
        { id: "c", name: "C", mode: "dark", theme: { background: "#0b0d10" } },
        { id: "d", name: "D", mode: "light", theme: { background: "#f5f5f7" } },
        { id: "e", name: "E", mode: "light", theme: {} },
      ]), "t");
    } finally { console.warn = w; }
    const sum = s.summary("dev.a.wrong")!;
    expect(sum.modeMismatch).toEqual(["a", "b"]);
    expect(sum.variants.map((v) => !!v.modeMismatch)).toEqual([true, true, false, false, false]);
    expect(warn.filter((m) => m.includes("dev.a.wrong"))).toHaveLength(2);
    await s.installFiles(pack("dev.a.right", [{ id: "a", name: "A", mode: "dark", theme: { background: "#101018" } }]), "t");
    expect(s.summary("dev.a.right")!.modeMismatch).toBeUndefined();
  });
  test("luminance and the mismatch rule", () => {
    expect(luminance("#000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1, 3);
    expect(luminance("red")).toBeNull();
    expect(modeMismatch({ background: "#e0e0e0" } as any, "dark")).toBe(true);
    expect(modeMismatch({ background: "#2b2b2b" } as any, "dark")).toBe(false);
    expect(modeMismatch({ background: "#7a7a7a" } as any, "light")).toBe(false);
  });
  test("the deck: the status bar and theme-color follow the mode, and the light standby is not black", () => {
    const t = src("web/deck/src/theme.ts");
    expect(t).toContain("set('theme-color', bg)");
    expect(t).toContain("light ? 'default' : 'black-translucent'");
    expect(t).toContain("chromeFor(root,");
    const css = src("web/deck/src/deck.css");
    expect(css).toContain(".pd-root[data-pd-theme='light'] .pd-sb { background: var(--pd-bg)");
    // sheets, charts and tracks read the light variables the root attribute switches
    expect(css).toMatch(/\.pd-root\[data-pd-theme='light'\] \{[^}]*--pd-bg/);
  });
  test("the real packs (when the plugins repo is next to this one): every variant's mode matches its background", async () => {
    const root = join(import.meta.dir, "../../nookdeck-plugins/themes");
    const { existsSync, readdirSync } = await import("node:fs");
    if (!existsSync(root)) return;
    const { resolveVariant } = await import("../src/plugins/manifest");
    const wrong: string[] = [];
    for (const d of readdirSync(root)) {
      const f = join(root, d, "nookdeck.json");
      if (!existsSync(f)) continue;
      const m = parseThemeManifest(JSON.parse(readFileSync(f, "utf8")), { agentVersion: "9.9.9" });
      for (const v of m.variants) if (modeMismatch(resolveVariant(m, v.id), v.mode)) wrong.push(`${d}/${v.id}`);
    }
    expect(wrong).toEqual([]);
  });
});
