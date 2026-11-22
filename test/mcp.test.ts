import "./_fetch";
import { WIN, MODE600, MODE644 } from "./_os";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-mcp-"));
const { startServer } = await import("../src/server");
const { LayoutHistory } = await import("../src/layout-history");
const { validateLayout } = await import("../src/config");
const { OPERATIONS } = await import("../src/mcp/ops");
const { layoutGrid } = await import("../src/mcp/ascii");
const { runMcp, handleMessage } = await import("../src/mcp/server");
const { AgentApi, TOOLS, callTool } = await import("../src/mcp/tools");

const L = (items: any[] = [], extra: any = {}) => validateLayout({ version: 1, pages: [{ id: "p", name: "Main", columns: 4, rows: 3, items }, { id: "q", name: "Other", columns: 4, rows: 2, items: [] }], ...extra });
const btn = (id: string, x: number, y: number, extra: any = {}) => ({ id, kind: "button", label: id, x, y, ...extra });
const run = (name: string, layout: any, args: any) => OPERATIONS[name]!(layout, args);

describe("ops", () => {
  test("add_item: first free spot, explicit cell pushes others, widgets get default size and shrink", () => {
    const l = L([btn("a", 0, 0)]);
    const r = run("add_item", l, { page: "p", kind: "button", label: "B" }) as any;
    expect(r.ok).toBe(true);
    expect(r.layout.pages[0].items[1]).toMatchObject({ kind: "button", x: 1, y: 0 });
    const push = run("add_item", l, { page: "p", kind: "button", label: "B", x: 0, y: 0 }) as any;
    expect(push.ok).toBe(true);
    expect(push.note).toContain("pushed a");
    const w = run("add_item", l, { page: "p", kind: "widget", widget: "clock" }) as any;
    expect(w.layout.pages[0].items.at(-1)).toMatchObject({ widget: "clock", w: 4, h: 2 });
    expect(w.layout.pages[0].items.at(-1).y).toBe(1); // below the button: 4x2 only fits from row 1
    expect((run("add_item", l, { page: "p", kind: "button", x: 9, y: 0 }) as any).reason).toContain("does not fit");
    expect((run("add_item", l, { page: "nope", kind: "button" }) as any).reason).toContain("no page");
    expect((run("add_item", l, { page: "p", kind: "widget", widget: "bogus" }) as any).ok).toBe(false);
    expect((run("add_item", l, { page: "p", kind: "button", id: "a" }) as any).reason).toContain("already exists");
  });

  test("add_item on a full page is rejected with a readable reason", () => {
    const l = L(Array.from({ length: 12 }, (_, i) => btn(`b${i}`, i % 4, Math.floor(i / 4))));
    expect((run("add_item", l, { page: "p", kind: "button" }) as any).reason).toContain("no free space");
  });

  test("update_item whitelists fields; null removes; geometry and identity are refused", () => {
    const l = L([btn("a", 0, 0, { color: "#f00", icon: "home" })]);
    const r = run("update_item", l, { page: "p", id: "a", changes: { label: "New", color: null } }) as any;
    expect(r.layout.pages[0].items[0]).toMatchObject({ label: "New" });
    expect(r.layout.pages[0].items[0].color).toBeUndefined();
    expect((run("update_item", l, { page: "p", id: "a", changes: { x: 2 } }) as any).reason).toContain("move_item");
    expect((run("update_item", l, { page: "p", id: "a", changes: { kind: "widget" } }) as any).reason).toContain("cannot be changed");
    expect((run("update_item", l, { page: "p", id: "a", changes: { bogus: 1 } }) as any).reason).toContain("unknown item field");
    expect((run("update_item", l, { page: "p", id: "zz", changes: {} }) as any).reason).toContain("no item");
  });

  test("move_item (push, other page, outside) and resize_item", () => {
    const l = L([btn("a", 0, 0), btn("b", 1, 0)]);
    const m = run("move_item", l, { page: "p", id: "a", x: 1, y: 0 }) as any;
    expect(m.ok).toBe(true);
    const items = Object.fromEntries(m.layout.pages[0].items.map((i: any) => [i.id, i]));
    expect([items.a.x, items.a.y]).toEqual([1, 0]);
    expect(items.b.x !== 1 || items.b.y !== 0).toBe(true);
    const o = run("move_item", l, { page: "p", id: "a", x: 3, y: 1, toPage: "Other" }) as any;
    expect(o.layout.pages[0].items.map((i: any) => i.id)).toEqual(["b"]);
    expect(o.layout.pages[1].items[0]).toMatchObject({ id: "a", x: 3, y: 1 });
    expect((run("move_item", l, { page: "p", id: "a", x: 4, y: 0 }) as any).reason).toContain("does not fit");
    const r = run("resize_item", l, { page: "p", id: "a", w: 2, h: 2 }) as any;
    expect(r.ok).toBe(true);
    expect(r.layout.pages[0].items.find((i: any) => i.id === "a")).toMatchObject({ w: 2, h: 2 });
    expect((run("resize_item", l, { page: "p", id: "a", w: 9, h: 1 }) as any).reason).toContain("does not fit");
  });

  test("remove_item, pages, theme", () => {
    const l = L([btn("a", 0, 0, { action: { type: "page", page: "q" } })]);
    expect((run("remove_item", l, { page: "p", id: "a" }) as any).layout.pages[0].items).toEqual([]);
    expect((run("remove_page", l, { page: "q" }) as any).reason).toContain("p/a");
    const ap = run("add_page", l, { name: "Sounds" }) as any;
    expect(ap.layout.pages.at(-1)).toMatchObject({ id: "sounds", columns: 8, rows: 3 });
    expect((run("add_page", ap.layout, { name: "Sounds" }) as any).layout.pages.at(-1).id).toBe("sounds-2");
    expect((run("add_page", l, { name: "x", columns: 99 }) as any).reason).toContain("1-12");
    expect((run("update_page", l, { page: "p", rows: 1 }) as any).ok).toBe(true);
    expect((run("update_page", L([btn("z", 0, 2)]), { page: "p", rows: 1 }) as any).ok).toBe(false);
    expect((run("remove_page", L(), { page: "q" }) as any).ok).toBe(true);
    expect((run("remove_page", validateLayout({ version: 1, pages: [{ id: "p", name: "M", columns: 2, rows: 2, items: [] }] }), { page: "p" }) as any).reason).toContain("at least one");
    const t = run("set_theme", l, { theme: { accent: "#ff6b35", gap: 8 } }) as any;
    expect(t.layout.theme).toMatchObject({ accent: "#ff6b35", gap: 8 });
    expect((run("set_theme", t.layout, { theme: { gap: null } }) as any).layout.theme.gap).toBeUndefined();
    expect((run("set_theme", l, { theme: { nope: 1 } }) as any).reason).toContain("unknown theme field");
  });
});

