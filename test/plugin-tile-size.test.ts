import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-tsize-home-"));
const { PluginStore } = await import("../src/plugins/store");
const { PluginHosts } = await import("../src/plugins/hosts");
const { PluginRuntime } = await import("../src/plugins/runtime");

const MANIFEST = {
  id: "dev.t.size", name: "Size", version: "1.0.0", nookdeck: ">=0.5.0", permissions: { network: [] }, main: "index.js",
  widgets: ["w", "old"].map((id) => ({ id, name: id, render: "text", sizes: ["2x2", "4x4"], source: { agent: { every: 3600 } } })),
  actions: ["fan", "fan-then-plain", "plain", "half"].map((id) => ({ id, name: id, settings: [], run: { agent: true } })),
};
// a real code plugin in its own process: the size reaches the provider, and push(fn) runs inside the plugin
const CODE = `
export function activate(ctx) {
  const text = (body) => ({ render: "text", data: { body } });
  ctx.widgets.provide("w", (settings, tile) => text("got " + tile.w + "x" + tile.h + " " + Object.keys(tile).sort().join(",")));
  ctx.widgets.provide("old", (settings) => text("old " + Object.keys(settings).length));
  ctx.actions.handle("fan", () => ctx.widgets.push("w", async (tile) => { await new Promise((r) => setTimeout(r, tile.w * 20)); return text("pushed " + tile.w + "x" + tile.h); }));
  ctx.actions.handle("fan-then-plain", () => { ctx.widgets.push("w", async () => { await new Promise((r) => setTimeout(r, 60)); return text("slow"); }); ctx.widgets.push("w", text("last")); });
  ctx.actions.handle("plain", () => ctx.widgets.push("w", text("same for all")));
  ctx.actions.handle("half", () => ctx.widgets.push("w", (tile) => { if (tile.w === 2) throw new Error("no small card"); return text("only big"); }));
}
`;

const item = (id: string, widget: string, w: number, h: number) => ({ id, kind: "widget", widget: "plugin", x: 0, y: 0, w, h, plugin: { id: "dev.t.size", widget } });
const layout = (items: unknown[]) => ({ pages: [{ id: "p", name: "P", items }] }) as any;

describe("plugins learn their tile size", () => {
  let dir = "", hosts: any, rt: any;
  afterEach(async () => { rt?.stop(); await hosts?.stopAll(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function setup() {
    dir = mkdtempSync(join(tmpdir(), "pd-tsize-"));
    const src = join(dir, "src");
    await Bun.write(join(src, "nookdeck.json"), JSON.stringify(MANIFEST));
    writeFileSync(join(src, "index.js"), CODE);
    const store = new PluginStore({ dir: join(dir, "plugins"), stateFile: join(dir, "plugins.json") });
    await store.load();
    await store.link(src);
    const shell = async () => ({ code: 0, stdout: "" });
    hosts = new PluginHosts(store, { fetch, shell, keys: { hotkey: async () => {}, type: async () => {} }, logDir: join(dir, "logs"), dataDir: join(dir, "data") } as any);
    const shown: Record<string, string> = {};
    const seen: string[] = [];
    rt = new PluginRuntime(store, { hosts, fetch, shell, onItems: (items: any) => { for (const [id, it] of Object.entries<any>(items)) { shown[id] = it.data?.body ?? `error: ${it.error}`; seen.push(`${id} ${shown[id]}`); } } });
    rt.setLayout(layout([item("small", "w", 2, 2), item("big", "w", 4, 4), item("o", "old", 4, 2)]));
    rt.setActive(true);
    const until = async (ok: () => boolean) => { const end = Date.now() + 8000; while (!ok() && Date.now() < end) await Bun.sleep(20); expect(ok()).toBe(true); };
    await until(() => !!shown.small && !!shown.big && !!shown.o);
    const run = (action: string) => rt.runAction({ plugin: "dev.t.size", action }, async () => {});
    return { shown, seen, until, run };
  }

  test("two tiles of one widget get their own data; a provider that takes only settings is as before; a resize asks again", async () => {
    const s = await setup();
    expect([s.shown.small, s.shown.big, s.shown.o]).toEqual(["got 2x2 h,w", "got 4x4 h,w", "old 0"]);
    rt.setLayout(layout([item("small", "w", 3, 2), item("big", "w", 4, 4), item("o", "old", 4, 2)]));
    await s.until(() => s.shown.small === "got 3x2 h,w");
    expect(s.seen.some((x) => x.includes("error"))).toBe(false);
  }, 20000);

  test("push(fn) makes one update per tile; plain data still goes to all; a later push is never overtaken", async () => {
    const s = await setup();
    await s.run("fan");
    await s.until(() => s.shown.small === "pushed 2x2" && s.shown.big === "pushed 4x4");
    await s.run("plain");
    await s.until(() => s.shown.small === "same for all" && s.shown.big === "same for all");
    await s.run("fan-then-plain");
    await s.until(() => s.shown.small === "last" && s.shown.big === "last");
    await Bun.sleep(150);
    expect([s.shown.small, s.shown.big, s.shown.o]).toEqual(["last", "last", "old 0"]);
    await s.run("half"); // one size failing does not hold back the other
    await s.until(() => s.shown.big === "only big");
    expect(s.shown.small).toBe("last");
    expect(hosts.logs("dev.t.size").join("\n")).toContain("failed for a 2x2 tile: no small card");
  }, 20000);
});

describe("core plugins get the size too", () => {
  test("provider and push(fn), through the runtime", async () => {
    const { CoreHost, loadCorePlugins } = await import("../src/plugins/core");
    const services = { log: () => {}, settings: () => ({}) } as any;
    const entries = loadCorePlugins(services).filter((e: any) => e.manifest.id === "core.quota");
    let ctx: any;
    entries[0]!.module = { activate: (c: any) => { ctx = c; c.widgets.provide("quota", (_s: unknown, tile: any) => ({ render: "custom:quota", data: { at: `${tile.w}x${tile.h}` } })); } };
    const core = new CoreHost(services, entries);
    await core.activate();
    const shown: Record<string, any> = {};
    const store = { onChange: () => {}, runnable: () => "ok", entry: () => ({ manifest: { ...entries[0]!.manifest, settings: [] }, state: { settings: {}, granted: { network: [] } } }) } as any;
    const rt = new PluginRuntime(store, { core, fetch, shell: async () => ({ code: 0, stdout: "" }), onItems: (items: any) => { for (const [id, it] of Object.entries<any>(items)) shown[id] = it.data?.at ?? it.error; } });
    const q = (id: string, w: number, h: number) => ({ id, kind: "widget", widget: "plugin", x: 0, y: 0, w, h, plugin: { id: "core.quota", widget: "quota" } });
    rt.setLayout(layout([q("a", 2, 1), q("b", 4, 2)]));
    rt.setActive(true);
    await Bun.sleep(30);
    expect(shown).toEqual({ a: "2x1", b: "4x2" });
    ctx.widgets.push("quota", (tile: any) => ({ render: "custom:quota", data: { at: `new ${tile.h}` } }));
    await Bun.sleep(30);
    expect(shown).toEqual({ a: "new 1", b: "new 2" });
    ctx.widgets.push("quota", { render: "custom:quota", data: { at: "all" } });
    expect(shown).toEqual({ a: "all", b: "all" });
    rt.stop();
  });
});
