// Several Claude accounts / Codex profiles (PhoneBox #538, #633) and the stale quota after the token expires (#577).
import "./_fetch";
import { rawFetch } from "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AccountStore, expandDir, MAX_ACCOUNTS } from "../src/ai/accounts";
import { claudeKeychainService, fetchClaudeQuota } from "../src/ai/claude";
import { multiAccount } from "../src/ai/index";
import { QuotaHistory } from "../src/ai/history";
import type { ProviderQuota } from "../src/ai/types";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-acc-"));

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const USAGE = { five_hour: { utilization: 42, resets_at: "2026-11-27T10:00:00Z" }, seven_day: { utilization: 10 } };
const creds = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: { accessToken: "tok-secret-123", subscriptionType: "max", ...o } });

describe("AccountStore", () => {
  // folders as the OS writes them ("/home/u/.claude" here, "D:\\home\\u\\.claude" on a Windows checkout)
  const R = (p: string) => resolve(p);
  const defaults = { claude: () => R("/home/u/.claude"), codex: () => R("/home/u/.codex") };
  test("the default account is always first; add, rename, remove; saved 0600 without tokens", async () => {
    const file = join(tmp("pd-acc-s-"), "ai-accounts.json");
    const work = tmp("pd-acc-w-");
    const s = new AccountStore(defaults, file);
    expect(s.list("claude")).toEqual([{ id: "default", name: "Claude", dir: R("/home/u/.claude"), isDefault: true }]);
    const a = await s.add("claude", "  Work   account ", work);
    expect(a).toMatchObject({ name: "Work account", dir: work, isDefault: false });
    expect(a.id).toMatch(/^a-[0-9a-f]{8}$/);
    await s.rename("claude", "default", "Personal");
    await s.rename("claude", a.id, "Job");
    expect(s.list("claude").map((x) => x.name)).toEqual(["Personal", "Job"]);
    expect(s.list("codex").map((x) => x.name)).toEqual(["Codex"]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600); // POSIX modes only (Windows: the user profile ACL)
    const again = new AccountStore(defaults, file);
    await again.load();
    expect(again.list("claude")).toEqual(s.list("claude"));
    await s.remove("claude", a.id);
    expect(s.list("claude").length).toBe(1);
    expect(readFileSync(file, "utf8")).not.toMatch(/token|secret/i);
  });
  test("refuses: missing folder, duplicates, the default folder, empty / long names, removing the default, too many", async () => {
    const s = new AccountStore(defaults, null as any, async (p) => p !== R("/nope"));
    (s as any).save = async () => {};
    await expect(s.add("claude", "x", "/nope")).rejects.toThrow(/does not exist/);
    await expect(s.add("claude", "x", "/home/u/.claude")).rejects.toThrow(/already in the list/);
    await expect(s.add("claude", "", "/a")).rejects.toThrow(/name/);
    await expect(s.add("claude", "x".repeat(41), "/a")).rejects.toThrow(/too long/);
    await expect(s.add("claude", "x", "")).rejects.toThrow(/folder/);
    await s.add("claude", "A", "/a");
    await expect(s.add("claude", "a", "/b")).rejects.toThrow(/name/);
    await expect(s.add("claude", "B", "/a")).rejects.toThrow(/already in the list/);
    await expect(s.remove("claude", "default")).rejects.toThrow(/cannot be removed/);
    await expect(s.rename("claude", "a-00000000", "Z")).rejects.toThrow(/No such account/);
    for (let i = 0; s.list("claude").length < MAX_ACCOUNTS; i++) await s.add("claude", `n${i}`, `/d${i}`);
    await expect(s.add("claude", "last", "/zz")).rejects.toThrow(/At most/);
  });
  test("a broken or hand-edited file keeps only valid entries", async () => {
    const dir = tmp("pd-acc-b-");
    const file = join(dir, "ai-accounts.json");
    await Bun.write(file, JSON.stringify({ claude: [{ id: "a-12345678", name: "ok", dir: "/x" }, { id: "../evil", name: "x", dir: "/y" }, { id: "a-abcdef12", name: "rel", dir: "relative" }], names: { codex: 5 } }));
    const s = new AccountStore(defaults, file);
    await s.load();
    expect(s.list("claude").map((a) => a.id)).toEqual(["default", "a-12345678"]);
    expect(s.list("codex")[0]!.name).toBe("Codex");
    await Bun.write(file, "{not json");
    await s.load();
    expect(s.list("claude").length).toBe(1);
  });
  test("~ paths are expanded", () => {
    expect(expandDir("~/.claude-work", "/Users/me")).toBe(join("/Users/me", ".claude-work"));
    expect(expandDir("~\\.claude-work", "/Users/me")).toBe(join("/Users/me", ".claude-work"));
    expect(expandDir("~", "/Users/me")).toBe("/Users/me");
    expect(expandDir("/abs/x/../y", "/Users/me")).toBe(resolve("/abs/y"));
    expect(expandDir("work", "/Users/me")).toBe(resolve("/Users/me", "work"));
  });
});

