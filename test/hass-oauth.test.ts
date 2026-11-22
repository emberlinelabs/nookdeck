import "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp storage only, no Keychain (platform "linux" = file store, or a fake `security` runner): never the real ones.
process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-hoa-"));
const { HassClient } = await import("../src/hass/client");
const { HassConfigStore } = await import("../src/hass/config");
const { HassOAuth, STATE_TTL_MS, clientIdFor, redirectUriFor } = await import("../src/hass/oauth");
const { startServer } = await import("../src/server");

const tmp = () => mkdtempSync(join(tmpdir(), "pd-hoa-store-"));
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A fake Home Assistant: /auth/token, /auth/revoke and a websocket that accepts only live access tokens. */
function fakeHa() {
  let n = 0;
  const codes = new Map<string, { challenge: string; clientId: string }>();
  const refreshTokens = new Set<string>();
  const access = new Set<string>();
  const log: Array<{ path: string; form: Record<string, string> }> = [];
  const sockets = new Set<any>();
  const state = { expiresIn: 1800, failRefresh: 0 };
  const issue = (refresh: string) => { const a = `ACCESS-${++n}`; access.add(a); return { access_token: a, expires_in: state.expiresIn, token_type: "Bearer", refresh_token: refresh }; };
  const server = Bun.serve({
    port: 0,
    async fetch(req, s) {
      const u = new URL(req.url);
      if (u.pathname === "/api/websocket") return s.upgrade(req) ? undefined : new Response("no", { status: 400 });
      const form = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;
      log.push({ path: u.pathname, form });
      if (u.pathname === "/auth/token") {
        if (form.grant_type === "authorization_code") {
          const c = codes.get(form.code!);
          if (!c || c.clientId !== form.client_id) return Response.json({ error: "invalid_request" }, { status: 400 });
          const verifier = b64url(createHash("sha256").update(form.code_verifier ?? "").digest());
          if (verifier !== c.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
          codes.delete(form.code!);
          const refresh = `REFRESH-${++n}`;
          refreshTokens.add(refresh);
          return Response.json(issue(refresh));
        }
        if (form.grant_type === "refresh_token") {
          if (state.failRefresh) return Response.json({ error: "invalid_grant" }, { status: state.failRefresh });
          if (!refreshTokens.has(form.refresh_token!)) return Response.json({ error: "invalid_grant" }, { status: 400 });
          const { refresh_token: _drop, ...rest } = issue(form.refresh_token!);
          return Response.json(rest);
        }
      }
      if (u.pathname === "/auth/revoke") { refreshTokens.delete(form.token!); return new Response(""); }
      return new Response("no", { status: 404 });
    },
    websocket: {
      open(ws) { sockets.add(ws); ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.1.0" })); },
      close(ws) { sockets.delete(ws); },
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        const ok = (result: unknown = null) => ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result }));
        if (m.type === "auth") return void ws.send(JSON.stringify(access.has(m.access_token) ? { type: "auth_ok", ha_version: "2026.1.0" } : { type: "auth_invalid", message: "Invalid access token" }));
        if (m.type === "ping") return void ws.send(JSON.stringify({ id: m.id, type: "pong" }));
        if (m.type === "auth/current_user") return ok({ name: "Alice" });
        if (m.type === "get_config") return ok({ location_name: "Casa", unit_system: { temperature: "°C" } });
        if (m.type === "subscribe_entities") { ok(); return void ws.send(JSON.stringify({ id: m.id, type: "event", event: { a: {} } })); }
        if (m.type === "config/entity_registry/list") return ok([]);
        ok({});
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`, log, state, refreshTokens, access,
    /** what the browser would do after the user clicks "Allow": HA makes a code bound to the challenge and redirects */
    approve(authorizeUrl: string): { code: string; state: string } {
      const q = new URL(authorizeUrl).searchParams;
      const code = `CODE-${++n}`;
      codes.set(code, { challenge: q.get("code_challenge")!, clientId: q.get("client_id")! });
      return { code, state: q.get("state")! };
    },
    dropSockets: () => { for (const ws of [...sockets]) ws.close(); },
    stop: () => server.stop(true),
  };
}

const ORIGIN = "http://127.0.0.1:7420";

describe("HassOAuth against a fake Home Assistant", () => {
  test("login: same host and port for client id and redirect, a random state, PKCE", async () => {
    const ha = fakeHa();
    const oauth = new HassOAuth({ store: new HassConfigStore({ home: tmp(), platform: "linux" }) });
    const { authorizeUrl } = oauth.login(ha.url, ORIGIN);
    const u = new URL(authorizeUrl);
    expect(u.origin + u.pathname).toBe(`${ha.url}/auth/authorize`);
    expect(u.searchParams.get("client_id")).toBe("http://127.0.0.1:7420/");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:7420/api/hass/callback");
    expect(new URL(clientIdFor(ORIGIN)).host).toBe(new URL(redirectUriFor(ORIGIN)).host); // HA's rule: same host and port
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")!.length).toBeGreaterThanOrEqual(24);
    expect(oauth.login(ha.url, ORIGIN).authorizeUrl).not.toBe(authorizeUrl); // fresh state every time
    expect(() => oauth.login("ftp://x", ORIGIN)).toThrow();
    ha.stop();
  });

  test("a state that does not match, was used, or is older than 10 minutes is refused and nothing is stored", async () => {
    const ha = fakeHa();
    const store = new HassConfigStore({ home: tmp(), platform: "linux" });
    let now = 1_000_000;
    const oauth = new HassOAuth({ store, now: () => now });
    const a = ha.approve(oauth.login(ha.url, ORIGIN).authorizeUrl);
    await expect(oauth.callback(a.code, "wrong-state")).rejects.toThrow("unknown or expired");
    await oauth.callback(a.code, a.state); // the real one still works
    await expect(oauth.callback(a.code, a.state)).rejects.toThrow("unknown or expired"); // one use only
    const b = ha.approve(oauth.login(ha.url, ORIGIN).authorizeUrl);
    now += STATE_TTL_MS + 1;
    await expect(oauth.callback(b.code, b.state)).rejects.toThrow("expired");
    await expect(oauth.callback(undefined, undefined)).rejects.toThrow();
    ha.stop();
  });

  test("the code is exchanged (with the PKCE verifier and the same client id); the refresh token is stored, the url too", async () => {
    const ha = fakeHa();
    const store = new HassConfigStore({ home: tmp(), platform: "linux" });
    const oauth = new HassOAuth({ store });
    const a = ha.approve(oauth.login(`${ha.url}/`, ORIGIN).authorizeUrl);
    await oauth.callback(a.code, a.state);
    const ex = ha.log.find((l) => l.form.grant_type === "authorization_code")!;
    expect(ex.form.client_id).toBe("http://127.0.0.1:7420/");
    expect(ex.form.code_verifier!.length).toBeGreaterThan(40);
    expect(await store.url()).toBe(ha.url);
    expect(await store.hasRefreshToken()).toBe(true);
    expect(await oauth.accessToken()).toBe("ACCESS-3"); // the one from the exchange, not refreshed
    ha.stop();
  });

  test("a bad code is refused by HA: an error, nothing stored", async () => {
    const ha = fakeHa();
    const store = new HassConfigStore({ home: tmp(), platform: "linux" });
    const oauth = new HassOAuth({ store });
    const a = oauth.login(ha.url, ORIGIN).authorizeUrl;
    await expect(oauth.callback("NOPE", new URL(a).searchParams.get("state"))).rejects.toThrow("refused the code (400: invalid_request)");
    expect(await store.hasRefreshToken()).toBe(false);
    ha.stop();
  });

  test("the access token is refreshed before it expires (and only then)", async () => {
    const ha = fakeHa();
    ha.state.expiresIn = 1800;
    const store = new HassConfigStore({ home: tmp(), platform: "linux" });
    let now = 5_000_000;
    const oauth = new HassOAuth({ store, now: () => now });
    const a = ha.approve(oauth.login(ha.url, ORIGIN).authorizeUrl);
    await oauth.callback(a.code, a.state);
    const first = (await oauth.accessToken())!;
    now += 20 * 60_000;
    expect(await oauth.accessToken()).toBe(first); // still fresh
    expect(ha.log.filter((l) => l.form.grant_type === "refresh_token")).toHaveLength(0);
    now += 10 * 60_000 - 30_000; // inside the last minute
    const second = (await oauth.accessToken())!;
    expect(second).not.toBe(first);
    expect(ha.log.filter((l) => l.form.grant_type === "refresh_token")).toHaveLength(1);
    expect(ha.log.at(-1)!.form.client_id).toBe("http://127.0.0.1:7420/");
    // concurrent callers share one refresh
    now += 40 * 60_000;
    await Promise.all([oauth.accessToken(), oauth.accessToken(), oauth.accessToken()]);
    expect(ha.log.filter((l) => l.form.grant_type === "refresh_token")).toHaveLength(2);
    ha.stop();
  });

  test("after a restart the refresh uses the origin saved at sign-in; HA ending the sign-in clears it", async () => {
    const ha = fakeHa();
    const home = tmp();
    const store = new HassConfigStore({ home, platform: "linux" });
    const o1 = new HassOAuth({ store });
    const a = ha.approve(o1.login(ha.url, ORIGIN).authorizeUrl);
    await o1.callback(a.code, a.state);
    const o2 = new HassOAuth({ store: new HassConfigStore({ home, platform: "linux" }) }); // a new process
    expect(await o2.accessToken()).toMatch(/^ACCESS-/);
    expect(ha.log.at(-1)!.form.client_id).toBe("http://127.0.0.1:7420/");
    ha.state.failRefresh = 400; // revoked in HA's profile page
    o2.invalidate();
    expect(await o2.accessToken()).toBeNull();
    expect(await store.hasRefreshToken()).toBe(false);
    ha.stop();
  });

  test("logout revokes the refresh token at HA and forgets it, even when HA is gone", async () => {
    const ha = fakeHa();
    const store = new HassConfigStore({ home: tmp(), platform: "linux" });
    const oauth = new HassOAuth({ store });
    const a = ha.approve(oauth.login(ha.url, ORIGIN).authorizeUrl);
    await oauth.callback(a.code, a.state);
    const refresh = [...ha.refreshTokens][0]!;
    await oauth.logout();
    expect(ha.log.at(-1)).toMatchObject({ path: "/auth/revoke", form: { token: refresh } });
    expect(ha.refreshTokens.size).toBe(0);
    expect(await store.hasRefreshToken()).toBe(false);
    expect(await oauth.accessToken()).toBeNull();
    // HA unreachable
    const o2 = new HassOAuth({ store: new HassConfigStore({ home: tmp(), platform: "linux" }), timeoutMs: 300 });
    const b = ha.approve(o2.login(ha.url, ORIGIN).authorizeUrl);
    await o2.callback(b.code, b.state);
    ha.stop();
    await o2.logout();
    expect(await o2.connected()).toBe(false);
  });

  test("the refresh token goes to the Keychain item Nookdeck-HASS (account refresh), through a fake `security`", async () => {
    const ha = fakeHa();
    const calls: string[][] = [];
    const mem = new Map<string, string>();
    const run = async (argv: string[]) => {
      calls.push(argv);
      const key = `${argv[argv.indexOf("-s") + 1]}/${argv[argv.indexOf("-a") + 1]}`;
      if (argv[1] === "add-generic-password") mem.set(key, argv[argv.indexOf("-w") + 1]!);
      if (argv[1] === "delete-generic-password") mem.delete(key);
      if (argv[1] === "find-generic-password") return mem.get(key) ?? (() => { throw new Error("none"); })();
      return "";
    };
    const home = tmp();
    const store = new HassConfigStore({ home, run });
    const oauth = new HassOAuth({ store });
    const a = ha.approve(oauth.login(ha.url, ORIGIN).authorizeUrl);
    await oauth.callback(a.code, a.state);
    expect(mem.has("Nookdeck-HASS/refresh")).toBe(true);
    expect(readFileSync(join(home, "hass.json"), "utf8")).not.toContain("REFRESH-"); // not in the file
    expect(await store.hasRefreshToken()).toBe(true);
    await oauth.logout();
    expect(mem.has("Nookdeck-HASS/refresh")).toBe(false);
    ha.stop();
  });
});

describe("the client and the REST routes (fake HA, temp storage)", () => {
  let ha: ReturnType<typeof fakeHa>; let app: any; let base: string; let store: InstanceType<typeof HassConfigStore>; let client: InstanceType<typeof HassClient>; let home: string;
  const J = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b) });
  const until = async (f: () => boolean | Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error("timeout"); };

  beforeAll(async () => {
    ha = fakeHa();
    home = tmp();
    store = new HassConfigStore({ home, platform: "linux" });
    client = new HassClient({ store, oauth: new HassOAuth({ store }), backoffMs: [30], pingMs: 60_000 });
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    app = await startServer({
      port: 0, pin: "555555", hostName: async () => "my-mac", hass: client,
      webhookKeyFile: join(home, "webhook-key"), layoutHistoryDir: home,
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
  });
  afterAll(() => { client.stop(); app.stop(); ha.stop(); });

  const callback = (code: string, state: string) => fetch(`http://127.0.0.1:${app.port}/api/hass/callback?code=${code}&state=${state}`, { redirect: "manual" });

  test("the login routes are local-only; a wrong state redirects back with an error", async () => {
    const { rawFetch } = await import("./_fetch");
    expect((await rawFetch(`${base}/api/hass/login`, { method: "POST", body: JSON.stringify({ url: ha.url }) })).status).toBe(403); // no CSRF header
    expect((await rawFetch(`${base}/api/hass/login`, { method: "POST", body: "{}", headers: { host: "evil.example", "x-nookdeck": "1", "content-type": "application/json" } })).status).toBe(403);
    expect((await fetch(`${base}/api/hass/login`, J({ url: "not a url" }))).status).toBe(400);
    const bad = await callback("x", "nope");
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toContain("/manage/#plugins/core.hass?hass=error&reason=");
    expect(await store.hasRefreshToken()).toBe(false);
  });

  test("sign in: login -> HA -> callback -> connected as oauth, with the HA name, version and user", async () => {
    const r = await fetch(`${base}/api/hass/login`, J({ url: ha.url }));
    const { authorizeUrl } = (await r.json()) as any;
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${app.port}/api/hass/callback`);
    expect((await (await fetch(`${base}/api/hass/status`)).json())).toMatchObject({ connected: false, mode: null });
    const a = ha.approve(authorizeUrl);
    const back = await callback(a.code, a.state);
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/manage/#plugins/core.hass?hass=ok");
    await until(() => client.connected());
    const st = (await (await fetch(`${base}/api/hass/status`)).json()) as any;
    await until(async () => ((await (await fetch(`${base}/api/hass/status`)).json()) as any).user === "Alice");
    expect(st).toMatchObject({ connected: true, mode: "oauth", haVersion: "2026.1.0" });
    const full = (await (await fetch(`${base}/api/hass/status`)).json()) as any;
    expect(full).toMatchObject({ haName: "Casa", user: "Alice" });
    // no token anywhere in what the API says
    const everything = JSON.stringify([full, await (await fetch(`${base}/api/hass/config`)).json(), await (await fetch(`${base}/api/about`)).text()]);
    expect(everything).not.toMatch(/ACCESS-|REFRESH-/);
    expect(existsSync(join(home, "hass.json"))).toBe(true);
  });

  test("a rejected access token is refreshed once and the client reconnects (the 401 retry)", async () => {
    const before = ha.log.filter((l) => l.form.grant_type === "refresh_token").length;
    ha.access.clear(); // HA forgot the token the client holds (it is still fresh locally)
    ha.dropSockets();
    await until(() => ha.log.filter((l) => l.form.grant_type === "refresh_token").length > before && client.connected());
    expect(ha.log.filter((l) => l.form.grant_type === "refresh_token").length).toBe(before + 1);
    expect(((await (await fetch(`${base}/api/hass/status`)).json()) as any).connected).toBe(true);
  });

  test("logout revokes, disconnects and clears; a pasted long-lived token still works as the fallback", async () => {
    const refresh = [...ha.refreshTokens][0]!;
    const out = (await (await fetch(`${base}/api/hass/logout`, J({}))).json()) as any;
    expect(out).toMatchObject({ connected: false, mode: null });
    expect(ha.log.at(-1)).toMatchObject({ path: "/auth/revoke", form: { token: refresh } });
    expect(ha.refreshTokens.size).toBe(0);
    expect(await store.hasRefreshToken()).toBe(false);
    // token mode (the old way)
    ha.access.add("LONG-LIVED");
    await fetch(`${base}/api/hass/config`, J({ url: ha.url }, "PUT"));
    await fetch(`${base}/api/hass/token`, J({ token: "LONG-LIVED" }, "PUT"));
    await until(() => client.connected());
    expect(((await (await fetch(`${base}/api/hass/status`)).json()) as any)).toMatchObject({ connected: true, mode: "token" });
  });
});
