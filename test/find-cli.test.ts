import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIN } from "./_os";
import { findCli } from "../src/ai/find-cli";
import { AgyAuthRequired, AGY_AUTH_BACKOFF_MS, fetchAntigravityQuota, resetAgyBackoff, runAgy } from "../src/ai/antigravity";
import { buildPlist } from "../src/service";
import { t, setLanguage } from "../src/i18n";

const tmp = () => mkdtempSync(join(tmpdir(), "nd-cli-"));
const ID = WIN ? "win32" : "darwin";
const X = WIN ? ".cmd" : "";
const exe = (f: string, body = "#!/bin/sh\nexit 0\n") => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, body); chmodSync(f, 0o755); return f; };

describe("findCli", () => {
  test("PATH wins; then ~/.local/bin and ~/.bun/bin; then extra dirs; null when nowhere", () => {
    const home = tmp(), onPath = tmp(), extra = tmp();
    const empty = { PATH: "/nonexistent" };
    expect(findCli("zzcli", [], { home, id: ID, env: empty })).toBeNull();
    const a = exe(join(home, ".local", "bin", `zzcli${X}`));
    expect(findCli("zzcli", [], { home, id: ID, env: empty })).toBe(a);
    const b = exe(join(home, ".bun", "bin", `zzcli2${X}`));
    expect(findCli("zzcli2", [], { home, id: ID, env: empty })).toBe(b);
    const c = exe(join(extra, `zzcli3${X}`));
    expect(findCli("zzcli3", [], { home, id: ID, env: empty })).toBeNull();
    expect(findCli("zzcli3", [extra], { home, id: ID, env: empty })).toBe(c);
    const d = exe(join(onPath, `zzcli${X}`));
    expect(findCli("zzcli", [], { home, id: ID, env: { PATH: onPath } })).toBe(d);
  });
  test("Windows: %APPDATA%\\npm and the extra agy dir, .exe and .cmd", () => {
    const home = tmp(), appdata = tmp(), agy = tmp();
    const cmd = exe(join(appdata, "npm", "agy.cmd"));
    expect(findCli("agy", [], { home, id: "win32", env: { PATH: "", APPDATA: appdata } })).toBe(cmd);
    const e = exe(join(agy, "agy.exe"));
    expect(findCli("agy", [agy], { home, id: "win32", env: { PATH: "", APPDATA: tmp() } })).toBe(e);
  });
  test("the launchd PATH includes ~/.local/bin and ~/.bun/bin", () => {
    const plist = buildPlist({ args: ["/x/nookdeck"], logDir: tmp() });
    expect(plist).toMatch(/<string>[^<]*\/\.local\/bin:[^<]*\/\.bun\/bin:\/opt\/homebrew\/bin/);
  });
});

describe("agy not signed in", () => {
  const fake = (body: string) => exe(join(tmp(), "agy"), `#!/bin/bash\n${body}\n`);
  const AUTH = `echo "Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?secret=1" >&2\nsleep 30`;
  test.skipIf(WIN)("runAgy stops at the message, fast", async () => {
    const t0 = Date.now();
    await expect(runAgy([fake(AUTH), "-p", "/usage"], 20_000)).rejects.toThrow("not signed in");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  test("a clear error without the URL, then a 30 min back-off, lifted by force", async () => {
    resetAgyBackoff();
    const bin = "/x/agy";
    let runs = 0;
    // a runner that behaves like runAgy meeting the message (the real process is covered by the test above, off Windows)
    const run = async (_a: string[], _ms: number): Promise<string> => { runs++; throw new AgyAuthRequired(); };
    const now = 1_000_000;
    const q = await fetchAntigravityQuota(run, now, bin);
    expect(q.error).toBe("Antigravity CLI is not signed in on this computer. Open a terminal, run `agy` once and sign in.");
    expect(JSON.stringify(q)).not.toContain("accounts.google.com");
    expect(runs).toBe(1);
    const again = await fetchAntigravityQuota(run, now + 60_000, bin);
    expect(again.error).toBe(q.error);
    expect(runs).toBe(1); // backed off
    await fetchAntigravityQuota(run, now + AGY_AUTH_BACKOFF_MS + 1, bin);
    expect(runs).toBe(2); // 30 min later
    await fetchAntigravityQuota(run, now + AGY_AUTH_BACKOFF_MS + 2, bin);
    expect(runs).toBe(2);
    await fetchAntigravityQuota(run, now + AGY_AUTH_BACKOFF_MS + 3, bin, { force: true });
    expect(runs).toBe(3); // refresh button
    resetAgyBackoff();
  });
  test("not found says how to fix it; messages exist in vi and zh", async () => {
    const q = await fetchAntigravityQuota(undefined, 1, null);
    expect(q.error).toContain("NOOKDECK_AGY");
    for (const l of ["vi", "zh"] as const) {
      setLanguage(l);
      try {
        expect(t("Antigravity CLI (agy) was not found. Install it, or set NOOKDECK_AGY to its path.")).not.toContain("was not found");
        expect(t("Antigravity CLI is not signed in on this computer. Open a terminal, run `agy` once and sign in.")).not.toContain("not signed in");
      } finally { setLanguage("en"); }
    }
  });
  test("a working agy still parses", async () => {
    const out = JSON.stringify({ response: "Gemini Models\tweekly\t80%\t2030-01-01T00:00:00Z" });
    const q = await fetchAntigravityQuota(async () => out, 1, "/x/agy");
    expect(q.windows.length).toBe(1);
  });
});
