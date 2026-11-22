import "./_fetch";
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIN } from "./_os";
import { BREW_NOTE, brewManaged, packageManaged, runInstall, stablePath, type InstallDeps } from "../src/install";

const tmp = (p = "pd-inst-") => mkdtempSync(join(tmpdir(), p));

/** A brew-looking program: <root>/Cellar/nookdeck/<v>/bin/nookdeck */
function brewBin(version: string, bytes = `bin-${version}`): string {
  const dir = join(tmp(), "Cellar", "nookdeck", version, "bin");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "nookdeck");
  writeFileSync(f, bytes);
  chmodSync(f, 0o755);
  return f;
}

function deps(over: Partial<InstallDeps> = {}) {
  const home = tmp();
  const log: string[] = [];
  const runs: string[][] = [];
  const d: InstallDeps = {
    platform: "darwin", execPath: brewBin("0.3.1"), home, version: "0.3.1",
    run: async (argv) => { runs.push(argv); return { code: 0, out: argv.includes("--version") ? "nookdeck 0.3.0 (old)" : "done" }; },
    agentVersion: async () => "0.3.1",
    pairing: async () => ({ pin: "123456", port: 7420, addresses: [{ host: "192.168.1.5", label: "Wi-Fi" }, { host: "mac.local", label: "Computer name" }] }),
    log: (l) => log.push(l), waitMs: 50, ...over,
  };
  return { d, home, log, runs };
}

