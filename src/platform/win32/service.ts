import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";

/**
 * The Windows background service: a per-user Task Scheduler task "Nookdeck" that runs at logon (no admin),
 * through a tiny hidden VBScript launcher (the compiled exe is a console program, so starting it directly would
 * flash a console window). Fallback: an HKCU Run value with the same launcher.
 */
export const TASK_NAME = "Nookdeck";
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export interface WinServiceCtx {
  /** Runs a program and returns its exit code and stdout+stderr (schtasks, reg, powershell). Never throws. */
  run: (argv: string[]) => Promise<{ code: number; out: string }>;
  /** Where launch.vbs lives (%LOCALAPPDATA%\Nookdeck). */
  dir: string;
  /** The agent's log dir (HOME\logs). */
  logDir: string;
  program: string[];
  env?: Record<string, string>;
  port?: number;
  /** This process id, never killed by stop(). */
  selfPid: number;
  log: (line: string) => void;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`; // a VBScript string literal
/** One argument for cmd.exe: quoted when it has spaces or cmd metacharacters. */
const cmdArg = (s: string) => (/[\s&|<>^()%!"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * The VBScript that starts the agent hidden: sets the env, then `cmd /s /c ""exe" args >> out.log 2>> err.log"`.
 * cmd (a console program) needs a console. Started bare, Windows 11 may hand that console to the default terminal app (Windows
 * Terminal), which ignores the hidden window style: an empty "cmd.exe" window that kills the agent when closed. There (build
 * 22000 and later) conhost.exe --headless hosts the console itself, with no window. conhost splits its command line again and
 * drops the quotes, so a path with a space (C:\Users\Tuan Long) broke the 0.7.0 launcher: the line goes into run.cmd next to
 * the launcher and conhost runs `cmd /d /c run.cmd` from that folder, a line with no path in it. Windows 10 has no
 * default-terminal handoff: the bare cmd, as before 0.7.0.
 */
export function buildLauncher(o: { program: string[]; env?: Record<string, string>; logDir: string; port?: number }): string {
  const args = [...o.program];
  if (o.port !== undefined && o.port !== 7420) args.push("--port", String(o.port));
  const line = `${args.map(cmdArg).join(" ")} >> ${cmdArg(join(o.logDir, "agent.out.log"))} 2>> ${cmdArg(join(o.logDir, "agent.err.log"))}`;
  const lines = ["' Starts Nookdeck without a console window. Written by `nookdeck service install`.", 'Set sh = CreateObject("WScript.Shell")'];
  for (const [k, v] of Object.entries({ NOOKDECK_SERVICE: "1", ...(o.env ?? {}) })) lines.push(`sh.Environment("Process")(${q(k)}) = ${q(v)}`);
  lines.push(...runLines(q(`cmd /s /c "${line}"`)));
  return lines.join("\r\n") + "\r\n";
}

/** The batch file the Windows 11 launcher writes and runs (its folder is the launcher's). */
export const RUN_CMD = "run.cmd";

/** Runs the cmd line (a VBScript string literal, `cmd /s /c "..."`) hidden: on Windows 11 through run.cmd under a headless conhost. */
function runLines(cmdLiteral: string): string[] {
  return [
    `c = ${cmdLiteral}`,
    "' Windows 11 may give cmd's console to Windows Terminal (a visible window): a headless conhost hosts it. conhost drops the quotes",
    `' around paths with spaces, so it runs ${RUN_CMD} from this folder. Windows 10 runs the bare cmd. Any error: the bare cmd.`,
    "b = 0",
    "On Error Resume Next",
    'b = CLng(sh.RegRead("HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\CurrentBuildNumber"))',
    "Err.Clear",
    "If b >= 22000 Then",
    '  Set fso = CreateObject("Scripting.FileSystemObject")',
    "  d = fso.GetParentFolderName(WScript.ScriptFullName)",
    `  Set f = fso.CreateTextFile(d & "\\${RUN_CMD}", True)`,
    '  f.WriteLine "@" & Mid(c, 12, Len(c) - 12)',
    "  f.Close",
    "  If Err.Number = 0 Then",
    "    sh.CurrentDirectory = d",
    `    c = "conhost.exe --headless cmd /d /c ${RUN_CMD}"`,
    "  End If",
    "End If",
    "On Error GoTo 0",
    "sh.Run c, 0, False",
  ];
}

