import { describe, expect, test } from "bun:test";
import { fetchClaudeQuota, SIGNED_OUT, TOKEN_EXPIRED, TOKEN_NOT_IN_FILE } from "../src/ai/claude";
import { createWin32 } from "../src/platform/win32";

const file = (text: string) => ({ readFile: async () => text, dir: "/x", platform: "win32" as const, now: () => 1_000 });

describe("Claude sign-in on Windows", () => {
  test("the real signed-out file of the PC (blank tokens, expiresAt 0) says: not signed in, run claude and /login", async () => {
    const exact = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: ["user:inference", "user:profile", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"] } });
    const q = await fetchClaudeQuota(file(exact));
    expect(q.error).toBe(SIGNED_OUT);
    expect(q.error).not.toContain("outside");
  });
  test("an empty access token but a refresh token: the token lives elsewhere", async () => {
    const q = await fetchClaudeQuota(file(JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "r", expiresAt: 5 } })));
    expect(q.error).toBe(TOKEN_NOT_IN_FILE);
  });
  test("no file at all still says sign in; an expired token says open Claude Code to refresh", async () => {
    const none = await fetchClaudeQuota({ readFile: async () => { throw new Error("ENOENT"); }, dir: "/x", platform: "win32", now: () => 1 });
    expect(none.error).toBe(SIGNED_OUT);
    const old = await fetchClaudeQuota(file(JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: 5 } })));
    expect(old.error).toBe(TOKEN_EXPIRED);
    expect(TOKEN_EXPIRED).toContain("open Claude Code once");
  });
  test("the Windows platform reads the OAuth JSON from Credential Manager (read-only, first target with an access token)", async () => {
    const asked: string[] = [];
    const cred = { read: (t: string) => { asked.push(t); return t === "claude-code-credentials" ? '{"claudeAiOauth":{"accessToken":"tok"}}' : t === "Claude Code-credentials" ? "unrelated" : undefined; }, write: () => { throw new Error("never"); }, remove: () => { throw new Error("never"); } };
    const win = createWin32({ cred, helper: { call: async () => null, dispose() {} } as any });
    expect(JSON.parse((await win.claudeCredentials())!).claudeAiOauth.accessToken).toBe("tok");
    expect(asked[0]).toBe("Claude Code-credentials");
    const none = createWin32({ cred: { ...cred, read: () => undefined }, helper: { call: async () => null, dispose() {} } as any });
    expect(await none.claudeCredentials()).toBeNull();
  });
});
