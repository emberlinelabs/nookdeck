import "./_fetch";
import { rawFetch } from "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// every plugin file goes to a temp dir: never the real ~/.nookdeck
process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-plug-home-"));
const { parseManifest, covers, hostMatches, versionAtLeast, describePermissions } = await import("../src/plugins/manifest");
const S = await import("../src/plugins/sources");
const { PluginStore, PluginError, manifestUrls, packageHash } = await import("../src/plugins/store");
const { PluginRuntime } = await import("../src/plugins/runtime");
const { validateLayout, defaultLayout } = await import("../src/config");

const FIX = join(import.meta.dir, "fixtures", "plugins");
const fixtureJson = (name: string) => JSON.parse(readFileSync(join(FIX, name, "nookdeck.json"), "utf8"));
const tmp = (p = "pd-plug-") => mkdtempSync(join(tmpdir(), p));
const mk = (extra: Record<string, unknown> = {}) => ({ id: "dev.t.x", name: "X", version: "1.0.0", ...extra });
const newStore = (o: Record<string, unknown> = {}) => { const d = tmp(); return new PluginStore({ dir: join(d, "plugins"), stateFile: join(d, "plugins.json"), agentVersion: "0.2.0", ...o }); };

describe("manifest", () => {
  test("the example plugins are valid and normalized", () => {
    const m = parseManifest(fixtureJson("dev.example.crypto"));
    expect(m).toMatchObject({ id: "dev.example.crypto", version: "1.0.0", main: null, permissions: { network: ["api.example.com"] } });
    expect(m.settings[0]).toMatchObject({ key: "apiKey", type: "secret" });
    expect(m.widgets.map((w) => w.id)).toEqual(["price", "top"]);
    expect(m.actions[0]!.run).toHaveProperty("http");
    const mm = parseManifest(fixtureJson("dev.example.macro"));
    expect(mm.permissions).toEqual({ network: [], shell: true, keyboard: true });
  });
  test("permissions always carry a network list", () => {
    expect(parseManifest(mk()).permissions).toEqual({ network: [] });
  });
  test("bad manifests say what is wrong", () => {
    const bad = (extra: Record<string, unknown>, msg: string) => expect(() => parseManifest(mk(extra), { agentVersion: "0.2.0" })).toThrow(msg);
    expect(() => parseManifest("x")).toThrow("JSON object");
    expect(() => parseManifest({ ...mk(), id: "Nope" })).toThrow("id must look like");
    expect(() => parseManifest({ ...mk(), id: "single" })).toThrow("id must look like");
    expect(() => parseManifest({ ...mk(), id: "core.weather" })).toThrow("reserved");
    expect(() => parseManifest({ ...mk(), version: "1" })).toThrow("version");
    expect(() => parseManifest({ ...mk(), name: "" })).toThrow("name");
    bad({ main: "index.js" }, "has code");
    bad({ nookdeck: ">=9.0.0" }, "needs Nookdeck >=9.0.0");
    bad({ permissions: { root: true } }, "not a known permission");
    bad({ permissions: { network: ["not a host"] } }, "host name");
    bad({ widgets: [{ id: "a", render: "pie", source: { http: { url: "https://h.com/" } } }] }, "render must be one of");
    bad({ widgets: [{ id: "a", render: "stat", source: {} }] }, 'needs "http" or "command"');
    bad({ widgets: [{ id: "a", render: "stat", source: { agent: true } }] }, "code plugin");
    bad({ widgets: [{ id: "a", render: "stat", source: { http: { url: "https://api.x.com/" } } }] }, "permissions.network must list it");
    bad({ widgets: [{ id: "a", render: "stat", source: { http: { url: "https://{{h}}.x.com/" } } }], permissions: { network: ["*.x.com"] } }, "host part");
    bad({ permissions: { network: ["a.com"] }, widgets: [{ id: "a", render: "stat", source: { http: { url: "https://a.com/{{nope}}" } } }] }, "{{nope}}");
    bad({ widgets: [{ id: "a", render: "stat", source: { command: { run: "date" } } }] }, "permissions.shell");
    bad({ permissions: { network: ["a.com"] }, widgets: [{ id: "a", render: "stat", source: { http: { url: "https://a.com/", every: 1 } } }] }, "5-86400");
    bad({ actions: [{ id: "a", run: { macro: [{ kind: "hotkey", keys: "x" }] } }] }, "permissions.keyboard");
    bad({ actions: [{ id: "a", run: { macro: [{ kind: "hass", service: "light.toggle" }] } }] }, "not available to plugins");
    bad({ actions: [{ id: "a", run: {} }] }, 'needs "macro" or "http"');
    bad({ widgets: [{ id: "a", render: "text", source: { command: { run: "x" } } }, { id: "a", render: "text", source: { command: { run: "x" } } }], permissions: { shell: true } }, "used twice");
    bad({ settings: [{ key: "k", type: "number", default: "x" }] }, "does not match type");
    bad({ themes: [{ id: "t", theme: { radius: 999 } }] }, "themes[0].theme");
  });
  test("themes and layout packs are validated with the layout rules", () => {
    const m = parseManifest(mk({ themes: [{ id: "dark", name: "Dark", theme: { mode: "dark", radius: 8 } }], layouts: [{ id: "base", name: "Base", layout: defaultLayout() }] }));
    expect(m.themes[0]!.theme).toMatchObject({ mode: "dark", radius: 8 });
    expect(m.layouts[0]!.layout.pages.length).toBeGreaterThan(0);
    expect(() => parseManifest(mk({ layouts: [{ id: "bad", layout: { pages: [] } }] }))).toThrow("layouts[0].layout");
  });
  test("version ranges, host patterns and permission coverage", () => {
    expect(versionAtLeast("0.2.0", ">=0.2.0")).toBe(true);
    expect(versionAtLeast("0.1.5", ">=0.2.0")).toBe(false);
    expect(versionAtLeast("1.0.0", "0.9")).toBe(true);
    expect(hostMatches("api.x.com", "*.x.com")).toBe(true);
    expect(hostMatches("x.com", "*.x.com")).toBe(false);
    expect(hostMatches("evilx.com", "*.x.com")).toBe(false);
    expect(covers({ network: ["*.x.com"] }, { network: ["a.x.com"] })).toBe(true);
    expect(covers({ network: ["a.x.com"] }, { network: ["*.x.com"] })).toBe(false);
    expect(covers(null, { network: [] })).toBe(true);
    expect(covers(null, { network: [], shell: true })).toBe(false);
    expect(covers({ network: [], shell: true }, { network: [], shell: true, keyboard: true })).toBe(false);
    expect(describePermissions({ network: ["a.com"], shell: true })).toEqual(["Connect to a.com", "Run commands on this computer"]);
  });
});

