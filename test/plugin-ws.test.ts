// Plugin API additions for the OBS plugin (spec obs-integration-and-on-air FR-13, D3): ctx.net.websocket limited to declared
// ws origins, select settings with optionsFrom + ctx.settings.options, and ctx.onair.set behind the onair permission.
import "./_fetch";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-ws-home-"));
const { PluginStore } = await import("../src/plugins/store");
const { PluginHosts } = await import("../src/plugins/hosts");
const { PluginServices } = await import("../src/plugins/capabilities");
const { parseManifest, parsePermissions, describePermissions, covers, wsOrigin } = await import("../src/plugins/manifest");
const { WS_MAX_MESSAGE_BYTES, WS_MAX_SOCKETS, RPC_ERR } = await import("../src/plugins/api");

const tmp = (p = "pd-ws-") => mkdtempSync(join(tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await sleep(10); }
  throw new Error("timed out waiting: " + f.toString().slice(0, 120));
}
/** expect(p).rejects, with the plugin log in the message: a host that ends (as on the Windows runner) says why. */
async function rejectsWith(p: Promise<unknown>, m: RegExp | string, logFile: string) {
  const e: any = await p.then(() => null, (x) => x ?? new Error("rejected"));
  if (!e) throw new Error(`expected a rejection matching ${m}`);
  const msg = String(e?.message ?? e);
  if (typeof m === "string" ? msg.includes(m) : m.test(msg)) return;
  let log = "(no log)";
  try { log = readFileSync(logFile, "utf8").slice(-4000); } catch { /* none yet */ }
  throw new Error(`"${msg}" does not match ${m}\nplugin log:\n${log}`);
}
const servers: Array<{ stop(force?: boolean): void }> = [];
const hosts: Array<InstanceType<typeof PluginHosts>> = [];
afterAll(async () => { await Promise.all(hosts.map((h) => h.stopAll())); for (const s of servers) s.stop(true); });

/** A WebSocket server that echoes "echo:<text>", answers "big" with a frame over the limit and "bin" with a binary frame. */
function wsServer() {
  const seen = { opens: 0, closes: 0, protocols: [] as string[], texts: [] as string[] };
  const s = Bun.serve<undefined, undefined>({
    port: 0,
    fetch(req, srv) {
      seen.protocols.push(req.headers.get("sec-websocket-protocol") ?? "");
      const proto = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
      return srv.upgrade(req, proto ? { headers: { "Sec-WebSocket-Protocol": proto } } : {}) ? undefined : new Response("ws only", { status: 400 });
    },
    websocket: {
      open(ws) { seen.opens++; ws.send("hello"); },
      close() { seen.closes++; },
      message(ws, m) {
        const t = String(m);
        seen.texts.push(t);
        if (t === "big") ws.send("x".repeat(WS_MAX_MESSAGE_BYTES + 10));
        else if (t === "bin") ws.send(new Uint8Array([1, 2, 3]));
        else ws.send(`echo:${t}`);
      },
    },
  });
  servers.push(s);
  return { port: s.port, seen, url: `ws://127.0.0.1:${s.port}`, origin: `ws://127.0.0.1:${s.port}` };
}

