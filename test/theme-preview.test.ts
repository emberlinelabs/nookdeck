import { rawFetch } from "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-tprev-home-"));
const { ThemePreviewCache } = await import("../src/plugins/theme-preview");
const { ThemeStore } = await import("../src/plugins/themes");
const { ThemeRegistry } = await import("../src/plugins/theme-registry");
const { PluginStore, packageHash } = await import("../src/plugins/store");
const { startServer } = await import("../src/server");

const tmp = (p = "pd-tprev-") => mkdtempSync(join(tmpdir(), p));
const enc = (s: string) => new TextEncoder().encode(s);

/** An in-memory theme package: two variants, a background, a preview, base css and a variant css. */
function pack(id = "dev.t.glass", version = "1.0.0", over: Record<string, unknown> = {}): Map<string, Uint8Array> {
  const manifest = {
    type: "theme", id, name: "Glass", version, preview: "preview.png", css: "theme.css",
    theme: { backgroundImage: "bg.png", accent: "#88ccff", tile: "#223344" },
    variants: [
      { id: "night", name: "Night", mode: "dark", theme: { background: "#0a0f1a" }, css: "night.css" },
      { id: "day", name: "Day", mode: "light", theme: { background: "#f0f4ff", tile: "#ffffff" } },
    ],
    ...over,
  };
  return new Map<string, Uint8Array>([
    ["nookdeck.json", enc(JSON.stringify(manifest))],
    ["bg.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3])],
    ["preview.png", new Uint8Array([137, 80, 78, 71, 9])],
    ["theme.css", enc('.a{color:red;background:url("bg.png")}')],
    ["night.css", enc(".b{color:blue}")],
  ]);
}
const pinOf = (files: Map<string, Uint8Array>, id = "dev.t.glass", version = "1.0.0") => ({ id, version, repo: `https://github.com/x/${id}`, sha256: packageHash(files) });

/** A download that serves the given packages by repo address and counts the calls. */
function fakeResolve(byRepo: Record<string, Map<string, Uint8Array>>) {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (src: string) => { calls.push(src); const f = byRepo[src]; if (!f) throw new Error("offline"); return { files: new Map(f), shown: src }; },
  };
}

