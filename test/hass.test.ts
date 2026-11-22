import "./_fetch";
import { WIN, MODE600, MODE644 } from "./_os";
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-hass-"));
const { HassClient, AUTH_ERR } = await import("../src/hass/client");
const { HassConfigStore, normalizeHassUrl, hassWsUrl } = await import("../src/hass/config");
const { entityPress } = await import("../src/hass/press");
const { wantedEntities, toPhoneEntity } = await import("../src/hass/entities");
const { startServer } = await import("../src/server");

const TOKEN = "SECRET-LONG-LIVED-TOKEN-123";

/** A tiny Home Assistant: websocket API on a local port. Never the real one. */
function fakeHa(token = TOKEN) {
  const received: any[] = [];
  let connections = 0;
  const sockets = new Set<any>();
  const subs: { id: number; ids: string[] }[] = [];
  let failService = false;
  const server = Bun.serve({
    port: 0,
    fetch(req, s) { return new URL(req.url).pathname === "/api/websocket" && s.upgrade(req) ? undefined : new Response("no", { status: 404 }); },
    websocket: {
      open(ws) { connections++; sockets.add(ws); ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.1.0" })); },
      close(ws) { sockets.delete(ws); },
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        received.push(m);
        const ok = (result: unknown = null) => ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result }));
        switch (m.type) {
          case "auth":
            if (m.access_token === token) ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.1.0" }));
            else ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
            return;
          case "ping": return void ws.send(JSON.stringify({ id: m.id, type: "pong" }));
          case "subscribe_entities": {
            subs.push({ id: m.id, ids: m.entity_ids });
            ok();
            const a: any = {};
            for (const id of m.entity_ids) if (STATES[id]) a[id] = { s: STATES[id].state, a: STATES[id].attributes };
            return void ws.send(JSON.stringify({ id: m.id, type: "event", event: { a } }));
          }
          case "unsubscribe_events": return ok();
          case "get_config": return ok({ unit_system: { temperature: "°F" } });
          case "call_service":
            if (failService) return void ws.send(JSON.stringify({ id: m.id, type: "result", success: false, error: { code: "not_found", message: "Service not found." } }));
            if (m.service === "get_forecasts") return ok({ response: { [m.target.entity_id]: { forecast: [{ datetime: "2026-11-17T11:00:00", temperature: 29, condition: "rainy" }] } } });
            return ok({});
          case "get_states": return ok(Object.entries(STATES).map(([entity_id, s]) => ({ entity_id, state: s.state, attributes: s.attributes })));
          case "config/entity_registry/list": return ok(REGISTRY);
          case "config/device_registry/list": return ok([{ id: "d1", area_id: "living_room" }]);
          case "config/area_registry/list": return ok([{ area_id: "kitchen", name: "Kitchen" }, { area_id: "living_room", name: "Living room" }]);
          case "get_services": return ok({ light: { turn_on: { name: "Turn on", description: "Turn on a light" }, toggle: {} }, scene: { turn_on: {} } });
        }
      },
    },
  });
  const REGISTRY: any[] = [{ entity_id: "light.kitchen", area_id: "kitchen", device_id: null }, { entity_id: "switch.fan", area_id: null, device_id: "d1" }];
  const STATES: Record<string, { state: string; attributes: any }> = {
    "light.kitchen": { state: "on", attributes: { friendly_name: "Kitchen light", brightness: 200, supported_color_modes: ["hs"], icon: "mdi:lightbulb" } },
    "switch.fan": { state: "off", attributes: { friendly_name: "Fan" } },
    "sensor.temp": { state: "27.5", attributes: { friendly_name: "Temperature", unit_of_measurement: "°C", device_class: "temperature" } },
    "weather.home": { state: "sunny", attributes: { friendly_name: "Home", temperature: 30 } },
  };
  const push = (event: any) => { const s = subs.at(-1); for (const ws of sockets) ws.send(JSON.stringify({ id: s?.id, type: "event", event })); };
  return {
    url: `http://127.0.0.1:${server.port}`, connections: () => connections, received, subs, STATES, REGISTRY, push,
    drop: () => { for (const ws of [...sockets]) ws.close(); },
    sockets: () => sockets.size,
    failServices: (f: boolean) => { failService = f; },
    stop: () => server.stop(true),
  };
}
const tmpHome = () => mkdtempSync(join(tmpdir(), "pd-hass-home-"));
async function until(fn: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await Bun.sleep(10); }
  throw new Error("condition not met in time");
}
async function client(ha: ReturnType<typeof fakeHa>, token = TOKEN) {
  const store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
  await store.setUrl(ha.url);
  await store.setToken(token);
  const c = new HassClient({ store, backoffMs: [30, 60], pingMs: 60_000 });
  await c.start();
  return { c, store };
}

describe("config", () => {
  test("urls are normalized; websocket url derived", () => {
    expect(normalizeHassUrl("192.168.1.10:8123/")).toBe("http://192.168.1.10:8123");
    expect(normalizeHassUrl("https://ha.example.com/")).toBe("https://ha.example.com");
    expect(() => normalizeHassUrl("ftp://x")).toThrow("http");
    expect(() => normalizeHassUrl("http://u:p@x")).toThrow("credentials");
    expect(() => normalizeHassUrl("")).toThrow("required");
    expect(hassWsUrl("https://a.b")).toBe("wss://a.b/api/websocket");
    expect(hassWsUrl("http://a.b:8123")).toBe("ws://a.b:8123/api/websocket");
  });

  test("macOS: token goes to the Keychain (service Nookdeck-HASS), not to the file; read, replace and delete", async () => {
    const home = tmpHome();
    const calls: string[][] = [];
    let stored: string | undefined;
    const run = async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] === "add-generic-password") { stored = argv[argv.indexOf("-w") + 1]; return ""; }
      if (argv[1] === "find-generic-password") { if (!stored) throw new Error("none"); return stored + "\n"; }
      if (argv[1] === "delete-generic-password") { stored = undefined; return ""; }
      return "";
    };
    const s = new HassConfigStore({ home, run, platform: "darwin" });
    expect(await s.token()).toBeUndefined();
    expect(calls.length).toBe(0); // no url yet: the Keychain is not touched at all
    await s.setUrl("http://ha.local:8123");
    expect(await s.setToken(TOKEN)).toBe("keychain");
    expect(calls[0]!.slice(0, 7)).toEqual(["security", "add-generic-password", "-U", "-s", "Nookdeck-HASS", "-a", "token"]);
    expect(readFileSync(join(home, "hass.json"), "utf8")).not.toContain(TOKEN);
    expect(await s.token()).toBe(TOKEN);
    expect(await s.hasToken()).toBe(true);
    await s.clearToken();
    expect(await s.token()).toBeUndefined();
    expect(calls.some((c) => c[1] === "delete-generic-password")).toBe(true);
  });

  test("fallback to ~/.nookdeck/hass.json at 0600 when there is no Keychain or it fails", async () => {
    const home = tmpHome();
    const s = new HassConfigStore({ home, platform: "linux" });
    await s.setUrl("http://x:8123");
    expect(await s.setToken(TOKEN)).toBe("file");
    expect(statSync(join(home, "hass.json")).mode & 0o777).toBe(MODE600);
    expect(await s.token()).toBe(TOKEN);
    const broken = new HassConfigStore({ home: tmpHome(), platform: "darwin", run: async () => { throw new Error("no keychain"); } });
    await broken.setUrl("http://x:8123");
    expect(await broken.setToken(TOKEN)).toBe("file");
    expect(await broken.token()).toBe(TOKEN);
    await broken.clearToken();
    expect(await broken.hasToken()).toBe(false);
    await expect(s.setToken("")).rejects.toThrow("not valid");
    await expect(s.setToken("has space")).rejects.toThrow("not valid");
    expect(existsSync(join(home, "hass.json.tmp"))).toBe(false);
  });
});

