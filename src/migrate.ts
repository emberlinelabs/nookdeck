import { userHome } from "./home";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile, appendFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { repointHooks, serviceInstall, unloadJob, plistPath, type ServiceDeps, type Instance } from "./service";
import type { HookTool } from "./hooks-install";

/**
 * The 0.1.x -> 0.2.0 rename (PhoneDesk -> Nookdeck). Runs on the first start of the new program, is idempotent (a second run
 * finds nothing to do and changes nothing) and never deletes user data: the old folder is kept (renamed on macOS/Linux, with a
 * symlink left at the old path; untouched with a MOVED.txt on Windows), changed files get a backup first.
 */
export const OLD_SERVICE_LABEL = "dev.phonedesk.agent";
export const OLD_TASK_NAME = "PhoneDesk";
export const OLD_FIREWALL_RULE = "PhoneDesk";
export const OLD_PATH_DIR = ".phonedesk\\bin";

export interface MigrateOptions {
  platform: NodeJS.Platform;
  /** The user's home folder (~). */
  home: string;
  /** Copy the data folder and fix PATH / ~/.local/bin (only for a default install, never for a custom NOOKDECK_HOME). */
  data: boolean;
  /** Install the new background service (launchd / Windows) and remove the old one. */
  service: boolean;
  svc: ServiceDeps;
  /** Windows: %LOCALAPPDATA% (the program lives in <it>\\PhoneDesk\\bin, now <it>\\Nookdeck\\bin). */
  winLocal?: string;
  /** The program the new service runs when there is no ~/.nookdeck/bin/nookdeck (running from source). */
  program: string[];
  /** Claude / Codex hook files to re-point (from hookTargets: empty in a sandbox). */
  hookFiles: Partial<Record<HookTool, string>>;
  instance: Instance;
  log?: (line: string) => void;
}

export interface MigrateResult { changed: string[]; notes: string[] }

const exists = (p: string) => lstat(p).then(() => true, () => false);
const isDir = (p: string) => lstat(p).then((s) => s.isDirectory() && !s.isSymbolicLink(), () => false);
const isLink = (p: string) => lstat(p).then((s) => s.isSymbolicLink(), () => false);

/** The alias `phonedesk` points at: runs the real program and says once, on a terminal, that the name changed. */
export const aliasScript = (win: boolean): string => win
  ? "@echo off\r\necho phonedesk is now called nookdeck. Run nookdeck from now on. 1>&2\r\n\"%~dp0nookdeck.exe\" %*\r\n"
  : `#!/bin/sh
# PhoneDesk is now Nookdeck: this keeps the old command working.
[ -t 2 ] && echo "phonedesk is now called nookdeck. Run nookdeck from now on." >&2
exec "$(dirname "$0")/nookdeck" "$@"
`;

async function writeIfDifferent(file: string, content: string, mode?: number): Promise<boolean> {
  if ((await readFile(file, "utf8").catch(() => null)) === content) return false;
  await writeFile(file, content);
  if (mode) await chmod(file, mode);
  return true;
}

