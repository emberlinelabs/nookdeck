import { describe, expect, test } from "bun:test";
import { WIN, MODE600, MODE644 } from "./_os";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Temp dirs only: never the real ~/Library/LaunchAgents, ~/.nookdeck or ~/.claude.
const sandbox = mkdtempSync(join(tmpdir(), "pd-svc-"));
process.env.NOOKDECK_HOME = join(sandbox, "data");
process.env.NOOKDECK_LAUNCH_AGENTS_DIR = join(sandbox, "LaunchAgents");
process.env.NOOKDECK_CLAUDE_DIR = join(sandbox, "claude");
process.env.NOOKDECK_CODEX_DIR = join(sandbox, "codex");
const S = await import("../src/service");
const HI = await import("../src/hooks-install");

const fake = (overrides: Partial<import("../src/service").ServiceDeps> = {}) => {
  const calls: string[][] = [];
  const lines: string[] = [];
  const deps: import("../src/service").ServiceDeps = {
    launchctl: async (a) => { calls.push(a); return { code: 0, out: "" }; },
    uid: 501, platform: "darwin", program: ["/h/.nookdeck/bin/nookdeck"], log: (l) => lines.push(l), timing: { unloadMs: 0, backoffMs: [] }, ...overrides,
  };
  return { deps, calls, lines };
};

describe.skipIf(WIN)("plist", () => {
  test("label, program, RunAtLoad, KeepAlive only after a crash, logs under ~/.nookdeck/logs", () => {
    const p = S.buildPlist({ args: ["/h/.nookdeck/bin/nookdeck", "--port", "7500"], env: { NOOKDECK_HOME: "/data & <x>" }, logDir: "/data/logs" });
    expect(p).toContain("<string>dev.nookdeck.agent</string>");
    expect(p).toMatch(/<array>\s*<string>\/h\/\.nookdeck\/bin\/nookdeck<\/string>\s*<string>--port<\/string>\s*<string>7500<\/string>\s*<\/array>/);
    expect(p).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(p).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
    expect(p).toContain("<string>/data/logs/agent.out.log</string>");
    expect(p).toContain("<string>/data/logs/agent.err.log</string>");
    expect(p).toContain("/opt/homebrew/bin"); // PATH for playerctl, agy ...
    expect(p).toContain("<string>/data &amp; &lt;x&gt;</string>"); // escaped
    expect(p.startsWith("<?xml")).toBe(true);
  });
});

