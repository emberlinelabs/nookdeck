import "./_fetch";
import { rawFetch } from "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-auto-"));
const { startServer } = await import("../src/server");

const ran: any[] = [];
const hassCalls: any[] = [];
let hassUp = true;
let failShell = false;
const weatherUrls: string[] = [];
let app: Awaited<ReturnType<typeof startServer>>;
let base: string;
let key: string;
let token: string;

const btn = (id: string, action: any) => ({ id, kind: "button", label: id, action });
const LAYOUT = () => ({
  version: 1,
  pages: [
    { id: "main", name: "Main", columns: 6, rows: 4, items: [
      btn("mac", { type: "macro", steps: [{ kind: "hotkey", keys: "cmd+c" }, { kind: "wait", ms: 10 }, { kind: "shell", command: "echo hi" }, { kind: "notify", text: "macro xong" }] }),
      btn("macfail", { type: "macro", steps: [{ kind: "shell", command: "fail" }, { kind: "hotkey", keys: "x" }] }),
      btn("ha", { type: "hass", service: "light.toggle", entityId: "light.a" }),
      btn("nest", { type: "macro", steps: [{ kind: "item", pageId: "main", itemId: "mac" }] }),
      { id: "wx", kind: "widget", widget: "weather", weather: { location: { name: "HN", lat: 21, lon: 105.8 } }, w: 2, h: 2 },
    ] },
    { id: "media", name: "Media", columns: 4, rows: 2, items: [] },
  ],
  rules: [
    { id: "r1", name: "Too hot", enabled: true, when: { kind: "push", key: "temp", op: ">", value: 30 }, then: [{ kind: "goto-page", pageId: "media", countdown: 3 }, { kind: "notify", text: "hot", level: "warn" }, { kind: "theme-mode", mode: "dark" }], revert: true },
  ],
});

function connect(tok: string) {
  const ws = new WebSocket(`ws://localhost:${app.port}/ws?token=${tok}`);
  const msgs: any[] = [];
  const waiters: Array<() => void> = [];
  ws.onmessage = (e) => { msgs.push(JSON.parse(String(e.data))); waiters.forEach((w) => w()); };
  const next = (pred: (m: any) => boolean, ms = 3000) => new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const check = () => { const i = msgs.findIndex(pred); if (i >= 0) { clearTimeout(t); resolve(msgs.splice(i, 1)[0]); return true; } return false; };
    if (check()) return;
    const w = () => { if (check()) waiters.splice(waiters.indexOf(w), 1); };
    waiters.push(w);
  });
  return { ws, next, msgs };
}
const authed = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });

beforeAll(async () => {
  const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
  app = await startServer({
    port: 0, pin: "444444", hostName: async () => "my-mac",
    webhookKeyFile: join(process.env.NOOKDECK_HOME!, "webhook-key"),
    layoutHistoryDir: mkdtempSync(join(tmpdir(), "pd-auto-hist-")),
    hass: { connected: () => hassUp, getState: () => undefined, callService: async (s, e, d) => { hassCalls.push([s, e, d]); } },
    weatherFetch: async (u) => { weatherUrls.push(u); return Response.json(u.includes("geocoding") ? { results: [{ name: "Hanoi", latitude: 21, longitude: 105.8 }] } : { current: { time: "2026-11-17T10:00", temperature_2m: 31, weather_code: 0, is_day: 1 }, hourly: { time: [], temperature_2m: [], weather_code: [] }, daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [] } }); },
    deps: { runAction: async (a: any) => { ran.push(a); if (a.type === "shell" && a.command === "fail" && !failShell) throw new Error("boom"); }, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
    aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
  } as any);
  base = `http://localhost:${app.port}`;
  expect((await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(LAYOUT()) })).status).toBe(200);
  key = ((await (await fetch(`${base}/api/webhooks?reveal=1`)).json()) as any).key;
  const r = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "444444", name: "t" }) })).json() as any;
  token = r.token;
});
afterAll(async () => {
  // config's HOME is shared by every test file in this process: put the default layout back for the others
  const { defaultLayout } = await import("../src/config");
  await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(defaultLayout()) });
  app.stop();
});