describe("manifest: ws origins, onair, optionsFrom", () => {
  test("permissions.network takes WebSocket origins with an explicit port, normalized; bad ones are refused", () => {
    const p = parsePermissions({ network: ["WS://127.0.0.1:4455", "wss://Example.com:443", "api.example.com"], onair: true });
    expect(p).toEqual({ network: ["ws://127.0.0.1:4455", "wss://example.com:443", "api.example.com"], onair: true });
    for (const bad of ["ws://127.0.0.1", "ws://127.0.0.1:4455/path", "ws://*.example.com:80", "ws://127.0.0.1:0", "ws://127.0.0.1:70000", "ws://a b:80", "ws://u:p@host:80"]) {
      expect(() => parsePermissions({ network: [bad] })).toThrow(/WebSocket origin/);
    }
    expect(() => parsePermissions({ network: ["http://example.com"] })).toThrow(/host name/);
    expect(() => parsePermissions({ onair: "yes" })).toThrow(/onair must be true or false/);
    expect(() => parsePermissions({ camera: true })).toThrow(/onair/);
  });

  test("install lines and the grant check know the new permissions", () => {
    expect(describePermissions({ network: ["ws://127.0.0.1:4455"], onair: true })).toEqual(["Connect to 127.0.0.1:4455", "Turn On Air on"]);
    expect(covers({ network: ["ws://127.0.0.1:4455"] }, { network: ["ws://127.0.0.1:4455"], onair: true })).toBe(false);
    expect(covers({ network: ["ws://127.0.0.1:4455"], onair: true }, { network: ["ws://127.0.0.1:4455"], onair: true })).toBe(true);
    // a host name does not cover a ws origin on it, nor the other way round
    expect(covers({ network: ["127.0.0.1"] }, { network: ["ws://127.0.0.1:4455"] })).toBe(false);
    expect(covers({ network: ["ws://127.0.0.1:4455"] }, { network: ["127.0.0.1"] })).toBe(false);
  });

  test("wsOrigin fills in the default port and refuses what is not a plain ws address", () => {
    expect(wsOrigin("ws://127.0.0.1")).toBe("ws://127.0.0.1:80");
    expect(wsOrigin("wss://Example.COM/x?y")).toBe("wss://example.com:443");
    expect(wsOrigin("ws://u:p@127.0.0.1:4455")).toBeNull();
    expect(wsOrigin("http://127.0.0.1:4455")).toBeNull();
    expect(wsOrigin("not a url")).toBeNull();
    expect(wsOrigin("ws://127.0.0.1:4455@evil.example:80")).toBe(null); // a user part: refused outright
  });

  test("a select may take optionsFrom (code plugins only), never both options and optionsFrom", () => {
    const base = { id: "dev.t.sel", name: "S", version: "1.0.0", main: "index.js" };
    const m = parseManifest({ ...base, settings: [{ key: "scene", type: "select", optionsFrom: "scenes", default: "Main" }], actions: [{ id: "a", settings: [{ key: "input", type: "select", optionsFrom: "inputs" }] }] });
    expect(m.settings[0]).toEqual({ key: "scene", type: "select", label: "scene", optionsFrom: "scenes", default: "Main" });
    expect(m.actions[0]!.settings[0]!.optionsFrom).toBe("inputs");
    expect(() => parseManifest({ ...base, settings: [{ key: "s", type: "select", optionsFrom: "x", options: ["a"] }] })).toThrow(/not both/);
    expect(() => parseManifest({ ...base, settings: [{ key: "s", type: "string", optionsFrom: "x" }] })).toThrow(/only for a select/);
    expect(() => parseManifest({ ...base, settings: [{ key: "s", type: "select", optionsFrom: "Bad Id" }] })).toThrow(/provider id/);
    const { main: _m, ...noCode } = base;
    expect(() => parseManifest({ ...noCode, settings: [{ key: "s", type: "select", optionsFrom: "x" }] })).toThrow(/needs a code plugin/);
  });
  test("a value of an optionsFrom select is kept as it is (the list is only known at run time); a fixed select still checks it", async () => {
    const { coerce } = await import("../src/plugins/sources");
    expect(coerce({ key: "scene", type: "select", label: "Scene", optionsFrom: "scenes" }, "Intro (BRB) 2")).toBe("Intro (BRB) 2");
    expect(coerce({ key: "scene", type: "select", label: "Scene", optionsFrom: "scenes" }, "")).toBeUndefined();
    expect(coerce({ key: "scene", type: "select", label: "Scene", optionsFrom: "scenes" }, "x".repeat(201))).toBeUndefined();
    expect(coerce({ key: "scene", type: "select", label: "Scene", optionsFrom: "scenes" }, 3)).toBeUndefined();
    expect(coerce({ key: "to", type: "select", label: "To", options: ["run", "pause"] }, "other")).toBeUndefined();
  });
});

function services(network: string[], extra: Partial<ConstructorParameters<typeof PluginServices>[0]> = {}) {
  const notes: Array<{ method: string; params: any }> = [];
  let granted: any = { network };
  const svc = new PluginServices({ granted: () => granted, fetch: fetch, shell: async () => ({ code: 0, stdout: "" }), keys: { hotkey: async () => {}, type: async () => {} }, dataFile: join(tmp(), "d.json"), ...extra });
  svc.attach((method, params) => notes.push({ method, params }));
  return { svc, notes, setGranted: (g: any) => { granted = g; } };
}

