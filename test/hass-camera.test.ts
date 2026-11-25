import "./_fetch";
import { rawFetch } from "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { CAMERA_MAX_BYTES, CAMERA_MAX_HELD, CAMERA_REUSE_MS, cameraCache, fetchCamera } from "../src/hass/camera";
import { validateLayout, defaultLayout } from "../src/config";
import { cameraTiles, toPhoneEntity, wantedEntities } from "../src/hass/entities";
import { CAMERA_STUCK_MS, CAMERA_VIEW_S, cameraDue, cameraEvery, cameraUrl } from "../web/deck/src/camera-logic";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-cam-"));
const { HassConfigStore } = await import("../src/hass/config");
const { startServer } = await import("../src/server");

const TOKEN = "HA-SECRET-TOKEN-987";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const fake = (fn: (url: string, init: any) => Response | Promise<Response>) => fn as unknown as typeof fetch;

describe("fetchCamera", () => {
  test("asks camera_proxy with the agent's token and follows no redirect", async () => {
    let seen: any;
    const img = await fetchCamera(fake((url, init) => { seen = { url, init }; return new Response(JPEG, { headers: { "content-type": "image/jpeg; charset=binary" } }); }), "http://ha.local:8123", TOKEN, "camera.door");
    expect(seen.url).toBe("http://ha.local:8123/api/camera_proxy/camera.door");
    expect(seen.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.init.redirect).toBe("manual");
    expect(img).toEqual({ bytes: JPEG, type: "image/jpeg" });
  });
  test("only pictures get through; errors never repeat what HA said", async () => {
    const get = (r: () => Response) => fetchCamera(fake(r), "http://ha", TOKEN, "camera.door");
    await expect(get(() => new Response(`<html>${TOKEN}</html>`, { headers: { "content-type": "text/html" } }))).rejects.toThrow("did not send the picture");
    await expect(get(() => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }))).rejects.toThrow("did not send");
    await expect(get(() => new Response(null, { status: 302, headers: { location: "http://evil/x" } }))).rejects.toThrow("did not send");
    await expect(get(() => new Response("no", { status: 404 }))).rejects.toMatchObject({ status: 404 });
    await expect(fetchCamera(fake(() => { throw new Error(`boom ${TOKEN}`); }), "http://ha", TOKEN, "camera.door")).rejects.toThrow(/^Home Assistant did not send the picture$/);
  });
  test("a picture over the limit is cut off", async () => {
    const big = () => new Response(new Uint8Array(CAMERA_MAX_BYTES + 1), { headers: { "content-type": "image/jpeg" } });
    await expect(fetchCamera(fake(big), "http://ha", TOKEN, "camera.door")).rejects.toThrow("too large");
  });
  test("requests at the same time, and within a second, share one picture; a failure is not kept", async () => {
    let calls = 0, now = 1000, bad = false;
    const get = cameraCache(async () => { calls++; if (bad) throw new Error("x"); return { bytes: JPEG, type: "image/jpeg" }; }, () => now);
    await Promise.all([get("camera.a"), get("camera.a"), get("camera.b")]);
    expect(calls).toBe(2);
    await get("camera.a");
    expect(calls).toBe(2);
    now += 1500;
    bad = true;
    await expect(get("camera.a")).rejects.toThrow("x");
    bad = false;
    await get("camera.a");
    expect(calls).toBe(4);
  });
  test("no picture stays in memory: each is dropped after its second, and only so many ids are held", async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    let calls = 0;
    const get = cameraCache(async () => { calls++; return { bytes: JPEG, type: "image/jpeg" }; }, () => 1000, (fn, ms) => timers.push({ fn, ms }));
    await get("camera.a");
    expect([get.held(), timers.map((t) => t.ms)]).toEqual([1, [CAMERA_REUSE_MS]]);
    timers[0]!.fn();
    expect(get.held()).toBe(0);
    await Promise.all(Array.from({ length: 100 }, (_, i) => get(`camera.x${i}`)));
    expect(get.held()).toBe(CAMERA_MAX_HELD);
    calls = 0;
    await get("camera.x99"); // the newest are the ones kept
    expect(calls).toBe(0);
    await get("camera.x0");
    expect(calls).toBe(1);
    for (const t of timers) t.fn();
    expect(get.held()).toBe(0);
  });
  test("the default timer drops the picture by itself", async () => {
    const get = cameraCache(async () => ({ bytes: JPEG, type: "image/jpeg" }));
    await get("camera.a");
    await Bun.sleep(CAMERA_REUSE_MS + 150);
    expect(get.held()).toBe(0);
  });
});

