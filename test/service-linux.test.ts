import { describe, expect, test } from "bun:test";
import { WIN, MODE644 } from "./_os";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Temp dirs only: never the real ~/.config/systemd, ~/.config/autostart, ~/.nookdeck or ~/.claude.
const sandbox = mkdtempSync(join(tmpdir(), "pd-svc-linux-"));
process.env.NOOKDECK_HOME ??= join(sandbox, "data");
process.env.NOOKDECK_SYSTEMD_DIR = join(sandbox, "systemd-user");
process.env.NOOKDECK_AUTOSTART_DIR = join(sandbox, "autostart");
process.env.NOOKDECK_LAUNCH_AGENTS_DIR ??= join(sandbox, "LaunchAgents");
process.env.NOOKDECK_CLAUDE_DIR ??= join(sandbox, "claude");
process.env.NOOKDECK_CODEX_DIR ??= join(sandbox, "codex");
const S = await import("../src/service");
type Deps = import("../src/service").ServiceDeps;

/**
 * a fake systemctl (answers by verb) and fake processes; `userBus: false` is a machine without a systemd user session,
 * `graphical: false` a desktop that never activates graphical-session.target (XFCE, MATE, Cinnamon, LXQt, i3).
 * A spawned pid runs the agent program (its exec); `cmd` sets the command line of any other pid.
 */
function fake(o: { userBus?: boolean; graphical?: boolean; fail?: string; show?: string } = {}) {
  const cmd = new Map<number, string[]>();
  const calls: string[][] = [];
  const lines: string[] = [];
  const live = new Set<number>();
  const spawned: string[][] = [];
  let next = 4000;
  const deps: Deps = {
    launchctl: async () => { throw new Error("launchctl must not be used on Linux"); },
    systemctl: async (a) => {
      calls.push(a);
      if (a[0] === "is-active" && a[1] === "graphical-session.target") return o.graphical === false ? { code: 3, out: "inactive" } : { code: 0, out: "active" };
      if (a[0] === "show-environment") return o.userBus === false ? { code: 1, out: "Failed to connect to bus: No medium found" } : { code: 0, out: "PATH=/usr/bin" };
      if (a[0] === o.fail) return { code: 1, out: `Job for nookdeck.service failed` };
      if (a[0] === "show") return { code: 0, out: o.show ?? "ActiveState=active\nMainPID=777" };
      return { code: 0, out: "" };
    },
    proc: {
      spawn: (argv) => { spawned.push(argv); const p = next++; live.add(p); cmd.set(p, ["/home/me/.nookdeck/bin/nookdeck"]); return p; },
      alive: (p) => live.has(p), kill: (p) => { live.delete(p); }, cmdline: (p) => (live.has(p) ? cmd.get(p) ?? null : null),
    },
    uid: 1000, platform: "linux", program: ["/home/me/.nookdeck/bin/nookdeck"], log: (l) => lines.push(l),
  };
  return { deps, calls, lines, spawned, live, cmd };
}

const reset = async () => { const fs = await import("node:fs/promises"); for (const f of [S.unitPath(), S.autostartPath(), S.autostartScript(), join(dirname(S.autostartScript()), "service.pid")]) await fs.rm(f, { force: true }); };

