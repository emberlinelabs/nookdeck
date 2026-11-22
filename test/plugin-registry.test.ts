import "./_fetch";
import { rawFetch } from "./_fetch";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// every plugin and cache file goes to a temp dir: never the real ~/.nookdeck
process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-reg-home-"));
const { Registry, parseRegistry, compareVersions } = await import("../src/plugins/registry");
const { PluginStore, packageHash } = await import("../src/plugins/store");

const tmp = (p = "pd-reg-") => mkdtempSync(join(tmpdir(), p));
const REPO = "https://github.com/alice/crypto";
const RAW = "https://raw.githubusercontent.com/alice/crypto/main";
const REGISTRY = "https://registry.test/plugins.json";

const manifest = (version: string, hosts: string[] = ["api.example.com"]) => JSON.stringify({
  id: "dev.alice.crypto", name: "Crypto price", version, author: "alice", description: "Live price",
  permissions: { network: hosts },
  settings: [{ key: "apiKey", type: "secret", label: "API key" }],
  widgets: [{ id: "price", name: "Price", render: "stat", sizes: ["2x1"], source: { http: { url: "https://api.example.com/p" }, map: { value: "$.usd" } } }],
});
const shaOf = (text: string) => packageHash(new Map([["nookdeck.json", new TextEncoder().encode(text)]]));

/** A fake of the registry file and the plugin's repo: nothing here touches the network. */
function fake() {
  const f = {
    offline: false, hits: [] as string[], etag: 'W/"1"', manifestText: manifest("1.0.0"), readme: "# Crypto\nhello" as string | null,
    entries: [] as any[],
    entry(over: Record<string, unknown> = {}) { return { id: "dev.alice.crypto", name: "Crypto price", version: "1.0.0", repo: REPO, sha256: shaOf(f.manifestText), description: "Live price", ...over }; },
    fetch: (async (url: any, init?: any) => {
      const u = String(url);
      f.hits.push(u);
      if (f.offline) throw new Error("offline");
      if (u === REGISTRY) {
        if (init?.headers?.["if-none-match"] === f.etag) return new Response(null, { status: 304 });
        return new Response(JSON.stringify({ plugins: f.entries }), { headers: { "content-type": "application/json", etag: f.etag } });
      }
      if (u === `${RAW}/nookdeck.json`) return new Response(f.manifestText);
      if (u === `${RAW}/README.md`) return f.readme === null ? new Response("no", { status: 404 }) : new Response(f.readme);
      return new Response("no", { status: 404 });
    }) as any as typeof fetch,
  };
  return f;
}

describe("registry parsing and versions", () => {
  test("bad rows are dropped, good rows kept, core ids and http repos refused", () => {
    const good = { id: "dev.a.b", name: "A", version: "1.2.3", repo: "https://github.com/a/b", sha256: "A".repeat(64), screenshot: "https://x.test/s.png", icon: "http://x.test/i.png" };
    const out = parseRegistry({ plugins: [good, { ...good, id: "dev.a.c", sha256: "zz" }, { ...good, id: "core.x" }, { ...good, id: "dev.a.d", repo: "http://x" }, { ...good, id: "dev.a.e", version: "one" }, { ...good }, null, 5] });
    expect(out.map((e) => e.id)).toEqual(["dev.a.b"]); // the duplicate id is dropped too
    expect(out[0]).toMatchObject({ sha256: "a".repeat(64), screenshot: "https://x.test/s.png" });
    expect(out[0]).not.toHaveProperty("icon"); // an http icon is not kept
    expect(parseRegistry([good])).toHaveLength(1);
    expect(() => parseRegistry({ nope: 1 })).toThrow();
  });
  test("compareVersions", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareVersions("v2.0", "1.9.9")).toBe(1);
  });
});