describe("nookdeck install", () => {
  test("a fresh install: stable copy (bytes, 0755), migrate then service install FROM the copy, PIN, brew reminder", async () => {
    const { d, home, log, runs } = deps();
    const r = await runInstall(d, { yes: true });
    const stable = join(home, ".nookdeck", "bin", "nookdeck");
    expect(r).toEqual({ status: "installed", stable });
    expect(readFileSync(stable, "utf8")).toBe("bin-0.3.1");
    if (!WIN) expect(statSync(stable).mode & 0o111).not.toBe(0); // Windows has no exec bit
    expect(runs).toEqual([[stable, "migrate", "--no-service"], [stable, "service", "install"]]);
    expect(readdirSync(join(home, ".nookdeck", "bin")).sort()).toEqual([".installed-by", "nookdeck"]); // no temp file left
    expect(readFileSync(join(home, ".nookdeck", "bin", ".installed-by"), "utf8")).toStartWith("homebrew");
    const text = log.join("\n");
    expect(text).toContain("Pairing PIN: 123456");
    expect(text).toContain("http://192.168.1.5:7420/?pin=123456  (Wi-Fi)");
    expect(text).toContain("http://mac.local:7420/?pin=123456");
    expect(text).toContain(BREW_NOTE);
  });

  test("again after `brew upgrade`: replaces the copy and restarts; the same bytes change nothing but still (re)register", async () => {
    const a = deps();
    await runInstall(a.d, { yes: true });
    // brew upgrade: a new version at a new Cellar path
    const up = deps({ home: a.home, execPath: brewBin("0.3.2"), version: "0.3.2" });
    const r = await runInstall(up.d, { yes: true });
    expect(r.status).toBe("updated");
    expect(readFileSync(r.stable, "utf8")).toBe("bin-0.3.2");
    expect(up.runs.map((x) => x.slice(1).join(" "))).toEqual(["--version", "migrate --no-service", "service install"]);
    // the same program again
    const same = deps({ home: a.home, execPath: up.d.execPath, version: "0.3.2", run: async (argv) => ({ code: 0, out: argv.includes("--version") ? "nookdeck 0.3.2" : "done" }) });
    const r2 = await runInstall(same.d, { yes: true });
    expect(r2.status).toBe("unchanged");
    expect(same.log.join("\n")).toContain("already this program");
  });

  test("never downgrades without --force", async () => {
    const a = deps();
    await runInstall(a.d, { yes: true });
    const old = deps({ home: a.home, execPath: brewBin("0.3.0"), version: "0.3.0", run: async (argv) => ({ code: 0, out: argv.includes("--version") ? "nookdeck 0.3.5 (x)" : "done" }) });
    const r = await runInstall(old.d, { yes: true });
    expect(r.status).toBe("refused");
    expect(r.reason).toContain("newer than this program");
    expect(readFileSync(r.stable, "utf8")).toBe("bin-0.3.1"); // untouched
    expect(old.runs.some((x) => x.includes("service"))).toBe(false);
    expect((await runInstall(old.d, { yes: true, force: true })).status).toBe("updated");
    expect(readFileSync(r.stable, "utf8")).toBe("bin-0.3.0");
  });

  test("the stable copy itself, a custom port, a failing step, a source run and Linux", async () => {
    // running from the stable path: no copy, still migrate + service install
    const home = tmp();
    const stable = stablePath({ platform: "darwin", home });
    mkdirSync(join(home, ".nookdeck", "bin"), { recursive: true });
    writeFileSync(stable, "me");
    const a = deps({ home, execPath: stable });
    expect((await runInstall(a.d, { yes: true, port: 7431 })).status).toBe("unchanged");
    expect(a.runs).toEqual([[stable, "migrate", "--no-service", "--port", "7431"], [stable, "service", "install", "--port", "7431"]]);
    expect(a.log.join("\n")).not.toContain(BREW_NOTE);
    // a failing service install is an error with the program's own words
    const bad = deps({ run: async (argv) => (argv.includes("service") ? { code: 1, out: "launchctl bootstrap failed" } : { code: 0, out: "" }) });
    await expect(runInstall(bad.d, { yes: true })).rejects.toThrow("service install failed (1): launchctl bootstrap failed");
    // from source / on Linux: refused, nothing written
    const src = deps({ execPath: "/Users/me/.bun/bin/bun" });
    expect((await runInstall(src.d, { yes: true })).status).toBe("refused");
    expect(existsSync(join(src.home, ".nookdeck"))).toBe(false);
    expect((await runInstall(deps({ platform: "linux" }).d, { yes: true })).status).toBe("refused");
  });

  test("asks on a terminal unless --yes; 'no' changes nothing", async () => {
    let asked = 0;
    const no = deps({ ask: async () => { asked++; return false; } });
    expect((await runInstall(no.d)).status).toBe("refused");
    expect(asked).toBe(1);
    expect(existsSync(join(no.home, ".nookdeck"))).toBe(false);
    const yes = deps({ ask: async () => { asked++; return true; } });
    await runInstall(yes.d, { yes: true });
    expect(asked).toBe(1); // --yes: not asked
  });

  test("no agent answering is a hint, not a failure; --open opens the manage page", async () => {
    const opened: string[] = [];
    const silent = deps({ agentVersion: async () => null });
    expect((await runInstall(silent.d, { yes: true })).status).toBe("installed");
    expect(silent.log.join("\n")).toContain("nothing answers on port 7420");
    const o = deps({ open: async (u) => { opened.push(u); } });
    await runInstall(o.d, { yes: true, open: true });
    expect(opened).toEqual(["http://localhost:7420/manage/"]);
    const q = deps({ open: async (u) => { opened.push(u); } });
    await runInstall(q.d, { yes: true });
    expect(opened.length).toBe(1); // not unless asked
  });

  test("Windows puts the copy in %LOCALAPPDATA%\\Nookdeck\\bin and stops the service first", async () => {
    expect(stablePath({ platform: "win32", home: join("C:", "Users", "me"), winLocal: join("C:", "Users", "me", "AppData", "Local") })).toBe(join("C:", "Users", "me", "AppData", "Local", "Nookdeck", "bin", "nookdeck.exe"));
    expect(stablePath({ platform: "win32", home: join("C:", "sandbox"), relocated: true })).toBe(join("C:", "sandbox", "bin", "nookdeck.exe"));
    expect(stablePath({ platform: "darwin", home: join("/Users", "me") })).toBe(join("/Users", "me", ".nookdeck", "bin", "nookdeck")); // host separators
    if (WIN) return;
    const order: string[] = [];
    const home = tmp();
    const w = deps({ platform: "win32", home, relocated: true, stopService: async () => { order.push("stop"); }, run: async (argv) => { order.push(argv.slice(1).join(" ")); return { code: 0, out: "" }; } });
    await runInstall(w.d, { yes: true });
    expect(order).toEqual(["migrate --no-service", "service install"]); // fresh: nothing to stop
    const w2 = deps({ platform: "win32", home, relocated: true, execPath: brewBin("0.3.9"), version: "0.3.9", stopService: async () => { order.push("stop"); }, run: async (argv) => { order.push(argv.slice(1).join(" ")); return { code: 0, out: argv.includes("--version") ? "nookdeck 0.3.1" : "" }; } });
    order.length = 0;
    await runInstall(w2.d, { yes: true });
    expect(order[0]).toBe("--version");
    expect(order[1]).toBe("stop"); // before the exe is replaced
  });

  test("brew detection: the Cellar path, the prefixes, and the marker next to a copy", async () => {
    expect(packageManaged("/opt/homebrew/Cellar/nookdeck/0.3.1/bin/nookdeck")).toBe(true);
    expect(packageManaged("/opt/homebrew/bin/nookdeck")).toBe(true);
    expect(packageManaged("/usr/local/bin/nookdeck")).toBe(true);
    expect(packageManaged("/Users/me/.nookdeck/bin/nookdeck")).toBe(false);
    expect(await brewManaged("/opt/homebrew/Cellar/nookdeck/0.3.1/bin/nookdeck")).toBe(true);
    const a = deps();
    const r = await runInstall(a.d, { yes: true });
    expect(await brewManaged(r.stable)).toBe(true); // the copy carries the marker
    // a later non-brew install of the same place clears it
    const direct = deps({ home: a.home, execPath: (() => { const f = join(tmp(), "nookdeck"); writeFileSync(f, "release-0.4"); return f; })(), version: "0.4.0", run: async (argv) => ({ code: 0, out: argv.includes("--version") ? "nookdeck 0.3.1" : "" }) });
    await runInstall(direct.d, { yes: true });
    expect(await brewManaged(r.stable)).toBe(false);
  });

  test.skipIf(WIN)("through the real runner: the copied program is the one that is run", async () => {
    const { realInstallDeps } = await import("../src/install");
    const log = join(tmp(), "calls.log");
    const dir = join(tmp(), "Cellar", "nookdeck", "9.9.9", "bin");
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, "nookdeck");
    writeFileSync(exe, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "nookdeck 9.9.9 (test)"; exit 0; fi\necho "$0 $*" >> "${log}"\n`);
    chmodSync(exe, 0o755);
    const home = tmp();
    const real = await realInstallDeps();
    const keep = process.cwd();
    process.chdir(tmp("pd-cwd-"));
    const r = await runInstall({ ...real, execPath: exe, home, relocated: true, version: "9.9.9", agentVersion: async () => "9.9.9", pairing: async () => null, log: () => {}, ask: undefined }, { yes: true });
    const stable = join(home, ".nookdeck", "bin", "nookdeck");
    expect(r.stable).toBe(stable);
    process.chdir(keep);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([`${stable} migrate --no-service`, `${stable} service install`]);
  });
});

describe("nothing is written outside the install folder", () => {
  test("an empty or relative home is refused, and the suite leaves no marker in the cwd or the repo root", async () => {
    const cwd = tmp("pd-cwd-");
    const before = process.cwd();
    process.chdir(cwd);
    try {
      for (const home of ["", "relative/home"]) {
        const a = deps({ home });
        expect((await runInstall(a.d, { yes: true })).status).toBe("refused");
        expect(a.runs).toEqual([]);
      }
      expect(readdirSync(cwd)).toEqual([]);
    } finally { process.chdir(before); }
    const root = join(import.meta.dir, "..");
    expect(existsSync(join(root, ".installed-by"))).toBe(false);
    expect(existsSync(join(process.cwd(), ".installed-by"))).toBe(false);
  });
});

describe("a stripped environment", () => {
  test.skipIf(WIN)("doctor, config and the CLI import and run with no HOME at all", () => {
    const home = tmp();
    const env = { PATH: process.env.PATH!, NOOKDECK_HOME: home }; // no HOME, no USERPROFILE
    const r = Bun.spawnSync(["bun", "-e", `import("${join(import.meta.dir, "..", "src", "doctor.ts")}").then(()=>import("${join(import.meta.dir, "..", "src", "config.ts")}")).then(()=>console.log("imported"))`], { env, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).not.toContain("homedir");
    expect(r.stdout.toString().trim()).toBe("imported");
    const v = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "index.ts"), "--version"], { env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe" });
    expect(v.stdout.toString()).toStartWith("nookdeck ");
  });
});

describe("the stable copy is unchanged and the service already runs it", () => {
  test("a restart is used instead of a reinstall; anything else falls back to service install", async () => {
    const a = deps();
    await runInstall(a.d, { yes: true });
    const stable = join(a.home, ".nookdeck", "bin", "nookdeck");
    const mk = (status: string, restartCode = 0) => deps({
      home: a.home, execPath: a.d.execPath, version: "0.3.1",
      run: async (argv) => { runs2.push(argv.slice(1).join(" ")); return { code: argv[2] === "restart" ? restartCode : 0, out: argv.includes("--version") ? "nookdeck 0.3.1" : argv[2] === "status" ? status : "" }; },
    });
    let runs2: string[] = [];
    await runInstall(mk(`Service: installed, running\nProgram: ${stable}`).d, { yes: true });
    expect(runs2).toEqual(["--version", "migrate --no-service", "service status", "service restart"]);
    runs2 = [];
    await runInstall(mk(`Service: installed, running\nProgram: /somewhere/else`).d, { yes: true });
    expect(runs2.at(-1)).toBe("service install");
    runs2 = [];
    await runInstall(mk(`Service: installed, running\nProgram: ${stable}`, 1).d, { yes: true });
    expect(runs2.slice(-2)).toEqual(["service restart", "service install"]);
  });
});