describe.skipIf(WIN)("the systemd unit and the autostart entry", () => {
  test("unit: the program and a custom port, graphical session, restart on failure only, logs, quoted values", () => {
    const u = S.buildUnit({ args: ["/home/me/my dir/nookdeck", "--port", "7511"], env: { NOOKDECK_HOME: "/d/100%$x\"y" }, logDir: "/d/logs" });
    expect(u).toContain('ExecStart="/home/me/my dir/nookdeck" "--port" "7511"');
    expect(u).toContain("PartOf=graphical-session.target");
    expect(u).toContain("WantedBy=graphical-session.target");
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain("StandardOutput=append:/d/logs/agent.out.log");
    expect(u).toContain("StandardError=append:/d/logs/agent.err.log");
    // Environment=: % escaped, $ kept as it is (systemd expands no $ there and would keep a $$ as two), the quote escaped
    expect(u).toContain('Environment="NOOKDECK_HOME=/d/100%%$x\\"y"');
    // ExecStart=: there a $ must be $$
    expect(S.buildUnit({ args: ["/h/$x/nookdeck"] })).toContain('ExecStart="/h/$$x/nookdeck"');
    expect(u).toMatch(/Environment="PATH=[^"]*\/\.local\/bin:[^"]*\/usr\/bin/);
  });
  test("autostart entry: runs a script by its path; the path is quoted for a .desktop file", () => {
    const e = S.buildDesktopEntry("/home/me/.nookdeck/autostart.sh");
    expect(e).toStartWith("[Desktop Entry]\nType=Application\n");
    expect(e).toContain('Exec=/bin/sh "/home/me/.nookdeck/autostart.sh"\n');
    expect(e).toContain("X-GNOME-Autostart-enabled=true");
    expect(S.desktopArg('/a b/100% "x" $y\\z')).toBe('"/a b/100%% \\\\"x\\\\" \\\\$y\\\\\\\\z"');
    const sh = S.buildAutostartScript({ args: ["/h/nookdeck", "--port", "7511"], env: { NOOKDECK_HOME: "/d/it's $HOME" }, logDir: "/d/logs" });
    expect(sh).toStartWith("#!/bin/sh\n");
    // the script records its own pid before exec, so an agent the login started is seen by status / stop / start
    expect(sh).toContain(`echo $$ >'${join(dirname(S.autostartScript()), "service.pid")}'\nexec env `);
    expect(sh).toContain(`'NOOKDECK_HOME=/d/it'\\''s $HOME' '/h/nookdeck' '--port' '7511' >>'/d/logs/agent.out.log' 2>>'/d/logs/agent.err.log'`);
  });
  test("the shell line of the entry really runs as written (no expansion of $HOME)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-auto-"));
    const line = S.autostartCommand({ args: ["/bin/sh", "-c", 'printf "%s|%s" "$NOOKDECK_HOME" "$0"', "x y"], env: { NOOKDECK_HOME: "/d/it's $HOME" }, logDir: dir });
    const r = Bun.spawnSync(["/bin/sh", "-c", line]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, "agent.out.log"), "utf8")).toBe("/d/it's $HOME|x y");
  });
  test("parseShow", () => {
    expect(S.parseShow("ActiveState=active\nMainPID=42")).toEqual({ running: true, pid: 42 });
    expect(S.parseShow("ActiveState=inactive\nMainPID=0")).toEqual({ running: false });
    expect(S.parseShow("ActiveState=failed")).toEqual({ running: false });
  });
});