describe("pure helpers", () => {
  test("entityPress per domain", () => {
    expect(entityPress("light.a")).toEqual({ service: "light.toggle", entityId: "light.a" });
    for (const d of ["switch", "fan", "input_boolean", "automation", "cover"]) expect((entityPress(`${d}.x`) as any).service).toBe(`${d}.toggle`);
    expect((entityPress("scene.movie") as any).service).toBe("scene.turn_on");
    expect((entityPress("script.go") as any).service).toBe("script.turn_on");
    expect((entityPress("button.ring") as any).service).toBe("button.press");
    expect((entityPress("media_player.tv") as any).service).toBe("media_player.media_play_pause");
    expect((entityPress("lock.front") as any).error).toContain("only shows status");
    expect((entityPress("sensor.t") as any).error).toContain("sensor");
  });
  test("toPhoneEntity keeps a compact set of attributes; wantedEntities collects every use", () => {
    expect(toPhoneEntity("light.a", "on", { friendly_name: "A", brightness: 10, supported_color_modes: ["x"], icon: "mdi:x" })).toEqual({ state: "on", name: "A", domain: "light", icon: "mdi:x", attrs: { brightness: 10, supported_color_modes: ["x"] } });
    expect(toPhoneEntity("sensor.t", "3", { unit_of_measurement: "°C" })).toMatchObject({ name: "sensor.t", unit: "°C" });
    const layout: any = {
      version: 1,
      pages: [{ id: "p", name: "P", columns: 6, rows: 4, items: [
        { id: "e", kind: "widget", widget: "entity", entity: { id: "light.a" } },
        { id: "w", kind: "widget", widget: "weather", weather: { entity: "weather.home" } },
        { id: "b", kind: "button", label: "b", action: { type: "hass", service: "scene.turn_on", entityId: "scene.s" } },
        { id: "m", kind: "button", label: "m", action: { type: "macro", steps: [{ kind: "hass", service: "light.turn_on", entityId: "light.b" }, { kind: "wait", ms: 1 }] } },
      ] }],
      rules: [{ id: "r", name: "r", enabled: true, when: { kind: "hass-state", entityId: "binary_sensor.door", state: "on" }, then: [{ kind: "notify", text: "x" }] }],
    };
    expect(wantedEntities(layout)).toEqual(["binary_sensor.door", "light.a", "light.b", "scene.s", "weather.home"]);
  });
});

// expect(promise).rejects is unreliable in Bun on Windows (the rejection is delivered late or never)
const errorOf = (p: Promise<unknown>) => p.then(() => "", (e: any) => String(e?.message ?? e));

