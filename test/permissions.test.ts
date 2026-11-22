import { describe, expect, test } from "bun:test";
import { WIN, MODE600, MODE644 } from "./_os";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-perm-"));
const { PermissionBroker, summarizeTool, formatHookOutput, hookInputFromStdin, runHook, parseHookInput, ensureHookSecret, secretMatches } = await import("../src/permissions");

function make(phones = true, timeoutMs = 60) {
  const events: any[] = [];
  const broker = new PermissionBroker(
    { hasPhones: () => phones, notify: (r) => events.push(["notify", r]), resolved: (id, d) => events.push(["resolved", id, d]) },
    timeoutMs,
  );
  return { broker, events };
}
const bash = { source: "claude" as const, toolName: "Bash", toolInput: { command: "rm -rf build" }, cwd: "/w/app", sessionId: "s1" };

describe("summaries", () => {
  test("by tool", () => {
    expect(summarizeTool("Bash", { command: "ls -la", description: "List" })).toEqual({ summary: "ls -la", detail: "List" });
    expect(summarizeTool("Edit", { file_path: "/a/b.ts", old_string: "x" })).toEqual({ summary: "/a/b.ts" });
    expect(summarizeTool("Write", { file_path: "/a/c.ts", content: "SECRET" }).summary).toBe("/a/c.ts");
    expect(summarizeTool("mcp__knowns__tasks", { action: "x" })).toEqual({ summary: "knowns/tasks" });
    expect(summarizeTool("mcp__claude_ai_Docs__read", {})).toEqual({ summary: "claude_ai_Docs/read" });
    expect(summarizeTool("shell", { command: ["git", "status"] }).summary).toBe("git status");
    expect(summarizeTool("Weird", undefined)).toEqual({ summary: "Weird" });
  });
  test("truncates to 300", () => {
    const s = summarizeTool("Bash", { command: "x".repeat(1000) }).summary;
    expect(s.length).toBe(300);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("broker", () => {
  test("no phone: null immediately, nothing broadcast", async () => {
    const { broker, events } = make(false);
    expect(await broker.request(bash)).toBeNull();
    expect(events).toEqual([]);
  });

  test("first answer wins, later ones are rejected", async () => {
    const { broker, events } = make();
    const p = broker.request(bash);
    const req = events[0][1];
    expect(req).toMatchObject({ source: "claude", project: "app", tool: "Bash", summary: "rm -rf build" });
    expect(req.expiresAt - req.createdAt).toBe(60);
    expect(broker.list().length).toBe(1);
    expect(broker.hints()).toEqual([{ source: "claude", sessionId: "s1", cwd: "/w/app" }]);
    expect(broker.answer(req.id, "deny")).toBe(true);
    expect(broker.answer(req.id, "allow")).toBe(false);
    expect(await p).toBe("deny");
    expect(events[1]).toEqual(["resolved", req.id, "deny"]);
    expect(broker.size).toBe(0);
  });

  test("timeout resolves null and announces timeout", async () => {
    const { broker, events } = make(true, 20);
    expect(await broker.request(bash)).toBeNull();
    expect(events.at(-1)![2]).toBe("timeout");
    expect(broker.answer(events[0][1].id, "allow")).toBe(false);
  });

  test("abort (hook process gone) cancels", async () => {
    const { broker, events } = make(true, 5000);
    const ac = new AbortController();
    const p = broker.request(bash, ac.signal);
    ac.abort();
    expect(await p).toBeNull();
    expect(events.at(-1)![2]).toBe("timeout");
    expect(broker.size).toBe(0);
  });
});

describe("hook plumbing", () => {
  test("formatHookOutput", () => {
    expect(JSON.parse(formatHookOutput("allow")!)).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(JSON.parse(formatHookOutput("deny")!).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "Denied from Nookdeck" });
    expect(formatHookOutput(null)).toBeNull();
    expect(formatHookOutput("maybe" as any)).toBeNull();
  });

  test("hookInputFromStdin", () => {
    const stdin = JSON.stringify({ session_id: "s", cwd: "/w/x", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(hookInputFromStdin("claude", stdin)).toEqual({ source: "claude", toolName: "Bash", toolInput: { command: "ls" }, sessionId: "s", cwd: "/w/x" });
    expect(hookInputFromStdin("codex", "not json")).toBeNull();
    expect(hookInputFromStdin("codex", "{}")).toBeNull();
  });

  test("runHook prints decision JSON, nothing on failure", async () => {
    let call: any;
    const ok = await runHook("claude", {
      stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), port: 1234, secret: "sek",
      fetch: (async (url: string, init: any) => { call = { url, init }; return Response.json({ decision: "allow" }); }) as any,
    });
    expect(call.url).toBe("http://127.0.0.1:1234/api/hooks/permission");
    expect(call.init.headers["x-nookdeck-hook"]).toBe("sek");
    expect(JSON.parse(ok!).hookSpecificOutput.decision.behavior).toBe("allow");
    const none = await runHook("claude", { stdin: JSON.stringify({ tool_name: "Bash" }), port: 1, secret: "s", fetch: (async () => Response.json({ decision: null })) as any });
    expect(none).toBeNull();
    const down = await runHook("claude", { stdin: JSON.stringify({ tool_name: "Bash" }), port: 1, secret: "s", fetch: (async () => { throw new Error("refused"); }) as any });
    expect(down).toBeNull();
    expect(await runHook("claude", { stdin: "junk", port: 1, secret: "s" })).toBeNull();
  });

  test("parseHookInput validates", () => {
    expect("error" in parseHookInput(null)).toBe(true);
    expect("error" in parseHookInput({ source: "x", toolName: "a" })).toBe(true);
    expect("error" in parseHookInput({ source: "claude" })).toBe(true);
    expect(parseHookInput({ source: "codex", toolName: "Bash", cwd: "/a", extra: 1 })).toEqual({ source: "codex", toolName: "Bash", cwd: "/a", toolInput: undefined });
  });

  test("secret file is created 0600 and stable; matching is exact", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pd-sec-")), "hook-secret");
    const a = await ensureHookSecret(file);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(statSync(file).mode & 0o777).toBe(MODE600);
    expect(await ensureHookSecret(file)).toBe(a);
    expect(secretMatches(a, a)).toBe(true);
    expect(secretMatches(a + "x", a)).toBe(false);
    expect(secretMatches(null, a)).toBe(false);
  });
});

describe("Grok payloads through ~/.claude/settings.json (Grok compat) are ignored", () => {
  const grokShapes = [
    { hookEventName: "pre_tool_use", sessionId: "g1", cwd: "/p", toolName: "Bash", toolInput: { command: "rm -rf x" } },
    { hook_event_name: "pre_tool_use", session_id: "g1", cwd: "/p", tool_name: "Bash", tool_input: { command: "ls" } },
    { hookEventName: "notification", notificationType: "permission_prompt", sessionId: "g1" },
    { sessionId: "g1", cwd: "/p", toolName: "AskUserQuestion", toolInput: { questions: [{ question: "q?", options: [{ label: "a" }] }] } },
  ];
  test("hook claude / codex: nothing is sent and nothing is printed", async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return Response.json({ decision: "allow" }); }) as any;
    for (const g of grokShapes) {
      expect(await runHook("claude", { stdin: JSON.stringify(g), port: 1, secret: "s", fetch: fetchFn })).toBeNull();
      expect(await runHook("codex", { stdin: JSON.stringify(g), port: 1, secret: "s", fetch: fetchFn })).toBeNull();
    }
    expect(calls).toBe(0);
  });
  test("hook claude-ask: the same", async () => {
    const { runAskHook } = await import("../src/questions");
    let calls = 0;
    const fetchFn = (async () => { calls++; return Response.json({ answers: { "q?": "a" } }); }) as any;
    for (const g of grokShapes) expect(await runAskHook({ stdin: JSON.stringify(g), port: 1, secret: "s", fetch: fetchFn })).toBeNull();
    expect(calls).toBe(0);
  });
  test("a real Claude payload still goes through", async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return Response.json({ decision: "allow" }); }) as any;
    const claude = { session_id: "c1", hook_event_name: "PermissionRequest", cwd: "/p", tool_name: "Bash", tool_input: { command: "ls" } };
    expect(await runHook("claude", { stdin: JSON.stringify(claude), port: 1, secret: "s", fetch: fetchFn })).toContain("allow");
    expect(calls).toBe(1);
  });
});
