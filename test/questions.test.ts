import "./_fetch";
import { WIN, MODE600, MODE644 } from "./_os";
import { rawFetch } from "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-q-"));
const Q = await import("../src/questions");
const HI = await import("../src/hooks-install");
const { startServer } = await import("../src/server");

const tmp = (p = "pd-qx-") => mkdtempSync(join(tmpdir(), p));
const QS = [
  { question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "SQL" }, { label: "SQLite", description: "file" }] },
  { question: "Which features?", header: "Feat", multiSelect: true, options: [{ label: "Auth", description: "" }, { label: "Billing, Invoices", description: "" }, { label: "Search", description: "" }] },
];

describe("parseQuestionInput", () => {
  test("accepts 1-4 questions, trims, rejects bad shapes", () => {
    const ok = Q.parseQuestionInput({ questions: QS, sessionId: "s1", cwd: "/x/app" }) as any;
    expect(ok.questions.length).toBe(2);
    expect(ok.questions[0]).toMatchObject({ question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "SQLite" }] });
    expect(ok.questions[1].multiSelect).toBe(true);
    expect(ok.sessionId).toBe("s1");
    for (const bad of [null, {}, { questions: [] }, { questions: Array(5).fill(QS[0]) }, { questions: [{ question: "", options: [{ label: "a" }] }] }, { questions: [{ question: "q", options: [] }] }, { questions: [{ question: "q", options: [{ label: "" }] }] }, { questions: [QS[0], QS[0]] }, { questions: [{ question: "q", options: [{ label: "a" }, { label: "a" }] }] }]) {
      expect("error" in (Q.parseQuestionInput(bad) as any)).toBe(true);
    }
  });
});

describe("validateAnswers", () => {
  const qs = Q.parseQuestionInput({ questions: QS }) as any;
  const v = (a: unknown, other?: unknown) => Q.validateAnswers(qs.questions, a, other) as any;
  test("labels only; multiSelect joined with ', ' in option order; arrays accepted; a label containing a comma works", () => {
    expect(v({ "Which database?": "SQLite", "Which features?": "Auth, Search" }).answers).toEqual({ "Which database?": "SQLite", "Which features?": "Auth, Search" });
    expect(v({ "Which database?": "Postgres", "Which features?": ["Search", "Auth"] }).answers["Which features?"]).toBe("Auth, Search");
    expect(v({ "Which database?": "Postgres", "Which features?": "Billing, Invoices" }).answers["Which features?"]).toBe("Billing, Invoices");
    expect(v({ "Which database?": "Postgres", "Which features?": "Auth,Search" }).answers["Which features?"]).toBe("Auth, Search");
    expect(v({ "Which database?": "Postgres", "Which features?": ["Auth", "Auth"] }).answers["Which features?"]).toBe("Auth");
  });
  test("rejects wrong keys, missing answers, unknown labels, empty selections", () => {
    expect(v({ "Which database?": "Postgres", "Which features?": "Auth", "Other?": "x" }).error).toContain("not in the request");
    expect(v({ "Which database?": "Postgres" }).error).toContain("missing answers");
    expect(v({ "Which database?": "MySQL", "Which features?": "Auth" }).error).toContain("is not an option");
    expect(v({ "Which database?": "Postgres", "Which features?": "Auth, Nope" }).error).toContain("available labels");
    expect(v({ "Which database?": "Postgres", "Which features?": [] }).error).toContain("available labels");
    expect(v({ "Which database?": ["Postgres"], "Which features?": "Auth" }).error).toContain("is not an option");
    expect(v("x").error).toContain("object");
    expect(v(null).error).toContain("object");
  });
  test("free text only for the questions the phone marks as other", () => {
    expect(v({ "Which database?": "Oracle XE", "Which features?": "Auth" }, ["Which database?"]).answers["Which database?"]).toBe("Oracle XE");
    expect(v({ "Which database?": "  ", "Which features?": "Auth" }, ["Which database?"]).error).toContain("is empty");
    expect(v({ "Which database?": "Oracle", "Which features?": "Auth" }, ["Which features?"]).error).toContain("is not an option");
    expect(v({ "Which database?": "Postgres", "Which features?": "my own, thing" }, ["Which features?"]).answers["Which features?"]).toBe("my own, thing");
    expect(v({ "Which database?": "x".repeat(900), "Which features?": "Auth" }, ["Which database?"]).answers["Which database?"].length).toBe(500);
  });
});