describe("net.ws in the agent: origin check, limits, cleanup", () => {
  test("only the exact listed origin opens; odd spellings of other places are refused before any connection", async () => {
    const a = wsServer();
    const { svc, notes } = services([a.origin]);
    const { sid } = await svc.wsOpen(`${a.url}/any/path?x=1`, ["obswebsocket.json"]);
    await until(() => notes.some((n) => n.method === "net.ws.message" && n.params.text === "hello"));
    expect(a.seen.protocols.at(-1)).toBe("obswebsocket.json");
    await svc.wsSend(sid, "hi");
    await until(() => notes.some((n) => n.params?.text === "echo:hi"));
    const before = a.seen.opens;
    const refused = [
      `ws://localhost:${a.port}`,            // same machine, other spelling: not listed
      `ws://127.0.0.1:${a.port + 1}`,         // other port
      `wss://127.0.0.1:${a.port}`,            // other scheme
      `http://127.0.0.1:${a.port}`,           // not a WebSocket address
      `ws://user:pw@127.0.0.1:${a.port}`,     // credentials
      `ws://127.0.0.1:${a.port}@example.com`, // the host is example.com
      `ws://127.0.0.1.nip.io:${a.port}`,      // a look-alike host
      `ws://[::1]:${a.port}`,
    ];
    for (const u of refused) {
      const err = await svc.wsOpen(u, []).then(() => null, (e) => e);
      expect(err, u).not.toBeNull();
      expect([RPC_ERR.hostNotAllowed, RPC_ERR.invalidParams]).toContain(err.code);
    }
    expect(a.seen.opens).toBe(before);
    svc.closeAllSockets();
  });

  test("no grant, no socket; a bad protocol name is refused", async () => {
    const a = wsServer();
    const { svc } = services([]);
    await expect(svc.wsOpen(a.url, [])).rejects.toMatchObject({ code: RPC_ERR.hostNotAllowed });
    const { svc: s2 } = services([a.origin]);
    await expect(s2.wsOpen(a.url, ["bad proto"])).rejects.toMatchObject({ code: RPC_ERR.invalidParams });
  });

  test("a redirect answer to the upgrade is not followed", async () => {
    const target = wsServer();
    const redir = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: target.url } }) });
    servers.push(redir);
    const { svc } = services([`ws://127.0.0.1:${redir.port}`]);
    await expect(svc.wsOpen(`ws://127.0.0.1:${redir.port}`, [])).rejects.toThrow(/cannot connect/);
    expect(target.seen.opens).toBe(0);
    expect(svc.openSockets()).toBe(0);
  });

  test(`limits: ${WS_MAX_SOCKETS} sockets, ${WS_MAX_MESSAGE_BYTES} bytes per message either way, text frames only`, async () => {
    const a = wsServer();
    const { svc, notes } = services([a.origin]);
    const sids: number[] = [];
    for (let i = 0; i < WS_MAX_SOCKETS; i++) sids.push((await svc.wsOpen(a.url, [])).sid);
    await expect(svc.wsOpen(a.url, [])).rejects.toMatchObject({ code: RPC_ERR.limit });
    await expect(svc.wsSend(sids[0], "x".repeat(WS_MAX_MESSAGE_BYTES + 1))).rejects.toMatchObject({ code: RPC_ERR.limit });
    await expect(svc.wsSend(sids[0], { not: "text" } as any)).rejects.toMatchObject({ code: RPC_ERR.invalidParams });
    // a too-big frame from the server closes that socket (1009), a binary one closes it too (1003); the others stay
    await svc.wsSend(sids[0], "big");
    await svc.wsSend(sids[1], "bin");
    await until(() => notes.filter((n) => n.method === "net.ws.closed").length === 2);
    const closed = notes.filter((n) => n.method === "net.ws.closed").map((n) => [n.params.sid, n.params.code]);
    expect(closed).toContainEqual([sids[0], 1009]);
    expect(closed).toContainEqual([sids[1], 1003]);
    expect(notes.some((n) => n.method === "net.ws.message" && n.params.text.length > 1000)).toBe(false);
    expect(svc.openSockets()).toBe(WS_MAX_SOCKETS - 2);
    // room again: one more opens
    sids.push((await svc.wsOpen(a.url, [])).sid);
    await expect(svc.wsSend(sids[0], "after close")).rejects.toThrow(/closed/);
    svc.closeAllSockets();
    expect(svc.openSockets()).toBe(0);
    await until(() => a.seen.closes >= WS_MAX_SOCKETS + 1);
  });

  test("withdrawing the host cuts the socket on the next send", async () => {
    const a = wsServer();
    const { svc, notes, setGranted } = services([a.origin]);
    const { sid } = await svc.wsOpen(a.url, []);
    setGranted({ network: [] });
    await expect(svc.wsSend(sid, "x")).rejects.toMatchObject({ code: RPC_ERR.hostNotAllowed });
    await until(() => notes.some((n) => n.method === "net.ws.closed" && n.params.code === 1008));
  });

  test("onair.set needs the onair permission and checks its values", async () => {
    const calls: unknown[][] = [];
    const { svc, setGranted } = services([], { onair: (...a) => calls.push(a) });
    await expect(svc.onairSet("stream", true, undefined)).rejects.toMatchObject({ code: RPC_ERR.permissionDenied, data: { permission: "onair" } });
    setGranted({ network: [], onair: true });
    const since = Date.now() - 5000;
    await svc.onairSet("stream", true, since);
    await svc.onairSet("record", false, since);
    expect(calls).toEqual([["stream", true, since], ["record", false, undefined]]);
    await expect(svc.onairSet("call", true, undefined)).rejects.toMatchObject({ code: RPC_ERR.invalidParams });
    await expect(svc.onairSet("stream", "yes", undefined)).rejects.toMatchObject({ code: RPC_ERR.invalidParams });
    await expect(svc.onairSet("stream", true, Date.now() + 3_600_000)).rejects.toMatchObject({ code: RPC_ERR.invalidParams });
  });
});