export async function migrate(o: MigrateOptions): Promise<MigrateResult> {
  const changed: string[] = [];
  const notes: string[] = [];
  const say = (s: string) => { changed.push(s); o.log?.(s); };
  const win = o.platform === "win32";
  const oldHome = join(o.home, ".phonedesk");
  const newHome = join(o.home, ".nookdeck");
  const exeName = win ? "nookdeck.exe" : "nookdeck";
  const newExe = join(newHome, "bin", exeName);
  let hadOld = false;

  // 1. data: copy, then leave the old path pointing at the new one. The old copy is kept (renamed) so nothing can be lost.
  if (o.data) {
    const oldIsDir = await isDir(oldHome);
    hadOld = oldIsDir || (await isLink(oldHome));
    if (oldIsDir && !(await exists(newHome))) {
      const tmp = `${newHome}.migrating`;
      await rm(tmp, { recursive: true, force: true });
      await cp(oldHome, tmp, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      await rename(tmp, newHome);
      if (win) {
        await writeFile(join(oldHome, "MOVED.txt"), "Nookdeck (formerly PhoneDesk) now keeps its data in ~\\.nookdeck. This folder is the old copy and is no longer used; delete it when you are sure you do not need it.\r\n").catch(() => {});
      } else {
        await rename(oldHome, `${oldHome}.migrated`);
        await symlink(newHome, oldHome);
      }
      say(`copied ${oldHome} to ${newHome}${win ? "" : ` (the old folder is kept as ${basename(oldHome)}.migrated, ${basename(oldHome)} now points at the new one)`}`);
    }
  }

  // 2. the program: the old updater replaced bin/phonedesk with the new binary; it is called bin/nookdeck now, and phonedesk becomes an alias
  const bin = join(newHome, "bin");
  if (await isDir(bin)) {
    const oldExe = join(bin, win ? "phonedesk.exe" : "phonedesk");
    const alias = join(bin, win ? "phonedesk.cmd" : "phonedesk");
    if (!(await exists(newExe)) && (await exists(oldExe)) && !(await isScript(oldExe))) {
      await rename(oldExe, newExe);
      say(`${oldExe} is now ${newExe}`);
    }
    if ((await exists(newExe)) && (hadOld || (await exists(alias)))) {
      if (await writeIfDifferent(alias, aliasScript(win), 0o755)) say(`installed the phonedesk alias (${alias})`);
    }
  }
  let program = (await exists(newExe)) ? [newExe] : o.program;
  // Windows keeps the program under %LOCALAPPDATA%: copy it next to the new name (the old copy stays), alias beside it
  const winBin = win && o.winLocal ? join(o.winLocal, "Nookdeck", "bin") : null;
  if (winBin && o.service) {
    const oldBin = join(o.winLocal!, "PhoneDesk", "bin");
    const from = join(oldBin, "phonedesk.exe");
    if (!(await exists(join(winBin, exeName))) && (await exists(from))) {
      await mkdir(winBin, { recursive: true });
      await cp(from, join(winBin, exeName));
      say(`copied ${from} to ${join(winBin, exeName)}`);
    }
    if (await exists(join(winBin, exeName))) {
      program = [join(winBin, exeName)];
      if (await writeIfDifferent(join(winBin, "phonedesk.cmd"), aliasScript(true))) say("installed the phonedesk alias (phonedesk.cmd)");
    }
  }

  // 3. ~/.local/bin and the PATH line of the shell, unix only
  if (o.data && !win && (await isDir(newHome))) {
    const lb = join(o.home, ".local", "bin");
    if ((await isLink(join(lb, "phonedesk"))) && !(await exists(join(lb, "nookdeck"))) && (await exists(newExe))) {
      await symlink(newExe, join(lb, "nookdeck"));
      say(`added ${join(lb, "nookdeck")}`);
    }
    for (const rc of [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"]) {
      const f = join(o.home, rc);
      const text = await readFile(f, "utf8").catch(() => null);
      if (text === null || !/\.phonedesk\/bin/.test(text)) continue;
      await writeFile(`${f}.nookdeck.bak`, text);
      await writeFile(f, text.replace(/\.phonedesk\/bin/g, ".nookdeck/bin").replace(/# phonedesk\b/g, "# nookdeck"));
      say(`${f}: PATH now uses .nookdeck/bin (backup: ${f}.nookdeck.bak)`);
    }
  }

  // 4. Claude / Codex hooks that point at the old program (same port and home only; backup first)
  try {
    for (const r of await repointHooks(o.hookFiles, program, o.instance, newHome)) if (r.changed) say(`re-pointed ${r.changed} hook(s) in ${r.file} (backup: ${r.file}.nookdeck.bak)`);
  } catch (e: any) { notes.push(`hooks: ${String(e?.message ?? e)}`); }

  // 5. the background service, last: replacing the old launchd job can end this very process (it may be that job)
  if (o.service) {
    try {
      if (win) await migrateWindows(o, program, newHome, say, notes);
      else await migrateLaunchd(o, program, say);
    } catch (e: any) { notes.push(`service: ${String(e?.message ?? e)}`); }
  }

  if (changed.length) {
    try {
      const dir = (await isDir(newHome)) ? newHome : null;
      if (dir) { await mkdir(join(dir, "logs"), { recursive: true }); await appendFile(join(dir, "logs", "migration.log"), `${new Date().toISOString()}\n${changed.map((c) => `  ${c}`).join("\n")}\n`); }
    } catch { /* the log is a courtesy */ }
  }
  return { changed, notes };
}

async function isScript(file: string): Promise<boolean> {
  try { const b = await readFile(file); return b.length < 4096 && b.subarray(0, 2).toString() === "#!"; } catch { return false; }
}

async function migrateLaunchd(o: MigrateOptions, program: string[], say: (s: string) => void) {
  const dir = dirname(plistPath());
  const oldPlist = join(dir, `${OLD_SERVICE_LABEL}.plist`);
  const text = await readFile(oldPlist, "utf8").catch(() => null);
  if (text === null) return;
  const port = Number(/--port<\/string>\s*<string>(\d+)<\/string>/.exec(text)?.[1]) || undefined;
  // the new job first, then the old one goes (booting the old one out may stop this process: everything else is already done)
  await serviceInstall({ ...o.svc, program }, { port });
  await rm(oldPlist, { force: true });
  say(`replaced the launchd service ${OLD_SERVICE_LABEL} with dev.nookdeck.agent`);
  await unloadJob(o.svc, `gui/${o.svc.uid}/${OLD_SERVICE_LABEL}`);
}

async function migrateWindows(o: MigrateOptions, program: string[], newHome: string, say: (s: string) => void, notes: string[]) {
  const { winServiceCtxFrom } = await import("./service");
  const { winInstall } = await import("./platform/win32/service");
  const { runCode } = await import("./platform/exec");
  // the real service deps carry no runner: the Windows one is the usual schtasks / reg / powershell caller
  const run = o.svc.winRun ?? ((argv: string[]) => runCode(argv, 15_000));
  const rule = (name: string) => ["netsh", "advfirewall", "firewall", "show", "rule", `name=${name}`];
  const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

  // startup entry
  const hadTask = (await run(["schtasks", "/Query", "/TN", OLD_TASK_NAME, "/FO", "LIST"])).code === 0;
  const hadRun = (await run(["reg", "query", RUN_KEY, "/v", OLD_TASK_NAME])).code === 0;
  if (hadTask || hadRun) {
    await run(["schtasks", "/End", "/TN", OLD_TASK_NAME]);
    await run(["schtasks", "/Delete", "/TN", OLD_TASK_NAME, "/F"]);
    await run(["reg", "delete", RUN_KEY, "/v", OLD_TASK_NAME, "/f"]);
    await winInstall(winServiceCtxFrom({ ...o.svc, program }));
    say("replaced the PhoneDesk startup entry with Nookdeck");
  }

  // firewall: the old inbound rule goes (when it cannot be removed, the exact command is printed); the new one is added unless it exists
  if ((await run(rule(OLD_FIREWALL_RULE))).code === 0) {
    const d = await run(["netsh", "advfirewall", "firewall", "delete", "rule", `name=${OLD_FIREWALL_RULE}`]);
    if (d.code === 0) say(`removed the old firewall rule "${OLD_FIREWALL_RULE}"`);
    else notes.push(`firewall: the old rule "${OLD_FIREWALL_RULE}" needs administrator rights to remove. Run as administrator: netsh advfirewall firewall delete rule name="${OLD_FIREWALL_RULE}"   (or in PowerShell: Remove-NetFirewallRule -DisplayName "${OLD_FIREWALL_RULE}")`);
    if ((await run(rule("Nookdeck"))).code !== 0) {
      const a = await run(["netsh", "advfirewall", "firewall", "add", "rule", "name=Nookdeck", "dir=in", "action=allow", `program=${program[0]}`, "profile=any", "remoteip=localsubnet"]);
      if (a.code === 0) say("added the firewall rule Nookdeck");
      else notes.push(`firewall: run as administrator: netsh advfirewall firewall add rule name="Nookdeck" dir=in action=allow program="${program[0]}" profile=any remoteip=localsubnet`);
    }
  }

  // user PATH: the old bin folder goes; the new one takes its place unless it is there already (no duplicates)
  const local = o.winLocal ?? process.env.LOCALAPPDATA ?? "";
  const oldBin = `${local}\\PhoneDesk\\bin`, newBin = `${local}\\Nookdeck\\bin`;
  const q = (x: string) => x.replace(/'/g, "''");
  const script = `$o='${q(oldBin)}'; $n='${q(newBin)}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){return}; $parts=@($p -split ';' | Where-Object { $_ -ne '' }); if(-not ($parts | Where-Object { $_.TrimEnd('\\') -ieq $o })){return}; $out=@(); $seen=$false; foreach($x in $parts){ if($x.TrimEnd('\\') -ieq $o){ if(-not $seen){$out+=$n; $seen=$true} } elseif($x.TrimEnd('\\') -ieq $n){ if(-not $seen){$out+=$x; $seen=$true} } else { $out+=$x } }; [Environment]::SetEnvironmentVariable('Path',($out -join ';'),'User'); 'changed'`;
  const r = await run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]);
  if (/changed/.test(r.out)) say(`PATH: removed ${oldBin} (${newBin} is used instead)`);
}

/**
 * The real thing, for index.ts and `nookdeck migrate`: this machine's home, this process's NOOKDECK_HOME. A custom
 * NOOKDECK_HOME (a second instance, a test) keeps its data where it is and leaves services and the real hook files alone,
 * unless the matching NOOKDECK_* override is set. NOOKDECK_INSTALL_HOME (setup.sh --home relocation) names another home folder.
 */
export async function migrateFromEnv(port: number, log: (l: string) => void, o: { service?: boolean } = {}): Promise<MigrateResult> {
  const { resolve } = await import("node:path");
  const { HOME } = await import("./config");
  const { platform } = await import("./platform");
  const svc = await import("./service");
  const home = process.env.NOOKDECK_INSTALL_HOME ?? userHome();
  const isDefault = resolve(HOME) === resolve(join(home, ".nookdeck"));
  const serviceOk = isDefault || !!process.env.NOOKDECK_LAUNCH_AGENTS_DIR || !!process.env.NOOKDECK_WIN_DIR;
  return migrate({
    platform: platform.id, home, winLocal: process.env.LOCALAPPDATA, data: isDefault, service: o.service !== false && serviceOk && (platform.id === "darwin" || platform.id === "win32"),
    svc: svc.realServiceDeps(() => {}), program: svc.defaultProgram(), hookFiles: svc.hookTargets().files, instance: svc.currentInstance(port), log,
  });
}