describe("QuestionBroker", () => {
  const input = () => ({ questions: (Q.parseQuestionInput({ questions: QS }) as any).questions, sessionId: "s", cwd: "/p/app" });
  const rig = (phones = true, timeoutMs = 5000) => {
    const log: any[] = [];
    const b = new Q.QuestionBroker({ hasPhones: () => phones, notify: (r) => log.push(["notify", r]), resolved: (id, how) => log.push(["resolved", id, how]) }, timeoutMs);
    return { b, log };
  };
  const good = { "Which database?": "Postgres", "Which features?": "Auth" };

  test("no phone: null at once, nothing pending", async () => {
    const { b, log } = rig(false);
    expect(await b.request(input())).toBeNull();
    expect(log).toEqual([]);
  });
  test("first valid answer wins; a bad answer leaves it open; later answers are refused", async () => {
    const { b, log } = rig();
    const p = b.request(input());
    const req = log[0][1];
    expect(req).toMatchObject({ project: "app", sessionId: "s" });
    expect(req.expiresAt - req.createdAt).toBe(5000);
    expect(b.answer(req.id, { "Which database?": "MySQL", "Which features?": "Auth" })).toMatchObject({ ok: false });
    expect(b.size).toBe(1);
    expect(b.answer(req.id, good)).toEqual({ ok: true });
    expect(await p).toEqual(good);
    expect(log.at(-1)).toEqual(["resolved", req.id, "answered"]);
    expect(b.answer(req.id, good)).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    expect(b.size).toBe(0);
  });
  test("release, timeout, abort (hook gone) and clear all resolve to null", async () => {
    const r1 = rig();
    const p1 = r1.b.request(input());
    expect(r1.b.release(r1.log[0][1].id)).toBe(true);
    expect(await p1).toBeNull();
    expect(r1.log.at(-1)[2]).toBe("released");
    expect(r1.b.release("nope")).toBe(false);
    const r2 = rig(true, 30);
    expect(await r2.b.request(input())).toBeNull();
    expect(r2.log.at(-1)[2]).toBe("timeout");
    const r3 = rig();
    const ac = new AbortController();
    const p3 = r3.b.request(input(), ac.signal);
    ac.abort();
    expect(await p3).toBeNull();
    expect(r3.log.at(-1)[2]).toBe("cancelled");
    const r4 = rig();
    const p4 = r4.b.request(input());
    r4.b.clear();
    expect(await p4).toBeNull();
    expect(r4.b.hints()).toEqual([]);
  });
  test("pending questions mark the Claude session as waiting", () => {
    const { b } = rig();
    void b.request(input());
    expect(b.hints()).toEqual([{ source: "claude", sessionId: "s", cwd: "/p/app" }]);
    b.clear();
  });
});

describe("idle time and settings", () => {
  test("HIDIdleTime in nanoseconds; unknown elsewhere or on failure", async () => {
    const out = '    | |   "HIDIdleTime" = 2500000000\\n';
    expect(await Q.readIdleSeconds(async (a) => { expect(a).toEqual(["ioreg", "-c", "IOHIDSystem"]); return out; }, "darwin")).toBeCloseTo(2.5);
    expect(await Q.readIdleSeconds(async () => "nothing", "darwin")).toBeNull();
    expect(await Q.readIdleSeconds(async () => { throw new Error("x"); }, "darwin")).toBeNull();
    expect(await Q.readIdleSeconds(async () => out, "linux")).toBeNull();
  });
  test("settings file: default off, 0600, persists", async () => {
    const file = join(tmp(), "ask.json");
    const s = new Q.AskSettingsStore(file);
    expect(await s.get()).toEqual({ onlyWhenAway: false });
    expect(await s.set({ onlyWhenAway: true })).toEqual({ onlyWhenAway: true });
    expect(statSync(file).mode & 0o777).toBe(MODE600);
    expect(await new Q.AskSettingsStore(file).get()).toEqual({ onlyWhenAway: true });
    expect(await s.set({})).toEqual({ onlyWhenAway: true });
  });
});