describe("service commands (launchctl faked)", () => {
  test.skipIf(WIN)("install writes the plist (0644) with logs dir, boots out then bootstraps in gui/<uid>; a custom port goes into the arguments", async () => {
    const { deps, calls } = fake();
    const r = await S.serviceInstall(deps, { port: 7500 });
    expect(r.plist).toBe(join(sandbox, "LaunchAgents", "dev.nookdeck.agent.plist"));
    expect(calls).toEqual([["bootout", "gui/501/dev.nookdeck.agent"], ["bootstrap", "gui/501", r.plist]]);
    const text = readFileSync(r.plist, "utf8");
    expect(text).toContain("<string>--port</string>");
    expect(text).toContain("<string>7500</string>");
    expect(text).toContain(`<key>NOOKDECK_HOME</key>`);
    expect(statSync(r.plist).mode & 0o777).toBe(MODE644);
    expect(existsSync(S.logsDir())).toBe(true); // HOME is fixed by whichever test file loads config first
    // default port: no --port argument
    await S.serviceInstall(deps, { port: 7420 });
    expect(readFileSync(r.plist, "utf8")).not.toContain("--port");
  });

  test("a failing bootstrap is an error with launchctl's message", async () => {
    const { deps } = fake({ launchctl: async (a) => (a[0] === "bootstrap" ? { code: 5, out: "Bootstrap failed: 5: Input/output error" } : a[0] === "print" || a[0] === "kickstart" ? { code: 113, out: "not found" } : { code: 0, out: "" }) });
    await expect(S.serviceInstall(deps)).rejects.toThrow("Input/output error");
  });

  /** A launchd that behaves like the real one: bootout answers at once but the job stays loaded for `lingerMs`; bootstrap of a job that is still loading answers 5. */
  const launchd = (o: { lingerMs?: number; eioFirst?: number; neverBootstrap?: boolean } = {}) => {
    const calls: string[][] = [];
    let loaded = true, unloadAt = 0, eio = o.eioFirst ?? 0, boots = 0;
    const launchctl = async (a: string[]) => {
      calls.push(a);
      if (a[0] === "bootout") { if (!loaded) return { code: 113, out: "Could not find service" }; unloadAt = Date.now() + (o.lingerMs ?? 0); loaded = false; return { code: 0, out: "" }; }
      if (a[0] === "print") return { code: loaded || Date.now() < unloadAt ? 0 : 113, out: "" };
      if (a[0] === "bootstrap") {
        boots++;
        if (o.neverBootstrap) return { code: 5, out: "Bootstrap failed: 5: Input/output error" };
        if (Date.now() < unloadAt || eio-- > 0) return { code: 5, out: "Bootstrap failed: 5: Input/output error" };
        loaded = true; return { code: 0, out: "" };
      }
      if (a[0] === "kickstart") return { code: loaded ? 0 : 113, out: "" };
      return { code: 0, out: "" };
    };
    return { calls, launchctl, boots: () => boots, isLoaded: () => loaded };
  };

  test("install waits until the booted-out job is really gone (it lingers 300 ms), then bootstraps once", async () => {
    const l = launchd({ lingerMs: 300 });
    const { deps } = fake({ launchctl: l.launchctl, timing: { unloadMs: 5000, pollMs: 20, backoffMs: [] } });
    await S.serviceInstall(deps);
    expect(l.isLoaded()).toBe(true);
    expect(l.boots()).toBe(1); // no failed attempt: the wait came first
    const names = l.calls.map((c) => c[0]);
    expect(names.indexOf("print")).toBeGreaterThan(names.indexOf("bootout"));
    expect(names.lastIndexOf("print")).toBeLessThan(names.indexOf("bootstrap"));
  });

  test("a bootstrap that answers 5 is retried with back-off and then succeeds; the old plist is never needed", async () => {
    const l = launchd({ eioFirst: 2 });
    const { deps } = fake({ launchctl: l.launchctl, timing: { unloadMs: 500, pollMs: 5, backoffMs: [5, 5, 5] } });
    await S.serviceInstall(deps);
    expect(l.boots()).toBe(3);
    expect(l.isLoaded()).toBe(true);
  });

  test("when bootstrap keeps failing the OLD plist is put back and loaded, and the error says so", async () => {
    const a = fake();
    await S.serviceInstall(a.deps); // an old plist exists now
    const before = (await import("node:fs")).readFileSync(S.plistPath(), "utf8");
    const l = launchd({ neverBootstrap: true });
    const { deps } = fake({ launchctl: l.launchctl, program: ["/new/nookdeck"], timing: { unloadMs: 200, pollMs: 5, backoffMs: [1, 1, 1] } });
    await expect(S.serviceInstall(deps)).rejects.toThrow(/bootstrap failed \(5\)/);
    expect((await import("node:fs")).readFileSync(S.plistPath(), "utf8")).toBe(before); // the old file is back
    expect(l.boots()).toBe(8); // 4 for the new plist, 4 to reload the old one
  });

  test("restart and start: a job that is still loaded is kicked instead of failing; stop waits for the unload", async () => {
    const l = launchd({ lingerMs: 150 });
    const { deps } = fake({ launchctl: l.launchctl, timing: { unloadMs: 3000, pollMs: 10, backoffMs: [5] } });
    await S.serviceInstall(deps);
    await S.serviceStop(deps);
    const t = Date.now();
    await S.serviceStart(deps);
    expect(l.isLoaded()).toBe(true);
    expect(Date.now() - t).toBeLessThan(2000);
    await S.serviceRestart(deps);
    expect(l.isLoaded()).toBe(true);
  });

  test("restart kickstarts; falls back to bootstrap when not loaded; refuses when not installed", async () => {
    const a = fake();
    await S.serviceInstall(a.deps);
    a.calls.length = 0;
    await S.serviceRestart(a.deps);
    expect(a.calls).toEqual([["kickstart", "-k", "gui/501/dev.nookdeck.agent"]]);
    const b = fake({ launchctl: async (x) => (x[0] === "kickstart" ? { code: 113, out: "not found" } : { code: 0, out: "" }) });
    await S.serviceRestart(b.deps);
    expect(b.lines.at(-1)).toBe("Service restarted.");
    await S.serviceUninstall(a.deps);
    await expect(S.serviceRestart(a.deps)).rejects.toThrow("not installed");
  });

  test("status: not installed, installed but stopped, running with pid", async () => {
    const none = fake();
    await S.serviceUninstall(none.deps);
    expect(await S.serviceStatus(none.deps)).toMatchObject({ installed: false, running: false });
    expect(S.formatStatus(await S.serviceStatus(none.deps))).toContain("not installed");
    await S.serviceInstall(none.deps);
    const stopped = fake({ launchctl: async () => ({ code: 113, out: "Could not find service" }) });
    expect(await S.serviceStatus(stopped.deps)).toMatchObject({ installed: true, running: false, program: "/h/.nookdeck/bin/nookdeck" });
    const running = fake({ launchctl: async () => ({ code: 0, out: "dev.nookdeck.agent = {\n\tstate = running\n\tpid = 4242\n}" }) });
    const st = await S.serviceStatus(running.deps);
    expect(st).toMatchObject({ installed: true, running: true, pid: 4242 });
    expect(S.formatStatus(st)).toContain("running (pid 4242)");
    expect(S.parsePrint("state = waiting")).toEqual({ running: false });
  });

  test("uninstall boots out and deletes the plist; twice is fine", async () => {
    const { deps, calls } = fake();
    await S.serviceInstall(deps);
    calls.length = 0;
    expect((await S.serviceUninstall(deps)).removed).toBe(true);
    expect(calls).toEqual([["bootout", "gui/501/dev.nookdeck.agent"]]);
    expect(existsSync(S.plistPath())).toBe(false);
    expect((await S.serviceUninstall(deps)).removed).toBe(false);
  });

  test("another OS: a clear error (unless NOOKDECK_LAUNCHCTL is set); Linux has its own tests (service-linux.test.ts)", async () => {
    await expect(S.serviceInstall(fake({ platform: "freebsd" }).deps)).rejects.toThrow("only available on macOS, Windows and Linux");
  });
});

