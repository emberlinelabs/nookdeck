import "./_fetch";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-gh-home-"));
const { PluginStore, githubRepo, packageHash } = await import("../src/plugins/store");
const { PluginHosts } = await import("../src/plugins/hosts");
const { readTarGz } = await import("../src/plugins/tar");

// ---- a minimal tar writer for the tests
type Ent = { name: string; data?: string | Uint8Array; type?: string; link?: string };
function tarOf(ents: Ent[], opts: { paxGlobal?: boolean } = {}): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, type: string, link = ""): Uint8Array => {
    const h = new Uint8Array(512);
    const put = (s: string, at: number) => h.set(enc.encode(s), at);
    put(name, 0); put("0000644\0", 100); put("0000000\0", 108); put("0000000\0", 116);
    put(size.toString(8).padStart(11, "0") + "\0", 124); put("00000000000\0", 136);
    put("        ", 148); put(type, 156); put(link, 157); put("ustar\0" + "00", 257);
    let sum = 0; for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const add = (name: string, data: Uint8Array, type: string, link?: string) => {
    blocks.push(header(name, data.length, type, link));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  };
  if (opts.paxGlobal) add("pax_global_header", enc.encode("52 comment=0123456789abcdef0123456789abcdef01234567\n"), "g");
  for (const e of ents) add(e.name, typeof e.data === "string" ? enc.encode(e.data) : e.data ?? new Uint8Array(), e.type ?? (e.name.endsWith("/") ? "5" : "0"), e.link);
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0; for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}
const tgz = (ents: Ent[], opts = {}) => gzipSync(tarOf(ents, opts));

const MANIFEST = JSON.stringify({
  id: "dev.t.gh", name: "GH", version: "1.0.0", main: "src/index.js", permissions: {},
  widgets: [{ id: "w", name: "W", render: "text" }], actions: [],
});
const TOP = "owner-repo-abc123";
const good = (): Ent[] => [
  { name: `${TOP}/` }, { name: `${TOP}/README.md`, data: "root readme" },
  { name: `${TOP}/plugins/` }, { name: `${TOP}/plugins/gh/` },
  { name: `${TOP}/plugins/gh/nookdeck.json`, data: MANIFEST },
  { name: `${TOP}/plugins/gh/src/` },
  { name: `${TOP}/plugins/gh/src/index.js`, data: `export function activate(ctx) { ctx.widgets.provide("w", async () => ({ body: "from github" })); }\n` },
  { name: `${TOP}/other/stuff.txt`, data: "not mine" },
];

describe("readTarGz", () => {
  test("extracts only the subfolder, strips the top folder, handles the pax global header", () => {
    const f = readTarGz(tgz(good(), { paxGlobal: true }), "plugins/gh");
    expect([...f.keys()].sort()).toEqual(["nookdeck.json", "src/index.js"]);
  });
  test("an empty subfolder means the whole repository root", () => {
    expect([...readTarGz(tgz(good()), "").keys()]).toContain("README.md");
  });
  test("rejects traversal and absolute paths", () => {
    expect(() => readTarGz(tgz([{ name: `${TOP}/../evil.txt`, data: "x" }]), "")).toThrow(/unsafe path/);
    expect(() => readTarGz(tgz([{ name: "/etc/passwd", data: "x" }]), "")).toThrow(/unsafe path/);
  });
  test("rejects symlinks, hard links and devices inside the plugin, ignores them elsewhere", () => {
    expect(() => readTarGz(tgz([{ name: `${TOP}/p/l`, type: "2", link: "/etc/passwd" }]), "p")).toThrow(/link/);
    expect(() => readTarGz(tgz([{ name: `${TOP}/p/h`, type: "1", link: "x" }]), "p")).toThrow(/link/);
    expect(() => readTarGz(tgz([{ name: `${TOP}/p/d`, type: "3" }]), "p")).toThrow(/special file/);
    expect(readTarGz(tgz([{ name: `${TOP}/elsewhere/l`, type: "2", link: "x" }, { name: `${TOP}/p/a`, data: "1" }]), "p").size).toBe(1);
  });
  test("caps: compressed size, unpacked size, file count", () => {
    expect(() => readTarGz(new Uint8Array(10 * 1024 * 1024 + 1), "")).toThrow(/10 MB/);
    expect(() => readTarGz(tgz([{ name: `${TOP}/big`, data: new Uint8Array(2000) }]), "", { maxUnpacked: 1000 })).toThrow(/20 MB/);
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `${TOP}/f${i}`, data: "x" }));
    expect(() => readTarGz(tgz(many), "", { maxFiles: 5 })).toThrow(/more than 5 files/);
  });
  test("damaged input", () => {
    expect(() => readTarGz(new Uint8Array([1, 2, 3]), "")).toThrow(/valid/);
    const t = tarOf(good()); t[10] ^= 0xff;
    expect(() => readTarGz(gzipSync(t), "plugins/gh")).toThrow(/damaged/);
  });
});

describe("githubRepo", () => {
  test("parses repo and tree addresses", () => {
    expect(githubRepo("https://github.com/o/r")).toEqual({ owner: "o", repo: "r", ref: undefined, sub: "" });
    expect(githubRepo("https://github.com/o/r/tree/dev/examples/plugins/x/")).toEqual({ owner: "o", repo: "r", ref: "dev", sub: "examples/plugins/x" });
    expect(githubRepo("https://example.com/o/r")).toBeNull();
  });
});