describe.skipIf(WIN)("service commands on Linux with systemd (systemctl faked)", () => {
  test("install writes the unit (0644), daemon-reload, enable, restart; status reads it back", async () => {
    await reset();
    const { deps, calls, lines } = fake();
    const r = await S.serviceInstall(deps, { port: 7511 });
    expect(r.plist).toBe(join(process.env.NOOKDECK_SYSTEMD_DIR!, "nookdeck.service"));
    expect(calls).toEqual([["show-environment"], ["is-active", "graphical-session.target"], ["daemon-reload"], ["enable", "nookdeck.service"], ["restart", "nookdeck.service"]]);
    expect(readFileSync(r.plist, "utf8")).toContain('ExecStart="/home/me/.nookdeck/bin/nookdeck" "--port" "7511"');
    expect(statSync(r.plist).mode & 0o777).toBe(MODE644);
    expect(existsSync(S.logsDir())).toBe(true);
    expect(lines.join("\n")).toContain("Service installed");
    const st = await S.serviceStatus(deps);
    expect(st).toEqual({ installed: true, kind: "systemd", running: true, pid: 777, plist: r.plist, program: "/home/me/.nookdeck/bin/nookdeck" });
    // `nookdeck install` looks for this line to decide on a restart
    expect(S.formatStatus(st)).toBe(`Service: installed (systemd), running (pid 777)\nUnit:     ${r.plist}\nProgram: /home/me/.nookdeck/bin/nookdeck`);
    await S.serviceInstall(deps, { port: 7420 });
    expect(readFileSync(r.plist, "utf8")).not.toContain("--port");
  });
  test("start, stop, restart map to systemctl --user; a failure says what systemd said", async () => {
    await reset();
    const f = fake();
    await S.serviceInstall(f.deps);
    f.calls.length = 0;
    await S.serviceStop(f.deps);
    await S.serviceStart(f.deps);
    await S.serviceRestart(f.deps);
    expect(f.calls).toEqual([["stop", "nookdeck.service"], ["start", "nookdeck.service"], ["restart", "nookdeck.service"]]);
    await expect(S.serviceStart(fake({ fail: "start" }).deps)).rejects.toThrow("systemctl --user start failed (1): Job for nookdeck.service failed");
  });
  test("a failing install puts the old unit back and starts it", async () => {
    await reset();
    await S.serviceInstall(fake().deps, { port: 7512 });
    const bad = fake({ fail: "enable" });
    await expect(S.serviceInstall(bad.deps, { port: 7513 })).rejects.toThrow("The previous service was started again.");
    expect(readFileSync(S.unitPath(), "utf8")).toContain('"7512"');
  });
  test("a failing FIRST install leaves no unit behind (disabled and deleted)", async () => {
    await reset();
    const bad = fake({ fail: "restart" });
    await expect(S.serviceInstall(bad.deps)).rejects.toThrow("systemctl --user failed (1)");
    expect(existsSync(S.unitPath())).toBe(false);
    expect(bad.calls.slice(-3)).toEqual([["restart", "nookdeck.service"], ["disable", "nookdeck.service"], ["daemon-reload"]]);
  });
  test("stopped status, uninstall disables and removes; twice is fine; not installed refuses start", async () => {
    await reset();
    const f = fake({ show: "ActiveState=inactive\nMainPID=0" });
    await S.serviceInstall(f.deps);
    expect((await S.serviceStatus(f.deps)).running).toBe(false);
    f.calls.length = 0;
    expect((await S.serviceUninstall(f.deps)).removed).toBe(true);
    expect(f.calls).toEqual([["disable", "--now", "nookdeck.service"], ["daemon-reload"]]);
    expect(existsSync(S.unitPath())).toBe(false);
    expect((await S.serviceUninstall(f.deps)).removed).toBe(false);
    expect(await S.serviceStatus(f.deps)).toEqual({ installed: false, running: false, plist: S.unitPath() });
    await expect(S.serviceStart(f.deps)).rejects.toThrow("not installed");
  });
});