describe.skipIf(WIN)("the real CLI with NOOKDECK_LAUNCHCTL=echo", () => {
  const run = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "index.ts"), ...args], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  test("--version prints the package version", () => {
    const r = run(["--version"]);
    const v = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;
    expect(r.stdout.toString().trim()).toMatch(new RegExp(`^nookdeck ${v.replace(/\\./g, "\\\\.")}( \\([0-9a-f]+(-dirty)?\\))?$`));
  });
  // launchd only: on Linux the same CLI runs the systemd code (service-linux.test.ts covers it with NOOKDECK_SYSTEMCTL=echo)
  test.skipIf(process.platform !== "darwin")("service install / status / restart / uninstall", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-cli-"));
    const env = { NOOKDECK_HOME: join(dir, "data"), NOOKDECK_LAUNCH_AGENTS_DIR: join(dir, "LA"), NOOKDECK_LAUNCHCTL: "echo", NOOKDECK_CLAUDE_DIR: join(dir, "c"), NOOKDECK_CODEX_DIR: join(dir, "x") };
    const inst = run(["service", "install", "--port", "7511"], env);
    expect(inst.exitCode).toBe(0);
    const plist = join(dir, "LA", "dev.nookdeck.agent.plist");
    expect(readFileSync(plist, "utf8")).toContain("<string>7511</string>");
    const st = run(["service", "status"], env);
    expect(st.stdout.toString()).toContain("installed");
    expect(run(["service", "restart"], env).exitCode).toBe(0);
    expect(run(["service", "uninstall"], env).exitCode).toBe(0);
    expect(existsSync(plist)).toBe(false);
    expect(run(["service", "bogus"], env).exitCode).toBe(2);
  }, 30_000); // six CLI starts: slow on a busy machine
});