describe("webhook auth and routes", () => {
  test("Bearer key opens push/notify/goto; wrong key, no key, foreign Host are refused", async () => {
    expect((await rawFetch(`${base}/api/push/temp`, { method: "POST", body: "20", headers: authed() })).status).toBe(200); // text/plain is fine with the key
    expect((await rawFetch(`${base}/api/push/temp`, { method: "POST", body: "20" })).status).toBe(403); // localhost without the key: CSRF rules
    expect((await rawFetch(`${base}/api/push/temp`, { method: "POST", body: "20", headers: { authorization: "Bearer nope" } })).status).toBe(403);
    expect((await rawFetch(`${base}/api/push/temp`, { method: "POST", body: "20", headers: authed({ host: "evil.example" }) })).status).toBe(403);
    expect((await rawFetch(`${base}/api/push/BAD KEY`, { method: "POST", body: "1", headers: authed() })).status).toBe(400);
    expect((await rawFetch(`${base}/api/push/temp`, { method: "POST", body: "", headers: authed() })).status).toBe(400);
    // the management page itself (localhost rules, no key) still works
    expect((await fetch(`${base}/api/push/temp`, { method: "POST", body: "21" })).status).toBe(200);
    // the key does not open the phone/management API
    expect((await rawFetch(`${base}/api/layout`, { method: "PUT", body: "{}", headers: authed() })).status).toBe(403);
    expect((await rawFetch(`${base}/api/webhooks/key/rotate`, { method: "POST", headers: authed() })).status).toBe(403);
  });

  test("GET /api/webhooks masks the key and lists curl examples; rotate invalidates the old key", async () => {
    const info = await (await fetch(`${base}/api/webhooks`)).json() as any;
    expect(info.key).toBeUndefined();
    expect(info.keyMasked).toContain("****");
    expect(info.keyMasked).not.toBe(key);
    expect(info.examples.join("\n")).toContain("my-mac.local");
    expect(info.examples.join("\n")).not.toContain(key);
    const old = key;
    const rot = await (await fetch(`${base}/api/webhooks/key/rotate`, { method: "POST", body: "{}" })).json() as any;
    expect(rot.key).not.toBe(old);
    expect((await rawFetch(`${base}/api/push/temp`, { method: "POST", body: "5", headers: { authorization: `Bearer ${old}` } })).status).toBe(403);
    key = rot.key;
    expect((await rawFetch(`${base}/api/push/temp`, { method: "POST", body: "5", headers: authed() })).status).toBe(200);
  });

  test("push reaches phones (delta and snapshot on connect, ttl removes it)", async () => {
    const a = connect(token);
    await a.next((m) => m.type === "hello");
    await rawFetch(`${base}/api/push/co2`, { method: "POST", body: JSON.stringify({ value: 420, sub: "living room" }), headers: authed({ "content-type": "application/json" }) });
    const m = await a.next((x) => x.type === "pushed" && x.values.co2);
    expect(m.values.co2).toMatchObject({ value: 420, sub: "living room" });
    const b = connect(token);
    const snap = await b.next((x) => x.type === "pushed" && x.values.co2);
    expect(snap.values.co2.value).toBe(420);
    await rawFetch(`${base}/api/push/short`, { method: "POST", body: JSON.stringify({ value: 1, ttl: 0.05 }), headers: authed({ "content-type": "application/json" }) });
    await a.next((x) => x.type === "pushed" && x.values.short);
    expect((await a.next((x) => x.type === "pushed" && x.values.short === null)).values.short).toBeNull();
    a.ws.close(); b.ws.close();
  });

  test("notify: broadcast, validation, history on connect and REST", async () => {
    const a = connect(token);
    await a.next((m) => m.type === "notifications");
    expect((await rawFetch(`${base}/api/notify`, { method: "POST", body: JSON.stringify({ title: "Xong", body: "ok", level: "alert" }), headers: authed({ "content-type": "application/json" }) })).status).toBe(200);
    const n = await a.next((m) => m.type === "notify" && m.notification.title === "Xong");
    expect(n.notification).toMatchObject({ level: "alert", body: "ok", source: "webhook" });
    expect((await rawFetch(`${base}/api/notify`, { method: "POST", body: "{}", headers: authed({ "content-type": "application/json" }) })).status).toBe(400);
    expect((await rawFetch(`${base}/api/notify`, { method: "POST", body: JSON.stringify({ title: "x", level: "boom" }), headers: authed({ "content-type": "application/json" }) })).status).toBe(400);
    const list = await (await fetch(`${base}/api/notifications`)).json() as any[];
    expect(list[0].title).toBe("Xong");
    const b = connect(token);
    expect((await b.next((m) => m.type === "notifications")).items[0].title).toBe("Xong");
    a.ws.close(); b.ws.close();
  });

  test("goto: page must exist, countdown validated, reason webhook", async () => {
    const a = connect(token);
    await a.next((m) => m.type === "hello");
    const call = (p: string, q = "") => rawFetch(`${base}/api/goto/${p}${q}`, { method: "POST", headers: authed() });
    expect((await call("media", "?countdown=5")).status).toBe(200);
    expect(await a.next((m) => m.type === "goto")).toMatchObject({ pageId: "media", countdown: 5, reason: "webhook" });
    expect((await rawFetch(`${base}/api/goto/media`, { method: "POST", body: JSON.stringify({ reason: "  Meeting starts  " }), headers: authed({ "content-type": "application/json" }) })).status).toBe(200);
    expect(await a.next((m) => m.type === "goto")).toMatchObject({ pageId: "media", countdown: 0, reason: "Meeting starts" });
    await rawFetch(`${base}/api/goto/media`, { method: "POST", body: JSON.stringify({ reason: "x".repeat(200) }), headers: authed({ "content-type": "application/json" }) });
    expect((await a.next((m) => m.type === "goto")).reason).toHaveLength(80);
    expect((await call("nope")).status).toBe(404);
    expect((await call("media", "?countdown=99")).status).toBe(400);
    a.ws.close();
  });
});