describe("Claude per folder", () => {
  test("Keychain service: Claude Code's own name for its folder, + 8 hex of sha256(folder) for another", () => {
    expect(claudeKeychainService("/Users/me/.claude", true)).toBe("Claude Code-credentials");
    const h = createHash("sha256").update("/Users/me/.claude-work").digest("hex").slice(0, 8);
    expect(claudeKeychainService("/Users/me/.claude-work", false)).toBe(`Claude Code-credentials-${h}`);
  });
  test("an extra folder reads its own .credentials.json, then its own Keychain entry", async () => {
    const asked: string[] = [];
    const net = async (_u: string, init: RequestInit) => { asked.push((init.headers as any).Authorization); return Response.json(USAGE); };
    const q = await fetchClaudeQuota({ dir: "/w", readFile: async (p) => { asked.push(p); return creds({ accessToken: "tok-work" }); }, fetch: net as any, now: () => 1000, blocked: new Map() });
    expect(asked).toEqual([join("/w", ".credentials.json"), "Bearer tok-work"]);
    expect(q.windows.length).toBe(2);
    const kc: string[] = [];
    const q2 = await fetchClaudeQuota({ dir: "/w2", readFile: async () => { throw new Error("ENOENT"); }, platform: "darwin", readKeychain: async () => { kc.push("kc"); return creds({}); }, fetch: net as any, now: () => 1000, blocked: new Map() });
    expect(kc).toEqual(["kc"]);
    expect(q2.plan).toBe("Max");
  });
});

describe("#577: an expired sign-in never looks current", () => {
  const net = async () => Response.json(USAGE);
  test("expired token: last windows kept, marked stale and needs_login; no request is sent", async () => {
    const good = await fetchClaudeQuota({ readFile: async () => creds({ expiresAt: 10_000 }), fetch: net as any, now: () => 5000, blocked: new Map() });
    expect(good.stale).toBeUndefined();
    expect(good.status).toBeUndefined();
    let sent = 0;
    const later = await fetchClaudeQuota({ readFile: async () => creds({ expiresAt: 10_000 }), fetch: (async () => { sent++; return Response.json(USAGE); }) as any, now: () => 20_000, blocked: new Map() }, good);
    expect(sent).toBe(0);
    expect(later).toMatchObject({ status: "needs_login", stale: true, windows: good.windows });
    expect(later.error).toMatch(/expired/);
    // Claude Code refreshed its own token (a new one): back to current without any action from us
    const back = await fetchClaudeQuota({ readFile: async () => creds({ accessToken: "fresh", expiresAt: 99_999 }), fetch: net as any, now: () => 21_000, blocked: new Map() }, later);
    expect(back.status).toBeUndefined();
    expect(back.stale).toBeUndefined();
  });
  test("401 and signed out: needs_login; a network error: stale only", async () => {
    const last: ProviderQuota = { id: "claude", name: "Claude", windows: [{ id: "five_hour", label: "5 hours", usedPercent: 50 }], updatedAt: 1 };
    const r401 = await fetchClaudeQuota({ readFile: async () => creds({}), fetch: (async () => new Response("", { status: 401 })) as any, now: () => 1000, blocked: new Map() }, last);
    expect(r401).toMatchObject({ status: "needs_login", stale: true });
    const out = await fetchClaudeQuota({ readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }), platform: "linux", fetch: net as any, now: () => 1000, blocked: new Map() }, last);
    expect(out).toMatchObject({ status: "needs_login", stale: true });
    const down = await fetchClaudeQuota({ readFile: async () => creds({}), fetch: (async () => { throw new Error("offline"); }) as any, now: () => 1000, blocked: new Map() }, last);
    expect(down.stale).toBe(true);
    expect(down.status).toBeUndefined();
    // nothing read before: no windows, so not "stale", but still needs_login
    const fresh = await fetchClaudeQuota({ readFile: async () => creds({ expiresAt: 1 }), fetch: net as any, now: () => 1000, blocked: new Map() });
    expect(fresh.status).toBe("needs_login");
    expect(fresh.stale).toBeUndefined();
  });
  test("the token never appears in a reading", async () => {
    const q = await fetchClaudeQuota({ readFile: async () => creds({}), fetch: (async () => new Response("", { status: 500 })) as any, now: () => 1000, blocked: new Map() });
    expect(JSON.stringify(q)).not.toContain("tok-secret-123");
  });
});