describe("hook process side", () => {
  const stdin = (extra: any = {}) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", session_id: "sess", cwd: "/p/app", tool_input: { questions: QS }, ...extra });
  const ANS = { "Which database?": "SQLite", "Which features?": "Auth, Search" };

  test("prints the exact PreToolUse allow JSON with the original questions array and the answers", async () => {
    let seen: any;
    const out = await Q.runAskHook({ stdin: stdin(), port: 7421, secret: "sec", fetch: (async (url: string, init: any) => { seen = { url, init }; return Response.json({ answers: ANS }); }) as any });
    expect(JSON.parse(out!)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { questions: QS, answers: ANS } } });
    expect(seen.url).toBe("http://127.0.0.1:7421/api/hooks/question");
    expect(seen.init.headers["x-nookdeck-hook"]).toBe("sec");
    expect(JSON.parse(seen.init.body)).toEqual({ questions: QS, sessionId: "sess", cwd: "/p/app" });
  });
  test("keeps other tool_input fields (updatedInput replaces the whole input)", async () => {
    const out = await Q.runAskHook({ stdin: stdin({ tool_input: { questions: QS, metadata: { source: "x" } } }), port: 1, secret: "s", fetch: (async () => Response.json({ answers: ANS })) as any });
    expect(JSON.parse(out!).hookSpecificOutput.updatedInput).toEqual({ questions: QS, metadata: { source: "x" }, answers: ANS });
  });
  test("nothing for other tools, bad stdin, no answer, release, agent down, errors", async () => {
    const f = (r: any) => (async () => r) as any;
    expect(await Q.runAskHook({ stdin: stdin({ tool_name: "Bash" }), port: 1, secret: "s", fetch: f(Response.json({ answers: ANS })) })).toBeNull();
    expect(await Q.runAskHook({ stdin: "not json", port: 1, secret: "s", fetch: f(Response.json({ answers: ANS })) })).toBeNull();
    expect(await Q.runAskHook({ stdin: stdin({ tool_input: {} }), port: 1, secret: "s", fetch: f(Response.json({ answers: ANS })) })).toBeNull();
    expect(await Q.runAskHook({ stdin: stdin(), port: 1, secret: "s", fetch: f(Response.json({ answers: null })) })).toBeNull();
    expect(await Q.runAskHook({ stdin: stdin(), port: 1, secret: "s", fetch: f(Response.json({ answers: {} })) })).toBeNull();
    expect(await Q.runAskHook({ stdin: stdin(), port: 1, secret: "s", fetch: f(new Response("no", { status: 401 })) })).toBeNull();
    expect(await Q.runAskHook({ stdin: stdin(), port: 1, secret: "s", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as any })).toBeNull();
    expect(await Q.runAskHook({ stdin: stdin(), port: 1, secret: "s", timeoutMs: 30, fetch: ((_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("timeout"))))) as any })).toBeNull();
  });
});