describe("macro and hass actions", () => {
  async function press(itemId: string) {
    const c = connect(token);
    await c.next((m) => m.type === "hello");
    c.ws.send(JSON.stringify({ type: "press", reqId: "r", pageId: "main", itemId }));
    const res = await c.next((m) => m.type === "result");
    c.ws.close();
    return res;
  }
  test("macro runs the steps in order and answers once; notify step lands in notifications", async () => {
    ran.length = 0;
    const res = await press("mac");
    expect(res.ok).toBe(true);
    expect(ran.map((a) => a.type)).toEqual(["hotkey", "shell"]);
    expect(((await (await fetch(`${base}/api/notifications`)).json()) as any[])[0].title).toBe("macro xong");
  });
  test("a failing step stops the macro and names the step", async () => {
    ran.length = 0;
    const res = await press("macfail");
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toContain("step 1 (shell): boom");
    expect(ran.length).toBe(1);
  });
  test("item steps can run another macro (depth within limit)", async () => {
    ran.length = 0;
    expect((await press("nest")).ok).toBe(true);
    expect(ran.map((a) => a.type)).toEqual(["hotkey", "shell"]);
  });
  test("hass action calls the service; refuses when HA is not connected", async () => {
    expect((await press("ha")).ok).toBe(true);
    expect(hassCalls.at(-1)).toEqual(["light.toggle", "light.a", undefined]);
    hassUp = false;
    const res = await press("ha");
    hassUp = true;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Home Assistant is not connected");
  });
});

describe("weather", () => {
  test("phones get weather for the widgets on connect; geocode is localhost-only REST", async () => {
    const c = connect(token);
    const w = await c.next((m) => m.type === "weather");
    expect(w.items.wx).toMatchObject({ now: { temp: 31, condition: "Clear sky" }, source: "open-meteo", location: "HN" });
    expect(weatherUrls[0]).toContain("latitude=21.0000");
    c.ws.close();
    const g = await (await fetch(`${base}/api/weather/geocode?q=Ha%20Noi`)).json() as any[];
    expect(g[0]).toMatchObject({ name: "Hanoi", lat: 21, lon: 105.8 });
    expect((await rawFetch(`${base}/api/weather/geocode?q=x`, { headers: { host: "evil.example" } })).status).toBe(403);
  });
});

describe("rules through the server", () => {
  test("a pushed value fires the rule: goto with countdown and reason, notify, theme override; revert when it ends; theme override on connect", async () => {
    const a = connect(token);
    await a.next((m) => m.type === "hello");
    await fetch(`${base}/api/push/temp`, { method: "POST", body: "25" });
    await fetch(`${base}/api/push/temp`, { method: "POST", body: "35" });
    expect(await a.next((m) => m.type === "goto")).toMatchObject({ pageId: "media", countdown: 3, reason: "Too hot", ruleId: "r1", revert: true });
    expect((await a.next((m) => m.type === "notify" && m.notification.source === "rule:r1")).notification).toMatchObject({ title: "hot", level: "warn" });
    expect(await a.next((m) => m.type === "theme-override")).toMatchObject({ mode: "dark" });
    const late = connect(token);
    expect((await late.next((m) => m.type === "theme-override")).mode).toBe("dark");
    await fetch(`${base}/api/push/temp`, { method: "POST", body: "20" });
    expect(await a.next((m) => m.type === "goto-revert")).toMatchObject({ ruleId: "r1" });
    expect((await a.next((m) => m.type === "theme-override" && m.mode === null)).mode).toBeNull();
    a.ws.close(); late.ws.close();
  });
});