describe("Registry cache", () => {
  test("cached for the ttl, revalidated with the ETag, last good copy when offline", async () => {
    const f = fake(); f.entries = [f.entry()];
    let t = 1_000;
    const dir = tmp();
    const r = new Registry({ url: REGISTRY, fetch: f.fetch, now: () => t, file: join(dir, "reg.json") });
    const a = await r.get();
    expect(a.plugins).toHaveLength(1);
    expect(a.stale).toBeUndefined();
    t += 5 * 60_000;
    await r.get();
    expect(f.hits.filter((h) => h === REGISTRY)).toHaveLength(1); // fresh: no request
    t += 6 * 60_000; // past 10 minutes
    const b = await r.get();
    expect(f.hits.filter((h) => h === REGISTRY)).toHaveLength(2);
    expect(b.fetchedAt).toBe(t); // a 304 renews the copy
    expect(b.plugins).toHaveLength(1);
    f.offline = true;
    t += 11 * 60_000;
    const c = await r.get();
    expect(c).toMatchObject({ stale: true });
    expect(c.plugins).toHaveLength(1);
    // a fresh process with no network still has the copy on disk
    const r2 = new Registry({ url: REGISTRY, fetch: f.fetch, now: () => t, file: join(dir, "reg.json") });
    expect((await r2.get()).stale).toBe(true);
    // nothing cached and offline: a clear 502
    const r3 = new Registry({ url: REGISTRY, fetch: f.fetch, now: () => t, file: join(tmp(), "none.json") });
    await expect(r3.get()).rejects.toMatchObject({ status: 502 });
  });
  test("a changed registry replaces the copy", async () => {
    const f = fake(); f.entries = [f.entry()];
    const r = new Registry({ url: REGISTRY, fetch: f.fetch, ttlMs: 0, file: join(tmp(), "reg.json") });
    expect((await r.get()).plugins[0]!.version).toBe("1.0.0");
    f.etag = 'W/"2"'; f.entries = [f.entry({ version: "1.1.0" })];
    expect((await r.get()).plugins[0]!.version).toBe("1.1.0");
  });
  test("NOOKDECK_REGISTRY_URL overrides the address", () => {
    process.env.NOOKDECK_REGISTRY_URL = "https://mirror.test/p.json";
    try { expect(new Registry().url).toBe("https://mirror.test/p.json"); } finally { delete process.env.NOOKDECK_REGISTRY_URL; }
    expect(new Registry().url).toContain("howznguyen/nookdeck-plugins");
  });
});

describe("Registry manifest cache", () => {
  test("cached for the ttl; the last copy when the repo cannot be reached", async () => {
    const f = fake(); f.entries = [f.entry()];
    let t = 1_000;
    const r = new Registry({ url: REGISTRY, fetch: f.fetch, now: () => t, file: join(tmp(), "reg.json") });
    const e = f.entries[0];
    await r.manifest(e);
    await r.manifest(e);
    expect(f.hits.filter((h) => h === `${RAW}/nookdeck.json`)).toHaveLength(1);
    t += 11 * 60_000; f.offline = true;
    expect((await r.manifest(e)).id).toBe("dev.alice.crypto");
  });
});