/** A plugin folder: manifest + index.js with the given activate() body. */
function plugin(id: string, body: string, manifest: Record<string, unknown> = {}): string {
  const dir = tmp("pd-wsplug-");
  writeFileSync(join(dir, "nookdeck.json"), JSON.stringify({
    id, name: id, version: "1.0.0", main: "index.js",
    widgets: [{ id: "w", name: "w", render: "text" }], actions: [{ id: "a", name: "a" }],
    ...manifest,
  }));
  writeFileSync(join(dir, "index.js"), `export function activate(ctx) {\n${body}\n}\n`);
  return dir;
}

async function setup(dir: string, id: string, over: Record<string, unknown> = {}) {
  const d = tmp();
  const store = new PluginStore({ dir: join(d, "plugins"), stateFile: join(d, "plugins.json"), agentVersion: "0.7.0" });
  await store.load();
  const r = await store.install(dir);
  await store.grant(id, r.plugin.permissions);
  await store.setEnabled(id, true);
  const onair: Array<[string, ...unknown[]]> = [];
  const h = new PluginHosts(store, {
    fetch: fetch, shell: async () => ({ code: 0, stdout: "" }), keys: { hotkey: async () => {}, type: async () => {} },
    logDir: join(d, "logs"), dataDir: join(d, "data"),
    // the REST test's ping timing: it runs the same throwing provider and passes on the Windows runner
    timing: { pingIntervalMs: 500, pingTimeoutMs: 10_000, callTimeoutMs: 20_000, backoffMs: [60, 120], restartMax: 3 },
    onair: { set: (pid: string, kind: string, on: boolean, since?: number) => onair.push(["set", pid, kind, on, since]), clear: (pid: string) => onair.push(["clear", pid]) },
    ...over,
  } as any);
  hosts.push(h);
  return { store, h, onair, logFile: join(d, "logs", `${id}.log`) };
}