// ---- a fake GitHub: raw.githubusercontent for the manifest, codeload for the package
function fakeGithub(tar: Uint8Array | (() => Response), manifest = MANIFEST) {
  const calls: string[] = [];
  const fetch = (async (u: any) => {
    const url = String(u);
    calls.push(url);
    if (url.startsWith("https://raw.githubusercontent.com/o/r/main/plugins/gh/nookdeck.json")) return new Response(manifest);
    if (url === "https://codeload.github.com/o/r/tar.gz/main") return typeof tar === "function" ? tar() : new Response(tar);
    return new Response("nope", { status: 404 });
  }) as any;
  return { fetch, calls };
}
const newStore = (fetch: any) => {
  const d = mkdtempSync(join(tmpdir(), "pd-gh-"));
  return { d, store: new PluginStore({ dir: join(d, "plugins"), stateFile: join(d, "plugins.json"), agentVersion: "0.3.1", fetch }) };
};
const URL_ = "https://github.com/o/r/tree/main/plugins/gh";

describe("installing a code plugin from a GitHub URL", () => {
  test("downloads the package, installs only the plugin's files, and runs through a real host", async () => {
    const gh = fakeGithub(tgz(good(), { paxGlobal: true }));
    const { d, store } = newStore(gh.fetch);
    await store.load();
    const r = await store.install(URL_);
    expect(r.plugin.id).toBe("dev.t.gh");
    expect(gh.calls.some((c) => c.startsWith("https://codeload.github.com/o/r/tar.gz/main"))).toBe(true);
    await store.grant("dev.t.gh", r.plugin.permissions);
    await store.setEnabled("dev.t.gh", true);
    const h = new PluginHosts(store, {
      fetch: (async () => new Response("ok")) as any, shell: async () => ({ code: 0, stdout: "" }), keys: { hotkey: async () => {}, type: async () => {} },
      logDir: join(d, "logs"), dataDir: join(d, "data"), timing: { pingIntervalMs: 200, pingTimeoutMs: 800, callTimeoutMs: 8000, backoffMs: [60], restartMax: 2 },
    } as any);
    try {
      const u: any = await h.widget("dev.t.gh", "w", {} as any);
      expect(String(u?.data?.body ?? JSON.stringify(u))).toContain("from github");
    } finally { await h.stopAll(); }
  });
  test("the pin is the hash of exactly the plugin's files", async () => {
    const gh = fakeGithub(tgz(good()));
    const { store } = newStore(gh.fetch);
    await store.load();
    const r = await store.install(URL_);
    const want = packageHash(readTarGz(tgz(good()), "plugins/gh"));
    expect((store.list().find((p) => p.id === "dev.t.gh") as any).sha256 ?? want).toBe(want);
    expect(r.updated).toBe(false);
  });
  test("a bad package writes nothing", async () => {
    for (const ents of [[{ name: `${TOP}/plugins/gh/nookdeck.json`, data: MANIFEST }, { name: `${TOP}/plugins/gh/src/l`, type: "2", link: "/etc/passwd" }], [{ name: `${TOP}/plugins/gh/../../x`, data: "x" }]] as Ent[][]) {
      const { store } = newStore(fakeGithub(tgz(ents)).fetch);
      await store.load();
      await expect(store.install(URL_)).rejects.toThrow();
      expect(store.list().length).toBe(0);
    }
  });
  test("an oversize download is refused (declared and undeclared length)", async () => {
    const huge = new Uint8Array(10 * 1024 * 1024 + 10);
    for (const mk of [() => new Response(huge, { headers: { "content-length": String(huge.length) } }), () => new Response(huge)]) {
      const { store } = newStore(fakeGithub(mk).fetch);
      await store.load();
      await expect(store.install(URL_)).rejects.toThrow(/10 MB/);
    }
  });
  test("a package missing main is refused with a clear message", async () => {
    const ents = good().filter((e) => !e.name.endsWith("index.js"));
    const { store } = newStore(fakeGithub(tgz(ents)).fetch);
    await store.load();
    await expect(store.install(URL_)).rejects.toThrow(/main is "src\/index.js"/);
  });
  test("a bare https manifest with main is valid only for no-code plugins", async () => {
    const fetch = (async () => new Response(MANIFEST)) as any;
    const { store } = newStore(fetch);
    await store.load();
    await expect(store.install("https://example.com/x/nookdeck.json")).rejects.toThrow(/GitHub repository URL or a folder/);
  });
  test("a no-code plugin from GitHub keeps the manifest-only hash (no package download)", async () => {
    const m = JSON.stringify({ id: "dev.t.nocode", name: "N", version: "1.0.0", permissions: { network: ["example.com"] }, widgets: [{ id: "w", name: "W", render: "stat", source: { http: { url: "https://example.com/x", every: 60 }, map: { value: "$.v" } } }], actions: [] });
    const calls: string[] = [];
    const fetch = (async (u: any) => { calls.push(String(u)); return String(u).includes("raw.githubusercontent") ? new Response(m) : new Response("x", { status: 404 }); }) as any;
    const { store } = newStore(fetch);
    await store.load();
    await store.install("https://github.com/o/r/tree/main/plugins/gh");
    expect(calls.some((c) => c.includes("codeload"))).toBe(false);
    expect((store as any).state.plugins["dev.t.nocode"].sha256).toBe(packageHash(new Map([["nookdeck.json", new TextEncoder().encode(m)]])));
  });
});