describe("server: browse, install from the registry, update, README", () => {
  test("sha match, mismatch, updateAvailable, update with a re-grant, README, local-only", async () => {
    const f = fake(); f.entries = [f.entry()];
    const home = tmp("pd-reg-srv-");
    const { startServer } = await import("../src/server");
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    const store = new PluginStore({ dir: join(home, "plugins"), stateFile: join(home, "plugins.json"), agentVersion: "0.2.0", fetch: f.fetch });
    const app: any = await startServer({
      port: 0, pin: "555555", hostName: async () => "my-mac",
      webhookKeyFile: join(home, "webhook-key"), layoutHistoryDir: tmp("pd-reg-hist-"),
      plugins: store, registry: new Registry({ url: REGISTRY, fetch: f.fetch, ttlMs: 0, file: join(home, "reg.json") }),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null },
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] },
    } as any);
    const base = `http://localhost:${app.port}`;
    const J = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
    try {
      // browse
      let reg = (await (await fetch(`${base}/api/plugins/registry`)).json()) as any;
      expect(reg.plugins[0]).toMatchObject({ id: "dev.alice.crypto", installed: false, updateAvailable: false });
      expect(reg.stale).toBeUndefined();
      expect(typeof reg.fetchedAt).toBe("number");

      // mismatch: the repo has other files than the reviewed ones -> nothing installed
      const reviewed = f.manifestText;
      f.manifestText = manifest("1.0.0", ["api.example.com", "evil.example"]);
      const bad = await fetch(`${base}/api/plugins/install-from-registry`, J({ id: "dev.alice.crypto" }));
      expect(bad.status).toBe(409);
      expect(((await bad.json()) as any).error).toBe("the plugin files do not match the reviewed version");
      expect(store.has("dev.alice.crypto")).toBe(false);
      // unknown id, bad body
      expect((await fetch(`${base}/api/plugins/install-from-registry`, J({ id: "dev.nope.x" }))).status).toBe(404);
      expect((await fetch(`${base}/api/plugins/install-from-registry`, J({}))).status).toBe(400);

      // match: installed, reviewed, still off until granted
      f.manifestText = reviewed;
      const ok = await fetch(`${base}/api/plugins/install-from-registry`, J({ id: "dev.alice.crypto" }));
      expect(ok.status).toBe(201);
      const p = (await ok.json()) as any;
      expect(p).toMatchObject({ id: "dev.alice.crypto", unreviewed: false, registryVersion: "1.0.0", enabled: false, needsApproval: true });
      reg = (await (await fetch(`${base}/api/plugins/registry`)).json()) as any;
      expect(reg.plugins[0]).toMatchObject({ installed: true, installedVersion: "1.0.0", updateAvailable: false });

      await fetch(`${base}/api/plugins/dev.alice.crypto/grant`, J({ permissions: { network: ["api.example.com"] } }));
      await fetch(`${base}/api/plugins/dev.alice.crypto/enabled`, J({ enabled: true }));
      await fetch(`${base}/api/plugins/dev.alice.crypto/settings`, { method: "PUT", body: JSON.stringify({ apiKey: "K" }) });

      // the registry gets 1.1.0 (more hosts): updateAvailable, then update keeps settings and asks for a re-grant
      f.manifestText = manifest("1.1.0", ["api.example.com", "other.example"]);
      f.etag = 'W/"2"'; f.entries = [f.entry({ version: "1.1.0" })];
      reg = (await (await fetch(`${base}/api/plugins/registry`)).json()) as any;
      expect(reg.plugins[0]).toMatchObject({ installed: true, installedVersion: "1.0.0", updateAvailable: true });
      const up = await fetch(`${base}/api/plugins/dev.alice.crypto/update`, J({}));
      expect(up.status).toBe(200);
      const u = (await up.json()) as any;
      expect(u).toMatchObject({ version: "1.1.0", registryVersion: "1.1.0", unreviewed: false, needsApproval: true, enabled: false });
      expect(u.fields[0]).toMatchObject({ key: "apiKey", isSet: true }); // settings kept
      reg = (await (await fetch(`${base}/api/plugins/registry`)).json()) as any;
      expect(reg.plugins[0].updateAvailable).toBe(false);

      // the registry going older than what is installed is refused
      f.etag = 'W/"3"'; f.manifestText = manifest("1.0.0"); f.entries = [f.entry({ version: "1.0.0" })];
      expect((await fetch(`${base}/api/plugins/dev.alice.crypto/update`, J({}))).status).toBe(409);

      // update is for registry plugins only
      const dir = tmp("pd-reg-local-");
      await Bun.write(join(dir, "nookdeck.json"), JSON.stringify({ id: "dev.local.x", name: "L", version: "1.0.0", permissions: { network: [] }, widgets: [] }));
      expect((await fetch(`${base}/api/plugins`, J({ source: dir }))).status).toBe(201);
      expect((await fetch(`${base}/api/plugins/dev.local.x/update`, J({}))).status).toBe(409);

      // manifest before install: widgets with previews, actions, permissions
      f.manifestText = JSON.stringify({ ...JSON.parse(manifest("1.1.0")), widgets: [{ id: "price", name: "Price", render: "stat", sizes: ["2x1"], preview: { value: 1, unit: "USD" }, source: { http: { url: "https://api.example.com/p" }, map: { value: "$.usd" } } }] });
      const mf = await fetch(`${base}/api/plugins/registry/dev.alice.crypto/manifest`);
      expect(mf.status).toBe(200);
      const mj = (await mf.json()) as any;
      expect(mj).toMatchObject({ id: "dev.alice.crypto", version: "1.1.0", registryVersion: "1.0.0", main: null, permissions: { network: ["api.example.com"] } });
      expect(mj.permissionLines.length).toBeGreaterThan(0);
      expect(mj.widgets[0]).toMatchObject({ id: "price", render: "stat", sizes: ["2x1"], preview: { value: 1, unit: "USD" } });
      expect(mj.widgets[0]).not.toHaveProperty("source"); // sources stay out of the display shape
      expect((await fetch(`${base}/api/plugins/registry/dev.nope.x/manifest`)).status).toBe(404);
      f.manifestText = "{ not json";
      expect((await fetch(`${base}/api/plugins/registry/dev.alice.crypto/manifest`)).status).toBe(502); // an invalid manifest is a clear error
      f.manifestText = manifest("1.0.0");

      // README
      const rd = await fetch(`${base}/api/plugins/registry/dev.alice.crypto/readme`);
      expect(rd.status).toBe(200);
      expect(rd.headers.get("content-type")).toContain("text/markdown");
      expect(await rd.text()).toBe("# Crypto\nhello");
      f.readme = "x".repeat(200 * 1024 + 1);
      expect((await fetch(`${base}/api/plugins/registry/dev.alice.crypto/readme`)).status).toBe(413);
      f.readme = null;
      expect((await fetch(`${base}/api/plugins/registry/dev.alice.crypto/readme`)).status).toBe(404);
      expect((await fetch(`${base}/api/plugins/registry/dev.nope.x/readme`)).status).toBe(404);

      // offline: the last good copy, marked stale
      f.offline = true;
      reg = (await (await fetch(`${base}/api/plugins/registry`)).json()) as any;
      expect(reg.stale).toBe(true);
      expect(reg.plugins).toHaveLength(1);

      // local-only like the rest of the plugin API
      expect((await rawFetch(`${base}/api/plugins/install-from-registry`, { method: "POST", body: "{}" })).status).toBe(403); // no CSRF header
      expect((await rawFetch(`${base}/api/plugins/registry`, { headers: { host: "evil.example" } })).status).toBe(403);
    } finally { app.stop(); }
  });
});