describe.skipIf(WIN)("the CLI never touches the real Claude/Codex config of another instance", () => {
  test("service install with a sandbox NOOKDECK_HOME and no NOOKDECK_CLAUDE_DIR leaves ~/.claude alone (HOME is faked, so even a bug cannot reach the real one)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-guard-"));
    const fakeHome = join(dir, "home");
    require("node:fs").mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    require("node:fs").mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const claude = join(fakeHome, ".claude", "settings.json");
    const codex = join(fakeHome, ".codex", "hooks.json");
    const other = "'/old/nookdeck' hook claude --port 7460 --home '/other/home' # nookdeck hook";
    writeFileSync(claude, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: other, timeout: 60 }] }] } }));
    writeFileSync(codex, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: other.replace("claude", "codex"), timeout: 60 }] }] } }));
    const bytes = [readFileSync(claude, "utf8"), readFileSync(codex, "utf8")];
    // on Linux the same command is the systemd one: a fake systemctl and its own unit and autostart folders, never the real user manager
    const env: Record<string, string> = { PATH: process.env.PATH!, HOME: fakeHome, NOOKDECK_HOME: join(dir, "data"), NOOKDECK_LAUNCH_AGENTS_DIR: join(dir, "LA"), NOOKDECK_LAUNCHCTL: "echo",
      NOOKDECK_SYSTEMCTL: "echo", NOOKDECK_SYSTEMD_DIR: join(dir, "systemd-user"), NOOKDECK_AUTOSTART_DIR: join(dir, "autostart"), NOOKDECK_TEST_SANDBOX: "1" };
    const run = (args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "index.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    const inst = run(["service", "install", "--port", "7482"]);
    expect(inst.exitCode).toBe(0);
    expect(inst.stdout.toString()).toContain("leaving the claude hooks");
    for (const args of [["hooks", "repoint"], ["hooks", "remove"]]) {
      const r = run(args);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("is not set");
    }
    expect([readFileSync(claude, "utf8"), readFileSync(codex, "utf8")]).toEqual(bytes);
    expect(existsSync(`${claude}.nookdeck.bak`)).toBe(false);

    // with the dirs given explicitly it works, but still only on its own instance (port 7482 does not match 7460)
    const env2 = { ...env, NOOKDECK_CLAUDE_DIR: join(fakeHome, ".claude"), NOOKDECK_CODEX_DIR: join(fakeHome, ".codex") };
    const r2 = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "index.ts"), "service", "install", "--port", "7482"], { env: env2, stdout: "pipe", stderr: "pipe" });
    expect(r2.exitCode).toBe(0);
    expect(readFileSync(claude, "utf8")).toBe(bytes[0]!);
  });
});