describe("HassClient against a fake HA", () => {
  const has: ReturnType<typeof fakeHa>[] = [];
  const clients: any[] = [];
  const mk = () => { const h = fakeHa(); has.push(h); return h; };
  afterEach(() => { clients.splice(0).forEach((c) => c.stop()); has.splice(0).forEach((h) => h.stop()); });

  test("auth ok: connected, version in status; nothing configured stays idle", async () => {
    const idle = new HassClient({ store: new HassConfigStore({ home: tmpHome(), platform: "linux" }) });
    await idle.start();
    expect(await idle.status()).toEqual({ url: null, hasToken: false, connected: false });
    idle.stop();
    const ha = mk();
    const { c } = await client(ha); clients.push(c);
    await until(() => c.connected());
    expect(await c.status()).toMatchObject({ connected: true, version: "2026.1.0", hasToken: true, url: ha.url });
    expect(JSON.stringify(await c.status())).not.toContain(TOKEN);
    expect(ha.received.find((m) => m.type === "auth").access_token).toBe(TOKEN);
  });

  test("auth invalid: error reported, no retry loop; fixing the token reconnects", async () => {
    const ha = mk();
    const { c, store } = await client(ha, "wrong"); clients.push(c);
    await until(async () => !!(await c.status()).error);
    expect((await c.status())).toMatchObject({ connected: false, error: AUTH_ERR });
    await Bun.sleep(200);
    expect(ha.received.filter((m) => m.type === "auth").length).toBe(1);
    await store.setToken(TOKEN);
    await c.reconfigure();
    await until(() => c.connected());
    expect((await c.status()).error).toBeUndefined();
  });

  test("subscribe_entities for exactly the wanted entities; initial state, diffs, attribute removal, removed entities", async () => {
    const ha = mk();
    const { c } = await client(ha); clients.push(c);
    const changes: any[] = [];
    const states: any[] = [];
    c.onEntities((x: any) => changes.push(x));
    c.onState((id: string, s: any) => states.push([id, s?.state]));
    c.setWanted(["light.kitchen", "sensor.temp"]);
    await until(() => c.connected() && ha.subs.length === 1);
    expect(ha.subs[0]!.ids).toEqual(["light.kitchen", "sensor.temp"]);
    await until(() => !!c.getState("sensor.temp"));
    expect(c.snapshot()["light.kitchen"]).toEqual({ state: "on", name: "Kitchen light", domain: "light", icon: "mdi:lightbulb", attrs: { brightness: 200, supported_color_modes: ["hs"] } });
    expect(c.snapshot()["sensor.temp"]).toMatchObject({ state: "27.5", unit: "°C" });
    changes.length = 0;
    ha.push({ c: { "light.kitchen": { "+": { s: "off", a: { brightness: 0 } } } } });
    await until(() => changes.length === 1);
    expect(changes[0]).toEqual({ "light.kitchen": { state: "off", name: "Kitchen light", domain: "light", icon: "mdi:lightbulb", attrs: { brightness: 0, supported_color_modes: ["hs"] } } }); // only the changed entity
    ha.push({ c: { "light.kitchen": { "-": { a: ["brightness", "icon"] } } } });
    await until(() => changes.length === 2);
    expect(changes[1]["light.kitchen"]).toEqual({ state: "off", name: "Kitchen light", domain: "light", attrs: { supported_color_modes: ["hs"] } });
    ha.push({ r: ["sensor.temp"] });
    await until(() => changes.length === 3);
    expect(changes[2]).toEqual({ "sensor.temp": null });
    expect(c.getState("sensor.temp")).toBeUndefined();
    expect(states.map((s) => s[0])).toContain("light.kitchen");
  });

  test("changing the wanted set unsubscribes and resubscribes; an unchanged set does nothing", async () => {
    const ha = mk();
    const { c } = await client(ha); clients.push(c);
    c.setWanted(["light.kitchen"]);
    await until(() => ha.subs.length === 1);
    c.setWanted(["light.kitchen"]);
    c.setWanted(["switch.fan", "light.kitchen"]);
    await until(() => ha.subs.length === 2);
    expect(ha.subs[1]!.ids).toEqual(["light.kitchen", "switch.fan"]);
    expect(ha.received.some((m) => m.type === "unsubscribe_events" && m.subscription === ha.subs[0]!.id)).toBe(true);
    c.setWanted([]);
    await Bun.sleep(50);
    expect(ha.subs.length).toBe(2);
    expect(c.snapshot()).toEqual({});
  });

  test("call_service sends domain, service, data and target; errors come back readable; not connected rejects", async () => {
    const ha = mk();
    const { c } = await client(ha); clients.push(c);
    await until(() => c.connected());
    await c.callService("light.turn_on", "light.kitchen", { brightness_pct: 50 });
    expect(ha.received.at(-1)).toMatchObject({ type: "call_service", domain: "light", service: "turn_on", service_data: { brightness_pct: 50 }, target: { entity_id: "light.kitchen" } });
    await c.callService("script.turn_on");
    expect(ha.received.at(-1).target).toBeUndefined();
    ha.failServices(true);
    expect(await errorOf(c.callService("light.nope", "light.x"))).toContain("Service not found.");
    expect(await errorOf(c.callService("nodot"))).toContain("invalid service");
    const off = new HassClient({ store: new HassConfigStore({ home: tmpHome(), platform: "linux" }) });
    expect(await errorOf(off.callService("light.toggle", "light.x"))).toContain("not connected");
  });

  test("reconnects with backoff after the connection drops and resubscribes", async () => {
    const ha = mk();
    const { c } = await client(ha); clients.push(c);
    const seen: any[] = [];
    c.onEntities((x: any) => seen.push(x));
    c.setWanted(["light.kitchen"]);
    await until(() => ha.subs.length === 1 && !!c.getState("light.kitchen"));
    seen.length = 0;
    ha.drop();
    await until(() => !c.connected());
    expect(seen.some((x) => x["light.kitchen"] === null)).toBe(true); // phones learn the tile is stale
    await until(() => c.connected() && ha.subs.length === 2);
    expect(ha.subs[1]!.ids).toEqual(["light.kitchen"]);
    await until(() => !!c.getState("light.kitchen"));
  });

  test("pong timeout counts as a dropped connection", async () => {
    const ha = mk();
    const store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
    await store.setUrl(ha.url); await store.setToken(TOKEN);
    const c = new HassClient({ store, backoffMs: [20], pingMs: 40 });
    clients.push(c);
    await c.start();
    await until(() => c.connected());
    await until(() => ha.received.some((m) => m.type === "ping"), 10_000);
  }, 15_000);

  test("entities (with areas), areas, services, weather forecasts, test()", async () => {
    const ha = mk();
    const { c } = await client(ha); clients.push(c);
    await until(() => c.connected());
    const ents = await c.entities();
    expect(ents.find((e: any) => e.id === "light.kitchen")).toMatchObject({ name: "Kitchen light", domain: "light", area: "Kitchen", state: "on", icon: "mdi:lightbulb" });
    expect(ents.find((e: any) => e.id === "switch.fan")!.area).toBe("Living room"); // via the device
    expect(ents.find((e: any) => e.id === "sensor.temp")!.area).toBeNull();
    expect(await c.areas()).toEqual([{ id: "kitchen", name: "Kitchen" }, { id: "living_room", name: "Living room" }]);
    expect((await c.services()).map((s: any) => s.service)).toEqual(["light.toggle", "light.turn_on", "scene.turn_on"]);
    c.setWanted(["weather.home"]);
    await until(() => !!c.getState("weather.home"));
    const w = await c.weather("weather.home");
    expect(w).toMatchObject({ state: "sunny", hourly: [{ temperature: 29 }], daily: [{ temperature: 29 }] });
    expect(await c.weather("weather.none")).toBeNull();
    expect((await c.test()).connected).toBe(true);
  });

  test("weatherEntity: not connected -> null; connected -> the first weather.* entity, subscribed and usable at once; per connection", async () => {
    const ha = mk();
    const { c } = await client(ha); clients.push(c);
    expect(await c.weatherEntity()).toBeNull(); // not connected yet
    await until(() => c.connected());
    expect(await c.weatherEntity()).toBe("weather.home");
    expect(c.getState("weather.home")?.state).toBe("sunny");
    expect(await c.weather("weather.home")).toMatchObject({ state: "sunny" });
    const asked = ha.received.filter((m) => m.type === "get_states").length;
    expect(await c.weatherEntity()).toBe("weather.home");
    expect(ha.received.filter((m) => m.type === "get_states").length).toBe(asked); // asked once
    await until(() => ha.subs.some((s) => s.ids.includes("weather.home"))); // kept subscribed although no tile named it
    await c.reconfigure(); // a new connection asks again
    await until(() => c.connected());
    expect(await c.weatherEntity()).toBe("weather.home");
    expect(ha.received.filter((m) => m.type === "get_states").length).toBeGreaterThan(asked);
  });

  test("get_config: HA's temperature unit is learned and given to climate entities", async () => {
    const ha = mk();
    const { c } = await client(ha); clients.push(c);
    await until(() => c.connected());
    await until(() => c.systemTempUnit() === "f");
    c.setWanted(["weather.home"]);
    await until(() => !!c.getState("weather.home"));
    expect(c.snapshot()["weather.home"]!.attrs?.temperature_unit).toBe("°F");
  });

  test("lights carry related selects (scenes) from the same device, kept subscribed, refreshed when the select changes", async () => {
    const ha = mk();
    ha.REGISTRY.splice(0, 1, { entity_id: "light.kitchen", area_id: "kitchen", device_id: "dk" }, { entity_id: "select.kitchen_scene", area_id: null, device_id: "dk" });
    ha.STATES["select.kitchen_scene"] = { state: "night", attributes: { friendly_name: "Kitchen scene", options: ["night", "reading", "party"] } };
    ha.STATES["light.kitchen"]!.attributes = { ...ha.STATES["light.kitchen"]!.attributes, supported_color_modes: ["color_temp", "hs"], hs_color: [30, 80], rgb_color: [255, 170, 51], color_temp_kelvin: 2700, effect: "rainbow", effect_list: ["rainbow", "pulse"] };
    const { c } = await client(ha); clients.push(c);
    c.setWanted(["light.kitchen"]);
    await until(() => c.connected());
    await until(() => (c.snapshot()["light.kitchen"]?.related?.length ?? 0) > 0);
    const e = c.snapshot()["light.kitchen"]!;
    expect(e.related).toEqual([{ id: "select.kitchen_scene", name: "Kitchen scene", options: ["night", "reading", "party"], current: "night" }]);
    expect(e.attrs).toMatchObject({ hs_color: [30, 80], rgb_color: [255, 170, 51], color_temp_kelvin: 2700, brightness: 200, effect: "rainbow", effect_list: ["rainbow", "pulse"] });
    expect(ha.subs.at(-1)!.ids).toContain("select.kitchen_scene");
    expect(c.related("switch.fan")).toEqual([]);
    const seen: any[] = [];
    c.onEntities((ch) => seen.push(ch));
    ha.push({ c: { "select.kitchen_scene": { "+": { s: "party" } } } });
    await until(() => seen.some((ch) => ch["light.kitchen"]?.related?.[0]?.current === "party"));
  });

  test("test() on an unreachable HA reports an error", async () => {
    const ha = mk();
    const store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
    await store.setUrl(ha.url); await store.setToken(TOKEN);
    ha.stop();
    const c = new HassClient({ store, backoffMs: [20] });
    clients.push(c);
    const st = await c.test(600);
    expect(st.connected).toBe(false);
    const none = new HassClient({ store: new HassConfigStore({ home: tmpHome(), platform: "linux" }) });
    expect((await none.test(100)).error).toContain("URL");
  });
});