describe("multiAccount", () => {
  const P = { id: "claude" as const, name: "Claude" };
  const ref = (id: string, name: string) => ({ id, name, dir: `/${id}`, isDefault: id === "default" });
  const q = (plan: string, used: number, extra: Partial<ProviderQuota> = {}): ProviderQuota => ({ id: "claude", name: "Claude", plan, windows: [{ id: "five_hour", label: "5 hours", usedPercent: used }], updatedAt: 7, ...extra });
  test("one account: exactly the old shape (no accounts list)", async () => {
    const r = await multiAccount(P, [ref("default", "Claude")], async () => q("Pro", 5), new Map());
    expect(r.accounts).toBeUndefined();
    expect(r.plan).toBe("Pro");
  });
  test("several: the default's reading on top, each account by id and name, no folder", async () => {
    const r = await multiAccount(P, [ref("default", "Personal"), ref("a-1", "Work")], async (a) => (a.id === "default" ? q("Pro", 5) : q("Max", 80, { status: "needs_login", stale: true, error: "expired" })), new Map());
    expect(r.plan).toBe("Pro");
    expect(r.accounts).toEqual([
      { id: "default", label: "Personal", plan: "Pro", windows: q("Pro", 5).windows, fetchedAt: 7 },
      { id: "a-1", label: "Work", plan: "Max", windows: q("Max", 80).windows, status: "needs_login", stale: true, error: "expired", fetchedAt: 7 },
    ]);
    expect(JSON.stringify(r)).not.toContain("/a-1");
  });
  test("each account gets its own last reading; a throwing reader keeps it as stale", async () => {
    const last = new Map<string, ProviderQuota>();
    const seen: Record<string, unknown> = {};
    await multiAccount(P, [ref("default", "A"), ref("a-1", "B")], async (a) => q("Pro", a.id === "default" ? 1 : 2), last);
    const r = await multiAccount(P, [ref("default", "A"), ref("a-1", "B")], async (a, l) => { seen[a.id] = l?.windows[0]?.usedPercent; if (a.id === "a-1") throw new Error("boom"); return q("Pro", 3); }, last);
    expect(seen).toEqual({ default: 1, "a-1": 2 });
    expect(r.accounts![1]).toMatchObject({ stale: true, error: "boom", windows: [{ usedPercent: 2 }] });
    await multiAccount(P, [ref("default", "A")], async () => q("Pro", 3), last);
    expect([...last.keys()]).toEqual(["default"]); // a removed account is forgotten
  });
  test("a failing Codex read with no earlier reading stays Codex, not Claude (review #4)", async () => {
    const r = await multiAccount({ id: "codex", name: "Codex" }, [ref("default", "Personal")], async () => { throw new Error("no sessions folder"); }, new Map());
    expect(r).toMatchObject({ id: "codex", name: "Codex", windows: [], error: "no sessions folder" });
    expect(r.stale).toBeUndefined();
  });
});

describe("history per account; stale readings are not sampled", () => {
  test("records and decorates each account", () => {
    let t = 1_000_000;
    const h = new QuotaHistory(join(tmp("pd-acc-h-"), "h.json"), () => t);
    const win = (p: number) => [{ id: "five_hour", label: "5h", usedPercent: p }];
    const p = (a: number, b: number, staleB = false): ProviderQuota => ({ id: "claude", name: "C", windows: win(a), updatedAt: t, accounts: [{ id: "default", label: "A", windows: win(a), fetchedAt: t }, { id: "a-1", label: "B", windows: win(b), fetchedAt: t, ...(staleB ? { stale: true } : {}) }] });
    h.record([p(10, 50)]);
    t += 6 * 60_000;
    h.record([p(20, 60, true)]);
    const d = h.decorate([p(20, 60)])[0]!;
    expect(d.accounts![0]!.windows[0]!.history!.map((x) => x[1])).toEqual([10, 20]);
    expect(d.accounts![1]!.windows[0]!.history!.map((x) => x[1])).toEqual([50]);
    t += 6 * 60_000;
    h.record([{ id: "codex", name: "X", windows: win(5), updatedAt: t, stale: true }]);
    expect(h.get("codex", undefined, "five_hour")).toEqual([]);
  });
});