describe("ThemePreviewCache", () => {
  test("downloads once at the pin, then serves from the cache; files and css follow the installed rules", async () => {
    const files = pack(), pin = pinOf(files), dir = tmp();
    const dl = fakeResolve({ [pin.repo]: files });
    const c = new ThemePreviewCache({ dir, resolve: dl.resolve });
    const a = await c.get(pin);
    expect(a.cached).toBe(false);
    expect(a.manifest.variants.map((v) => v.id)).toEqual(["night", "day"]);
    expect((await c.get(pin)).cached).toBe(true);
    expect(dl.calls).toHaveLength(1);
    expect(existsSync(join(dir, pin.sha256, "files", "bg.png"))).toBe(true);
    expect((await c.file("dev.t.glass", "bg.png"))?.bytes).toEqual(files.get("bg.png")!);
    for (const bad of ["nookdeck.json", "../meta.json", "a/../bg.png", "x.exe", "", "missing.png"]) expect(await c.file("dev.t.glass", bad)).toBeNull();
    expect(await c.file("dev.other", "bg.png")).toBeNull();
    const night = await c.css("dev.t.glass", "night");
    expect(night).toContain('.pd-root[data-theme-pkg="dev.t.glass"] .a');
    expect(night).toContain('[data-theme-variant="night"] .b');
    expect(night).toContain('url("/api/themes/dev.t.glass/files/bg.png")');
    expect(await c.css("dev.t.glass", "day")).not.toContain(".b");
    await expect(c.css("dev.t.glass", "zzz")).rejects.toThrow(/no variant/);
    // a new agent run finds the cached pack on disk without downloading
    const again = new ThemePreviewCache({ dir, resolve: dl.resolve });
    expect((await again.get(pin)).cached).toBe(true);
    expect(dl.calls).toHaveLength(1);
  });

  test("the hash check: files that do not match the pin, or another id or version, are refused and not cached", async () => {
    const files = pack(), dir = tmp();
    const repo = "https://github.com/x/dev.t.glass";
    const dl = fakeResolve({ [repo]: files });
    const c = new ThemePreviewCache({ dir, resolve: dl.resolve });
    await expect(c.get({ id: "dev.t.glass", version: "1.0.0", repo, sha256: "0".repeat(64) })).rejects.toThrow(/do not match/);
    await expect(c.get({ ...pinOf(files), version: "1.0.1" })).rejects.toThrow(/do not match/);
    await expect(c.get({ ...pinOf(files), id: "dev.t.other" })).rejects.toThrow(/do not match/);
    expect(await c.has("dev.t.glass")).toBe(false);
    expect(readdirSync(dir).filter((n) => !n.startsWith("."))).toEqual([]);
    // a package that matches its pin but breaks the package rules is refused too
    const bad = pack("dev.t.glass", "1.0.0"); bad.set("run.sh", enc("x"));
    const dl2 = fakeResolve({ [repo]: bad });
    await expect(new ThemePreviewCache({ dir, resolve: dl2.resolve }).get(pinOf(bad))).rejects.toThrow(/not an allowed theme file/);
    // offline
    await expect(new ThemePreviewCache({ dir, resolve: fakeResolve({}).resolve }).get(pinOf(files))).rejects.toThrow(/offline/);
  });

  test("keeps the most recent packs only, one copy per pack", async () => {
    const dir = tmp();
    const packs = ["dev.t.a", "dev.t.b", "dev.t.c"].map((id) => ({ id, files: pack(id) }));
    const byRepo = Object.fromEntries(packs.map((p) => [pinOf(p.files, p.id).repo, p.files]));
    let clock = 1000;
    const c = new ThemePreviewCache({ dir, max: 2, resolve: fakeResolve(byRepo).resolve, now: () => clock++ });
    for (const p of packs) await c.get(pinOf(p.files, p.id));
    expect(await c.has("dev.t.a")).toBe(false);
    expect(await c.has("dev.t.b")).toBe(true);
    expect(await c.has("dev.t.c")).toBe(true);
    expect(existsSync(join(dir, pinOf(packs[0]!.files, "dev.t.a").sha256))).toBe(false);
    // a new version of a pack replaces the old copy
    const v2 = pack("dev.t.c", "1.1.0");
    const c2 = new ThemePreviewCache({ dir, max: 2, resolve: fakeResolve({ "https://github.com/x/dev.t.c": v2 }).resolve, now: () => clock++ });
    await c2.get(pinOf(v2, "dev.t.c", "1.1.0"));
    expect(existsSync(join(dir, pinOf(packs[2]!.files, "dev.t.c").sha256))).toBe(false);
    expect(await c2.has("dev.t.b")).toBe(true);
  });

  test("take: the cached files for an install, only while they still hash to the pin", async () => {
    const files = pack(), pin = pinOf(files), dir = tmp();
    const c = new ThemePreviewCache({ dir, resolve: fakeResolve({ [pin.repo]: files }).resolve });
    expect(await c.take(pin)).toBeNull();
    await c.get(pin);
    const got = await c.take(pin);
    expect(got && packageHash(got.files)).toBe(pin.sha256);
    expect(got?.shown).toBe(pin.repo);
    expect(await c.take({ ...pin, version: "2.0.0" })).toBeNull();
    writeFileSync(join(dir, pin.sha256, "files", "bg.png"), "changed");
    expect(await c.take(pin)).toBeNull();
  });
});