/** Servers that are not (quite) Home Assistant. */
function oddServer(mode: "http404" | "silent" | "no-auth-reply" | "close-at-once") {
  const s = Bun.serve({
    port: 0,
    fetch(req, srv) { return mode !== "http404" && srv.upgrade(req) ? undefined : new Response("not ha", { status: 404 }); },
    websocket: {
      open(ws) {
        if (mode === "no-auth-reply") ws.send(JSON.stringify({ type: "auth_required" }));
        if (mode === "close-at-once") ws.close();
      },
      message() { /* never answers */ },
    },
  });
  return { url: `http://127.0.0.1:${s.port}`, port: s.port, stop: () => s.stop(true) };
}

describe("test(): the real cause of a failure, in English by default", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => cleanup.splice(0).forEach((f) => f()));
  async function probe(url: string, o: Record<string, unknown> = {}, token = TOKEN) {
    const store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
    await store.setUrl(url); await store.setToken(token);
    const c = new HassClient({ store, backoffMs: [5000], pingMs: 60_000, connectMs: 1500, greetMs: 150, authMs: 150, ...o });
    cleanup.push(() => c.stop());
    return c.test(5000);
  }

  test("name that does not resolve (DNS / .local)", async () => {
    const st = await probe("http://khong-co-may.local:8123", { resolveHost: async () => { throw new Error("ENOTFOUND"); } });
    expect(st).toMatchObject({ connected: false });
    expect(st.error).toBe('cannot resolve the host name "khong-co-may.local" (check DNS or the .local name)');
    expect(st.detail).toBeTruthy();
  });
  test("host resolves but nothing listens: machine off / wrong port / blocked", async () => {
    const st = await probe("http://localhost:1", { resolveHost: async () => ({}) });
    expect(st.error).toBe("cannot connect to localhost:1 (the machine is off, the port is wrong or it is blocked)");
    expect(st.detail).toContain("Failed to connect");
    expect((await probe("http://127.0.0.1:1")).error).toContain("cannot connect to 127.0.0.1:1");
  });
  test("HTTPS with a certificate problem", async () => {
    const plain = oddServer("silent"); cleanup.push(plain.stop);
    const st = await probe(`https://127.0.0.1:${plain.port}`);
    expect(st.error).toContain("HTTPS certificate error");
    expect(st.detail).toBeTruthy();
  });
  test("a web server that is not Home Assistant: no WebSocket / no auth_required / closes at once", async () => {
    const web = oddServer("http404"); cleanup.push(web.stop);
    expect((await probe(web.url)).error).toContain("the URL is not Home Assistant (the server answered but has no WebSocket");
    const silent = oddServer("silent"); cleanup.push(silent.stop);
    const st = await probe(silent.url);
    expect(st.error).toBe("the URL is not Home Assistant (no auth_required received)");
    expect(st.detail).toBe("no auth_required");
    const bye = oddServer("close-at-once"); cleanup.push(bye.stop);
    expect((await probe(bye.url)).error).toContain("the URL is not Home Assistant");
  });
  test("HA that never answers the auth: a real timeout, with the seconds in the message", async () => {
    const quiet = oddServer("no-auth-reply"); cleanup.push(quiet.stop);
    const st = await probe(quiet.url, { authMs: 1000 });
    expect(st.error).toBe("Home Assistant did not answer authentication within 1 seconds");
    expect(st.detail).toBe("auth timeout");
  });
  test("token rejected", async () => {
    const ha = fakeHa(); cleanup.push(ha.stop);
    const st = await probe(ha.url, {}, "wrong-token");
    expect(st.error).toBe(AUTH_ERR);
    expect(st.detail).toBe("Invalid access token");
  });
  test("success clears error and detail; missing url or token is said plainly", async () => {
    const ha = fakeHa(); cleanup.push(ha.stop);
    const st = await probe(ha.url);
    expect(st).toMatchObject({ connected: true, version: "2026.1.0" });
    expect(st.error).toBeUndefined();
    expect(st.detail).toBeUndefined();
    const store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
    expect((await new HassClient({ store }).test(50)).error).toBe("no Home Assistant URL yet");
    await store.setUrl(ha.url);
    expect((await new HassClient({ store }).test(50)).error).toBe("no token yet");
  });
  test("a connection that is already being established is waited for, not duplicated", async () => {
    const ha = fakeHa(); cleanup.push(ha.stop);
    const store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
    await store.setUrl(ha.url); await store.setToken(TOKEN);
    const c = new HassClient({ store, backoffMs: [30], pingMs: 60_000 });
    cleanup.push(() => c.stop());
    await c.start();
    const [a, b] = await Promise.all([c.test(), c.test()]);
    expect(a.connected).toBe(true);
    expect(b.connected).toBe(true);
    expect(ha.connections()).toBe(1);
  });
  test("pressing the button after a failure retries right away instead of waiting for the backoff", async () => {
    const ha = fakeHa();
    const store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
    await store.setUrl(ha.url); await store.setToken("wrong");
    const c = new HassClient({ store, backoffMs: [60_000], pingMs: 60_000 });
    cleanup.push(() => { c.stop(); ha.stop(); });
    expect((await c.test()).error).toBe(AUTH_ERR);
    await store.setToken(TOKEN);
    const st = await c.test();
    expect(st.connected).toBe(true);
  });
});

