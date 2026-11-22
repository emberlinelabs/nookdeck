/**
 * `nookdeck install [--port N] [--yes] [--force] [--open]`: puts the RUNNING binary in its stable place and registers the background
 * service from there. For a Homebrew install (the binary sits at a versioned Cellar path that changes on every upgrade, and macOS
 * keys Accessibility by path), but it works from any copy. Run it again after `brew upgrade`: it replaces the stable copy and restarts.
 *
 *   macOS    ~/.nookdeck/bin/nookdeck             (the place setup.sh uses)
 *   Windows  %LOCALAPPDATA%\Nookdeck\bin\nookdeck.exe   (the place setup.ps1 uses)
 *
 * The copy is byte for byte (the signature stays valid; no re-sign), replaced atomically. `migrate --no-service` and `service install`
 * run FROM the stable copy, so the plist / task points at the stable path.
 */
import { userHome } from "./home";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { cmpVersions, currentVersion } from "./update";

export interface InstallDeps {
  platform: "darwin" | "win32" | string;
  execPath: string;
  /** NOOKDECK_INSTALL_HOME or the user's home; the data folder is <home>/.nookdeck. */
  home: string;
  /** Windows: %LOCALAPPDATA%. NOOKDECK_INSTALL_HOME relocates it to <home>/bin like setup.ps1 does (tests). */
  winLocal?: string;
  relocated?: boolean;
  /** This program's version. */
  version: string;
  /** Runs a program (the stable copy) and returns its exit code and output. */
  run(argv: string[]): Promise<{ code: number; out: string }>;
  /** What the agent on `port` says its version is (null: it does not answer). */
  agentVersion(port: number): Promise<string | null>;
  /** The pairing data of the agent on `port`. */
  pairing(port: number): Promise<{ pin: string; addresses: { host: string; label: string }[]; port: number } | null>;
  /** Stops the service so a Windows exe can be replaced (a no-op elsewhere). */
  stopService?(): Promise<void>;
  /** Yes/no question to the person at the terminal (only asked on a TTY without --yes). */
  ask?(question: string): Promise<boolean>;
  open?(url: string): Promise<void>;
  log: (line: string) => void;
  /** Wait for the agent after the install (ms; tests use a small value). */
  waitMs?: number;
}

export interface InstallOptions { port?: number; yes?: boolean; force?: boolean; open?: boolean }
export type InstallResult = { status: "installed" | "updated" | "unchanged" | "refused"; stable: string; reason?: string };

/** Where the stable copy lives. */
export function stablePath(d: Pick<InstallDeps, "platform" | "home" | "winLocal" | "relocated">): string {
  // `join` is the host's own: backslashes on Windows, where this branch really runs
  if (d.platform === "win32") return d.relocated ? join(d.home, "bin", "nookdeck.exe") : join(d.winLocal ?? join(d.home, "AppData", "Local"), "Nookdeck", "bin", "nookdeck.exe");
  return join(d.home, ".nookdeck", "bin", "nookdeck");
}

/** A program under a package manager's prefix: its path changes with every upgrade. */
export function packageManaged(execPath: string): boolean {
  const p = execPath.replace(/\\/g, "/");
  return /\/Cellar\//.test(p) || /^\/opt\/homebrew\//.test(p) || /^\/usr\/local\//.test(p) || /^\/home\/linuxbrew\//.test(p);
}

export const BREW_NOTE = "After `brew upgrade nookdeck`, run `nookdeck install` again";
const MARKER = ".installed-by";