describe("store: reviewed flag", () => {
  test("persists, and a plain install of other files clears it", async () => {
    const f = fake();
    const d = tmp();
    const mk = () => new PluginStore({ dir: join(d, "plugins"), stateFile: join(d, "plugins.json"), agentVersion: "0.2.0", fetch: f.fetch });
    const store = mk();
    await store.load();
    const r = await store.install(REPO, { sha256: shaOf(f.manifestText), version: "1.0.0" });
    expect(r.plugin).toMatchObject({ unreviewed: false, registryVersion: "1.0.0" });
    const again = mk(); await again.load();
    expect(again.summary("dev.alice.crypto")).toMatchObject({ unreviewed: false, registryVersion: "1.0.0" });
    // the same id, new files, installed by hand: not reviewed any more
    f.manifestText = manifest("1.0.1");
    expect((await again.install(REPO)).plugin).toMatchObject({ unreviewed: true });
    expect(again.summary("dev.alice.crypto")).not.toHaveProperty("registryVersion");
    // an unreviewed copy of the same files becomes reviewed when the registry vouches for them
    expect((await again.install(REPO, { sha256: shaOf(f.manifestText), version: "1.0.1" })).plugin).toMatchObject({ unreviewed: false, registryVersion: "1.0.1" });
  });
});