describe("server integration (fake HA, never the real one)", () => {
  let ha: ReturnType<typeof fakeHa>;
  let app: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let store: InstanceType<typeof HassConfigStore>;
  let token: string;
  const wsLog: string[] = [];

  function connect() {
    const ws = new WebSocket(`ws://localhost:${app.port}/ws?token=${token}`);
    const msgs: any[] = [];
    const waiters: Array<() => void> = [];
    ws.onmessage = (e) => { wsLog.push(String(e.data)); msgs.push(JSON.parse(String(e.data))); waiters.forEach((w) => w()); };
    const next = (pred: (m: any) => boolean, ms = 3000) => new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      const check = () => { const i = msgs.findIndex(pred); if (i >= 0) { clearTimeout(t); resolve(msgs.splice(i, 1)[0]); return true; } return false; };
      if (check()) return;
      const w = () => { if (check()) waiters.splice(waiters.indexOf(w), 1); };
      waiters.push(w);
    });
    return { ws, next };
  }

  beforeAll(async () => {
    ha = fakeHa();
    store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
    const client = new HassClient({ store, backoffMs: [30], pingMs: 60_000 });
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    app = await startServer({
      port: 0, pin: "555555", hostName: async () => "my-mac", hass: client,
      webhookKeyFile: join(tmpHome(), "webhook-key"), layoutHistoryDir: tmpHome(),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
    const e = (id: string, ent: any, size: any = {}) => ({ id, kind: "widget", widget: "entity", entity: ent, ...size });
    const layout = {
      version: 1,
      pages: [{ id: "ha", name: "Home", columns: 6, rows: 3, items: [
        e("lamp", { id: "light.kitchen" }), e("temp", { id: "sensor.temp", readOnly: true }), e("fan", { id: "switch.fan" }), e("door", { id: "lock.front" }), e("tv", { id: "sensor.other" }),
        { id: "scn", kind: "button", label: "Phim", action: { type: "hass", service: "scene.turn_on", entityId: "scene.movie" } },
      ] }],
    };
    expect((await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(layout) })).status).toBe(200);
    const r = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "555555" }) })).json() as any;
    token = r.token;
  });
  afterAll(async () => {
    const { defaultLayout } = await import("../src/config");
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(defaultLayout()) });
    app.stop(); ha.stop();
  });

  test("REST: not configured, set url and token, test, entities/areas/services; the token is never returned", async () => {
    const st0 = await (await fetch(`${base}/api/hass/config`)).json() as any;
    expect(st0).toEqual({ url: null, hasToken: false, connected: false });
    expect((await fetch(`${base}/api/hass/entities`)).status).toBe(503);
    expect((await fetch(`${base}/api/hass/config`, { method: "PUT", body: JSON.stringify({ url: "ftp://x" }) })).status).toBe(400);
    const afterUrl = await (await fetch(`${base}/api/hass/config`, { method: "PUT", body: JSON.stringify({ url: ha.url }) })).json() as any;
    expect(afterUrl).toMatchObject({ url: ha.url, hasToken: false, connected: false });
    expect((await fetch(`${base}/api/hass/token`, { method: "PUT", body: JSON.stringify({ token: "bad token" }) })).status).toBe(400);
    const bodies: string[] = [];
    const wrong = await fetch(`${base}/api/hass/token`, { method: "PUT", body: JSON.stringify({ token: "nope-token" }) });
    bodies.push(await wrong.text());
    await until(async () => !!((await (await fetch(`${base}/api/hass/config`)).json()) as any).error);
    expect(((await (await fetch(`${base}/api/hass/config`)).json()) as any).error).toContain("token");
    const good = await fetch(`${base}/api/hass/token`, { method: "PUT", body: JSON.stringify({ token: TOKEN }) });
    bodies.push(await good.text());
    await until(async () => ((await (await fetch(`${base}/api/hass/config`)).json()) as any).connected === true);
    const test = await (await fetch(`${base}/api/hass/test`, { method: "POST", body: "{}" })).json() as any;
    expect(test).toMatchObject({ connected: true, hasToken: true, version: "2026.1.0" });
    bodies.push(JSON.stringify(test));
    const ents = await (await fetch(`${base}/api/hass/entities`)).json() as any[];
    expect(ents.length).toBe(4);
    bodies.push(JSON.stringify(ents));
    bodies.push(JSON.stringify(await (await fetch(`${base}/api/hass/areas`)).json()), JSON.stringify(await (await fetch(`${base}/api/hass/services`)).json()));
    for (const b of bodies) expect(b).not.toContain(TOKEN);
    expect((await fetch(`${base}/api/hass/nope`)).status).toBe(404);
  });

  test("guarded like every localhost route", async () => {
    const { rawFetch } = await import("./_fetch");
    expect((await rawFetch(`${base}/api/hass/token`, { method: "PUT", body: JSON.stringify({ token: "x" }), headers: { "content-type": "text/plain" } })).status).toBe(403);
    expect((await rawFetch(`${base}/api/hass/config`, { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await rawFetch(`${base}/api/hass/token`, { method: "DELETE" })).status).toBe(403);
  });

  test("phones get the entities the layout uses: full first, then only changes; never the token or the HA url", async () => {
    await until(() => ha.subs.length > 0 && ha.subs.at(-1)!.ids.includes("light.kitchen"));
    expect(ha.subs.at(-1)!.ids).toEqual(["light.kitchen", "lock.front", "scene.movie", "sensor.other", "sensor.temp", "switch.fan"]);
    const a = connect();
    const first = await a.next((m) => m.type === "hass");
    expect(first.connected).toBe(true);
    expect(Object.keys(first.entities).sort()).toEqual(["light.kitchen", "sensor.temp", "switch.fan"]);
    expect(first.entities["light.kitchen"]).toMatchObject({ state: "on", name: "Kitchen light", domain: "light" });
    ha.push({ c: { "switch.fan": { "+": { s: "on" } } } });
    const diff = await a.next((m) => m.type === "hass" && m.entities["switch.fan"]);
    expect(Object.keys(diff.entities)).toEqual(["switch.fan"]);
    expect(diff.entities["switch.fan"].state).toBe("on");
    a.ws.close();
    for (const m of wsLog) { expect(m).not.toContain(TOKEN); expect(m).not.toContain(ha.url); expect(m).not.toContain("127.0.0.1:" + new URL(ha.url).port); }
  });

  test("pressing entity tiles: toggle by domain, read-only and lock refuse, unsupported domain refuses; hass buttons call the service", async () => {
    const a = connect();
    await a.next((m) => m.type === "hello");
    const press = async (itemId: string) => { a.ws.send(JSON.stringify({ type: "press", reqId: itemId, pageId: "ha", itemId })); return a.next((m) => m.type === "result" && m.reqId === itemId); };
    const calls = () => ha.received.filter((m) => m.type === "call_service" && m.service !== "get_forecasts");
    expect((await press("lamp")).ok).toBe(true);
    expect(calls().at(-1)).toMatchObject({ domain: "light", service: "toggle", target: { entity_id: "light.kitchen" } });
    expect((await press("fan")).ok).toBe(true);
    expect(calls().at(-1)).toMatchObject({ domain: "switch", service: "toggle" });
    const n = calls().length;
    expect((await press("temp")).ok).toBe(false); // readOnly
    const lock = await press("door");
    expect(lock.ok).toBe(false);
    expect(lock.error).toContain("only shows status");
    expect((await press("tv")).ok).toBe(false);
    expect(calls().length).toBe(n);
    expect((await press("scn")).ok).toBe(true);
    expect(calls().at(-1)).toMatchObject({ domain: "scene", service: "turn_on", target: { entity_id: "scene.movie" } });
    ha.failServices(true);
    const bad = await press("lamp");
    ha.failServices(false);
    expect(bad).toMatchObject({ ok: false, error: "Service not found." });
    a.ws.close();
  });

  test("changing the layout updates the subscription; DELETE token disconnects", async () => {
    const lay = await (await fetch(`${base}/api/layout`)).json() as any;
    lay.pages[0].items = lay.pages[0].items.filter((i: any) => i.id === "lamp");
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(lay) });
    await until(() => ha.subs.at(-1)!.ids.join() === "light.kitchen");
    const gone = await (await fetch(`${base}/api/hass/token`, { method: "DELETE" })).json() as any;
    expect(gone).toMatchObject({ hasToken: false, connected: false });
    await until(() => ha.sockets() === 0);
  });
});