describe("through a real plugin host", () => {
  setDefaultTimeout(60_000);
  test("ctx.net.websocket: early frames are kept, send/onMessage/onClose, a closed socket refuses send", async () => {
    const a = wsServer();
    const dir = plugin("dev.t.ws", `
      let ws, got = [], closed = null;
      ctx.actions.handle("a", async (s) => {
        if (s.do === "open") { ws = await ctx.net.websocket(${JSON.stringify(a.url)}, { protocols: ["obswebsocket.json"] }); await new Promise((r) => setTimeout(r, 100)); ws.onMessage((t) => got.push(t)); ws.onClose((c) => { closed = c; }); }
        if (s.do === "send") ws.send(s.text);
        if (s.do === "close") ws.close();
        if (s.do === "bad") await ctx.net.websocket("ws://localhost:1/");
      });
      ctx.widgets.provide("w", async () => ({ render: "text", data: { body: JSON.stringify({ got, closed }) } }));
    `, { permissions: { network: [a.origin] } });
    const { h, logFile } = await setup(dir, "dev.t.ws");
    await h.action("dev.t.ws", "a", { do: "open" });
    await h.action("dev.t.ws", "a", { do: "send", text: "one" });
    await h.action("dev.t.ws", "a", { do: "send", text: "two" });
    const state = async () => JSON.parse(String((await h.widget("dev.t.ws", "w", {})).data && ((await h.widget("dev.t.ws", "w", {})).data as any).body));
    await until(async () => (await state()).got.length === 3);
    expect((await state()).got).toEqual(["hello", "echo:one", "echo:two"]); // "hello" came before onMessage was set
    await rejectsWith(h.action("dev.t.ws", "a", { do: "bad" }), /localhost:1 is not in this plugin's allowed hosts|permission denied: network/, logFile);
    await h.action("dev.t.ws", "a", { do: "close" });
    await until(async () => (await state()).closed === 1000);
    await expect(h.action("dev.t.ws", "a", { do: "send", text: "late" })).rejects.toThrow(/closed/);
  });

  test("stopping the plugin closes its sockets on the server and clears its On Air state", async () => {
    const a = wsServer();
    const dir = plugin("dev.t.stop", `
      ctx.actions.handle("a", async () => { await ctx.net.websocket(${JSON.stringify(a.url)}); ctx.onair.set("stream", true, Date.now() - 1000); });
    `, { permissions: { network: [a.origin], onair: true } });
    const { h, onair } = await setup(dir, "dev.t.stop");
    await h.action("dev.t.stop", "a", {});
    await until(() => a.seen.opens === 1 && onair.some((x) => x[0] === "set"));
    expect(onair.find((x) => x[0] === "set")!.slice(1, 4)).toEqual(["dev.t.stop", "stream", true]);
    await h.stop("dev.t.stop");
    await until(() => a.seen.closes === 1);
    expect(onair.at(-1)).toEqual(["clear", "dev.t.stop"]);
  });

  test("without the onair permission ctx.onair is absent; with it, the plugin starts without being called and is not stopped as idle", async () => {
    const a = wsServer();
    const off = plugin("dev.t.noair", `ctx.widgets.provide("w", () => ({ render: "text", data: { body: typeof ctx.onair } }));`);
    const { h: h1 } = await setup(off, "dev.t.noair");
    expect(((await h1.widget("dev.t.noair", "w", {})).data as any).body).toBe("undefined");
    const on = plugin("dev.t.air", `
      ctx.net.websocket(${JSON.stringify(a.url)}).then(() => ctx.onair.set("record", true));
    `, { permissions: { network: [a.origin], onair: true } });
    const { h, onair } = await setup(on, "dev.t.air", { timing: { pingIntervalMs: 150, pingTimeoutMs: 2000, callTimeoutMs: 8000, idleStopMs: 200 } });
    h.startEager();
    await until(() => onair.some((x) => x[0] === "set" && x[2] === "record"));
    await sleep(700); // several idle periods
    expect(h.info("dev.t.air").state).toBe("running");
    expect(a.seen.closes).toBe(0);
  });

  test("an idle plugin without sockets or onair is still stopped", async () => {
    const dir = plugin("dev.t.idle", `ctx.widgets.provide("w", () => ({ render: "text", data: { body: "x" } }));`);
    const { h } = await setup(dir, "dev.t.idle", { timing: { pingIntervalMs: 150, pingTimeoutMs: 2000, callTimeoutMs: 8000, idleStopMs: 200 } });
    await h.widget("dev.t.idle", "w", {});
    await until(() => h.info("dev.t.idle").state === "stopped", 3000);
  });

  test("ctx.settings.options: called with the settings, cleaned (strings, no duplicates, at most 200), errors pass through", async () => {
    const dir = plugin("dev.t.opts", `
      ctx.settings.options("scenes", async (s) => ["Main", "Main", 3, "", "Intro " + (s.suffix ?? ""), ...Array.from({ length: 300 }, (_, i) => "s" + i)]);
      ctx.settings.options("broken", () => { throw new Error("OBS is not connected"); });
    `, { settings: [{ key: "scene", type: "select", optionsFrom: "scenes" }, { key: "x", type: "select", optionsFrom: "broken" }] });
    const { h, logFile } = await setup(dir, "dev.t.opts");
    const list = await h.options("dev.t.opts", "scenes", { suffix: "A" });
    expect(list.slice(0, 3)).toEqual(["Main", "Intro A", "s0"]);
    expect(list.length).toBe(200);
    await rejectsWith(h.options("dev.t.opts", "broken", {}), "OBS is not connected", logFile);
    await expect(h.options("dev.t.opts", "nope", {})).rejects.toThrow(/no options provider/);
  });
});

describe("REST and the agent: options route, onair plugins start with the agent", () => {
  setDefaultTimeout(60_000);
  test("POST /api/plugins/:id/options merges the form over the saved settings, keeps secrets server-side, and reports a provider error", async () => {
    const { startServer } = await import("../src/server");
    const a = wsServer();
    const dir = plugin("dev.t.optrest", `
      ctx.settings.options("scenes", (s) => ["host=" + s.host, "pw=" + (s.password ? "set" : "none"), "x=" + (s.x ?? "-")]);
      ctx.settings.options("fails", () => { throw new Error("OBS is not connected"); });
      ctx.net.websocket(${JSON.stringify(a.url)}).then(() => ctx.onair.set("stream", true, Date.now() - 2000), (e) => ctx.log("ws error", e.message));
    `, {
      permissions: { network: [a.origin], onair: true },
      settings: [{ key: "host", type: "string", default: "127.0.0.1" }, { key: "password", type: "secret" }, { key: "scene", type: "select", optionsFrom: "scenes" }, { key: "x", type: "select", optionsFrom: "fails" }],
    });
    const d = tmp();
    const store = new PluginStore({ dir: join(d, "plugins"), stateFile: join(d, "plugins.json"), agentVersion: "0.7.0" });
    await store.load();
    const r = await store.install(dir);
    await store.grant("dev.t.optrest", r.plugin.permissions);
    await store.setEnabled("dev.t.optrest", true);
    await store.setSettings("dev.t.optrest", { host: "studio", password: "s3cret" });
    const app = await startServer({
      port: 0, pin: "111111", plugins: store, hostName: async () => "x", deps: { startStats: () => () => {} } as any,
      pluginHostDeps: { logDir: join(d, "logs"), dataDir: join(d, "data"), timing: { pingIntervalMs: 500 } },
      onairFile: join(d, "onair.json"),
      hookSecret: "s", hookPaths: { claude: join(d, "c.json"), codex: join(d, "x.json") },
    } as any);
    try {
      const base = `http://localhost:${app.port}`;
      const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-nookdeck": "1" }, body: JSON.stringify(body) });
      // started with the agent (onair): its socket is open and On Air counts it, with no call and no phone
      await until(() => a.seen.opens === 1);
      await until(() => (app as any).onair.snapshot().sources.includes("obs-stream"));
      const ok = await post("/api/plugins/dev.t.optrest/options", { provider: "scenes", settings: { x: "typed", password: "from-the-form" } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ options: ["host=studio", "pw=set", "x=typed"] });
      const bad = await post("/api/plugins/dev.t.optrest/options", { provider: "fails", settings: {} });
      expect(bad.status).toBe(502);
      expect(await bad.json()).toEqual({ error: "OBS is not connected" });
      expect((await post("/api/plugins/dev.t.optrest/options", { provider: "undeclared" })).status).toBe(400);
      const { rawFetch } = await import("./_fetch");
      expect((await rawFetch(`${base}/api/plugins/dev.t.optrest/options`, { method: "POST", body: JSON.stringify({ provider: "scenes" }) })).status).toBeGreaterThanOrEqual(400);
      // disabled: the socket closes and the On Air source goes away
      expect((await post("/api/plugins/dev.t.optrest/enabled", { enabled: false })).status).toBe(200);
      await until(() => a.seen.closes === 1);
      await until(() => !(app as any).onair.snapshot().sources.includes("obs-stream"));
    } finally { app.stop(); }
  });
});

describe("ctx.widgets.push(fn): each tile's settings", () => {
  test("the function gets the tile's size and its settings, so a tile can show its own scene", async () => {
    const { createPushQueue } = await import("../src/plugins/push-queue");
    const sent: Array<{ key?: string; data: unknown }> = [];
    const push = createPushQueue({
      tiles: async () => [{ key: "a", size: { w: 1, h: 1 }, settings: { scene: "Intro" } }, { key: "b", size: { w: 2, h: 1 }, settings: { scene: "Main" } }, { key: "c", size: { w: 1, h: 1 } }],
      send: (_id, u, key) => sent.push({ key, data: u.data }),
      log: () => {},
    });
    push("scene", (tile, s) => ({ data: { root: { t: "text", text: `${tile.w}:${s.scene ?? "-"}:${s.scene === "Main"}` } } }));
    await until(() => sent.length === 3);
    expect(sent.map((x) => [x.key, (x.data as any).root.text])).toEqual([["a", "1:Intro:false"], ["b", "2:Main:true"], ["c", "1:-:false"]]);
  });
});

describe("ctx.notify (permission: notify)", () => {
  setDefaultTimeout(60_000);
  test("the agent checks the grant, the fields and the rate, and trims what it keeps", async () => {
    const got: any[] = [];
    let now = 1_000_000;
    let granted: any = { network: [] };
    const s = new PluginServices({ granted: () => granted, fetch, shell: async () => ({ code: 0, stdout: "" }), keys: { hotkey: async () => {}, type: async () => {} }, dataFile: join(tmp(), "d.json"), notify: (n: any) => got.push(n), now: () => now } as any);
    await expect(s.request("notify", { title: "x" })).rejects.toThrow(/notify/);
    granted = { network: [], notify: true };
    await expect(s.request("notify", {})).rejects.toThrow(/title/);
    await expect(s.request("notify", { title: "x", sound: "siren" })).rejects.toThrow(/sound/);
    await expect(s.request("notify", { title: "x", level: "loud" })).rejects.toThrow(/level/);
    await s.request("notify", { title: "  Drink water  ", body: "b".repeat(600), level: "warn", sound: "chime" });
    expect(got[0]).toEqual({ title: "Drink water", body: "b".repeat(500), level: "warn", sound: "chime" });
    for (let i = 1; i < 6; i++) await s.request("notify", { title: `n${i}` });
    await expect(s.request("notify", { title: "seventh" })).rejects.toMatchObject({ code: RPC_ERR.limit, message: expect.stringMatching(/6 notifications a minute/) });
    now += 60_001;
    await s.request("notify", { title: "a minute later" });
    expect(got.length).toBe(7);
    expect(describePermissions({ network: [], notify: true })).toEqual(["Show notifications on your phones"]);
    expect(covers({ network: [] }, { network: [], notify: true })).toBe(false);
  });

  test("through a real host: ctx.notify exists only when granted, and reaches the agent with the plugin id", async () => {
    const got: any[] = [];
    const on = plugin("dev.t.note", `ctx.actions.handle("a", async () => { await ctx.notify("Pomodoro done", { body: "Take a break", sound: "soft" }); });`, { permissions: { notify: true } });
    const { h } = await setup(on, "dev.t.note", { notify: (pid: string, n: any) => got.push([pid, n]) });
    await h.action("dev.t.note", "a", {});
    expect(got).toEqual([["dev.t.note", { title: "Pomodoro done", body: "Take a break", sound: "soft" }]]);
    const off = plugin("dev.t.nonote", `ctx.widgets.provide("w", () => ({ render: "text", data: { body: typeof ctx.notify } }));`);
    const { h: h2 } = await setup(off, "dev.t.nonote");
    expect(((await h2.widget("dev.t.nonote", "w", {})).data as any).body).toBe("undefined");
  });
});

describe("plugins granted notify keep running", () => {
  setDefaultTimeout(60_000);
  test("they start with the agent and are not stopped as idle, so a reminder comes while the phones sleep", async () => {
    const dir = plugin("dev.t.remind", `ctx.widgets.provide("w", () => ({ render: "text", data: { body: "x" } }));`, { permissions: { notify: true } });
    const { h } = await setup(dir, "dev.t.remind", { timing: { pingIntervalMs: 150, pingTimeoutMs: 2000, callTimeoutMs: 8000, idleStopMs: 200 } });
    h.startEager();
    await until(() => h.info("dev.t.remind").state === "running", 8000);
    await sleep(700); // several idle periods
    expect(h.info("dev.t.remind").state).toBe("running");
  });
});