describe("settings.json entry", () => {
  const cfg = () => join(tmp(), "settings.json");
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
  const cmd = Q && HI.askHookCommand({ execPath: "/bin/nookdeck", port: 7430, home: "/h/pd", defaultHome: "/d" });

  test("command carries the marker, port and home", () => {
    expect(cmd).toBe("'/bin/nookdeck' hook claude-ask --port 7430 --home '/h/pd' # nookdeck hook claude-ask");
    expect(HI.askHookCommand({ execPath: "/bin/nookdeck" })).toBe("'/bin/nookdeck' hook claude-ask # nookdeck hook claude-ask");
    expect(HI.askHookCommand({ execPath: "/opt/nookdeck-bin", indexPath: "/x/index.ts" })).toBe("'/opt/nookdeck-bin' hook claude-ask # nookdeck hook claude-ask"); // compiled form
    expect(HI.askHookCommand({ execPath: "/usr/bin/bun", indexPath: "/x/index.ts" })).toBe("'/usr/bin/bun' '/x/index.ts' hook claude-ask # nookdeck hook claude-ask");
  });
  test("install: PreToolUse + matcher AskUserQuestion + timeout 600; idempotent; keeps other hooks; backup; uninstall removes only ours", async () => {
    const f = cfg();
    const mine = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }], Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] }, theme: "dark" };
    writeFileSync(f, JSON.stringify(mine));
    expect(await HI.isAskHookInstalled(f)).toBe(false);
    expect((await HI.installAskHook(f, cmd)).changed).toBe(true);
    const d = read(f);
    expect(d.theme).toBe("dark");
    expect(d.hooks.Stop).toEqual(mine.hooks.Stop);
    expect(d.hooks.PreToolUse[0]).toEqual(mine.hooks.PreToolUse[0]);
    expect(d.hooks.PreToolUse[1]).toEqual({ matcher: "AskUserQuestion", hooks: [{ type: "command", command: cmd, timeout: 600 }] });
    expect(readFileSync(`${f}.nookdeck.bak`, "utf8")).toBe(JSON.stringify(mine));
    expect(await HI.isAskHookInstalled(f)).toBe(true);
    expect((await HI.installAskHook(f, cmd)).changed).toBe(false);
    expect((await HI.installAskHook(f, cmd + "2")).changed).toBe(true); // port changed: command updated in place
    expect(read(f).hooks.PreToolUse.length).toBe(2);
    expect((await HI.uninstallAskHook(f)).changed).toBe(true);
    expect(read(f).hooks.PreToolUse).toEqual(mine.hooks.PreToolUse);
    expect((await HI.uninstallAskHook(f)).changed).toBe(false);
    expect(await HI.isAskHookInstalled(f)).toBe(false);
  });
  test("separate from the permission hook: either can be installed and removed alone", async () => {
    const f = cfg();
    await HI.installHook(f, HI.hookCommand("claude", { execPath: "/bin/nookdeck" }));
    expect(await HI.isAskHookInstalled(f)).toBe(false);
    await HI.installAskHook(f, cmd);
    expect(await HI.isHookInstalled(f)).toBe(true);
    expect(await HI.isAskHookInstalled(f)).toBe(true);
    await HI.uninstallHook(f);
    expect(await HI.isHookInstalled(f)).toBe(false);
    expect(await HI.isAskHookInstalled(f)).toBe(true);
    await HI.installHook(f, HI.hookCommand("claude", { execPath: "/bin/nookdeck" }));
    await HI.uninstallAskHook(f);
    expect(await HI.isHookInstalled(f)).toBe(true);
    expect(read(f).hooks.PreToolUse).toBeUndefined();
  });
  test("refuses a settings file that is not valid JSON", async () => {
    const f = cfg();
    writeFileSync(f, "{ nope");
    await expect(HI.installAskHook(f, cmd)).rejects.toThrow("not valid JSON");
    expect(readFileSync(f, "utf8")).toBe("{ nope");
  });
});