import { planControl, CONTROL_OPS } from "../src/hass/control";

const S = (state: string, attributes: Record<string, unknown> = {}) => ({ state, attributes });
const AC = S("cool", { min_temp: 16, max_temp: 30, target_temp_step: 1, hvac_modes: ["off", "cool", "heat", "auto"], fan_modes: ["auto", "low", "high"], swing_modes: ["off", "vertical"] });
const LIGHT = S("on", { supported_color_modes: ["color_temp", "hs"], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6000 });
const FAN = S("on", { percentage_step: 25, preset_modes: ["auto", "sleep"] });

describe("planControl: ops validated against live attributes", () => {
  test("climate", () => {
    expect(planControl("climate.bedroom_ac", AC, "set_temperature", 24.4)).toEqual({ service: "climate.set_temperature", data: { temperature: 24 } }); // step 1
    expect(planControl("climate.x", S("cool", { min_temp: 16, max_temp: 30 }), "set_temperature", 24.3)).toEqual({ service: "climate.set_temperature", data: { temperature: 24.5 } }); // default step 0.5
    expect((planControl("climate.x", AC, "set_temperature", 15) as any).error).toContain("between 16 and 30");
    expect((planControl("climate.x", AC, "set_temperature", 31) as any).error).toContain("between 16 and 30");
    expect((planControl("climate.x", AC, "set_temperature", "24") as any).error).toContain("needs a number");
    expect((planControl("climate.x", AC, "set_temperature", NaN) as any).error).toContain("needs a number");
    expect(planControl("climate.x", AC, "set_hvac_mode", "heat")).toEqual({ service: "climate.set_hvac_mode", data: { hvac_mode: "heat" } });
    expect((planControl("climate.x", AC, "set_hvac_mode", "dry") as any).error).toContain("is not supported");
    expect((planControl("climate.x", AC, "set_hvac_mode") as any).error).toContain("needs a value");
    expect(planControl("climate.x", AC, "set_fan_mode", "high")).toEqual({ service: "climate.set_fan_mode", data: { fan_mode: "high" } });
    expect((planControl("climate.x", AC, "set_fan_mode", "turbo") as any).error).toBeTruthy();
    expect(planControl("climate.x", AC, "set_swing_mode", "vertical")).toEqual({ service: "climate.set_swing_mode", data: { swing_mode: "vertical" } });
    expect((planControl("climate.x", S("off", {}), "set_swing_mode", "off") as any).error).toContain("available");
    expect(planControl("climate.x", AC, "turn_off")).toEqual({ service: "climate.turn_off" });
    expect(planControl("climate.x", AC, "turn_on")).toEqual({ service: "climate.turn_on" });
    expect((planControl("climate.x", AC, "explode") as any).error).toContain("has no operation");
  });
  test("light", () => {
    expect(planControl("light.l", LIGHT, "turn_on")).toEqual({ service: "light.turn_on" });
    expect(planControl("light.l", LIGHT, "turn_on", 40)).toEqual({ service: "light.turn_on", data: { brightness_pct: 40 } });
    expect(planControl("light.l", LIGHT, "set_brightness", 100)).toEqual({ service: "light.turn_on", data: { brightness_pct: 100 } });
    expect((planControl("light.l", LIGHT, "set_brightness", 0) as any).error).toContain("between 1 and 100");
    expect((planControl("light.l", LIGHT, "set_brightness", 101) as any).error).toContain("between 1 and 100");
    expect(planControl("light.l", LIGHT, "set_color_temp", 3000)).toEqual({ service: "light.turn_on", data: { color_temp_kelvin: 3000 } });
    expect((planControl("light.l", LIGHT, "set_color_temp", 2000) as any).error).toContain("between 2200 and 6000");
    expect((planControl("light.l", S("on", { supported_color_modes: ["brightness"] }), "set_color_temp", 3000) as any).error).toContain("no adjustable color temperature");
    expect(planControl("light.l", LIGHT, "set_hs_color", [120, 50])).toEqual({ service: "light.turn_on", data: { hs_color: [120, 50] } });
    expect((planControl("light.l", LIGHT, "set_hs_color", [361, 50]) as any).error).toContain("0-360");
    expect((planControl("light.l", LIGHT, "set_hs_color", [10, 101]) as any).error).toContain("0-100");
    expect((planControl("light.l", LIGHT, "set_hs_color", "red") as any).error).toBeTruthy();
    expect((planControl("light.l", S("on", { supported_color_modes: ["color_temp"] }), "set_hs_color", [1, 1]) as any).error).toContain("no adjustable color");
    expect(planControl("light.l", LIGHT, "turn_on", { brightness_pct: 30, color_temp_kelvin: 4000 })).toEqual({ service: "light.turn_on", data: { brightness_pct: 30, color_temp_kelvin: 4000 } });
    expect((planControl("light.l", LIGHT, "turn_on", { color_temp_kelvin: 4000, hs_color: [1, 1] }) as any).error).toContain("not both");
    expect((planControl("light.l", LIGHT, "turn_on", { transition: 5 }) as any).error).toContain("transition");
    expect((planControl("light.l", S("on", { supported_color_modes: ["onoff"] }), "turn_on", 50) as any).error).toContain("cannot be dimmed");
    expect(planControl("light.l", LIGHT, "turn_off")).toEqual({ service: "light.turn_off" });
  });
  test("fan (incl. air purifier), cover, vacuum", () => {
    expect(planControl("fan.purifier", FAN, "set_percentage", 60)).toEqual({ service: "fan.set_percentage", data: { percentage: 50 } }); // step 25
    expect(planControl("fan.x", FAN, "set_percentage", 0)).toEqual({ service: "fan.set_percentage", data: { percentage: 0 } });
    expect(planControl("fan.x", FAN, "set_percentage", 100)).toEqual({ service: "fan.set_percentage", data: { percentage: 100 } });
    expect((planControl("fan.x", FAN, "set_percentage", 101) as any).error).toContain("between 0 and 100");
    expect((planControl("fan.x", FAN, "set_percentage", -1) as any).error).toContain("between 0 and 100");
    expect(planControl("fan.x", FAN, "set_preset_mode", "sleep")).toEqual({ service: "fan.set_preset_mode", data: { preset_mode: "sleep" } });
    expect((planControl("fan.x", FAN, "set_preset_mode", "turbo") as any).error).toContain("is not supported");
    expect(planControl("fan.x", FAN, "oscillate", true)).toEqual({ service: "fan.oscillate", data: { oscillating: true } });
    expect((planControl("fan.x", FAN, "oscillate", "yes") as any).error).toContain("true or false");
    expect(planControl("fan.x", FAN, "turn_on")).toEqual({ service: "fan.turn_on" });
    const C = S("open", { supported_features: 15 });
    expect(planControl("cover.c", C, "set_cover_position", 42.4)).toEqual({ service: "cover.set_cover_position", data: { position: 42 } });
    expect((planControl("cover.c", C, "set_cover_position", 120) as any).error).toContain("between 0 and 100");
    expect((planControl("cover.c", S("open", { supported_features: 11 }), "set_cover_position", 50) as any).error).toContain("cannot be set to a position");
    expect(planControl("cover.c", S("open"), "set_cover_position", 50)).toEqual({ service: "cover.set_cover_position", data: { position: 50 } }); // no feature info: allowed
    for (const op of ["open_cover", "close_cover", "stop_cover"]) expect(planControl("cover.c", C, op)).toEqual({ service: `cover.${op}` });
    for (const op of ["start", "pause", "return_to_base", "locate"]) expect(planControl("vacuum.v", S("docked"), op)).toEqual({ service: `vacuum.${op}` });
    expect((planControl("vacuum.v", S("docked"), "clean_spot") as any).error).toContain("has no operation");
  });
  test("unknown domain, missing state, unavailable, missing op", () => {
    expect((planControl("sensor.t", S("1"), "turn_on") as any).error).toContain("sensor has no detailed controls yet");
    expect((planControl("climate.x", undefined, "turn_on") as any).error).toContain("no state for this device yet");
    expect((planControl("climate.x", S("unavailable"), "turn_on") as any).error).toContain("unavailable");
    expect((planControl("climate.x", AC, undefined) as any).error).toContain("missing op");
    expect(Object.keys(CONTROL_OPS).sort()).toEqual(["climate", "cover", "fan", "light", "vacuum"]);
  });
});

