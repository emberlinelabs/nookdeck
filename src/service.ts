import { userHome } from "./home";
import { basename, dirname, join, resolve } from "node:path";

import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { HOME } from "./config";
import { ASK_EVENT, ASK_MARKER, HOOK_EVENT, HOOK_MARKER, LEGACY_ASK_MARKER, LEGACY_HOOK_MARKER, hookConfigPath, uninstallAskHook, uninstallHook, type HookTool } from "./hooks-install";
import { copyFile } from "node:fs/promises";
import { platform } from "./platform";
import { runCode } from "./platform/exec";
import { winInstall, winRestart, winStartService, winStatus, winStopService, winUninstall, type WinServiceCtx } from "./platform/win32/service";

/**
 * launchd label and plist name of the background service (macOS). NOOKDECK_SERVICE_LABEL overrides it for a dev sandbox (the menu
 * bar app's sandbox mode), so a test run never touches the real login service; it must look like a reverse-DNS label.
 */
export const DEFAULT_SERVICE_LABEL = "dev.nookdeck.agent";
const labelOverride = process.env.NOOKDECK_SERVICE_LABEL;
export const SERVICE_LABEL = labelOverride && /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(labelOverride) ? labelOverride : DEFAULT_SERVICE_LABEL;

/** Where the plist goes. NOOKDECK_LAUNCH_AGENTS_DIR overrides it (tests, a relocated install). */
export const launchAgentsDir = (): string => process.env.NOOKDECK_LAUNCH_AGENTS_DIR ?? join(userHome(), "Library", "LaunchAgents");
export const plistPath = (): string => join(launchAgentsDir(), `${SERVICE_LABEL}.plist`);
export const logsDir = (): string => join(HOME, "logs");

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface PlistOptions {
  /** The program and its arguments, e.g. ["/Users/me/.nookdeck/bin/nookdeck", "--port", "7420"]. */
  args: string[];
  /** Extra environment (NOOKDECK_HOME when not the default, ...). */
  env?: Record<string, string>;
  logDir?: string;
}