describe("ascii", () => {
  test("grid shows labels, spans, free cells and a legend", () => {
    const out = layoutGrid(L([btn("a", 0, 0), { id: "w", kind: "widget", widget: "clock", x: 1, y: 0, w: 2, h: 2 }]), "p");
    expect(out).toContain('Page "Main" (id: p) 4 columns x 3 rows');
    expect(out).toContain("clock");
    expect(out).toContain("~~~~~~~~~");
    expect(out).toContain("w  widget:clock");
    expect(out).toContain("at 1,0  2x2");
    expect(out).toContain("Fill: 5/12 cells (42%)");
    expect(layoutGrid(L())).toContain('Page "Other"');
  });
});

function pipe() {
  const lines: any[] = [];
  let push!: (s: string) => void, end!: () => void;
  const input = (async function* () {
    const q: Uint8Array[] = [];
    let wake: (() => void) | null = null, done = false;
    push = (s) => { q.push(new TextEncoder().encode(s)); wake?.(); };
    end = () => { done = true; wake?.(); };
    while (true) {
      while (q.length) yield q.shift()!;
      if (done) return;
      await new Promise<void>((r) => { wake = r; });
    }
  })();
  return { lines, push: (s: string) => push(s), end: () => end(), input };
}

describe("protocol", () => {
  test("initialize, notifications, ping, tools/list, errors over fake stdio", async () => {
    const p = pipe();
    const done = runMcp({ port: 1, input: p.input, write: (l) => p.lines.push(JSON.parse(l)), fetch: async () => { throw new Error("down"); } });
    p.push(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) + "\n");
    p.push(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    p.push('{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,"meth');
    p.push('od":"tools/list"}\n');
    p.push("not json\n");
    p.push('{"jsonrpc":"2.0","id":4,"method":"nope"}\n');
    p.push('{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"zzz"}}\n');
    p.push('{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_layout","arguments":{}}}\n');
    p.end();
    await done;
    const by = (id: any) => p.lines.find((l) => l.id === id);
    expect(by(1).result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "nookdeck" } });
    expect(by(2).result).toEqual({});
    expect(by(3).result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(by(3).result.tools.every((t: any) => t.inputSchema.type === "object")).toBe(true);
    expect(p.lines.find((l) => l.error?.code === -32700)).toBeTruthy();
    expect(by(4).error.code).toBe(-32601);
    expect(by(5).error.code).toBe(-32602);
    expect(by(6).result.isError).toBe(true);
    expect(by(6).result.content[0].text).toContain("not reachable");
    expect(p.lines.filter((l) => l.id === 1 || l.method).length).toBe(1); // no reply to the notification
    expect((await handleMessage(new AgentApi(1), { jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "1999" } }) as any).result.protocolVersion).toBe("2025-06-18");
  });
});