export const launcherPath = (dir: string) => join(dir, "launch.vbs");

/**
 * A launcher written before 0.7.1 runs cmd bare (a Windows Terminal window on Windows 11) or, 0.7.0, under a headless conhost
 * with the paths on its command line (the agent never starts when a path has a space): the same text with the 0.7.1 run lines,
 * everything else (env, program, port, logs) kept. null when there is nothing to change.
 */
export function upgradeLauncher(text: string): string | null {
  if (text.includes(RUN_CMD)) return null;
  const m = /^sh\.Run "(?:conhost\.exe --headless )?(cmd \/s \/c .*)", 0, False$/m.exec(text);
  if (!m) return null;
  return text.replace(m[0], runLines(`"${m[1]}"`).join("\r\n"));
}

/** Upgrades launch.vbs in place before it is run (an update only restarts the service, it does not install it again). */
async function freshLauncher(c: Pick<WinServiceCtx, "dir" | "log">): Promise<void> {
  const file = launcherPath(c.dir);
  const text = await readFile(file, "utf8").catch(() => null);
  const next = text === null ? null : upgradeLauncher(text);
  if (next === null) return;
  await writeFile(file, next);
  c.log("Launcher updated: the agent starts without a console window, also when the user folder has a space.");
}

/** The task definition: at logon of this user, no admin, runs on battery, never times out, restarts after a crash. */
export function buildTaskXml(o: { user: string; launcher: string }): string {
  const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Nookdeck agent (turns a phone into a control panel for this PC)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${x(o.user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${x(o.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>//B //Nologo ${x(`"${o.launcher}"`)}</Arguments></Exec></Actions>
</Task>
`;
}

export const schtasksCreate = (xmlFile: string) => ["schtasks", "/Create", "/TN", TASK_NAME, "/XML", xmlFile, "/F"];
export const schtasksRun = () => ["schtasks", "/Run", "/TN", TASK_NAME];
export const schtasksEnd = () => ["schtasks", "/End", "/TN", TASK_NAME];
export const schtasksDelete = () => ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"];
export const schtasksQuery = () => ["schtasks", "/Query", "/TN", TASK_NAME, "/FO", "LIST"];
export const regAddRun = (launcher: string) => ["reg", "add", RUN_KEY, "/v", TASK_NAME, "/t", "REG_SZ", "/d", `wscript.exe //B //Nologo "${launcher}"`, "/f"];
export const regDeleteRun = () => ["reg", "delete", RUN_KEY, "/v", TASK_NAME, "/f"];
export const regQueryRun = () => ["reg", "query", RUN_KEY, "/v", TASK_NAME];

/** Stops our agent: every process running exactly this exe except the one asking (`nookdeck service ...` itself). */
export const stopAgentArgv = (exe: string, selfPid: number) => [
  "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
  `Get-Process | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' -and $_.Id -ne ${selfPid} } | Stop-Process -Force`,
];

/** `schtasks /Query /FO LIST` output: Status (Running / Ready / Disabled) and the next run. */
export function parseQuery(out: string): { running: boolean; state?: string } {
  const state = /^\s*Status:\s*(.+?)\s*$/m.exec(out)?.[1];
  return { running: !!state && /running/i.test(state), ...(state ? { state } : {}) };
}

export async function winInstall(c: WinServiceCtx): Promise<{ launcher: string; method: "task" | "run-key" }> {
  const launcher = launcherPath(c.dir);
  await mkdir(c.dir, { recursive: true });
  await mkdir(c.logDir, { recursive: true });
  await writeFile(launcher, buildLauncher({ program: c.program, env: c.env, logDir: c.logDir, port: c.port }));
  await winStop(c); // a running copy would keep the exe locked and the port busy
  const xmlFile = join(c.dir, "task.xml");
  const user = (await c.run(["whoami"])).out.trim() || "";
  // schtasks wants UTF-16 for the XML it declares as such
  await writeFile(xmlFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildTaskXml({ user, launcher }), "utf16le")]));
  let method: "task" | "run-key" = "task";
  const r = await c.run(schtasksCreate(xmlFile));
  if (r.code !== 0) {
    const k = await c.run(regAddRun(launcher));
    if (k.code !== 0) throw new Error(`could not create the scheduled task (${r.out || r.code}) or the Run entry (${k.out || k.code})`);
    method = "run-key";
  }
  await rm(xmlFile, { force: true });
  if (method === "task") {
    const s = await c.run(schtasksRun());
    if (s.code !== 0) c.log(`The task is installed but did not start now: ${s.out}`);
  } else {
    await c.run(["wscript.exe", "//B", "//Nologo", launcher]);
  }
  c.log(method === "task" ? `Service installed: scheduled task "${TASK_NAME}" (at logon)` : `Service installed: HKCU Run entry "${TASK_NAME}" (at logon)`);
  return { launcher, method };
}

/** Stops the agent now (the task stays installed and starts again at the next sign-in). */
export async function winStopService(c: WinServiceCtx): Promise<void> {
  if (!(await stat(launcherPath(c.dir)).then(() => true, () => false))) throw new Error("The service is not installed. Run `nookdeck service install`.");
  await winStop(c);
  c.log("Service stopped.");
}

/** Starts the agent now (the task, or the Run-key launcher). */
export async function winStartService(c: WinServiceCtx): Promise<void> {
  if (!(await stat(launcherPath(c.dir)).then(() => true, () => false))) throw new Error("The service is not installed. Run `nookdeck service install`.");
  await freshLauncher(c);
  const r = await c.run(schtasksRun());
  if (r.code !== 0) await c.run(["wscript.exe", "//B", "//Nologo", launcherPath(c.dir)]);
  c.log("Service started.");
}

async function winStop(c: WinServiceCtx) {
  await c.run(schtasksEnd());
  const exe = c.program[0]!;
  // from source the program is bun.exe: never kill every bun on the machine, ending the task is all we can do
  if (!/^bun(\.exe)?$/i.test(win32.basename(exe))) await c.run(stopAgentArgv(exe, c.selfPid));
}

export async function winUninstall(c: WinServiceCtx): Promise<{ removed: boolean }> {
  const launcher = launcherPath(c.dir);
  const had = (await stat(launcher).then(() => true, () => false)) || (await c.run(schtasksQuery())).code === 0;
  await winStop(c);
  await c.run(schtasksDelete());
  await c.run(regDeleteRun());
  await rm(launcher, { force: true });
  await rm(join(c.dir, RUN_CMD), { force: true });
  c.log(had ? "Service removed." : "Service was not installed.");
  return { removed: had };
}

export async function winRestart(c: WinServiceCtx): Promise<void> {
  if (!(await stat(launcherPath(c.dir)).then(() => true, () => false))) throw new Error("The service is not installed. Run `nookdeck service install`.");
  await winStop(c);
  await freshLauncher(c);
  const r = await c.run(schtasksRun());
  if (r.code !== 0) await c.run(["wscript.exe", "//B", "//Nologo", launcherPath(c.dir)]); // the Run-key variant
  c.log("Service restarted.");
}

export async function winStatus(c: Pick<WinServiceCtx, "run" | "dir">): Promise<{ installed: boolean; running: boolean; plist: string; program?: string; method?: string }> {
  const launcher = launcherPath(c.dir);
  const text = await readFile(launcher, "utf8").catch(() => null);
  if (text === null) return { installed: false, running: false, plist: launcher };
  const q1 = await c.run(schtasksQuery());
  const program = /cmd \/s \/c ""?([^"]+?)"?\s/.exec(text)?.[1];
  if (q1.code === 0) return { installed: true, running: parseQuery(q1.out).running, plist: launcher, method: "scheduled task", ...(program ? { program } : {}) };
  const k = await c.run(regQueryRun());
  return { installed: k.code === 0, running: false, plist: launcher, method: "Run key", ...(program ? { program } : {}) };
}