describe("sources", () => {
  test("templates and dot paths", () => {
    expect(S.expand("a={{x}}&b={{ y }}&c={{z}}", { x: "1 2", y: 3 }, true)).toBe("a=1%202&b=3&c=");
    const doc = { a: { b: [{ c: 5 }, { c: 6 }] }, "k-1": "v" };
    expect(S.jsonPath(doc, "$.a.b[1].c")).toBe(6);
    expect(S.jsonPath(doc, "$['k-1']")).toBeUndefined();
    expect(S.jsonPath(doc, "$.k-1")).toBe("v");
    expect(S.jsonPath(doc, "$")).toBe(doc);
    expect(S.jsonPath(doc, "$.a.nope.x")).toBeUndefined();
    expect(S.jsonPath(doc, "$.a.b[9]")).toBeUndefined();
    expect(S.jsonPath(doc, "$.constructor")).toBeUndefined(); // never inherited members
    expect(S.jsonPath(doc, "a.b")).toBeUndefined();
  });
  test("each renderer checks and trims its data", () => {
    expect(S.cleanRender("stat", { value: 12.5, unit: "USD", label: "x", color: "#fff", junk: 1 })).toEqual({ data: { value: 12.5, unit: "USD", label: "x", color: "#fff" } });
    expect(S.cleanRender("stat", { value: undefined })).toEqual({ error: "no value to show" });
    expect(S.cleanRender("stat", { value: { a: 1 } })).toEqual({ error: "no value to show" });
    expect(S.cleanRender("gauge", { value: 150, color: "javascript:x" })).toEqual({ data: { value: 100 } });
    expect(S.cleanRender("gauge", { value: "abc" })).toHaveProperty("error");
    expect(S.cleanRender("text", { body: "x".repeat(5000), title: "t" })).toEqual({ data: { body: "x".repeat(2000), title: "t" } });
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, value: i }));
    const list = S.cleanRender("list", { items }) as any;
    expect(list.data.items).toHaveLength(20);
    expect(S.cleanRender("list", { items: "no" })).toHaveProperty("error");
    const chart = S.cleanRender("chart", { points: Array.from({ length: 200 }, (_, i) => i).concat(["x" as any]) }) as any;
    expect(chart.data.points).toHaveLength(120);
    expect(chart.data.points[119]).toBe(199);
    expect(S.cleanRender("chart", { points: ["x"] })).toHaveProperty("error");
    expect(S.cleanRender("image", { url: "https://a.com/x.png", fit: "cover" })).toEqual({ data: { url: "https://a.com/x.png", fit: "cover" } });
    expect(S.cleanRender("image", { url: "http://a.com/x.png" })).toHaveProperty("error");
    expect(S.cleanRender("image", { url: "javascript:alert(1)" })).toHaveProperty("error");
    expect(S.cleanRender("image", { url: "data:image/png;base64,AAAA" })).toHaveProperty("data");
    expect(S.cleanRender("status", { state: "warn", label: "hot" })).toEqual({ data: { state: "warn", label: "hot" } });
    expect(S.cleanRender("status", { state: "fine" })).toHaveProperty("error");
  });
  test("settings: defaults, plugin layer, tile layer, coercion; a secret ignores the tile layer", () => {
    const fields = [
      { key: "coin", type: "string" as const, label: "c", default: "bitcoin" },
      { key: "n", type: "number" as const, label: "n", default: 1 },
      { key: "on", type: "boolean" as const, label: "o" },
      { key: "cur", type: "select" as const, label: "s", options: ["usd", "eur"], default: "usd" },
      { key: "tok", type: "secret" as const, label: "t" },
    ];
    expect(S.resolveSettings(fields, [{ tok: "S3" }, { coin: "eth", n: "7", on: "true", cur: "gbp", tok: "STOLEN", junk: 1 } as any])).toEqual({ coin: "eth", n: 7, on: true, cur: "usd", tok: "S3" });
    expect(S.resolveSettings(fields, [undefined, undefined])).toEqual({ coin: "bitcoin", n: 1, cur: "usd" });
  });

  const widget = parseManifest(fixtureJson("dev.example.crypto")).widgets[0]!;
  const perms = { network: ["api.example.com"] };
  const calls: Array<{ url: string; init: any }> = [];
  const deps = (handler: (url: string) => Response | Promise<Response>): any => ({
    fetch: async (url: string, init: any) => { calls.push({ url: String(url), init }); return handler(String(url)); },
    shell: async () => ({ code: 0, stdout: "" }),
  });
  test("an http widget maps the response onto the renderer", async () => {
    calls.length = 0;
    const r = await S.evaluateWidget(widget, { coin: "bitcoin", currency: "usd", apiKey: "K" }, perms, deps(() => Response.json({ bitcoin: { usd: 64000.5 } })));
    expect(r).toEqual({ render: "stat", data: { value: 64000.5, unit: "usd", label: "bitcoin" } });
    expect(calls[0]!.url).toBe("https://api.example.com/v3/price?ids=bitcoin&vs=usd");
    expect(calls[0]!.init.headers).toEqual({ "x-key": "K" });
    expect(calls[0]!.init.redirect).toBe("manual");
  });
  test("a list widget maps items", async () => {
    const top = parseManifest(fixtureJson("dev.example.crypto")).widgets[1]!;
    const r = await S.evaluateWidget(top, {}, perms, deps(() => Response.json({ coins: [{ name: "BTC", price: 1 }, { name: "ETH", price: 2 }] })));
    expect(r).toEqual({ render: "list", data: { items: [{ title: "BTC", value: 1 }, { title: "ETH", value: 2 }] } });
  });
  test("calls to hosts the plugin did not declare fail, also through a redirect", async () => {
    calls.length = 0;
    const r1 = await S.evaluateWidget(widget, { coin: "b", currency: "usd" }, { network: ["other.com"] }, deps(() => Response.json({})));
    expect(r1).toEqual({ error: "api.example.com is not in this plugin's allowed hosts" });
    expect(calls).toHaveLength(0);
    const r2 = await S.evaluateWidget(widget, { coin: "b", currency: "usd" }, perms, deps((u) => u.includes("api.example.com") ? new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }) : Response.json({})));
    expect(r2).toEqual({ error: "evil.test is not in this plugin's allowed hosts" });
    expect(calls.map((c) => c.url)).toEqual(["https://api.example.com/v3/price?ids=b&vs=usd"]);
  });
  test("failures become a short error, never a throw", async () => {
    expect(await S.evaluateWidget(widget, { coin: "b", currency: "usd" }, perms, deps(() => new Response("no", { status: 500 })))).toEqual({ error: "the server answered 500" });
    expect(await S.evaluateWidget(widget, { coin: "b", currency: "usd" }, perms, deps(() => Response.json({ other: 1 })))).toEqual({ error: "no value to show" });
    expect(await S.evaluateWidget(widget, { coin: "b", currency: "usd" }, perms, { fetch: async () => { throw new Error("offline"); }, shell: async () => ({ code: 0, stdout: "" }) } as any)).toEqual({ error: "offline" });
  });
  test("a command widget needs the shell permission and parses stdout", async () => {
    const mood = parseManifest(fixtureJson("dev.example.macro")).widgets[0]!;
    const ran: string[] = [];
    const d: any = { fetch, shell: async (c: string) => { ran.push(c); return { code: 0, stdout: '{"state":"ok","label":"fine"}\n' }; } };
    expect(await S.evaluateWidget(mood, { label: "fine" }, { network: [] }, d)).toEqual({ error: "this plugin has not been allowed to run commands" });
    expect(ran).toHaveLength(0);
    expect(await S.evaluateWidget(mood, { label: "fine" }, { network: [], shell: true }, d)).toEqual({ render: "status", data: { state: "ok", label: "fine" } });
    expect(ran).toEqual(['echo {"state":"ok","label":"fine"}']);
    expect(await S.evaluateWidget(mood, {}, { network: [], shell: true }, { ...d, shell: async () => ({ code: 3, stdout: "" }) })).toEqual({ error: "the command failed (exit 3)" });
  });
  test("plain text from a command goes to the main field", async () => {
    const w: any = { id: "t", name: "t", render: "stat", sizes: ["2x1"], settings: [], source: { command: { run: "date" } } };
    expect(await S.evaluateWidget(w, {}, { network: [], shell: true }, { fetch, shell: async () => ({ code: 0, stdout: " 42 \n" }) } as any)).toEqual({ render: "stat", data: { value: 42 } });
  });
});