describe("the agent: /api/ai/accounts", () => {
  let app: any, base: string;
  const work = tmp("pd-acc-claude-work-");
  mkdirSync(join(work, "x"), { recursive: true });
  const reads: string[] = [];
  beforeAll(async () => {
    const { startServer } = await import("../src/server");
    const one = (id: "claude" | "codex"): ProviderQuota => ({ id, name: id, windows: [], updatedAt: 1 });
    app = await startServer({
      port: 0, pin: "616161", hostName: async () => "my-mac",
      layoutHistoryDir: tmp("pd-acc-hist-"),
      aiAccountsFile: join(tmp("pd-acc-f-"), "ai-accounts.json"),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => { reads.push("claude"); return one("claude"); }, codex: async () => one("codex"), antigravity: async () => ({ id: "antigravity", name: "a", windows: [], updatedAt: 1 }), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
  });
  afterAll(() => app.stop());

  test("list, add, rename, remove; errors are 400; phone keys and foreign hosts are refused", async () => {
    let r = await (await fetch(`${base}/api/ai/accounts`)).json() as any;
    expect(r.claude.map((a: any) => a.id)).toEqual(["default"]);
    expect(r.codex[0]).toMatchObject({ id: "default", name: "Codex", isDefault: true });
    const before = reads.length;
    r = await (await fetch(`${base}/api/ai/accounts`, { method: "POST", body: JSON.stringify({ tool: "claude", name: "Work", dir: work }) })).json() as any;
    expect(r.claude[1]).toMatchObject({ name: "Work", dir: work, isDefault: false });
    expect(reads.length).toBeGreaterThan(before); // re-read at once
    const id = r.claude[1].id;
    r = await (await fetch(`${base}/api/ai/accounts/claude/${id}`, { method: "PATCH", body: JSON.stringify({ name: "Job" }) })).json() as any;
    expect(r.claude[1].name).toBe("Job");
    expect((await fetch(`${base}/api/ai/accounts`, { method: "POST", body: JSON.stringify({ tool: "claude", name: "X", dir: "/definitely/not/here" }) })).status).toBe(400);
    expect((await fetch(`${base}/api/ai/accounts`, { method: "POST", body: JSON.stringify({ tool: "grok", name: "X", dir: work }) })).status).toBe(400);
    expect((await fetch(`${base}/api/ai/accounts/claude/default`, { method: "DELETE" })).status).toBe(400);
    expect((await rawFetch(`${base}/api/ai/accounts`, { method: "POST", body: "{}" })).status).toBe(403); // no CSRF header
    expect((await rawFetch(`${base}/api/ai/accounts`, { headers: { host: "evil.example" } })).status).toBe(403);
    r = await (await fetch(`${base}/api/ai/accounts/claude/${id}`, { method: "DELETE" })).json() as any;
    expect(r.claude.length).toBe(1);
  });
});

describe("AiHub: a second quota read waits for the one in flight", () => {
  test("two callers at once both see the reading, not 'Reading…'", async () => {
    const { AiHub } = await import("../src/ai/index");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const one = (id: any): ProviderQuota => ({ id, name: id, windows: [{ id: "w", label: "w", usedPercent: 1 }], updatedAt: 1 });
    const hub = new AiHub({ claude: async () => { await gate; return one("claude"); }, codex: async () => one("codex"), antigravity: async () => one("antigravity"), sessions: async () => [] } as any);
    const a = hub.refreshQuotas(true);
    let bDone = false;
    const b = hub.refreshQuotas().then(() => { bDone = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(bDone).toBe(false); // waits instead of answering at once
    release();
    await Promise.all([a, b]);
    expect(hub.snapshot().providers.find((p) => p.id === "claude")!.windows.length).toBe(1);
  });
});