describe("theme preview endpoints", () => {
  let app: any, base = "";
  const files = pack(), pin = pinOf(files);
  const bad = pack("dev.t.bad");
  const dl = fakeResolve({ [pin.repo]: files, "https://github.com/x/dev.t.bad": bad });
  const rows = [
    { id: pin.id, name: "Glass", version: "1.0.0", repo: pin.repo, sha256: pin.sha256, variants: [{ id: "night", name: "Night", mode: "dark", preview: "https://example.test/n.png" }] },
    { id: "dev.t.bad", name: "Bad", version: "1.0.0", repo: "https://github.com/x/dev.t.bad", sha256: "1".repeat(64), variants: [] },
    { id: "dev.t.gone", name: "Gone", version: "1.0.0", repo: "https://github.com/x/dev.t.gone", sha256: "2".repeat(64), variants: [] },
  ];
  const d = tmp();
  const api = (p: string, init: RequestInit = {}) => fetch(base + p, init);
  beforeAll(async () => {
    const ps = new PluginStore({ dir: join(d, "p"), stateFile: join(d, "p.json") });
    const themes = new ThemeStore({ dir: join(d, "t"), stateFile: join(d, "t.json"), resolve: async () => { throw new Error("install must use the cache"); } });
    const themeRegistry = new ThemeRegistry("https://raw.example/x/plugins.json", (async () => new Response(JSON.stringify(rows))) as any);
    const themePreviews = new ThemePreviewCache({ dir: join(d, "cache"), resolve: dl.resolve });
    app = await startServer({
      port: 0, pin: "123456", hostName: async () => "my-mac", themes, plugins: ps, themeRegistry, themePreviews,
      webhookKeyFile: join(process.env.NOOKDECK_HOME!, "webhook-key"), layoutHistoryDir: mkdtempSync(join(tmpdir(), "pd-tprev-hist-")),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null },
      aiSources: { claude: async () => ({ id: "claude", name: "c", windows: [], updatedAt: 1 }), codex: async () => ({ id: "codex", name: "c", windows: [], updatedAt: 1 }), antigravity: async () => ({ id: "antigravity", name: "c", windows: [], updatedAt: 1 }), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
  });
  afterAll(() => app?.stop());

  test("preview fetches the pack into the cache without installing it; files and css are served to this computer", async () => {
    expect((await api("/api/themes/dev.t.glass/files/bg.png")).status).toBe(404); // nothing before the preview
    const r = await api("/api/themes/dev.t.glass/preview", { method: "POST" });
    expect(r.status).toBe(200);
    const p: any = await r.json();
    expect(p).toMatchObject({ id: "dev.t.glass", version: "1.0.0", installed: false, cached: false, hasCss: true, preview: "/api/themes/dev.t.glass/files/preview.png", sha256: pin.sha256 });
    expect(p.variants.find((v: any) => v.id === "day").look).toMatchObject({ background: "#f0f4ff", tile: "#ffffff", accent: "#88ccff" });
    expect(((await (await api("/api/themes/dev.t.glass/preview", { method: "POST" })).json()) as any).cached).toBe(true);
    const list: any = await (await api("/api/themes")).json();
    expect(list.themes.some((t: any) => t.id === "dev.t.glass")).toBe(false);
    expect(list.registry.find((t: any) => t.id === "dev.t.glass").installed).toBe(false);
    const bg = await api("/api/themes/dev.t.glass/files/bg.png");
    expect(bg.status).toBe(200);
    expect(bg.headers.get("content-security-policy")).toContain("sandbox");
    expect((await api("/api/themes/dev.t.glass/files/nookdeck.json")).status).toBe(404);
    const css = await (await api("/api/themes/dev.t.glass/css?variant=night&v=1.0.0")).text();
    expect(css).toContain('[data-theme-pkg="dev.t.glass"] .a');
    expect(css).toContain('[data-theme-variant="night"] .b');
  });

  test("Install reuses the cached files (no second download), then the preview route says it is installed", async () => {
    const before = dl.calls.length;
    const r = await api("/api/themes/install", { method: "POST", body: JSON.stringify({ id: "dev.t.glass" }) });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any)).toMatchObject({ id: "dev.t.glass", reviewed: true, sha256: pin.sha256 });
    expect(dl.calls.length).toBe(before);
    expect((await api("/api/themes/dev.t.glass/preview", { method: "POST" })).status).toBe(409);
  });

  test("failures answer with an error and cache nothing: bad hash, offline, not in the registry", async () => {
    const b = await api("/api/themes/dev.t.bad/preview", { method: "POST" });
    expect(b.status).toBe(409);
    expect(((await b.json()) as any).error).toMatch(/do not match/);
    expect((await api("/api/themes/dev.t.bad/files/bg.png")).status).toBe(404);
    expect((await api("/api/themes/dev.t.gone/preview", { method: "POST" })).status).toBe(502);
    expect((await api("/api/themes/dev.t.none/preview", { method: "POST" })).status).toBe(404);
  });

  test("the preview route is localhost-only with the CSRF header, like the other theme APIs", async () => {
    expect((await rawFetch(`${base}/api/themes/dev.t.other/preview`, { method: "POST" })).status).toBe(403); // no X-Nookdeck header
    expect((await rawFetch(`${base}/api/themes/dev.t.other/preview`, { method: "POST", headers: { "x-nookdeck": "1", "content-type": "application/json", origin: "https://evil.test" } })).status).toBe(403);
    expect((await api("/api/themes/dev.t.glass/preview")).status).toBe(405); // GET does not download
  });
});