describe.skipIf(WIN)("service commands on Linux without systemd (XDG autostart)", () => {
  test("install writes the entry and starts the agent now; status says autostart; stop / start / restart; uninstall", async () => {
    await reset();
    const f = fake({ userBus: false });
    const r = await S.serviceInstall(f.deps, { port: 7514 });
    expect(r.plist).toBe(join(process.env.NOOKDECK_AUTOSTART_DIR!, "nookdeck.desktop"));
    expect(existsSync(S.unitPath())).toBe(false);
    expect(f.calls).toEqual([["show-environment"]]); // nothing else asked of systemd
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]).toEqual(["/bin/sh", S.autostartScript()]);
    expect(readFileSync(S.autostartScript(), "utf8")).toContain("'/home/me/.nookdeck/bin/nookdeck' '--port' '7514'");
    expect(statSync(S.autostartScript()).mode & 0o777).toBe(0o700);
    expect(f.lines.join("\n")).toContain("Installed an autostart entry");
    const st = await S.serviceStatus(f.deps);
    expect(st).toMatchObject({ installed: true, kind: "autostart", running: true, pid: 4000, program: "/home/me/.nookdeck/bin/nookdeck" });
    expect(S.formatStatus(st)).toStartWith("Service: installed (autostart), running (pid 4000)");
    await S.serviceStop(f.deps);
    expect(f.live.size).toBe(0);
    expect((await S.serviceStatus(f.deps)).running).toBe(false);
    await S.serviceStart(f.deps);
    await S.serviceStart(f.deps); // already running: not a second one
    expect(f.live.size).toBe(1);
    expect(f.spawned[1]).toEqual(f.spawned[0]); // start runs exactly what login runs
    await S.serviceRestart(f.deps);
    expect(f.live.size).toBe(1);
    expect((await S.serviceUninstall(f.deps)).removed).toBe(true);
    expect(f.live.size).toBe(0);
    expect(existsSync(S.autostartPath())).toBe(false);
    expect(existsSync(S.autostartScript())).toBe(false);
  });
  test("a later install with systemd replaces the autostart entry (no second agent at login)", async () => {
    await reset();
    const a = fake({ userBus: false });
    await S.serviceInstall(a.deps);
    expect(existsSync(S.autostartPath())).toBe(true);
    const b = fake();
    (b.deps as any).proc = a.deps.proc;
    await S.serviceInstall(b.deps);
    expect(existsSync(S.autostartPath())).toBe(false);
    expect(a.live.size).toBe(0);
    expect((await S.serviceStatus(b.deps)).kind).toBe("systemd");
    await S.serviceUninstall(b.deps);
  });
  test("a desktop without graphical-session.target (XFCE, MATE, Cinnamon, LXQt, i3) gets the autostart entry, and an old unit is stopped and removed first", async () => {
    await reset();
    await S.serviceInstall(fake().deps); // GNOME earlier: the unit
    expect(existsSync(S.unitPath())).toBe(true);
    const f = fake({ graphical: false });
    await S.serviceInstall(f.deps);
    expect(f.calls).toEqual([["show-environment"], ["is-active", "graphical-session.target"], ["disable", "--now", "nookdeck.service"], ["daemon-reload"]]);
    const iDisable = f.calls.findIndex((c) => c[0] === "disable");
    expect(iDisable).toBeGreaterThan(-1); // the unit's agent is stopped before the autostart one is spawned (spawn is not a systemctl call)
    expect(existsSync(S.unitPath())).toBe(false);
    expect(existsSync(S.autostartPath())).toBe(true);
    expect(f.live.size).toBe(1);
    expect((await S.serviceStatus(f.deps)).kind).toBe("autostart");
    await S.serviceUninstall(f.deps);
  });
  test("switching from autostart to the unit stops the autostart agent BEFORE the unit starts (never two on one port)", async () => {
    await reset();
    const a = fake({ userBus: false });
    await S.serviceInstall(a.deps);
    const b = fake();
    (b.deps as any).proc = a.deps.proc;
    const aliveAtRestart: number[] = [];
    const sc = b.deps.systemctl!;
    b.deps.systemctl = async (args) => { if (args[0] === "restart") aliveAtRestart.push(a.live.size); return sc(args); };
    await S.serviceInstall(b.deps);
    expect(aliveAtRestart).toEqual([0]);
    await S.serviceUninstall(b.deps);
  });
  test("a failing switch to the unit starts the autostart agent again and keeps its entry", async () => {
    await reset();
    const a = fake({ userBus: false });
    await S.serviceInstall(a.deps);
    const b = fake({ fail: "restart" });
    (b.deps as any).proc = a.deps.proc;
    await expect(S.serviceInstall(b.deps)).rejects.toThrow("The previous autostart agent was started again.");
    expect(existsSync(S.unitPath())).toBe(false);
    expect(existsSync(S.autostartPath())).toBe(true);
    expect(a.live.size).toBe(1);
    await S.serviceUninstall(a.deps);
  });
});

describe.skipIf(WIN)("service.pid is trusted only for our own agent", () => {
  const pidFile = () => join(dirname(S.autostartScript()), "service.pid");
  test("an agent the LOGIN started (pid written by the script) is seen by status and stopped by stop; start does not add a second", async () => {
    await reset();
    const f = fake({ userBus: false });
    await S.serviceInstall(f.deps);
    await S.serviceStop(f.deps);
    // the login runs the script: it writes its own pid, then execs the agent
    f.live.add(5555); f.cmd.set(5555, ["/home/me/.nookdeck/bin/nookdeck", "--port", "7420"]);
    writeFileSync(pidFile(), "5555\n");
    expect(await S.serviceStatus(f.deps)).toMatchObject({ running: true, pid: 5555 });
    const before = f.spawned.length;
    await S.serviceStart(f.deps);
    expect(f.spawned.length).toBe(before); // already running
    await S.serviceStop(f.deps);
    expect(f.live.has(5555)).toBe(false);
    await S.serviceUninstall(f.deps);
  });
  test("a stale pid now used by another program (after a reboot) is not ours: not reported, never signalled; start launches the agent", async () => {
    await reset();
    const f = fake({ userBus: false });
    await S.serviceInstall(f.deps);
    await S.serviceStop(f.deps);
    f.live.add(6666); f.cmd.set(6666, ["/usr/bin/firefox"]);
    writeFileSync(pidFile(), "6666\n");
    expect((await S.serviceStatus(f.deps)).running).toBe(false);
    await S.serviceStop(f.deps);
    expect(f.live.has(6666)).toBe(true); // firefox untouched
    await S.serviceStart(f.deps);
    expect(f.spawned.at(-1)).toEqual(["/bin/sh", S.autostartScript()]);
    // a process whose command line cannot be read (gone, or another user's) is not ours either
    f.live.add(7777);
    writeFileSync(pidFile(), "7777\n");
    expect((await S.serviceStatus(f.deps)).running).toBe(false);
    await S.serviceUninstall(f.deps);
    expect(f.live.has(7777)).toBe(true);
  });
});