describe("hass-control through the server (fake HA)", () => {
  let ha: ReturnType<typeof fakeHa>;
  let app: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let tok: string;
  const calls = () => ha.received.filter((m) => m.type === "call_service");

  beforeAll(async () => {
    ha = fakeHa();
    Object.assign(ha.STATES, {
      "climate.bedroom_ac": { state: "cool", attributes: { friendly_name: "Bedroom AC", min_temp: 16, max_temp: 30, target_temp_step: 1, hvac_modes: ["off", "cool", "heat"], fan_modes: ["auto", "low"], swing_modes: ["off", "vertical"], temperature: 25, current_temperature: 27 } },
      "light.l": { state: "on", attributes: { friendly_name: "L", supported_color_modes: ["color_temp", "hs"], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6000, brightness: 128 } },
      "fan.purifier": { state: "on", attributes: { friendly_name: "Purifier", percentage: 50, percentage_step: 25, preset_modes: ["auto", "sleep"] } },
      "cover.c": { state: "open", attributes: { friendly_name: "Curtain", current_position: 70, supported_features: 15 } },
      "vacuum.v": { state: "docked", attributes: { friendly_name: "Robot", battery_level: 90 } },
      "light.secret": { state: "on", attributes: { friendly_name: "Not in layout", supported_color_modes: ["hs"] } },
    });
    const store = new HassConfigStore({ home: tmpHome(), platform: "linux" });
    await store.setUrl(ha.url); await store.setToken(TOKEN);
    const client = new HassClient({ store, backoffMs: [30], pingMs: 60_000 });
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    app = await startServer({
      port: 0, pin: "666666", hostName: async () => "my-mac", hass: client, webhookKeyFile: join(tmpHome(), "webhook-key"), layoutHistoryDir: tmpHome(),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
    const e = (id: string, entity: any) => ({ id, kind: "widget", widget: "entity", entity });
    const layout = { version: 1, pages: [{ id: "ha", name: "Home", columns: 8, rows: 4, items: [
      e("ac", { id: "climate.bedroom_ac" }), e("lamp", { id: "light.l" }), e("purifier", { id: "fan.purifier" }), e("curtain", { id: "cover.c" }), e("robot", { id: "vacuum.v" }),
      e("ro", { id: "climate.bedroom_ac", readOnly: true }),
      { id: "act", kind: "button", label: "Light", action: { type: "hass", service: "light.toggle", entityId: "light.l" } },
      { id: "plain", kind: "button", label: "x", action: { type: "shell", command: "echo" } },
    ] }] };
    expect((await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(layout) })).status).toBe(200);
    tok = ((await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "666666" }) })).json()) as any).token;
    await until(() => ha.subs.length > 0 && !!app && ha.subs.at(-1)!.ids.includes("vacuum.v"));
  });
  afterAll(async () => {
    const { defaultLayout } = await import("../src/config");
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(defaultLayout()) });
    app.stop(); ha.stop();
  });

  function phone() {
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
    let n = 0;
    const control = async (itemId: string, op: string, value?: unknown, extra: Record<string, unknown> = {}) => {
      const reqId = `c${n++}`;
      ws.send(JSON.stringify({ type: "hass-control", reqId, pageId: "ha", itemId, op, ...(value !== undefined ? { value } : {}), ...extra }));
      return next((m) => m.type === "result" && m.reqId === reqId);
    };
    return { ws, next, control };
  }

  test("the hass payload carries what the controls need (limits, modes, current values), trimmed", async () => {
    const p = phone();
    const m = await p.next((x) => x.type === "hass");
    expect(m.entities["climate.bedroom_ac"].attrs).toMatchObject({ min_temp: 16, max_temp: 30, target_temp_step: 1, hvac_modes: ["off", "cool", "heat"], fan_modes: ["auto", "low"], swing_modes: ["off", "vertical"], temperature: 25, current_temperature: 27 });
    expect(m.entities["light.l"].attrs).toMatchObject({ brightness: 128, supported_color_modes: ["color_temp", "hs"], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6000 });
    expect(m.entities["fan.purifier"].attrs).toMatchObject({ percentage: 50, percentage_step: 25, preset_modes: ["auto", "sleep"] });
    expect(m.entities["cover.c"].attrs).toMatchObject({ current_position: 70, supported_features: 15 });
    expect(m.entities["vacuum.v"].attrs).toMatchObject({ battery_level: 90 });
    expect(m.entities["light.secret"]).toBeUndefined(); // not in the layout: never subscribed
    p.ws.close();
  });

  test("each domain maps to the right call_service on the tile's own entity", async () => {
    const p = phone();
    await p.next((x) => x.type === "hello");
    const last = () => calls().at(-1)!;
    const expectCall = (domain: string, service: string, entity: string, data?: any) => {
      expect(last()).toMatchObject({ domain, service, target: { entity_id: entity } });
      if (data) expect(last().service_data).toEqual(data); else expect(last().service_data).toBeUndefined();
    };
    expect((await p.control("ac", "set_temperature", 23.6)).ok).toBe(true); expectCall("climate", "set_temperature", "climate.bedroom_ac", { temperature: 24 });
    expect((await p.control("ac", "set_hvac_mode", "heat")).ok).toBe(true); expectCall("climate", "set_hvac_mode", "climate.bedroom_ac", { hvac_mode: "heat" });
    expect((await p.control("ac", "set_fan_mode", "low")).ok).toBe(true); expectCall("climate", "set_fan_mode", "climate.bedroom_ac", { fan_mode: "low" });
    expect((await p.control("ac", "set_swing_mode", "vertical")).ok).toBe(true); expectCall("climate", "set_swing_mode", "climate.bedroom_ac", { swing_mode: "vertical" });
    expect((await p.control("ac", "turn_off")).ok).toBe(true); expectCall("climate", "turn_off", "climate.bedroom_ac");
    expect((await p.control("lamp", "turn_on", 55)).ok).toBe(true); expectCall("light", "turn_on", "light.l", { brightness_pct: 55 });
    expect((await p.control("lamp", "set_color_temp", 3000)).ok).toBe(true); expectCall("light", "turn_on", "light.l", { color_temp_kelvin: 3000 });
    expect((await p.control("lamp", "set_hs_color", [200, 80])).ok).toBe(true); expectCall("light", "turn_on", "light.l", { hs_color: [200, 80] });
    expect((await p.control("lamp", "turn_off")).ok).toBe(true); expectCall("light", "turn_off", "light.l");
    expect((await p.control("purifier", "set_percentage", 80)).ok).toBe(true); expectCall("fan", "set_percentage", "fan.purifier", { percentage: 75 });
    expect((await p.control("purifier", "set_preset_mode", "sleep")).ok).toBe(true); expectCall("fan", "set_preset_mode", "fan.purifier", { preset_mode: "sleep" });
    expect((await p.control("purifier", "oscillate", false)).ok).toBe(true); expectCall("fan", "oscillate", "fan.purifier", { oscillating: false });
    expect((await p.control("curtain", "set_cover_position", 30)).ok).toBe(true); expectCall("cover", "set_cover_position", "cover.c", { position: 30 });
    expect((await p.control("curtain", "stop_cover")).ok).toBe(true); expectCall("cover", "stop_cover", "cover.c");
    expect((await p.control("robot", "return_to_base")).ok).toBe(true); expectCall("vacuum", "return_to_base", "vacuum.v");
    expect((await p.control("act", "turn_on", 20)).ok).toBe(true); expectCall("light", "turn_on", "light.l", { brightness_pct: 20 }); // a hass button's entity works too
    p.ws.close();
  });

  test("refused without a call: out of range, unsupported, wrong item, read-only, an entity the layout does not have", async () => {
    const p = phone();
    await p.next((x) => x.type === "hello");
    const n = calls().length;
    const bad = async (itemId: string, op: string, value?: unknown, extra: Record<string, unknown> = {}) => { const r = await p.control(itemId, op, value, extra); expect(r.ok).toBe(false); return r.error as string; };
    expect(await bad("ac", "set_temperature", 40)).toContain("between 16 and 30");
    expect(await bad("ac", "set_hvac_mode", "dry")).toContain("is not supported");
    expect(await bad("ac", "set_fan_mode", "turbo")).toContain("is not supported");
    expect(await bad("lamp", "set_brightness", 0)).toContain("between 1 and 100");
    expect(await bad("lamp", "set_color_temp", 9000)).toContain("between 2200 and 6000");
    expect(await bad("lamp", "set_hs_color", [400, 10])).toContain("0-360");
    expect(await bad("purifier", "set_percentage", 150)).toContain("between 0 and 100");
    expect(await bad("purifier", "set_preset_mode", "turbo")).toContain("is not supported");
    expect(await bad("curtain", "set_cover_position", -5)).toContain("between 0 and 100");
    expect(await bad("robot", "clean_spot")).toContain("has no operation");
    expect(await bad("ac", "set_temperature")).toContain("needs a number");
    expect(await bad("ro", "turn_off")).toContain("only shows status");
    expect(await bad("plain", "turn_on")).toContain("not linked to a Home Assistant device");
    expect(await bad("nope", "turn_on")).toContain("not linked to a Home Assistant device");
    // the phone cannot redirect a control to another entity, whatever extra fields it sends
    const r = await p.control("lamp", "turn_off", undefined, { entityId: "light.secret", entity_id: "light.secret", target: { entity_id: "light.secret" } });
    expect(r.ok).toBe(true);
    expect(calls().length).toBe(n + 1);
    expect(calls().at(-1)!.target).toEqual({ entity_id: "light.l" });
    expect(JSON.stringify(ha.received)).not.toContain("light.secret\"");
    p.ws.close();
  });

  test("HA errors come back as the result; not connected says so", async () => {
    const p = phone();
    await p.next((x) => x.type === "hello");
    ha.failServices(true);
    const r = await p.control("lamp", "turn_off");
    ha.failServices(false);
    expect(r).toMatchObject({ ok: false, error: "Service not found." });
    p.ws.close();
  });
});