describe("camera tile timing and settings", () => {
  test("10 s by default, 5 to 60", () => {
    expect([cameraEvery(undefined), cameraEvery(1), cameraEvery(30), cameraEvery(600)]).toEqual([10, 5, 30, 60]);
    expect(CAMERA_VIEW_S).toBe(2);
  });
  test("loads at once, then each period; never off screen, never on top of a load under way (unless it is stuck)", () => {
    expect(cameraDue({ started: 0, loading: false }, 100_000, 10, true)).toBe(true);
    expect(cameraDue({ started: 0, loading: false }, 100_000, 10, false)).toBe(false);
    expect(cameraDue({ started: 100_000, loading: false }, 109_999, 10, true)).toBe(false);
    expect(cameraDue({ started: 100_000, loading: false }, 110_000, 10, true)).toBe(true);
    expect(cameraDue({ started: 100_000, loading: true }, 112_000, 2, true)).toBe(false);
    expect(cameraDue({ started: 100_000, loading: true }, 100_000 + CAMERA_STUCK_MS, 2, true)).toBe(true);
  });
  test("the phone's address of a picture names only the agent", () => {
    expect(cameraUrl("", "camera.door", 5)).toBe("/api/hass/camera/camera.door?t=5");
  });
  const layoutWith = (entity: unknown) => {
    const l: any = defaultLayout();
    l.pages = [{ id: "p", name: "P", columns: 4, rows: 3, items: [{ id: "c", kind: "widget", widget: "entity", x: 0, y: 0, w: 2, h: 2, entity }] }];
    return l;
  };
  test("refresh is a whole number from 5 to 60", () => {
    expect((validateLayout(layoutWith({ id: "camera.door", refresh: 30 })).pages[0]!.items[0] as any).entity).toEqual({ id: "camera.door", refresh: 30 });
    for (const refresh of [4, 61, 7.5, "10"]) expect(() => validateLayout(layoutWith({ id: "camera.door", refresh }))).toThrow("5 to 60");
    expect(wantedEntities(validateLayout(layoutWith({ id: "camera.door" })))).toEqual(["camera.door"]);
  });
  test("only an entity tile opens a camera to phones: not a button, a macro step, the weather or a rule", () => {
    const l: any = { pages: [{ items: [
      { kind: "widget", widget: "entity", entity: { id: "camera.door" } },
      { kind: "widget", widget: "entity", entity: { id: "light.hall" } },
      { kind: "widget", widget: "weather", weather: { entity: "camera.weather" } },
      { kind: "button", action: { type: "hass", entityId: "camera.button" } },
      { kind: "button", action: { type: "macro", steps: [{ kind: "hass", entityId: "camera.macro" }] } },
    ] }], rules: [{ when: { kind: "hass-state", entityId: "camera.rule" } }] };
    expect([...cameraTiles(l)]).toEqual(["camera.door"]);
    expect(wantedEntities(l)).toContain("camera.rule"); // still watched
  });
  test("a camera's own access token and picture address never reach the phone", () => {
    const e = toPhoneEntity("camera.door", "idle", { friendly_name: "Door", access_token: "abc123", entity_picture: "/api/camera_proxy/camera.door?token=abc123", supported_features: 2 });
    expect(JSON.stringify(e)).not.toContain("abc123");
    expect(JSON.stringify(e)).not.toContain("entity_picture");
  });
});

const lan = Object.values(networkInterfaces()).flatMap((l) => l ?? []).find((a) => a.family === "IPv4" && !a.internal)?.address;