/** A copy that `nookdeck install` made from a Homebrew binary says so next to itself; `nookdeck update` then points at brew. */
export async function brewManaged(execPath: string): Promise<boolean> {
  if (/\/Cellar\//.test(execPath.replace(/\\/g, "/"))) return true;
  const m = await readFile(join(dirname(execPath), MARKER), "utf8").catch(() => "");
  return m.startsWith("homebrew");
}

const sha = async (f: string): Promise<string | null> => readFile(f).then((b) => createHash("sha256").update(b).digest("hex"), () => null);

export async function runInstall(d: InstallDeps, o: InstallOptions = {}): Promise<InstallResult> {
  const stable = stablePath(d);
  // everything (the copy, the marker) is written next to `stable`: it must be an absolute path, never "" or a bare name (that would be the cwd)
  if (!d.home || !isAbsolute(stable) || !isAbsolute(dirname(stable))) return { status: "refused", stable, reason: "the install folder could not be worked out (no home folder). Nothing was changed." };
  const refuse = (reason: string): InstallResult => { d.log(reason); return { status: "refused", stable, reason }; };
  if (d.platform !== "darwin" && d.platform !== "win32") return refuse("nookdeck install is for macOS and Windows. On Linux run `nookdeck` in a terminal.");
  if (/^bun(\.exe)?$/i.test(basename(d.execPath))) return refuse("This copy runs from source (bun). Install a release with setup.sh / setup.ps1, or use `nookdeck service install`.");
  const sameFile = resolve(d.execPath) === resolve(stable) || (d.platform === "win32" && d.execPath.toLowerCase() === stable.toLowerCase());
  const brew = packageManaged(d.execPath);

  if (!o.yes && d.ask && !(await d.ask(`Install Nookdeck to ${stable} and start it at login?`))) return refuse("Cancelled. Nothing was changed.");

  // never go back to an older program unless asked
  const had = await stat(stable).then(() => true, () => false);
  let before: string | null = null;
  if (had && !sameFile) {
    const r = await d.run([stable, "--version"]);
    before = r.code === 0 ? /(\d+\.\d+\.\d+)/.exec(r.out)?.[1] ?? null : null;
    if (before && cmpVersions(d.version, before) < 0 && !o.force) return refuse(`${stable} is version ${before}, newer than this program (${d.version}). Nothing was changed. Use --force to go back.`);
  }

  let status: InstallResult["status"] = "unchanged";
  if (!sameFile) {
    const same = had && (await sha(d.execPath)) === (await sha(stable));
    if (!same) {
      if (had) await d.stopService?.().catch(() => {}); // a running Windows exe cannot be replaced
      await mkdir(dirname(stable), { recursive: true });
      const tmp = `${stable}.new-${process.pid}`;
      try {
        await copyFile(d.execPath, tmp); // bytes only: the code signature travels with them
        await chmod(tmp, 0o755);
        await rename(tmp, stable);
      } catch (e) { await rm(tmp, { force: true }); throw e; }
      status = had ? "updated" : "installed";
      d.log(`${had ? "Replaced" : "Installed"} ${stable} (${d.version})`);
    } else d.log(`${stable} is already this program`);
    // where it came from, so `nookdeck update` can say what to do
    if (brew) await writeFile(join(dirname(stable), MARKER), `homebrew\n${d.execPath}\n`).catch(() => {});
    else await rm(join(dirname(stable), MARKER), { force: true }).catch(() => {});
  } else d.log(`Running from ${stable} already`);

  const portArgs = o.port !== undefined && o.port !== 7420 ? ["--port", String(o.port)] : [];
  const step = async (label: string, argv: string[]): Promise<void> => {
    const r = await d.run([stable, ...argv]);
    if (r.code !== 0) throw new Error(`${label} failed (${r.code}): ${r.out.trim().slice(0, 300)}`);
    for (const l of r.out.split("\n").map((x) => x.trim()).filter(Boolean)) d.log(`  ${l}`);
  };
  await step("migrate", ["migrate", "--no-service", ...portArgs]); // 0.1.x data, hooks and the old service; safe to repeat
  await step("service install", ["service", "install", ...portArgs]); // (re)starts the agent from the stable copy

  const port = o.port ?? 7420;
  let seen: string | null = null;
  const deadline = Date.now() + (d.waitMs ?? 15_000);
  while (Date.now() < deadline) { seen = await d.agentVersion(port); if (seen) break; await new Promise((r) => setTimeout(r, Math.min(300, d.waitMs ?? 300))); }
  if (!seen) d.log(`Nookdeck was installed but nothing answers on port ${port} yet. Check ~/.nookdeck/logs/agent.err.log, or run: nookdeck service restart`);
  else {
    d.log(`Nookdeck ${seen} is running on port ${port}`);
    const p = await d.pairing(port);
    if (p) {
      d.log(`\nPairing PIN: ${p.pin}`);
      p.addresses.forEach((a, i) => d.log(`${i === 0 ? "Pair URL:    " : "             "}http://${a.host}:${p.port}/?pin=${p.pin}  (${a.label})`));
      d.log("");
    }
    if (o.open) await d.open?.(`http://localhost:${port}/manage/`);
  }
  if (brew) d.log(BREW_NOTE);
  return { status, stable };
}

/** The real dependencies (the CLI). */
export async function realInstallDeps(): Promise<InstallDeps> {
  const { platform } = await import("./platform");
  const svc = await import("./service");
  const relocated = !!process.env.NOOKDECK_INSTALL_HOME;
  const sd = svc.realServiceDeps(() => {});
  const getJson = async (port: number, path: string, ms: number): Promise<any> => {
    try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "x-nookdeck": "1" }, signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  return {
    platform: platform.id, execPath: process.execPath, home: process.env.NOOKDECK_INSTALL_HOME ?? userHome(), winLocal: process.env.LOCALAPPDATA, relocated,
    version: currentVersion(),
    run: async (argv) => {
      const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: process.env });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out: out + err };
    },
    agentVersion: async (port) => { const j = await getJson(port, "/api/about", 2000); return j?.version ? String(j.version) : null; },
    pairing: async (port) => {
      const j = await getJson(port, "/api/pairing?all=1", 4000);
      return j?.pin ? { pin: String(j.pin), port: Number(j.port) || port, addresses: (j.addresses ?? []).map((a: any) => ({ host: String(a.host), label: String(a.label) })) } : null;
    },
    stopService: platform.id === "win32" ? async () => { if ((await svc.serviceStatus(sd)).installed) await svc.serviceStop(sd); } : undefined,
    ask: process.stdin.isTTY && process.stdout.isTTY ? async (q) => {
      process.stdout.write(`${q} [Y/n] `);
      for await (const line of console) return !/^\s*n/i.test(String(line));
      return true;
    } : undefined,
    open: async (url) => { await platform.runAction({ type: "open", target: url }); },
    log: (l) => console.log(l),
  };
}