describe("hooks that point at an older binary", () => {
  const settings = () => join(mkdtempSync(join(tmpdir(), "pd-rp-")), "settings.json");
  const NEW = ["/h/.nookdeck/bin/nookdeck"];

  test("repointCommand keeps the arguments and marker; no-op when already right; ignores other commands", () => {
    expect(S.repointCommand("'/old/nookdeck' hook claude --port 7460 --home '/x y' # nookdeck hook", NEW)).toBe("'/h/.nookdeck/bin/nookdeck' hook claude --port 7460 --home '/x y' # nookdeck hook");
    expect(S.repointCommand("'/bun' '/src/index.ts' hook claude-ask # nookdeck hook claude-ask", NEW)).toBe("'/h/.nookdeck/bin/nookdeck' hook claude-ask # nookdeck hook claude-ask");
    expect(S.repointCommand("'/h/.nookdeck/bin/nookdeck' hook codex # nookdeck hook", NEW)).toBeNull();
    expect(S.repointCommand("echo hi", NEW)).toBeNull();
    expect(S.repointCommand("'/bin/x' hook claude # nookdeck hook", ["/bun", "/a b/index.ts"])).toBe("'/bun' '/a b/index.ts' hook claude # nookdeck hook");
  });

  const INST = { port: 7430, home: "/h/d" };
  const flags = { port: 7430, home: "/h/d" };

  test("only our entries of THIS instance change (permission and question hooks); others stay; backup written", async () => {
    const f = settings();
    const mine = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'/old/nookdeck' hook claude # not ours" }] }], Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] }, theme: "dark" };
    writeFileSync(f, JSON.stringify(mine));
    await HI.installHook(f, HI.hookCommand("claude", { execPath: "/old/nookdeck", ...flags }));
    await HI.installAskHook(f, HI.askHookCommand({ execPath: "/old/nookdeck", ...flags }));
    const before = JSON.parse(readFileSync(f, "utf8"));
    const r = await S.repointHooks({ claude: f, codex: join(sandbox, "none.json") }, NEW, INST);
    expect(r).toEqual([{ file: f, changed: 2 }]);
    const after = JSON.parse(readFileSync(f, "utf8"));
    expect(after.hooks.PermissionRequest[0].hooks[0].command).toBe("'/h/.nookdeck/bin/nookdeck' hook claude --port 7430 --home '/h/d' # nookdeck hook");
    const ask = after.hooks.PreToolUse.find((g: any) => g.matcher === "AskUserQuestion").hooks[0].command;
    expect(ask).toBe("'/h/.nookdeck/bin/nookdeck' hook claude-ask --port 7430 --home '/h/d' # nookdeck hook claude-ask");
    expect(after.hooks.PreToolUse[0]).toEqual(mine.hooks.PreToolUse[0]);
    expect(after.hooks.Stop).toEqual(mine.hooks.Stop);
    expect(after.theme).toBe("dark");
    expect(JSON.parse(readFileSync(`${f}.nookdeck.bak`, "utf8"))).toEqual(before);
    expect(await HI.isHookInstalled(f)).toBe(true);
    expect((await S.repointHooks({ claude: f }, NEW, INST))[0]).toEqual({ file: f, changed: 0 }); // idempotent
  });

  test("a hook of ANOTHER instance (different --port or --home) is left alone, byte for byte", async () => {
    const f = settings();
    writeFileSync(f, "{}");
    await HI.installHook(f, HI.hookCommand("claude", { execPath: "/old/nookdeck", port: 7460, home: "/other/home" }));
    await HI.installAskHook(f, HI.askHookCommand({ execPath: "/old/nookdeck", port: 7430, home: "/other/home" }));
    const bytes = readFileSync(f, "utf8");
    // wrong port, wrong home, default instance: none of them matches the hooks above
    for (const inst of [{ port: 7482, home: "/other/home" }, { port: 7460, home: "/tmp/x" }, { port: 7420, home: join(homedir(), ".nookdeck") }, { port: 7430, home: "/h/d" }]) {
      expect(await S.repointHooks({ claude: f }, NEW, inst)).toEqual([{ file: f, changed: 0 }]);
    }
    expect(readFileSync(f, "utf8")).toBe(bytes);
    // the matching instance does change exactly its own hook (the ask hook has another port, so it stays)
    expect(await S.repointHooks({ claude: f }, NEW, { port: 7460, home: "/other/home" })).toEqual([{ file: f, changed: 1 }]);
    const d = JSON.parse(readFileSync(f, "utf8"));
    expect(d.hooks.PermissionRequest[0].hooks[0].command).toContain("/h/.nookdeck/bin/nookdeck");
    expect(d.hooks.PreToolUse[0].hooks[0].command).toContain("/old/nookdeck");
  });

  test.skipIf(WIN)("defaults count: a hook without flags belongs to port 7420 and ~/.nookdeck", async () => {
    const f = settings();
    writeFileSync(f, "{}");
    await HI.installHook(f, HI.hookCommand("claude", { execPath: "/old/nookdeck" }));
    expect(S.commandInstance("'/x' hook claude # nookdeck hook")).toEqual({ port: 7420, home: join(homedir(), ".nookdeck") });
    expect(S.commandInstance("'/x' hook claude --port 7460 --home '/a b/it'\\''s' # m")).toEqual({ port: 7460, home: "/a b/it's" });
    expect(await S.repointHooks({ claude: f }, NEW, { port: 7482, home: join(homedir(), ".nookdeck") })).toEqual([{ file: f, changed: 0 }]);
    expect(await S.repointHooks({ claude: f }, NEW, { port: 7420, home: join(homedir(), ".nookdeck") })).toEqual([{ file: f, changed: 1 }]);
  });

  test("hookTargets: a non-default NOOKDECK_HOME without NOOKDECK_CLAUDE_DIR / CODEX_DIR never reaches ~/.claude or ~/.codex", () => {
    const keep = { c: process.env.NOOKDECK_CLAUDE_DIR, x: process.env.NOOKDECK_CODEX_DIR };
    try {
      delete process.env.NOOKDECK_CLAUDE_DIR;
      delete process.env.NOOKDECK_CODEX_DIR;
      const t = S.hookTargets();
      expect(t.files).toEqual({});
      expect(t.skipped).toEqual(["claude", "codex"]);
      expect(t.notes.join("\n")).toContain("NOOKDECK_CLAUDE_DIR is not set");
      // one explicit dir: only that tool is used
      process.env.NOOKDECK_CODEX_DIR = join(sandbox, "codex");
      expect(S.hookTargets().files).toEqual({ codex: join(sandbox, "codex", "hooks.json") });
      // explicit files always win
      expect(S.hookTargets({ claude: "/t/s.json" }).files.claude).toBe("/t/s.json");
    } finally {
      for (const [k, v] of [["NOOKDECK_CLAUDE_DIR", keep.c], ["NOOKDECK_CODEX_DIR", keep.x]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test("removeHooks takes out both hooks with a backup and leaves the rest", async () => {
    const f = settings();
    const codex = settings();
    writeFileSync(f, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } }));
    await HI.installHook(f, HI.hookCommand("claude", { execPath: "/p/nookdeck" }));
    await HI.installAskHook(f, HI.askHookCommand({ execPath: "/p/nookdeck" }));
    await HI.installHook(codex, HI.hookCommand("codex", { execPath: "/p/nookdeck" }));
    const r = await S.removeHooks({ claude: f, codex });
    expect(r).toEqual([{ file: f, changed: true }, { file: codex, changed: true }]);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } });
    expect(await HI.isHookInstalled(codex)).toBe(false);
    expect(existsSync(`${f}.nookdeck.bak`)).toBe(true);
    expect((await S.removeHooks({ claude: f, codex })).every((x) => !x.changed)).toBe(true);
  });
});

describe("NOOKDECK_SERVICE_LABEL (dev sandbox)", () => {
  const run = (env: Record<string, string>) => Bun.spawnSync([process.execPath, "-e", `const s = await import(${JSON.stringify(join(import.meta.dir, "../src/service.ts"))}); console.log(s.SERVICE_LABEL)`], { env: { ...process.env, ...env }, stdout: "pipe" }).stdout.toString().trim();
  test("defaults to dev.nookdeck.agent, takes a sane override, refuses a junk one", () => {
    expect(run({ NOOKDECK_SERVICE_LABEL: "" })).toBe("dev.nookdeck.agent");
    expect(run({ NOOKDECK_SERVICE_LABEL: "dev.nookdeck.sandbox" })).toBe("dev.nookdeck.sandbox");
    expect(run({ NOOKDECK_SERVICE_LABEL: "../../etc/x y" })).toBe("dev.nookdeck.agent");
  });
});