describe("GET /api/hass/camera/<entity>, with a fake Home Assistant", () => {
  const asked: { path: string; auth: string | null }[] = [];
  let ha: ReturnType<typeof Bun.serve>;
  let app: any;
  // the data folder is shared by every test file: the layout saved here is put back afterwards
  let layoutFile = "";
  let savedLayout: string | null = null;
  beforeAll(async () => {
    const { HOME } = await import("../src/config");
    layoutFile = join(HOME, "layout.json"); // fixed at the first import, whatever NOOKDECK_HOME says now
    savedLayout = existsSync(layoutFile) ? readFileSync(layoutFile, "utf8") : null;
    ha = Bun.serve({
      port: 0,
      fetch(req, s) {
        const path = new URL(req.url).pathname;
        if (path === "/api/websocket") return s.upgrade(req) ? undefined : new Response("no", { status: 400 });
        asked.push({ path, auth: req.headers.get("authorization") });
        if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("401", { status: 401 });
        return path.startsWith("/api/camera_proxy/camera.") ? new Response(JPEG, { headers: { "content-type": "image/jpeg" } }) : new Response("404", { status: 404 });
      },
      websocket: {
        open(ws) { ws.send(JSON.stringify({ type: "auth_required" })); },
        message(ws, raw) {
          const m = JSON.parse(String(raw));
          if (m.type === "auth") return void ws.send(JSON.stringify({ type: m.access_token === TOKEN ? "auth_ok" : "auth_invalid" }));
          ws.send(JSON.stringify({ id: m.id, type: m.type === "ping" ? "pong" : "result", success: true, result: m.type === "get_config" ? {} : [] }));
        },
      },
    });
    const home = mkdtempSync(join(tmpdir(), "pd-cam-home-"));
    const store = new HassConfigStore({ home, platform: "linux" });
    await store.setUrl(`http://127.0.0.1:${ha.port}`);
    await store.setToken(TOKEN);
    app = await startServer({
      port: 0, pin: "555555", hostName: async () => "my-mac", interfaces: () => networkInterfaces(), hassStore: store,
      webhookKeyFile: join(home, "webhook-key"), layoutHistoryDir: mkdtempSync(join(tmpdir(), "pd-cam-hist-")),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => null, codex: async () => null, antigravity: async () => null, sessions: async () => [] } as any,
    });
    const l: any = defaultLayout();
    l.pages = [{ id: "p", name: "P", columns: 4, rows: 3, items: [
      { id: "c", kind: "widget", widget: "entity", x: 0, y: 0, w: 2, h: 2, entity: { id: "camera.door" } },
      { id: "b", kind: "button", x: 2, y: 0, w: 1, h: 1, label: "Snap", action: { type: "hass", service: "camera.turn_on", entityId: "camera.button" } },
    ] }];
    const put = await fetch(`http://127.0.0.1:${app.port}/api/layout`, { method: "PUT", body: JSON.stringify(l) });
    expect(put.status).toBe(200);
    const end = Date.now() + 3000;
    while (Date.now() < end && (await fetch(`http://127.0.0.1:${app.port}/api/hass/camera/camera.door`)).status !== 200) await Bun.sleep(30);
  });
  afterAll(() => {
    app?.stop?.();
    ha?.stop(true);
    if (savedLayout === null) rmSync(layoutFile, { force: true });
    else writeFileSync(layoutFile, savedLayout);
  });

  test("this computer gets the picture; nothing of Home Assistant comes with it", async () => {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/hass/camera/camera.door`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
    expect(asked.at(-1)).toEqual({ path: "/api/camera_proxy/camera.door", auth: `Bearer ${TOKEN}` });
  });
  test("only camera ids; a rebinding Host is refused", async () => {
    for (const id of ["light.kitchen", "camera.Door", "camera.a%2F..%2F..%2Fconfig", "camera.a%3Fx"]) expect((await fetch(`http://127.0.0.1:${app.port}/api/hass/camera/${id}`)).status).toBe(404);
    expect((await rawFetch(`http://127.0.0.1:${app.port}/api/hass/camera/camera.door`, { headers: { host: "evil.example" } })).status).toBe(403);
  });
  test.skipIf(!lan)("a phone must be paired, and gets only cameras that are on the layout", async () => {
    const at = (path: string, init?: RequestInit) => rawFetch(`http://${lan}:${app.port}${path}`, init);
    const before = asked.length;
    expect((await at("/api/hass/camera/camera.door")).status).toBe(401);
    expect((await at("/api/hass/camera/camera.door?token=wrong")).status).toBe(401);
    expect(asked.length).toBe(before);
    const paired: any = await (await at("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "555555", name: "phone" }) })).json();
    const cookie = { cookie: `pd_token=${paired.token}` };
    await Bun.sleep(1100); // past the shared picture, so Home Assistant is asked again
    const ok = await at("/api/hass/camera/camera.door", { headers: cookie });
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(JPEG);
    expect((await at("/api/hass/camera/camera.bedroom", { headers: cookie })).status).toBe(404);
    expect((await at("/api/hass/camera/camera.button", { headers: cookie })).status).toBe(404);
    expect(asked.some((a) => /camera\.(bedroom|button)$/.test(a.path))).toBe(false);
    expect((await fetch(`http://127.0.0.1:${app.port}/api/hass/camera/camera.button`)).status).toBe(200); // this computer: any camera
  });
});