/** The launchd property list: starts at login, restarts only after a crash (a clean exit stays stopped), logs to ~/.nookdeck/logs. */
export function buildPlist(o: PlistOptions): string {
  const logs = o.logDir ?? logsDir();
  // launchd gives agents a minimal PATH; add the usual Homebrew locations so playerctl, agy and grok are found
  // ~/.local/bin and ~/.bun/bin are where agy, grok, opencode, claude and codex usually live
  const home = process.env.HOME || userHome();
  const env: Record<string, string> = { PATH: `${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, ...(o.env ?? {}) };
  const envXml = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${o.args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(join(logs, "agent.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logs, "agent.err.log"))}</string>
</dict>
</plist>
`;
}

export interface ServiceDeps {
  /** Runs launchctl (or NOOKDECK_LAUNCHCTL, e.g. `echo`) with these arguments. */
  launchctl: (args: string[]) => Promise<{ code: number; out: string }>;
  uid: number;
  platform: NodeJS.Platform;
  /** The program the service runs: the compiled binary, or [bun, index.ts] when run from source. */
  program: string[];
  log: (line: string) => void;
  /** launchd timing (tests make it instant): how long to wait for a booted-out job to be gone, the poll step, and the pauses between bootstrap retries. */
  timing?: { unloadMs?: number; pollMs?: number; backoffMs?: number[] };
  /** Windows: runs schtasks / reg / powershell (tests pass a fake). */
  winRun?: (argv: string[]) => Promise<{ code: number; out: string }>;
  /** Windows: where launch.vbs lives (default %LOCALAPPDATA%\\Nookdeck). */
  winDir?: string;
  /** Linux: runs `systemctl --user` (or NOOKDECK_SYSTEMCTL, e.g. `echo`) with these arguments. */
  systemctl?: (args: string[]) => Promise<{ code: number; out: string }>;
  /** Linux without systemd (XDG autostart): starts the agent detached and gives its pid; whether a pid lives; stops it. */
  proc?: { spawn: (argv: string[]) => number; alive: (pid: number) => boolean; kill: (pid: number) => void; cmdline: (pid: number) => string[] | null };
}

/** %LOCALAPPDATA%\Nookdeck: the launcher script of the Windows service. NOOKDECK_WIN_DIR overrides it (tests). */
export const winServiceDir = (): string => process.env.NOOKDECK_WIN_DIR ?? join(process.env.LOCALAPPDATA ?? join(userHome(), "AppData", "Local"), "Nookdeck");

export const winServiceCtxFrom = (d: ServiceDeps, port?: number): WinServiceCtx => winCtx(d, port);

function winCtx(d: ServiceDeps, port?: number): WinServiceCtx {
  const env: Record<string, string> = {};
  if (process.env.NOOKDECK_HOME) env.NOOKDECK_HOME = process.env.NOOKDECK_HOME;
  return { run: d.winRun ?? ((argv) => runCode(argv, 15_000)), dir: d.winDir ?? winServiceDir(), logDir: logsDir(), program: d.program, env, port, selfPid: process.pid, log: d.log };
}

export async function runLaunchctl(args: string[]): Promise<{ code: number; out: string }> {
  const bin = process.env.NOOKDECK_LAUNCHCTL ?? "launchctl";
  try {
    const p = Bun.spawn([...bin.split(" ").filter(Boolean), ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: (out + err).trim() };
  } catch (e: any) {
    return { code: 127, out: String(e?.message ?? e) };
  }
}

/** The command the service runs: `nookdeck` itself, or `bun <index.ts>` when started from source. */
export function defaultProgram(): string[] {
  const exe = process.execPath;
  return /^bun(\.exe)?$/i.test(basename(exe)) ? [exe, join(import.meta.dir, "index.ts")] : [exe];
}

export const realServiceDeps = (log: (l: string) => void = (l) => console.log(l)): ServiceDeps => ({
  launchctl: runLaunchctl,
  systemctl: runSystemctl,
  uid: process.getuid?.() ?? 501,
  platform: platform.id,
  // a fake launchctl (NOOKDECK_LAUNCHCTL, tests) has no unload delay to wait for
  ...(process.env.NOOKDECK_LAUNCHCTL ? { timing: { unloadMs: 0, backoffMs: [] } } : {}),
  program: defaultProgram(),
  log,
});

const domain = (d: ServiceDeps) => `gui/${d.uid}`;
const target = (d: ServiceDeps) => `${domain(d)}/${SERVICE_LABEL}`;

function needMac(d: ServiceDeps) {
  if (d.platform !== "darwin" && d.platform !== "win32" && d.platform !== "linux" && !process.env.NOOKDECK_LAUNCHCTL) throw new Error("The background service is only available on macOS, Windows and Linux. Run `nookdeck` in a terminal instead.");
}

// ---------- Linux: a systemd user unit, or an XDG autostart entry without systemd ----------

/** $XDG_CONFIG_HOME or ~/.config */
const xdgConfig = (): string => process.env.XDG_CONFIG_HOME || join(userHome(), ".config");
/** Where the unit goes. NOOKDECK_SYSTEMD_DIR overrides it (tests). */
export const systemdUserDir = (): string => process.env.NOOKDECK_SYSTEMD_DIR ?? join(xdgConfig(), "systemd", "user");
/** Where the autostart entry goes. NOOKDECK_AUTOSTART_DIR overrides it (tests). */
export const autostartDir = (): string => process.env.NOOKDECK_AUTOSTART_DIR ?? join(xdgConfig(), "autostart");
/** nookdeck.service, or <label>.service for a dev sandbox label, so a sandbox never replaces the real unit */
export const unitName = (): string => (SERVICE_LABEL === DEFAULT_SERVICE_LABEL ? "nookdeck" : SERVICE_LABEL) + ".service";
export const unitPath = (): string => join(systemdUserDir(), unitName());
export const autostartPath = (): string => join(autostartDir(), unitName().replace(/\.service$/, ".desktop"));
/** the pid of an agent started from the autostart entry by `service start` / `install` (systemd keeps its own) */
const autostartPidFile = (): string => join(HOME, "service.pid");

/** A login PATH for the agent: the usual places for playerctl, ydotool, claude, codex, agy ... */
const linuxPath = (): string => {
  const home = process.env.HOME || userHome();
  return `${home}/.local/bin:${home}/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin`;
};

/** One word of a systemd command line (ExecStart=): always double-quoted; `%` and `$` are not expanded. */
const sdWord = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
/** One Environment= assignment: double-quoted, `%` escaped. systemd expands no `$` there and keeps `$$` as two characters. */
const sdEnv = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export interface UnitOptions { args: string[]; env?: Record<string, string>; logDir?: string }

/**
 * The systemd user unit: part of the graphical session (so it has DISPLAY / WAYLAND_DISPLAY and starts with it), restarts only
 * after a failure (a clean exit stays stopped, as with launchd), logs to ~/.nookdeck/logs.
 */
export function buildUnit(o: UnitOptions): string {
  const logs = o.logDir ?? logsDir();
  const env: Record<string, string> = { PATH: linuxPath(), ...(o.env ?? {}) };
  return `[Unit]
Description=Nookdeck agent
PartOf=graphical-session.target
After=graphical-session.target

[Service]
Type=simple
ExecStart=${o.args.map(sdWord).join(" ")}
${Object.entries(env).map(([k, v]) => `Environment=${sdEnv(`${k}=${v}`)}`).join("\n")}
Restart=on-failure
RestartSec=10
StandardOutput=append:${join(logs, "agent.out.log").replace(/%/g, "%%")}
StandardError=append:${join(logs, "agent.err.log").replace(/%/g, "%%")}

[Install]
WantedBy=graphical-session.target
`;
}

const shq0 = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The shell line the autostart entry (and `service start` without systemd) runs: env, program, logs. */
export function autostartCommand(o: UnitOptions): string {
  const logs = o.logDir ?? logsDir();
  const env: Record<string, string> = { PATH: linuxPath(), ...(o.env ?? {}) };
  return `exec env ${Object.entries(env).map(([k, v]) => shq0(`${k}=${v}`)).join(" ")} ${o.args.map(shq0).join(" ")} >>${shq0(join(logs, "agent.out.log"))} 2>>${shq0(join(logs, "agent.err.log"))}`;
}

/** The script the autostart entry runs (in the data folder), so the .desktop file only has to quote one path. */
export const autostartScript = (): string => join(HOME, "autostart.sh");

/** The script records its own pid (exec keeps it) so `service status/stop/start` also see an agent the login started. */
export const buildAutostartScript = (o: UnitOptions): string => `#!/bin/sh\n# Nookdeck agent, started at login by the XDG autostart entry (nookdeck service install)\necho $$ >${shq0(autostartPidFile())}\n${autostartCommand(o)}\n`;

/**
 * One argument of a .desktop Exec line: double-quoted; `"`, `` ` ``, `$` and `\\` get a backslash (the quoting rule), then every
 * backslash is doubled (the string escape the spec applies first), and `%` is `%%`.
 */
export const desktopArg = (s: string): string => `"${s.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/\\/g, "\\\\").replace(/%/g, "%%")}"`;

/** An XDG autostart entry: the desktop starts the script at login. */
export function buildDesktopEntry(script: string): string {
  return `[Desktop Entry]
Type=Application
Name=Nookdeck agent
Comment=Starts the Nookdeck agent at login
Exec=/bin/sh ${desktopArg(script)}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

/** Inside the test suite (test/_preload.ts sets NOOKDECK_TEST_SANDBOX) the real user manager and a real detached agent are off limits. */
const inTestSandbox = (): boolean => process.env.NOOKDECK_TEST_SANDBOX === "1";

export async function runSystemctl(args: string[]): Promise<{ code: number; out: string }> {
  if (inTestSandbox() && !process.env.NOOKDECK_SYSTEMCTL) throw new Error("test sandbox: set NOOKDECK_SYSTEMCTL (for example `echo`); a test never runs the real systemctl --user");
  const bin = process.env.NOOKDECK_SYSTEMCTL ?? "systemctl --user";
  try {
    const p = Bun.spawn([...bin.split(" ").filter(Boolean), ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: (out + err).trim() };
  } catch (e: any) {
    return { code: 127, out: String(e?.message ?? e) };
  }
}

const realProc: NonNullable<ServiceDeps["proc"]> = {
  spawn: (argv) => {
    if (inTestSandbox()) throw new Error("test sandbox: a test never starts a detached agent; pass ServiceDeps.proc");
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true } as any);
    p.unref();
    return p.pid;
  },
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } },
  kill: (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone already */ } },
  cmdline: (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { return null; } },
};

const sysctl = (d: ServiceDeps) => d.systemctl ?? runSystemctl;
const procOf = (d: ServiceDeps) => d.proc ?? realProc;
const exists = (f: string) => stat(f).then(() => true, () => false);

/** A systemd user manager answers for this user (not the case over a plain ssh login without linger, in a container, ...). */
export async function hasSystemdUser(d: ServiceDeps): Promise<boolean> {
  return (await sysctl(d)(["show-environment"])).code === 0;
}

/**
 * Unit or autostart entry? The unit is WantedBy graphical-session.target, which only some desktops activate: GNOME and KDE
 * Plasma do (Ubuntu, Debian, Fedora), while XFCE, MATE, Cinnamon (Linux Mint), LXQt and i3 never do even with a systemd user
 * manager, so a unit there would never start after a reboot. Rule: the unit only when that target is active at install time
 * (so install from inside the desktop), otherwise the XDG autostart entry, which every desktop runs at login.
 */
export async function useSystemdUnit(d: ServiceDeps): Promise<boolean> {
  if (!(await hasSystemdUser(d))) return false;
  return (await sysctl(d)(["is-active", "graphical-session.target"])).code === 0;
}

function linuxSpec(d: ServiceDeps, port?: number): UnitOptions {
  const args = [...d.program];
  if (port !== undefined && port !== 7420) args.push("--port", String(port));
  // NOOKDECK_SERVICE: the agent knows it was started by the service (doctor), as with the Windows launcher
  const env: Record<string, string> = { NOOKDECK_SERVICE: "1" };
  if (process.env.NOOKDECK_HOME) env.NOOKDECK_HOME = process.env.NOOKDECK_HOME;
  if (SERVICE_LABEL !== DEFAULT_SERVICE_LABEL) env.NOOKDECK_SERVICE_LABEL = SERVICE_LABEL;
  return { args, env };
}

/**
 * The pid in service.pid, only when that process really is our agent: after a reboot the number can belong to any program,
 * which must never be reported as the agent or sent SIGTERM. Ours = its command line has the agent program (or, in the instant
 * before its exec, the autostart script).
 */
async function autostartPid(d: ServiceDeps): Promise<number | null> {
  const pid = Number((await readFile(autostartPidFile(), "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 1 || !procOf(d).alive(pid)) return null;
  const argv = procOf(d).cmdline(pid);
  const program = d.program[d.program.length - 1]!;
  return argv && (argv.includes(program) || argv.includes(autostartScript())) ? pid : null;
}

/** Runs the autostart script now, unless its agent already runs. */
async function autostartStart(d: ServiceDeps): Promise<void> {
  if (await autostartPid(d)) return;
  if (!(await exists(autostartScript()))) throw new Error(`${autostartScript()} is missing. Run \`nookdeck service install\` again.`);
  const pid = procOf(d).spawn(["/bin/sh", autostartScript()]);
  await mkdir(dirname(autostartPidFile()), { recursive: true });
  await writeFile(autostartPidFile(), `${pid}\n`);
}

async function autostartStop(d: ServiceDeps): Promise<void> {
  const pid = await autostartPid(d);
  if (pid) procOf(d).kill(pid);
  await rm(autostartPidFile(), { force: true });
}

async function linuxInstall(d: ServiceDeps, port?: number): Promise<{ plist: string; loaded: boolean }> {
  const spec = linuxSpec(d, port);
  await mkdir(logsDir(), { recursive: true, mode: 0o700 });
  const sc = sysctl(d);
  if (await useSystemdUnit(d)) {
    const file = unitPath();
    await mkdir(dirname(file), { recursive: true });
    const oldText = await readFile(file, "utf8").catch(() => null);
    // an agent from an earlier autostart install holds the port: stop it first, so there are never two
    const hadAutostart = await exists(autostartPath());
    if (hadAutostart) await autostartStop(d);
    await writeFile(file, buildUnit(spec), { mode: 0o644 });
    await chmod(file, 0o644);
    // enable for the next logins, restart (not just start) so a reinstall runs the new program and port now
    let r = await sc(["daemon-reload"]);
    if (r.code === 0) r = await sc(["enable", unitName()]);
    if (r.code === 0) r = await sc(["restart", unitName()]);
    if (r.code !== 0) {
      let back = "";
      if (oldText !== null) {
        await writeFile(file, oldText, { mode: 0o644 });
        await sc(["daemon-reload"]);
        const b = await sc(["restart", unitName()]);
        back = b.code === 0 ? " The previous service was started again." : ` The previous service could not be started again either (${b.code}).`;
      } else {
        // a first install leaves nothing behind (not even an enabled unit that would start at the next login)
        await sc(["disable", unitName()]);
        await rm(file, { force: true });
        await sc(["daemon-reload"]);
        if (hadAutostart) { await autostartStart(d).catch(() => {}); back = " The previous autostart agent was started again."; }
      }
      throw new Error(`systemctl --user failed (${r.code}): ${r.out || "no output"}.${back}`);
    }
    // the autostart entry would start a second agent at login
    if (hadAutostart) { await rm(autostartPath(), { force: true }); await rm(autostartScript(), { force: true }); }
    d.log(`Service installed: ${file}`);
    return { plist: file, loaded: true };
  }
  // a unit from an earlier install (the desktop changed, or no graphical session now): stop and remove it first, never two agents
  if (await exists(unitPath())) {
    await sc(["disable", "--now", unitName()]);
    await rm(unitPath(), { force: true });
    await sc(["daemon-reload"]);
  }
  const file = autostartPath();
  await mkdir(dirname(file), { recursive: true });
  await mkdir(dirname(autostartScript()), { recursive: true });
  await writeFile(autostartScript(), buildAutostartScript(spec), { mode: 0o700 });
  await chmod(autostartScript(), 0o700);
  await writeFile(file, buildDesktopEntry(autostartScript()), { mode: 0o644 });
  await autostartStop(d); // a reinstall runs the new program and port now
  await autostartStart(d);
  d.log(`Installed an autostart entry (${file}): this desktop does not start graphical-session.target, or there is no systemd user session. The agent starts when you sign in to the desktop.`);
  return { plist: file, loaded: true };
}

async function linuxUninstall(d: ServiceDeps): Promise<{ removed: boolean }> {
  let removed = false;
  if (await exists(unitPath())) {
    const sc = sysctl(d);
    await sc(["disable", "--now", unitName()]);
    await rm(unitPath(), { force: true });
    await sc(["daemon-reload"]);
    d.log(`Service removed: ${unitPath()}`);
    removed = true;
  }
  if (await exists(autostartPath())) {
    await autostartStop(d);
    await rm(autostartPath(), { force: true });
    await rm(autostartScript(), { force: true });
    d.log(`Autostart entry removed: ${autostartPath()}`);
    removed = true;
  }
  if (!removed) d.log("Service was not installed.");
  return { removed };
}

/** Which kind is installed: the systemd unit wins over an autostart entry. */
async function linuxKind(): Promise<"systemd" | "autostart" | null> {
  if (await exists(unitPath())) return "systemd";
  if (await exists(autostartPath())) return "autostart";
  return null;
}

const NOT_INSTALLED = "The service is not installed. Run `nookdeck service install`.";

async function linuxCtl(d: ServiceDeps, verb: "start" | "stop" | "restart"): Promise<void> {
  const kind = await linuxKind();
  if (!kind) throw new Error(NOT_INSTALLED);
  if (kind === "systemd") {
    const r = await sysctl(d)([verb, unitName()]);
    if (r.code !== 0) throw new Error(`systemctl --user ${verb} failed (${r.code}): ${r.out || "no output"}`);
  } else {
    if (verb !== "start") await autostartStop(d);
    if (verb !== "stop") await autostartStart(d);
  }
  d.log(verb === "start" ? "Service started." : verb === "stop" ? "Service stopped." : "Service restarted.");
}

/** `systemctl --user show -p ActiveState -p MainPID` output -> running state and pid. */
export function parseShow(out: string): { running: boolean; pid?: number } {
  const state = /^ActiveState=(\S+)/m.exec(out)?.[1];
  const pid = Number(/^MainPID=(\d+)/m.exec(out)?.[1] ?? 0);
  return { running: state === "active" || state === "activating" || state === "reloading", ...(pid > 0 ? { pid } : {}) };
}

/** The first word of ExecStart, unquoted. */
const unitProgram = (text: string): string | undefined => {
  const m = /^ExecStart="((?:[^"\\]|\\.)*)"/m.exec(text);
  return m ? m[1]!.replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$") : undefined;
};