describe("through the server", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let tok: string;
  let idle: number | null = 600;
  const hookDir = tmp("pd-q-hooks-");
  const SECRET = "ask-secret";
  const settingsFile = join(hookDir, "claude-settings.json");

  beforeAll(async () => {
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    app = await startServer({
      port: 0, pin: "777777", hostName: async () => "my-mac", hookSecret: SECRET, webhookKeyFile: join(tmp(), "wk"), layoutHistoryDir: tmp(),
      askSettingsFile: join(tmp(), "ask.json"), idleSeconds: async () => idle, questionTimeoutMs: 600,
      hookPaths: { claude: settingsFile, codex: join(hookDir, "codex-hooks.json") },
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
    tok = ((await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "777777" }) })).json()) as any).token;
  });
  afterAll(() => app.stop());

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
    const answer = async (body: Record<string, unknown>) => { const reqId = `a${n++}`; ws.send(JSON.stringify({ type: "question-answer", reqId, ...body })); return next((m) => m.type === "result" && m.reqId === reqId); };
    return { ws, next, answer };
  }
  const ask = (body: any = { questions: QS, sessionId: "s1", cwd: "/p/app" }, headers: Record<string, string> = { "x-nookdeck-hook": SECRET }, signal?: AbortSignal) =>
    rawFetch(`${base}/api/hooks/question`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers }, signal });
  const GOOD = { "Which database?": "Postgres", "Which features?": "Auth, Search" };

  test("secret required; no phone connected -> answers null at once; bad body 400", async () => {
    expect((await ask(undefined, {})).status).toBe(401);
    expect((await ask(undefined, { "x-nookdeck-hook": "wrong" })).status).toBe(401);
    expect((await rawFetch(`${base}/api/hooks/question`, { method: "POST", body: "{}", headers: { "x-nookdeck-hook": SECRET, host: "evil.example" } })).status).toBe(403);
    const none = await (await ask()).json() as any;
    expect(none).toEqual({ answers: null });
    const p = phone();
    await p.next((m) => m.type === "hello");
    expect((await ask({ questions: [] })).status).toBe(400);
    p.ws.close();
  });

  test("the phone gets the question, a bad answer is refused and keeps it open, a good one reaches the hook; resolved is broadcast", async () => {
    const p = phone(), other = phone();
    await p.next((m) => m.type === "hello"); await other.next((m) => m.type === "hello");
    const pending = ask();
    const m = await p.next((x) => x.type === "question");
    expect(m.request).toMatchObject({ project: "app", sessionId: "s1" });
    expect(m.request.questions[0].question).toBe("Which database?");
    expect(Object.keys(m.request).sort()).toEqual(["createdAt", "expiresAt", "id", "project", "questions", "sessionId"]);
    await other.next((x) => x.type === "question");
    const bad = await p.answer({ id: m.request.id, answers: { "Which database?": "MySQL", "Which features?": "Auth" } });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toContain("is not an option");
    const good = await p.answer({ id: m.request.id, answers: GOOD });
    expect(good.ok).toBe(true);
    expect(await (await pending).json()).toEqual({ answers: GOOD });
    const res = await other.next((x) => x.type === "question-resolved");
    expect(res).toEqual({ type: "question-resolved", id: m.request.id, how: "answered" });
    const late = await other.answer({ id: m.request.id, answers: GOOD });
    expect(late).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    p.ws.close(); other.ws.close();
  });

  test("free text for 'other'; release hands it back; a phone connecting later sees pending questions", async () => {
    const p = phone();
    await p.next((x) => x.type === "hello");
    const pending = ask();
    const m = await p.next((x) => x.type === "question");
    const late = phone();
    expect((await late.next((x) => x.type === "question")).request.id).toBe(m.request.id);
    late.ws.close();
    const r = await p.answer({ id: m.request.id, answers: { "Which database?": "Oracle XE", "Which features?": "Auth" }, other: ["Which database?"] });
    expect(r.ok).toBe(true);
    expect(((await (await pending).json()) as any).answers["Which database?"]).toBe("Oracle XE");
    const pending2 = ask();
    const m2 = await p.next((x) => x.type === "question");
    expect((await p.answer({ id: m2.request.id, release: true })).ok).toBe(true);
    expect(await (await pending2).json()).toEqual({ answers: null });
    expect((await p.next((x) => x.type === "question-resolved")).how).toBe("answered");
    expect((await p.next((x) => x.type === "question-resolved")).how).toBe("released");
    expect((await p.answer({ id: 5 })).ok).toBe(false);
    p.ws.close();
  });

  test("the hook disconnecting cancels the question on the phones; a timeout answers null", async () => {
    const p = phone();
    await p.next((x) => x.type === "hello");
    const ac = new AbortController();
    const pending = ask(undefined, { "x-nookdeck-hook": SECRET }, ac.signal).catch(() => null);
    const m = await p.next((x) => x.type === "question");
    ac.abort();
    await pending;
    expect(await p.next((x) => x.type === "question-resolved")).toEqual({ type: "question-resolved", id: m.request.id, how: "cancelled" });
    const t = await (await ask()).json() as any; // nobody answers: the 600 ms test timeout
    expect(t).toEqual({ answers: null });
    expect((await p.next((x) => x.type === "question-resolved")).how).toBe("timeout");
    p.ws.close();
  });

  test("'only when I am away': present at the keyboard -> terminal (no question sent); away -> phone", async () => {
    const p = phone();
    await p.next((x) => x.type === "hello");
    expect((await (await fetch(`${base}/api/integrations/claude/ask-hook`, { method: "PUT", body: JSON.stringify({ onlyWhenAway: true }) })).json())).toMatchObject({ ok: true, onlyWhenAway: true });
    idle = 5;
    expect(await (await ask()).json()).toEqual({ answers: null, reason: "present" });
    idle = null; // unknown: do not gate
    const pend = ask();
    const m = await p.next((x) => x.type === "question");
    await p.answer({ id: m.request.id, answers: GOOD });
    expect(((await (await pend).json()) as any).answers).toEqual(GOOD);
    idle = 61;
    const pend2 = ask();
    const m2 = await p.next((x) => x.type === "question");
    await p.answer({ id: m2.request.id, release: true });
    await pend2;
    await fetch(`${base}/api/integrations/claude/ask-hook`, { method: "PUT", body: JSON.stringify({ onlyWhenAway: false }) });
    idle = 1;
    const pend3 = ask();
    const m3 = await p.next((x) => x.type === "question");
    await p.answer({ id: m3.request.id, release: true });
    await pend3;
    p.ws.close();
  });

  test("REST: GET /api/integrations claude.askHook; POST / DELETE / PUT ask-hook; guarded; the permission hook is untouched", async () => {
    const info = async () => ((await (await fetch(`${base}/api/integrations`)).json()) as any).claude;
    expect((await info()).askHook).toEqual({ installed: false, onlyWhenAway: false });
    const inst = await (await fetch(`${base}/api/integrations/claude/ask-hook`, { method: "POST", body: "{}" })).json() as any;
    expect(inst).toMatchObject({ ok: true, changed: true, installed: true, settingsPath: settingsFile, onlyWhenAway: false });
    const d = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(d.hooks.PreToolUse[0].matcher).toBe("AskUserQuestion");
    expect(d.hooks.PreToolUse[0].hooks[0].timeout).toBe(600);
    expect(d.hooks.PreToolUse[0].hooks[0].command).toContain("hook claude-ask");
    expect(d.hooks.PreToolUse[0].hooks[0].command).toContain(`--port ${app.port}`);
    expect(await info()).toMatchObject({ installed: false, askHook: { installed: true } });
    expect((await (await fetch(`${base}/api/integrations/claude/ask-hook`, { method: "PUT", body: JSON.stringify({ onlyWhenAway: true }) })).json())).toMatchObject({ ok: true, installed: true, onlyWhenAway: true });
    expect((await info()).askHook).toEqual({ installed: true, onlyWhenAway: true });
    expect((await fetch(`${base}/api/integrations/claude/ask-hook`, { method: "PUT", body: JSON.stringify({ onlyWhenAway: "yes" }) })).status).toBe(400);
    await fetch(`${base}/api/integrations/claude/hook`, { method: "POST", body: "{}" });
    expect(await info()).toMatchObject({ installed: true, askHook: { installed: true } });
    const del = await (await fetch(`${base}/api/integrations/claude/ask-hook`, { method: "DELETE" })).json() as any;
    expect(del).toMatchObject({ ok: true, changed: true, installed: false });
    expect(await info()).toMatchObject({ installed: true, askHook: { installed: false, onlyWhenAway: true } });
    await fetch(`${base}/api/integrations/claude/hook`, { method: "DELETE" });
    expect((await rawFetch(`${base}/api/integrations/claude/ask-hook`, { method: "POST", body: "{}", headers: { "content-type": "text/plain" } })).status).toBe(403);
    expect((await rawFetch(`${base}/api/integrations/claude/ask-hook`, { method: "PUT", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
  });

  // Bun.spawn with a buffer as stdin never closes the pipe on Windows (the real hook, fed by a shell pipe, works)
  test.skipIf(WIN)("end to end: `nookdeck hook claude-ask` as a real process prints the PreToolUse JSON the phone's answer produced", async () => {
    await fetch(`${base}/api/integrations/claude/ask-hook`, { method: "PUT", body: JSON.stringify({ onlyWhenAway: false }) });
    const home = tmp("pd-q-home-");
    writeFileSync(join(home, "hook-secret"), SECRET + "\n");
    const p = phone();
    await p.next((x) => x.type === "hello");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts"), "hook", "claude-ask", "--port", String(app.port), "--home", home], {
      stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "AskUserQuestion", session_id: "e2e", cwd: "/p/app", tool_input: { questions: QS } })),
      stdout: "pipe", stderr: "pipe", env: { ...process.env, NOOKDECK_HOME: home },
    });
    const m = await p.next((x) => x.type === "question", 15000);
    expect(m.request.sessionId).toBe("e2e");
    expect((await p.answer({ id: m.request.id, answers: GOOD })).ok).toBe(true);
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { questions: QS, answers: GOOD } } });
    // another tool: prints nothing, exits 0
    const other = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "index.ts"), "hook", "claude-ask", "--port", String(app.port), "--home", home], { stdin: new TextEncoder().encode(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } })), stdout: "pipe", stderr: "pipe" });
    expect(await new Response(other.stdout).text()).toBe("");
    expect(await other.exited).toBe(0);
    p.ws.close();
  }, 20000);
});