describe.skipIf(WIN)("the real CLI on a fake Linux service (NOOKDECK_SYSTEMCTL=echo)", () => {
  test.skipIf(process.platform !== "linux")("service install / status / restart / uninstall", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-cli-linux-"));
    const env = { ...process.env, NOOKDECK_HOME: join(dir, "data"), NOOKDECK_SYSTEMD_DIR: join(dir, "sd"), NOOKDECK_AUTOSTART_DIR: join(dir, "as"), NOOKDECK_SYSTEMCTL: "echo", NOOKDECK_CLAUDE_DIR: join(dir, "c"), NOOKDECK_CODEX_DIR: join(dir, "x") };
    const run = (args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "index.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
    expect(run(["service", "install", "--port", "7515"]).exitCode).toBe(0);
    expect(readFileSync(join(dir, "sd", "nookdeck.service"), "utf8")).toContain('"7515"');
    expect(run(["service", "status"]).stdout.toString()).toContain("installed (systemd)");
    expect(run(["service", "restart"]).exitCode).toBe(0);
    expect(run(["service", "uninstall"]).exitCode).toBe(0);
    expect(existsSync(join(dir, "sd", "nookdeck.service"))).toBe(false);
  });
});

writeFileSync(join(sandbox, ".keep"), "");

describe("the test sandbox guard", () => {
  test("under NOOKDECK_TEST_SANDBOX=1 the real systemctl --user and a real detached agent are refused", async () => {
    expect(process.env.NOOKDECK_TEST_SANDBOX).toBe("1"); // test/_preload.ts sets it for every test file
    const saved = process.env.NOOKDECK_SYSTEMCTL;
    delete process.env.NOOKDECK_SYSTEMCTL;
    try {
      await expect(S.runSystemctl(["show-environment"])).rejects.toThrow("test sandbox");
      // an install with the real runner stops there: it never falls back to autostart and never starts anything
      await expect(S.serviceInstall({ ...S.realServiceDeps(() => {}), platform: "linux" })).rejects.toThrow("test sandbox");
    } finally { if (saved !== undefined) process.env.NOOKDECK_SYSTEMCTL = saved; }
    // no user manager (a fake systemctl that fails) and no ServiceDeps.proc: the autostart fallback refuses to start a real agent
    const dir = mkdtempSync(join(tmpdir(), "pd-guard-linux-"));
    const env = { NOOKDECK_SYSTEMD_DIR: join(dir, "sd"), NOOKDECK_AUTOSTART_DIR: join(dir, "as") };
    const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const deps = { ...S.realServiceDeps(() => {}), platform: "linux" as const, systemctl: async () => ({ code: 1, out: "Failed to connect to bus" }), program: ["/bin/false"] };
      await expect(S.serviceInstall(deps)).rejects.toThrow("test sandbox");
    } finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });

  test("with NOOKDECK_SYSTEMCTL set the fake runs (how the CLI tests use it)", async () => {
    const saved = process.env.NOOKDECK_SYSTEMCTL;
    process.env.NOOKDECK_SYSTEMCTL = "echo";
    try { expect(await S.runSystemctl(["daemon-reload"])).toEqual({ code: 0, out: "daemon-reload" }); }
    finally { if (saved === undefined) delete process.env.NOOKDECK_SYSTEMCTL; else process.env.NOOKDECK_SYSTEMCTL = saved; }
  });
});