async function linuxStatus(d: ServiceDeps): Promise<ServiceStatus> {
  const kind = await linuxKind();
  if (kind === "systemd") {
    const text = await readFile(unitPath(), "utf8").catch(() => "");
    const program = unitProgram(text);
    const r = await sysctl(d)(["show", unitName(), "-p", "ActiveState", "-p", "MainPID"]);
    return { installed: true, kind, ...(r.code === 0 ? parseShow(r.out) : { running: false }), plist: unitPath(), ...(program ? { program } : {}) };
  }
  if (kind === "autostart") {
    const line = (await readFile(autostartScript(), "utf8").catch(() => "")).split("\n").find((l) => l.startsWith("exec env ")) ?? "";
    // the words are single-quoted: env assignments (NAME=...) first, then the program
    const words = [...line.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1]!.replace(/'\\''/g, "'"));
    const program = words.find((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
    const pid = await autostartPid(d);
    return { installed: true, kind, running: !!pid, ...(pid ? { pid } : {}), plist: autostartPath(), ...(program ? { program } : {}) };
  }
  return { installed: false, running: false, plist: unitPath() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * launchctl bootout returns BEFORE launchd has finished unloading the job; a bootstrap right after it fails with
 * "5: Input/output error". So: bootout, then wait until `launchctl print` no longer finds the job (100 ms steps, 5 s at most).
 */
export async function unloadJob(d: ServiceDeps, tgt: string = target(d)): Promise<void> {
  const r = await d.launchctl(["bootout", tgt]);
  if (r.code !== 0) return; // it was not loaded
  const end = Date.now() + (d.timing?.unloadMs ?? 5000);
  while (Date.now() < end) {
    if ((await d.launchctl(["print", tgt])).code !== 0) return;
    await sleep(d.timing?.pollMs ?? 100);
  }
}

/**
 * Loads the plist. An EIO (code 5) is retried with back-off (3 retries); when the job turns out to be loaded anyway it is kicked
 * instead (`kickstart -k` restarts it, `kickstart` alone only starts it when `restart` is false). Returns the last result.
 */
async function loadJob(d: ServiceDeps, file: string, restart = true): Promise<{ code: number; out: string }> {
  const back = d.timing?.backoffMs ?? [300, 800, 1500];
  for (let i = 0; ; i++) {
    const r = await d.launchctl(["bootstrap", domain(d), file]);
    if (r.code === 0) return r;
    if ((await d.launchctl(["print", target(d)])).code === 0) {
      const k = await d.launchctl(["kickstart", ...(restart ? ["-k"] : []), target(d)]);
      if (k.code === 0) return k;
    }
    if (!(r.code === 5 || /Input\/output error/i.test(r.out)) || i >= back.length) return r;
    await sleep(back[i]!);
  }
}

/** Writes the plist and (re)loads it: bootout, wait until it is gone, bootstrap (with retries). The agent starts at once (RunAtLoad). A failure puts the old plist back and loads it, so the agent is never left stopped. */
export async function serviceInstall(d: ServiceDeps, opts: { port?: number } = {}): Promise<{ plist: string; loaded: boolean }> {
  needMac(d);
  if (d.platform === "win32") return { plist: (await winInstall(winCtx(d, opts.port))).launcher, loaded: true };
  if (d.platform === "linux") return linuxInstall(d, opts.port);
  const args = [...d.program];
  if (opts.port !== undefined && opts.port !== 7420) args.push("--port", String(opts.port));
  const env: Record<string, string> = {};
  if (process.env.NOOKDECK_HOME) env.NOOKDECK_HOME = process.env.NOOKDECK_HOME;
  if (SERVICE_LABEL !== DEFAULT_SERVICE_LABEL) env.NOOKDECK_SERVICE_LABEL = SERVICE_LABEL; // the agent it starts must know its own label (doctor)
  const file = plistPath();
  await mkdir(dirname(file), { recursive: true });
  await mkdir(logsDir(), { recursive: true, mode: 0o700 });
  const oldText = await readFile(file, "utf8").catch(() => null);
  await writeFile(file, buildPlist({ args, env }), { mode: 0o644 });
  await chmod(file, 0o644);
  await unloadJob(d);
  const r = await loadJob(d, file);
  if (r.code !== 0) {
    let back = "";
    if (oldText !== null) {
      await writeFile(file, oldText, { mode: 0o644 });
      const b = await loadJob(d, file);
      back = b.code === 0 ? " The previous service was loaded again." : ` The previous service could not be loaded again either (${b.code}).`;
    }
    throw new Error(`launchctl bootstrap failed (${r.code}): ${r.out || "no output"}.${back}`);
  }
  d.log(`Service installed: ${file}`);
  return { plist: file, loaded: true };
}

export async function serviceUninstall(d: ServiceDeps): Promise<{ removed: boolean }> {
  needMac(d);
  if (d.platform === "win32") return winUninstall(winCtx(d));
  if (d.platform === "linux") return linuxUninstall(d);
  const file = plistPath();
  const had = await stat(file).then(() => true, () => false);
  await unloadJob(d);
  if (had) await rm(file, { force: true });
  d.log(had ? `Service removed: ${file}` : "Service was not installed.");
  return { removed: had };
}

export async function serviceRestart(d: ServiceDeps): Promise<void> {
  needMac(d);
  if (d.platform === "win32") return winRestart(winCtx(d));
  if (d.platform === "linux") return linuxCtl(d, "restart");
  if (!(await stat(plistPath()).then(() => true, () => false))) throw new Error("The service is not installed. Run `nookdeck service install`.");
  const r = await d.launchctl(["kickstart", "-k", target(d)]);
  if (r.code !== 0) {
    // not loaded (for example after a reboot with it booted out): load it again
    const b = await loadJob(d, plistPath());
    if (b.code !== 0) throw new Error(`launchctl kickstart failed (${r.code}): ${r.out || "no output"}`);
  }
  d.log("Service restarted.");
}

/** Stops the agent now; it starts again at the next sign-in (the service stays installed). The menu bar / tray apps use this. */
export async function serviceStop(d: ServiceDeps): Promise<void> {
  needMac(d);
  if (d.platform === "win32") return winStopService(winCtx(d));
  if (d.platform === "linux") return linuxCtl(d, "stop");
  if (!(await stat(plistPath()).then(() => true, () => false))) throw new Error("The service is not installed. Run `nookdeck service install`.");
  await unloadJob(d); // not loaded is fine
  d.log("Service stopped.");
}

/** Starts the agent now (after `service stop`). */
export async function serviceStart(d: ServiceDeps): Promise<void> {
  needMac(d);
  if (d.platform === "win32") return winStartService(winCtx(d));
  if (d.platform === "linux") return linuxCtl(d, "start");
  if (!(await stat(plistPath()).then(() => true, () => false))) throw new Error("The service is not installed. Run `nookdeck service install`.");
  const r = await loadJob(d, plistPath(), false); // already loaded is fine: it is kicked so it runs
  if (r.code !== 0) throw new Error(`launchctl bootstrap failed (${r.code}): ${r.out || "no output"}`);
  d.log("Service started.");
}

export interface ServiceStatus { installed: boolean; running: boolean; pid?: number; plist: string; program?: string; /** Linux: what starts it */ kind?: "systemd" | "autostart" }

/** `launchctl print` output -> running state and pid. */
export function parsePrint(out: string): { running: boolean; pid?: number } {
  const pid = /^\s*pid = (\d+)/m.exec(out)?.[1];
  const state = /^\s*state = (\w+)/m.exec(out)?.[1];
  return { running: state === "running" || pid !== undefined, ...(pid ? { pid: Number(pid) } : {}) };
}

export async function serviceStatus(d: ServiceDeps): Promise<ServiceStatus> {
  needMac(d);
  if (d.platform === "win32") return winStatus(winCtx(d));
  if (d.platform === "linux") return linuxStatus(d);
  const file = plistPath();
  const text = await readFile(file, "utf8").catch(() => null);
  const program = text ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)?.[1] : undefined;
  if (text === null) return { installed: false, running: false, plist: file };
  const r = await d.launchctl(["print", target(d)]);
  return { installed: true, ...(r.code === 0 ? parsePrint(r.out) : { running: false }), plist: file, ...(program ? { program } : {}) };
}

export function formatStatus(s: ServiceStatus): string {
  if (!s.installed) return "Service: not installed (run `nookdeck service install`)";
  const where = s.plist.endsWith(".vbs") ? "Launcher:" : s.kind === "systemd" ? "Unit:    " : s.kind === "autostart" ? "Entry:   " : "Plist:   ";
  return `Service: installed${s.kind ? ` (${s.kind})` : ""}, ${s.running ? `running${s.pid ? ` (pid ${s.pid})` : ""}` : "not running"}\n${where} ${s.plist}${s.program ? `\nProgram: ${s.program}` : ""}`;
}

// ---------- hooks that point at an older binary ----------

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** `'<exe>'` for the compiled binary, `'<bun>' '<index.ts>'` from source (same convention as hookCommand). */
const programWords = (program: string[]) => program.map((p) => shq(platform.hookPath(p))).join(" ");

/** Swaps the program part of one of our hook commands: `<old program> hook <tool>[args] # marker` keeps everything after `hook`. */
export function repointCommand(command: string, program: string[]): string | null {
  const m = /^(.*?) hook (claude-ask|claude|codex)(.*)$/s.exec(command);
  if (!m) return null;
  const next = `${programWords(program)} hook ${m[2]}${m[3].replace("# phonedesk hook", "# nookdeck hook")}`;
  return next === command ? null : next;
}

export interface Instance { port: number; home: string }

const DEFAULT_PORT = 7420;
const unq = (v: string) => (v.startsWith("'") ? v.slice(1, -1).replace(/'\\''/g, "'") : v);

/** The instance a hook command belongs to: its --port and --home, defaults included (what hookCommand leaves out). */
export function commandInstance(command: string, defaultHome: string = join(userHome(), ".nookdeck")): Instance {
  const port = /\s--port[ =](\d+)/.exec(command)?.[1];
  const home = /\s--home[ =]('(?:[^']|'\\'')*'|\S+)/.exec(command)?.[1];
  return { port: port ? Number(port) : DEFAULT_PORT, home: resolve(home ? unq(home) : defaultHome) };
}

export const sameInstance = (a: Instance, b: Instance): boolean => a.port === b.port && resolve(a.home) === resolve(b.home);

/** The instance this process serves: NOOKDECK_HOME (or ~/.nookdeck) and the given port (default 7420). */
export const currentInstance = (port?: number): Instance => ({ port: port ?? (Number(process.env.NOOKDECK_PORT) || DEFAULT_PORT), home: resolve(HOME) });

/**
 * Which hook files this process may touch. With a non-default NOOKDECK_HOME (a test or second instance) and no explicit
 * NOOKDECK_CLAUDE_DIR / NOOKDECK_CODEX_DIR, the real ~/.claude and ~/.codex are left alone and a note says so.
 */
export function hookTargets(files: Partial<Record<HookTool, string>> = {}): { files: Partial<Record<HookTool, string>>; skipped: string[]; notes: string[] } {
  const sandboxed = resolve(HOME) !== resolve(join(userHome(), ".nookdeck"));
  const out: Partial<Record<HookTool, string>> = {};
  const skipped: string[] = [];
  const notes: string[] = [];
  for (const [tool, envName] of [["claude", "NOOKDECK_CLAUDE_DIR"], ["codex", "NOOKDECK_CODEX_DIR"]] as const) {
    if (files[tool]) { out[tool] = files[tool]; continue; }
    if (sandboxed && !process.env[envName]) {
      skipped.push(tool);
      notes.push(`NOOKDECK_HOME is not the default and ${envName} is not set: leaving the ${tool} hooks (${hookConfigPath(tool)}) alone.`);
      continue;
    }
    out[tool] = hookConfigPath(tool);
  }
  return { files: out, skipped, notes };
}

/**
 * After an upgrade the binary may live somewhere else. Re-points our installed Claude/Codex hooks (found by their marker;
 * other hooks are never touched) at `program`, but ONLY hooks that belong to this instance: the same --port and --home
 * (defaults included). Hooks of another instance are left as they are. A backup `<file>.nookdeck.bak` is written first.
 */
export async function repointHooks(files: Partial<Record<HookTool, string>>, program: string[], instance: Instance = currentInstance(), defaultHome?: string): Promise<Array<{ file: string; changed: number }>> {
  const out: Array<{ file: string; changed: number }> = [];
  for (const tool of ["claude", "codex"] as const) {
    const file = files[tool];
    if (!file) continue;
    let data: any;
    try { data = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
    let changed = 0;
    for (const [event, marker] of [[HOOK_EVENT, HOOK_MARKER], [ASK_EVENT, ASK_MARKER]] as const) {
      for (const g of Array.isArray(data?.hooks?.[event]) ? data.hooks[event] : []) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          if (typeof h?.command !== "string" || !(h.command.includes(marker) || h.command.includes(marker === HOOK_MARKER ? LEGACY_HOOK_MARKER : LEGACY_ASK_MARKER))) continue;
          if (!sameInstance(commandInstance(h.command, defaultHome), instance)) continue;
          const next = repointCommand(h.command, program);
          if (next) { h.command = next; changed++; }
        }
      }
    }
    if (changed) {
      await copyFile(file, `${file}.nookdeck.bak`);
      await writeFile(file, JSON.stringify(data, null, 2) + "\n");
    }
    out.push({ file, changed });
  }
  return out;
}

/** Removes every Nookdeck hook entry (permission and question hooks) from the Claude and Codex configs, with a backup. */
export async function removeHooks(files: Partial<Record<HookTool, string>> = {}): Promise<Array<{ file: string; changed: boolean }>> {
  const t = hookTargets(files).files;
  const out: Array<{ file: string; changed: boolean }> = [];
  for (const [file, fns] of [[t.claude, [uninstallHook, uninstallAskHook]], [t.codex, [uninstallHook]]] as const) {
    if (!file) continue;
    let changed = false;
    for (const fn of fns) { try { changed = (await fn(file)).changed || changed; } catch { /* unreadable or not JSON: leave it alone */ } }
    out.push({ file, changed });
  }
  return out;
}