describe("store", () => {
  const copyFixture = (name: string) => { const d = join(tmp(), name); cpSync(join(FIX, name), d, { recursive: true }); return d; };

  test("install from a folder: pinned by hash, starts disabled and needing approval", async () => {
    const store = newStore();
    const src = copyFixture("dev.example.crypto");
    const r = await store.install(src);
    expect(r).toMatchObject({ updated: false, unchanged: false });
    expect(r.plugin).toMatchObject({ id: "dev.example.crypto", version: "1.0.0", enabled: false, needsApproval: true, unreviewed: true, permissions: { network: ["api.example.com"] }, granted: { network: [] } });
    expect(r.plugin.permissionLines).toEqual(["Connect to api.example.com"]);
    expect(r.plugin.sha256).toBe(packageHash(new Map([["nookdeck.json", new Uint8Array(readFileSync(join(src, "nookdeck.json")))]])));
    expect(existsSync(join(store.dir, "dev.example.crypto", "1.0.0", "nookdeck.json"))).toBe(true);
    expect(store.runnable("dev.example.crypto")).toBe("disabled");
  });
  test("install from a manifest file, and the same install again changes nothing", async () => {
    const store = newStore();
    const file = join(copyFixture("dev.example.macro"), "nookdeck.json");
    expect((await store.install(file)).plugin.id).toBe("dev.example.macro");
    expect(await store.install(file)).toMatchObject({ unchanged: true, updated: false });
  });
  test("invalid installs are refused with a clear message", async () => {
    const store = newStore();
    const d = tmp();
    await expect(store.install(join(d, "nope"))).rejects.toThrow("does not exist");
    await expect(store.install(d)).rejects.toThrow("no nookdeck.json");
    writeFileSync(join(d, "nookdeck.json"), "{ not json");
    await expect(store.install(d)).rejects.toThrow("not valid JSON");
    writeFileSync(join(d, "nookdeck.json"), JSON.stringify({ id: "bad", name: "x", version: "1.0.0" }));
    await expect(store.install(d)).rejects.toThrow("nookdeck.json: id must look like");
    await expect(store.install("")).rejects.toThrow("folder path");
    await expect(store.install("http://example.com/nookdeck.json")).rejects.toThrow("only https");
    await expect(store.install("ftp://example.com/x")).rejects.toThrow("only https");
    expect(store.list()).toEqual([]);
  });
  test("a plugin that needs a newer Nookdeck is refused", async () => {
    const store = newStore({ agentVersion: "0.1.5" });
    const d = tmp();
    writeFileSync(join(d, "nookdeck.json"), JSON.stringify(mk({ nookdeck: ">=0.2.0" })));
    await expect(store.install(d)).rejects.toThrow("needs Nookdeck >=0.2.0, you have 0.1.5");
  });
  test("install from an https URL (the file itself, or a GitHub repo page)", async () => {
    const seen: string[] = [];
    const body = JSON.stringify(fixtureJson("dev.example.crypto"));
    const fakeFetch: any = async (u: string) => { seen.push(String(u)); return String(u).endsWith("/main/nookdeck.json") ? new Response(null, { status: 404 }) : new Response(body); };
    const store = newStore({ fetch: fakeFetch });
    expect((await store.install("https://example.org/p/nookdeck.json")).plugin.id).toBe("dev.example.crypto");
    const store2 = newStore({ fetch: fakeFetch });
    seen.length = 0;
    expect((await store2.install("https://github.com/alice/crypto")).plugin.source).toBe("https://github.com/alice/crypto");
    expect(seen).toEqual(["https://raw.githubusercontent.com/alice/crypto/main/nookdeck.json", "https://raw.githubusercontent.com/alice/crypto/master/nookdeck.json"]);
    expect(manifestUrls("https://github.com/a/b/tree/dev/sub/dir")).toEqual(["https://raw.githubusercontent.com/a/b/dev/sub/dir/nookdeck.json"]);
    const gone = newStore({ fetch: (async () => new Response(null, { status: 404 })) as any });
    await expect(gone.install("https://example.org/x.json")).rejects.toThrow("no nookdeck.json found");
    const broken = newStore({ fetch: (async () => new Response(null, { status: 500 })) as any });
    await expect(broken.install("https://example.org/x.json")).rejects.toThrow("answered 500");
  });
  test("nothing runs until the user grants the permissions", async () => {
    const store = newStore();
    await store.install(copyFixture("dev.example.crypto"));
    await expect(store.setEnabled("dev.example.crypto", true)).rejects.toThrow("grant the plugin's permissions first");
    await expect(store.grant("dev.example.crypto", { network: ["api.example.com", "evil.com"] })).rejects.toThrow("more than it declares");
    await expect(store.grant("dev.example.crypto", { network: [], shell: true })).rejects.toThrow("more than it declares");
    const g = await store.grant("dev.example.crypto", { network: ["api.example.com"] });
    expect(g).toMatchObject({ needsApproval: false, granted: { network: ["api.example.com"] } });
    expect((await store.setEnabled("dev.example.crypto", true)).enabled).toBe(true);
    expect(store.runnable("dev.example.crypto")).toBe("ok");
    expect((await store.setEnabled("dev.example.crypto", false)).enabled).toBe(false);
    await expect(store.setEnabled("dev.example.crypto", "yes" as any)).rejects.toThrow("true or false");
    await expect(store.setEnabled("dev.nope.x", true)).rejects.toThrow("not installed");
  });
  test("a plugin without permissions can be enabled right away", async () => {
    const store = newStore();
    const d = tmp();
    writeFileSync(join(d, "nookdeck.json"), JSON.stringify(mk()));
    const r = await store.install(d);
    expect(r.plugin.needsApproval).toBe(false);
    expect((await store.setEnabled("dev.t.x", true)).enabled).toBe(true);
  });
  test("an update that asks for more permissions is disabled until granted again; settings survive", async () => {
    const store = newStore();
    const src = copyFixture("dev.example.crypto");
    await store.install(src);
    await store.grant("dev.example.crypto", { network: ["api.example.com"] });
    await store.setEnabled("dev.example.crypto", true);
    await store.setSettings("dev.example.crypto", { apiKey: "S3CRET" });
    // same permissions, new version: stays enabled
    const m = fixtureJson("dev.example.crypto");
    writeFileSync(join(src, "nookdeck.json"), JSON.stringify({ ...m, version: "1.1.0" }));
    const u1 = await store.install(src);
    expect(u1).toMatchObject({ updated: true, plugin: { version: "1.1.0", enabled: true, needsApproval: false } });
    expect(existsSync(join(store.dir, "dev.example.crypto", "1.0.0"))).toBe(false); // the old version is gone
    // new permission: off, needs approval
    writeFileSync(join(src, "nookdeck.json"), JSON.stringify({ ...m, version: "1.2.0", permissions: { network: ["api.example.com", "cdn.example.com"] } }));
    const u2 = await store.install(src);
    expect(u2.plugin).toMatchObject({ version: "1.2.0", enabled: false, needsApproval: true });
    expect(store.entry("dev.example.crypto")!.state.settings.apiKey).toBe("S3CRET");
    expect(store.runnable("dev.example.crypto")).toBe("disabled");
    await store.grant("dev.example.crypto", { network: ["api.example.com", "cdn.example.com"] });
    expect((await store.setEnabled("dev.example.crypto", true)).enabled).toBe(true);
  });
  test("settings: secrets never leave, an absent secret keeps its value, bad values are refused", async () => {
    const store = newStore();
    await store.install(copyFixture("dev.example.crypto"));
    let s = await store.setSettings("dev.example.crypto", { apiKey: "S3CRET" });
    expect(s.fields).toEqual([{ key: "apiKey", type: "secret", label: "API key", isSet: true }]);
    expect(s.settings).toEqual({});
    expect(JSON.stringify(s)).not.toContain("S3CRET");
    s = await store.setSettings("dev.example.crypto", {});
    expect(s.fields[0]).toMatchObject({ isSet: true });
    expect(store.entry("dev.example.crypto")!.state.settings.apiKey).toBe("S3CRET");
    s = await store.setSettings("dev.example.crypto", { apiKey: "" });
    expect(s.fields[0]!.isSet).toBeUndefined();
    await expect(store.setSettings("dev.example.crypto", [] as any)).rejects.toThrow("object");
    const store2 = newStore();
    const d = tmp();
    writeFileSync(join(d, "nookdeck.json"), JSON.stringify(mk({ settings: [{ key: "n", type: "number", label: "N", default: 5 }, { key: "s", type: "select", label: "S", options: ["a", "b"] }] })));
    await store2.install(d);
    expect((await store2.setSettings("dev.t.x", { n: "12", junk: 1 })).settings).toEqual({ n: 12 });
    await expect(store2.setSettings("dev.t.x", { n: "abc" })).rejects.toThrow("not a valid number");
    await expect(store2.setSettings("dev.t.x", { s: "c" })).rejects.toThrow("not a valid select");
    expect((await store2.setSettings("dev.t.x", { n: null })).settings).toEqual({ n: 5 }); // back to the default
  });
  test("state survives a restart; the file is private; remove deletes the files", async () => {
    const d = tmp();
    const opts = { dir: join(d, "plugins"), stateFile: join(d, "plugins.json"), agentVersion: "0.2.0" };
    const a = new PluginStore(opts);
    await a.install(copyFixture("dev.example.crypto"));
    await a.grant("dev.example.crypto", { network: ["api.example.com"] });
    await a.setEnabled("dev.example.crypto", true);
    await a.setSettings("dev.example.crypto", { apiKey: "S3CRET" });
    if (process.platform !== "win32") expect(require("node:fs").statSync(opts.stateFile).mode & 0o777).toBe(0o600);
    const b = new PluginStore(opts);
    await b.load();
    expect(b.summary("dev.example.crypto")).toMatchObject({ enabled: true, granted: { network: ["api.example.com"] } });
    expect(b.entry("dev.example.crypto")!.state.settings.apiKey).toBe("S3CRET");
    await b.remove("dev.example.crypto");
    expect(b.list()).toEqual([]);
    expect(existsSync(join(opts.dir, "dev.example.crypto"))).toBe(false);
    await expect(b.remove("dev.example.crypto")).rejects.toThrow("not installed");
    const c = new PluginStore(opts);
    await c.load();
    expect(c.list()).toEqual([]);
  });
  test("files changed after install: kept, but disabled with a reason", async () => {
    const d = tmp();
    const opts = { dir: join(d, "plugins"), stateFile: join(d, "plugins.json"), agentVersion: "0.2.0" };
    const a = new PluginStore(opts);
    await a.install(copyFixture("dev.example.crypto"));
    await a.grant("dev.example.crypto", { network: ["api.example.com"] });
    await a.setEnabled("dev.example.crypto", true);
    const file = join(opts.dir, "dev.example.crypto", "1.0.0", "nookdeck.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("Crypto price", "Crypto prices"));
    const b = new PluginStore(opts);
    await b.load();
    expect(b.summary("dev.example.crypto")).toMatchObject({ enabled: false, error: expect.stringContaining("changed after install") });
    expect(b.runnable("dev.example.crypto")).toBe("disabled");
    await expect(b.setEnabled("dev.example.crypto", true)).rejects.toThrow("changed after install");
  });
  test("the PluginError status is carried for the REST layer", async () => {
    const store = newStore();
    try { await store.setEnabled("dev.nope.x", true); } catch (e: any) { expect(e).toBeInstanceOf(PluginError); expect(e.status).toBe(404); }
  });
});

describe("layout references (D7)", () => {
  const page = (items: unknown[]) => ({ version: 1, pages: [{ id: "p", name: "P", columns: 4, rows: 4, items }] });
  test("plugin widgets and actions validate and round-trip", () => {
    const l = validateLayout(page([
      { id: "pw", kind: "widget", widget: "plugin", plugin: { id: "dev.example.crypto", widget: "price", settings: { coin: "eth", n: 1, on: true } }, w: 2 },
      { id: "pb", kind: "button", label: "Go", action: { type: "plugin", plugin: "dev.example.crypto", action: "refresh", settings: { coin: "eth" } } },
    ]));
    expect((l.pages[0]!.items[0] as any).plugin).toEqual({ id: "dev.example.crypto", widget: "price", settings: { coin: "eth", n: 1, on: true } });
    expect((l.pages[0]!.items[1] as any).action).toEqual({ type: "plugin", plugin: "dev.example.crypto", action: "refresh", settings: { coin: "eth" } });
    expect(validateLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
  });
  test("bad references are refused; plugin tile ids are unique across pages", () => {
    const w = (plugin: unknown) => page([{ id: "a", kind: "widget", widget: "plugin", plugin }]);
    expect(() => validateLayout(w(undefined))).toThrow("needs plugin.id and plugin.widget");
    expect(() => validateLayout(w({ id: "Bad", widget: "x" }))).toThrow("plugin.id");
    expect(() => validateLayout(w({ id: "dev.a.b", widget: "../x" }))).toThrow("plugin.widget");
    expect(() => validateLayout(w({ id: "dev.a.b", widget: "x", settings: { k: { a: 1 } } }))).toThrow("settings.k");
    expect(() => validateLayout(page([{ id: "b", kind: "button", label: "x", action: { type: "plugin", plugin: "nope", action: "a" } }]))).toThrow("plugin id");
    const two = { version: 1, pages: [
      { id: "p1", name: "1", columns: 4, rows: 2, items: [{ id: "same", kind: "widget", widget: "plugin", plugin: { id: "dev.a.b", widget: "x" } }] },
      { id: "p2", name: "2", columns: 4, rows: 2, items: [{ id: "same", kind: "widget", widget: "plugin", plugin: { id: "dev.a.b", widget: "x" } }] },
    ] };
    expect(() => validateLayout(two)).toThrow("unique across all pages");
  });
  test("existing layouts with legacy widgets load unchanged (AC-6)", () => {
    const l = defaultLayout();
    expect(validateLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
    expect(JSON.stringify(l)).not.toContain('"plugin"');
  });
});

describe("runtime", () => {
  const layoutWith = (...tiles: Array<{ id: string; plugin: any }>) => validateLayout({ version: 1, pages: [{ id: "p", name: "P", columns: 6, rows: 4, items: tiles.map((t) => ({ id: t.id, kind: "widget", widget: "plugin", plugin: t.plugin })) }] });

  async function setup() {
    const store = newStore();
    const src = join(tmp(), "dev.example.crypto"); cpSync(join(FIX, "dev.example.crypto"), src, { recursive: true });
    await store.install(src);
    let price = 100;
    const sent: any[] = [];
    const fetched: string[] = [];
    const rt = new PluginRuntime(store, {
      fetch: (async (u: string) => { fetched.push(String(u)); return Response.json({ bitcoin: { usd: price++ } }); }) as any,
      shell: async () => ({ code: 0, stdout: "" }),
      onItems: (i) => sent.push(i),
      scale: 0.01, // every:5 s becomes 50 ms
    });
    return { store, rt, sent, fetched, setPrice: (n: number) => { price = n; } };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("missing, disabled and not-granted plugins give their tiles a neutral error, nothing crashes (AC-5)", async () => {
    const { store, rt, sent } = await setup();
    rt.setLayout(layoutWith({ id: "t1", plugin: { id: "dev.example.crypto", widget: "price" } }, { id: "t2", plugin: { id: "dev.gone.x", widget: "w" } }));
    expect(rt.snapshot()).toEqual({ t1: { error: "plugin disabled" }, t2: { error: "plugin missing" } });
    expect(sent[0]).toEqual({ t1: { error: "plugin disabled" }, t2: { error: "plugin missing" } });
    await store.grant("dev.example.crypto", { network: [] }); // partial grant
    await store.setEnabled("dev.example.crypto", false);
    rt.stop();
  });
  test("an enabled plugin tile shows live data while a phone is connected and refreshes at `every` (AC-3)", async () => {
    const { store, rt, sent, fetched } = await setup();
    await store.grant("dev.example.crypto", { network: ["api.example.com"] });
    await store.setEnabled("dev.example.crypto", true);
    rt.setLayout(layoutWith({ id: "t1", plugin: { id: "dev.example.crypto", widget: "price", settings: { coin: "bitcoin" } } }));
    await wait(30);
    expect(fetched).toHaveLength(0); // no phone: no polling
    rt.setActive(true);
    await wait(30);
    expect(rt.snapshot().t1).toEqual({ render: "stat", data: { value: 100, unit: "usd", label: "bitcoin" } });
    await wait(130);
    expect(fetched.length).toBeGreaterThanOrEqual(3);
    expect((rt.snapshot().t1 as any).data.value).toBeGreaterThan(100);
    expect(sent.at(-1)).toHaveProperty("t1.data.value");
    rt.setActive(false);
    const n = fetched.length;
    await wait(120);
    expect(fetched.length).toBe(n); // the last phone left: polling stops
    rt.stop();
  });
  test("an unchanged answer is not sent again; disabling turns the tile into an error at once", async () => {
    const { store, rt, sent } = await setup();
    await store.grant("dev.example.crypto", { network: ["api.example.com"] });
    await store.setEnabled("dev.example.crypto", true);
    const same = new PluginRuntime(store, { fetch: (async () => Response.json({ bitcoin: { usd: 5 } })) as any, shell: async () => ({ code: 0, stdout: "" }), onItems: (i) => sent.push(i), scale: 0.01 });
    sent.length = 0;
    same.setLayout(layoutWith({ id: "t1", plugin: { id: "dev.example.crypto", widget: "price" } }));
    same.setActive(true);
    await wait(150);
    expect(sent.filter((m) => m.t1.render).length).toBe(1);
    await store.setEnabled("dev.example.crypto", false);
    expect(same.snapshot().t1).toEqual({ error: "plugin disabled" });
    expect(sent.at(-1)).toEqual({ t1: { error: "plugin disabled" } });
    same.stop(); rt.stop();
  });
  test("a tile that is not on the layout any more is dropped", async () => {
    const { rt } = await setup();
    rt.setLayout(layoutWith({ id: "t1", plugin: { id: "dev.gone.x", widget: "w" } }));
    expect(Object.keys(rt.snapshot())).toEqual(["t1"]);
    rt.setLayout(layoutWith());
    expect(rt.snapshot()).toEqual({});
    rt.stop();
  });
  test("plugin actions: http runs against declared hosts; macro steps go to the macro runner with settings filled in (AC-4)", async () => {
    const { store, rt } = await setup();
    const calls: Array<{ url: string; init: any }> = [];
    const live = new PluginRuntime(store, { fetch: (async (u: string, init: any) => { calls.push({ url: String(u), init }); return new Response("ok"); }) as any, shell: async () => ({ code: 0, stdout: "" }), onItems: () => {} });
    const noSteps = async () => { throw new Error("no macro here"); };
    await expect(live.runAction({ plugin: "dev.example.crypto", action: "refresh" }, noSteps)).rejects.toThrow("plugin disabled");
    await expect(live.runAction({ plugin: "dev.gone.x", action: "a" }, noSteps)).rejects.toThrow("plugin missing");
    await store.grant("dev.example.crypto", { network: ["api.example.com"] });
    await store.setEnabled("dev.example.crypto", true);
    await live.runAction({ plugin: "dev.example.crypto", action: "refresh", settings: { coin: "eth" } }, noSteps);
    expect(calls[0]).toMatchObject({ url: "https://api.example.com/v3/ping", init: { method: "POST", body: '{"coin":"eth"}' } });
    await expect(live.runAction({ plugin: "dev.example.crypto", action: "nope" }, noSteps)).rejects.toThrow("plugin action missing");
    // macro plugin
    const m = join(tmp(), "dev.example.macro"); cpSync(join(FIX, "dev.example.macro"), m, { recursive: true });
    await store.install(m);
    await expect(live.runAction({ plugin: "dev.example.macro", action: "copy-all" }, noSteps)).rejects.toThrow("plugin disabled");
    await store.grant("dev.example.macro", { network: [], shell: true, keyboard: true });
    await store.setEnabled("dev.example.macro", true);
    let got: any[] = [];
    await live.runAction({ plugin: "dev.example.macro", action: "copy-all", settings: { what: "the page" } }, async (steps) => { got = steps; });
    expect(got).toEqual([{ kind: "hotkey", keys: "cmd+a" }, { kind: "hotkey", keys: "cmd+c" }, { kind: "notify", text: "copied the page" }]);
    live.stop(); rt.stop();
  });
});

// ---------- through the real server ----------

describe("server: REST, the plugin WS message and plugin buttons", () => {
  let app: any; let base: string; let token: string;
  const ran: any[] = [];
  const hits: string[] = [];
  const dir = tmp("pd-plug-srv-");
  const store = new PluginStore({ dir: join(dir, "plugins"), stateFile: join(dir, "plugins.json"), agentVersion: "0.2.0" });
  const J = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });

  function connect() {
    const ws = new WebSocket(`ws://localhost:${app.port}/ws?token=${token}`);
    const msgs: any[] = []; const waiters: Array<() => void> = [];
    ws.onmessage = (e) => { msgs.push(JSON.parse(String(e.data))); waiters.forEach((w) => w()); };
    const next = (pred: (m: any) => boolean, ms = 4000) => new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      const check = () => { const i = msgs.findIndex(pred); if (i >= 0) { clearTimeout(t); resolve(msgs.splice(i, 1)[0]); return true; } return false; };
      if (check()) return;
      const w = () => { if (check()) waiters.splice(waiters.indexOf(w), 1); };
      waiters.push(w);
    });
    return { ws, next };
  }

  beforeAll(async () => {
    const { startServer } = await import("../src/server");
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    app = await startServer({
      port: 0, pin: "555555", hostName: async () => "my-mac",
      webhookKeyFile: join(dir, "webhook-key"), layoutHistoryDir: join(dir, "hist"), plugins: store,
      pluginDeps: { fetch: (async (u: string) => { hits.push(String(u)); return Response.json({ bitcoin: { usd: 777 } }); }) as any },
      deps: { runAction: async (a: any) => { ran.push(a); }, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
    token = ((await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "555555", name: "t" }) })).json()) as any).token;
  });
  afterAll(async () => {
    const { defaultLayout } = await import("../src/config");
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(defaultLayout()) });
    app.stop();
  });

  test("the plugin API is local-only like the rest of the management API", async () => {
    expect((await rawFetch(`${base}/api/plugins`)).status).toBe(200);
    expect((await rawFetch(`${base}/api/plugins`, { method: "POST", body: "{}" })).status).toBe(403); // no CSRF header
    expect((await rawFetch(`${base}/api/plugins`, { headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("install, grant, enable, settings, delete over REST (AC-1, AC-2, AC-5)", async () => {
    expect(await (await fetch(`${base}/api/plugins`)).json()).toEqual([]);
    expect((await fetch(`${base}/api/plugins`, J({}))).status).toBe(400);
    const bad = await fetch(`${base}/api/plugins`, J({ source: join(dir, "nowhere") }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain("does not exist");
    const src = join(tmp(), "dev.example.crypto"); cpSync(join(FIX, "dev.example.crypto"), src, { recursive: true });
    const inst = await fetch(`${base}/api/plugins`, J({ source: src }));
    expect(inst.status).toBe(201);
    const p = (await inst.json()) as any;
    expect(p).toMatchObject({ id: "dev.example.crypto", enabled: false, needsApproval: true, permissions: { network: ["api.example.com"] }, granted: { network: [] } });
    expect((await fetch(`${base}/api/plugins`, J({ source: src }))).status).toBe(200); // again: nothing changes
    expect(Array.isArray(await (await fetch(`${base}/api/plugins`)).json())).toBe(true);
    expect(((await (await fetch(`${base}/api/plugins/dev.example.crypto`)).json()) as any).name).toBe("Crypto price");
    const noGrant = await fetch(`${base}/api/plugins/dev.example.crypto/enabled`, J({ enabled: true }));
    expect(noGrant.status).toBe(409);
    expect((await fetch(`${base}/api/plugins/dev.example.crypto/grant`, J({ permissions: { network: ["x.com"] } }))).status).toBe(400);
    const g = await fetch(`${base}/api/plugins/dev.example.crypto/grant`, J({ permissions: { network: ["api.example.com"] } }));
    expect(((await g.json()) as any).needsApproval).toBe(false);
    const en = (await (await fetch(`${base}/api/plugins/dev.example.crypto/enabled`, J({ enabled: true }))).json()) as any;
    expect(en.enabled).toBe(true);
    const st = await fetch(`${base}/api/plugins/dev.example.crypto/settings`, J({ apiKey: "S3CRET" }, "PUT"));
    const stj = (await st.json()) as any;
    expect(stj.fields[0]).toMatchObject({ key: "apiKey", isSet: true });
    expect(JSON.stringify(await (await fetch(`${base}/api/plugins`)).json())).not.toContain("S3CRET");
    expect((await fetch(`${base}/api/plugins/dev.nope.x`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${base}/api/plugins/dev.example.crypto/enabled`, { method: "GET" })).status).toBe(405);
  });

  test("a phone gets {type:'plugin', items} for its tiles, live, and a neutral error after the plugin is disabled (AC-3, AC-5)", async () => {
    const layout = { version: 1, pages: [{ id: "main", name: "Main", columns: 4, rows: 2, items: [
      { id: "price1", kind: "widget", widget: "plugin", plugin: { id: "dev.example.crypto", widget: "price", settings: { coin: "bitcoin" } }, w: 2 },
      { id: "doit", kind: "button", label: "Ping", action: { type: "plugin", plugin: "dev.example.crypto", action: "refresh", settings: { coin: "bitcoin" } } },
      { id: "gone", kind: "widget", widget: "plugin", plugin: { id: "dev.gone.x", widget: "w" } },
    ] }] };
    expect((await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(layout) })).status).toBe(200);
    const a = connect();
    const first = await a.next((m) => m.type === "plugin" && m.items.price1?.render);
    expect(first.items.price1).toEqual({ render: "stat", data: { value: 777, unit: "usd", label: "bitcoin" } });
    expect(hits[0]).toBe("https://api.example.com/v3/price?ids=bitcoin&vs=usd");
    const snap = connect();
    const full = await snap.next((m) => m.type === "plugin" && m.items.gone);
    expect(full.items.gone).toEqual({ error: "plugin missing" });
    expect(full.items.price1.render).toBe("stat");
    // a button of the plugin
    a.ws.send(JSON.stringify({ type: "press", pageId: "main", itemId: "doit", reqId: 1 }));
    expect((await a.next((m) => m.type === "result" && m.reqId === 1)).ok).toBe(true);
    expect(hits.at(-1)).toBe("https://api.example.com/v3/ping");
    await fetch(`${base}/api/plugins/dev.example.crypto/enabled`, J({ enabled: false }));
    const off = await a.next((m) => m.type === "plugin" && m.items.price1?.error);
    expect(off.items.price1).toEqual({ error: "plugin disabled" });
    a.ws.send(JSON.stringify({ type: "press", pageId: "main", itemId: "doit", reqId: 2 }));
    expect(await a.next((m) => m.type === "result" && m.reqId === 2)).toMatchObject({ ok: false, error: "plugin disabled" });
    // removing it: tiles say missing
    await fetch(`${base}/api/plugins/dev.example.crypto`, { method: "DELETE" });
    expect((await a.next((m) => m.type === "plugin" && m.items.price1?.error === "plugin missing")).items.price1).toEqual({ error: "plugin missing" });
    a.ws.close(); snap.ws.close();
  });

  test("a macro plugin button runs its steps through the macro runner", async () => {
    const src = join(tmp(), "dev.example.macro"); cpSync(join(FIX, "dev.example.macro"), src, { recursive: true });
    expect((await fetch(`${base}/api/plugins`, J({ source: src }))).status).toBe(201);
    await fetch(`${base}/api/plugins/dev.example.macro/grant`, J({ permissions: { network: [], shell: true, keyboard: true } }));
    await fetch(`${base}/api/plugins/dev.example.macro/enabled`, J({ enabled: true }));
    const layout = { version: 1, pages: [{ id: "main", name: "Main", columns: 4, rows: 2, items: [
      { id: "cp", kind: "button", label: "Copy", action: { type: "plugin", plugin: "dev.example.macro", action: "copy-all" } },
    ] }] };
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(layout) });
    const a = connect();
    await a.next((m) => m.type === "hello");
    ran.length = 0;
    a.ws.send(JSON.stringify({ type: "press", pageId: "main", itemId: "cp", reqId: 9 }));
    expect((await a.next((m) => m.type === "result" && m.reqId === 9)).ok).toBe(true);
    expect(ran.filter((x) => x.type === "hotkey").map((x) => x.keys)).toEqual(["cmd+a", "cmd+c"]);
    a.ws.close();
  });
});