describe("layout history", () => {
  test("push dedupes, caps at 50, files are 0600, undo returns the previous layout", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pd-hist-")), "h");
    let t = 1_700_000_000_000;
    const h = new LayoutHistory(dir, () => t++);
    expect(await h.undo()).toBeNull();
    const a = L([btn("a", 0, 0)]);
    await h.push(a);
    await h.push(a);
    expect((await h.list()).length).toBe(1);
    for (let i = 0; i < 60; i++) await h.push(L([btn(`b${i}`, 0, 0)]));
    expect((await h.list()).length).toBe(50);
    const files = readdirSync(dir);
    expect(files.length).toBe(50);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(MODE600);
    const prev = await h.undo();
    expect(prev!.pages[0]!.items[0]!.id).toBe("b58");
    expect((await h.list())[0]!.items).toBe(1);
  });
});

describe("tools against a real (temp) agent", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let api: InstanceType<typeof AgentApi>;
  const call = (name: string, args: any = {}) => callTool(api, name, args);
  const fakeIcons: any = {
    listApps: async () => [{ name: "Safari", bundleId: "com.apple.Safari" }, { name: "Finder", bundleId: "com.apple.finder" }],
    layoutAssets: async () => ({}),
    appIcon: async () => null,
    uploadIcon: async () => { throw new Error("n/a"); },
  };
  beforeAll(async () => {
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    app = await startServer({
      port: 0, pin: "222222", icons: fakeIcons,
      layoutHistoryDir: mkdtempSync(join(tmpdir(), "pd-mcp-hist-")),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
      hostName: async () => "t",
    } as any);
    api = new AgentApi(app.port);
  });
  afterAll(() => app.stop());

  test("get_layout, list_widgets, list_apps, search_icons", async () => {
    const g = await call("get_layout", { json: true });
    expect(g.isError).toBeUndefined();
    expect(g.text).toContain("Page ");
    expect(g.text).toContain('"version": 1');
    const first = await api.getLayout();
    const second = first.pages[1]?.id;
    if (second) {
      const only = await call("get_layout", { pageId: second });
      expect(only.text).toContain(`(id: ${second})`);
      expect(only.text).not.toContain(`(id: ${first.pages[0]!.id})`);
      expect((await call("get_layout", { pageId: second, json: true })).text.match(/"id": "/g)!.length).toBeGreaterThan(0);
      expect((await call("get_layout", { page: second })).text).toContain(`(id: ${second})`);
    }
    expect(await call("get_layout", { pageId: "nope" })).toMatchObject({ isError: true });
    expect((await call("list_widgets")).text).toContain("clock 4x2");
    expect((await call("list_apps", { query: "saf" })).text).toBe("Safari  app:com.apple.Safari");
    const s = await call("search_icons", { query: "home", limit: 5 });
    expect(s.text.split("\n")[0]).toStartWith("home ");
    expect(s.text.split("\n").length).toBeLessThanOrEqual(5);
    expect((await call("search_icons", { query: "zzzzqqq" })).text).toContain("no icon matches");
    expect((await call("search_icons", { query: "" })).isError).toBe(true);
  });

  test("mutations save through the agent, preview does not, undo reverts, history grows", async () => {
    const before = await api.getLayout();
    const pid = before.pages[0]!.id;
    const prev = await call("preview_changes", { operations: [{ tool: "add_page", args: { name: "Preview" } }] });
    expect(prev.text).toContain("Preview only, nothing saved");
    expect((await api.getLayout()).pages.length).toBe(before.pages.length);
    expect((await call("preview_changes", { operations: [{ tool: "nope", args: {} }] })).isError).toBe(true);

    const add = await call("add_page", { name: "Sound Board", columns: 4, rows: 2 });
    expect(add.text).toContain("Saved");
    expect((await api.getLayout()).pages.at(-1)).toMatchObject({ id: "sound-board", columns: 4, rows: 2 });
    const item = await call("add_item", { page: "sound-board", kind: "button", id: "air", label: "Air", icon: "lobe:ace" });
    expect(item.isError).toBeUndefined();
    expect((await call("move_item", { page: "sound-board", id: "air", x: 3, y: 1 })).text).toContain("moved");
    expect((await call("update_item", { page: "sound-board", id: "air", changes: { label: "Horn" } })).isError).toBeUndefined();
    expect((await call("resize_item", { page: "sound-board", id: "air", w: 1, h: 1 })).isError).toBeUndefined();
    expect((await call("set_theme", { theme: { accent: "#123456" } })).isError).toBeUndefined();
    const bad = await call("move_item", { page: "sound-board", id: "air", x: 9, y: 9 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("does not fit");
    expect((await api.getLayout()).theme?.accent).toBe("#123456");

    const hist = await api.history() as any[];
    expect(hist.length).toBeGreaterThanOrEqual(6);
    await call("undo");
    expect((await api.getLayout()).theme?.accent).not.toBe("#123456");
    await call("remove_item", { page: "sound-board", id: "air" });
    await call("remove_page", { page: "sound-board" });
    expect((await api.getLayout()).pages.some((p) => p.id === "sound-board")).toBe(false);
    expect((await api.getLayout()).pages[0]!.id).toBe(pid);
  });

  test("history/undo REST: 409 when nothing to undo; guarded; undo broadcasts the previous layout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-mcp-hist2-"));
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    const solo = await startServer({
      port: 0, pin: "333333", icons: fakeIcons, layoutHistoryDir: dir,
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
    } as any);
    const b = `http://127.0.0.1:${solo.port}`;
    const first = await (await fetch(`${b}/api/layout/history`)).json() as any[];
    expect(first.length).toBe(1);
    expect((await fetch(`${b}/api/layout/undo`, { method: "POST" })).status).toBe(409);
    const cur = await (await fetch(`${b}/api/layout`)).json() as any;
    cur.pages[0].name = "Renamed";
    await fetch(`${b}/api/layout`, { method: "PUT", body: JSON.stringify(cur) });
    expect(((await (await fetch(`${b}/api/layout/history`)).json()) as any[]).length).toBe(2);
    const u = await (await fetch(`${b}/api/layout/undo`, { method: "POST" })).json() as any;
    expect(u.ok).toBe(true);
    expect(u.layout.pages[0].name).not.toBe("Renamed");
    expect((await (await fetch(`${b}/api/layout`)).json() as any).pages[0].name).not.toBe("Renamed");
    solo.stop();
  });
});
