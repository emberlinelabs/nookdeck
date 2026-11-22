import { WIN } from "./_os";
import "./_fetch";
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// R4: everything below lives in temp folders; the real home, ~/.claude and ~/.codex are never touched
const tmp = (p = "pd-mig-") => mkdtempSync(join(tmpdir(), p));
const { migrate, aliasScript } = await import("../src/migrate");
const { applyLegacyEnv } = await import("../src/compat");
const { localRequestError } = await import("../src/guard");
const { HOOK_MARKER, installHook, uninstallHook, installAskHook, uninstallAskHook, isHookInstalled } = await import("../src/hooks-install");
const { versionLine } = await import("../src/about");
const { sumFor } = await import("../src/update");

const OLD_HOOK = (home = "") => `'/h/.phonedesk/bin/phonedesk' hook claude${home} # phonedesk hook`;

function fakeInstall() {
  const home = tmp();
  const old = join(home, ".phonedesk");
  mkdirSync(join(old, "bin"), { recursive: true });
  mkdirSync(join(old, "sounds"));
  writeFileSync(join(old, "devices.json"), '{"devices":[{"id":"d1","tokenHash":"abc"}]}');
  writeFileSync(join(old, "layout.json"), '{"version":1}');
  writeFileSync(join(old, "hook-secret"), "s3cret");
  writeFileSync(join(old, "sounds", "a.mp3"), "snd");
  writeFileSync(join(old, "bin", "phonedesk"), "REAL-BINARY");
  const agents = join(home, "agents");
  mkdirSync(agents);
  writeFileSync(join(agents, "dev.phonedesk.agent.plist"), "<array><string>/x/phonedesk</string><string>--port</string><string>7421</string></array>");
  writeFileSync(join(home, ".zshrc"), 'export FOO=1\nexport PATH="$HOME/.phonedesk/bin:$PATH" # phonedesk\n');
  const claude = join(home, "claude-settings.json");
  const other = { type: "command", command: "echo mine" };
  writeFileSync(claude, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [other, { type: "command", command: OLD_HOOK(), timeout: 60 }] }] } }));
  const foreign = join(home, "other-instance.json");
  writeFileSync(foreign, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: OLD_HOOK(" --port 9999"), timeout: 60 }] }] } }));
  const calls: string[][] = [];
  const svc: any = { launchctl: async (a: string[]) => { calls.push(a); return { code: 0, out: "" }; }, uid: 501, platform: "darwin", program: ["/tmp/dl/nookdeck"], log: () => {}, timing: { unloadMs: 0, backoffMs: [] } };
  return { home, old, agents, claude, foreign, calls, svc };
}

describe.skipIf(WIN)("migration from 0.1.x (macOS)", () => {
  test("data is copied, the old path links to it, the service, PATH line and hooks move; a second run changes nothing", async () => {
    const f = fakeInstall();
    process.env.NOOKDECK_LAUNCH_AGENTS_DIR = f.agents;
    const opts = { platform: "darwin" as const, home: f.home, data: true, service: true, svc: f.svc, program: ["/tmp/dl/nookdeck"], hookFiles: { claude: f.claude }, instance: { port: 7420, home: join(f.home, ".nookdeck") } };
    try {
      const r = await migrate(opts);
      const nh = join(f.home, ".nookdeck");
      // data (AC-2, AC-3: the devices file and the hook secret carry over, so paired phones stay paired)
      expect(readFileSync(join(nh, "devices.json"), "utf8")).toBe('{"devices":[{"id":"d1","tokenHash":"abc"}]}');
      expect(readFileSync(join(nh, "hook-secret"), "utf8")).toBe("s3cret");
      expect(readFileSync(join(nh, "sounds", "a.mp3"), "utf8")).toBe("snd");
      expect(lstatSync(f.old).isSymbolicLink()).toBe(true);
      expect(readlinkSync(f.old)).toBe(nh);
      expect(readFileSync(join(f.home, ".phonedesk.migrated", "layout.json"), "utf8")).toBe('{"version":1}'); // nothing deleted
      // program and alias
      expect(readFileSync(join(nh, "bin", "nookdeck"), "utf8")).toBe("REAL-BINARY");
      expect(readFileSync(join(nh, "bin", "phonedesk"), "utf8")).toBe(aliasScript(false));
      expect(lstatSync(join(nh, "bin", "phonedesk")).mode & 0o111).not.toBe(0);
      // launchd: new plist (same port) with the new label and program, old one gone and booted out
      expect(existsSync(join(f.agents, "dev.phonedesk.agent.plist"))).toBe(false);
      const plist = readFileSync(join(f.agents, "dev.nookdeck.agent.plist"), "utf8");
      expect(plist).toContain("<string>dev.nookdeck.agent</string>");
      expect(plist).toContain(join(nh, "bin", "nookdeck"));
      expect(plist).toContain("<string>7421</string>");
      expect(f.calls.some((c) => c[0] === "bootout" && c[1] === "gui/501/dev.phonedesk.agent")).toBe(true);
      expect(f.calls.some((c) => c[0] === "bootstrap")).toBe(true);
      // PATH line, with a backup
      expect(readFileSync(join(f.home, ".zshrc"), "utf8")).toContain('$HOME/.nookdeck/bin:$PATH" # nookdeck');
      expect(readFileSync(join(f.home, ".zshrc.nookdeck.bak"), "utf8")).toContain(".phonedesk/bin");
      // hooks: re-pointed, the user's own hook untouched, backup first
      const hook = JSON.parse(readFileSync(f.claude, "utf8")).hooks.PermissionRequest[0].hooks;
      expect(hook[0].command).toBe("echo mine");
      expect(hook[1].command).toBe(`'${join(nh, "bin", "nookdeck")}' hook claude # nookdeck hook`);
      expect(readFileSync(`${f.claude}.nookdeck.bak`, "utf8")).toContain("# phonedesk hook");
      expect(r.changed.length).toBeGreaterThan(4);
      expect(readFileSync(join(nh, "logs", "migration.log"), "utf8")).toContain("copied");

      // second run: nothing to do
      const before = readdirSync(f.agents).sort();
      const calls = f.calls.length;
      const snap = readFileSync(f.claude, "utf8");
      const again = await migrate(opts);
      expect(again.changed).toEqual([]);
      expect(f.calls.length).toBe(calls);
      expect(readdirSync(f.agents).sort()).toEqual(before);
      expect(readFileSync(f.claude, "utf8")).toBe(snap);
    } finally { delete process.env.NOOKDECK_LAUNCH_AGENTS_DIR; }
  });

  test("hooks of another instance (other port) are left alone", async () => {
    const f = fakeInstall();
    process.env.NOOKDECK_LAUNCH_AGENTS_DIR = f.agents;
    try {
      const snap = readFileSync(f.foreign, "utf8");
      await migrate({ platform: "darwin", home: f.home, data: true, service: false, svc: f.svc, program: ["/p/nookdeck"], hookFiles: { claude: f.foreign }, instance: { port: 7420, home: join(f.home, ".nookdeck") } });
      expect(readFileSync(f.foreign, "utf8")).toBe(snap);
      expect(existsSync(`${f.foreign}.nookdeck.bak`)).toBe(false);
    } finally { delete process.env.NOOKDECK_LAUNCH_AGENTS_DIR; }
  });

  test("an existing ~/.nookdeck is never overwritten; a fresh machine gets nothing", async () => {
    const f = fakeInstall();
    mkdirSync(join(f.home, ".nookdeck"));
    writeFileSync(join(f.home, ".nookdeck", "layout.json"), "NEW");
    const base = { platform: "darwin" as const, home: f.home, data: true, service: false, svc: f.svc, program: ["/p/nookdeck"], hookFiles: {}, instance: { port: 7420, home: join(f.home, ".nookdeck") } };
    await migrate(base);
    expect(readFileSync(join(f.home, ".nookdeck", "layout.json"), "utf8")).toBe("NEW");
    expect(lstatSync(f.old).isDirectory()).toBe(true); // untouched
    const empty = tmp();
    expect((await migrate({ ...base, home: empty })).changed).toEqual([]);
    expect(readdirSync(empty)).toEqual([]);
  });

  test("data: false (a custom NOOKDECK_HOME) leaves the folders alone", async () => {
    const f = fakeInstall();
    await migrate({ platform: "darwin", home: f.home, data: false, service: false, svc: f.svc, program: ["/p/nookdeck"], hookFiles: {}, instance: { port: 7420, home: join(f.home, ".nookdeck") } });
    expect(existsSync(join(f.home, ".nookdeck"))).toBe(false);
    expect(lstatSync(f.old).isDirectory()).toBe(true);
  });
});

describe("migration on Windows (fake schtasks / netsh / reg / powershell)", () => {
  test("startup entry, firewall rule, PATH and the program move to Nookdeck", async () => {
    const home = tmp(); const local = tmp();
    mkdirSync(join(home, ".phonedesk"));
    writeFileSync(join(home, ".phonedesk", "devices.json"), "{}");
    mkdirSync(join(local, "PhoneDesk", "bin"), { recursive: true });
    writeFileSync(join(local, "PhoneDesk", "bin", "phonedesk.exe"), "EXE");
    const ran: string[] = [];
    const winRun = async (argv: string[]) => {
      ran.push(argv.join(" "));
      if (argv[0] === "powershell") return { code: 0, out: "changed" };
      if (argv[0] === "netsh" && argv.includes("show") && argv.includes("name=Nookdeck")) return { code: 1, out: "No rules match" };
      return { code: 0, out: "" };
    };
    process.env.NOOKDECK_WIN_DIR = join(local, "Nookdeck");
    try {
      const svc: any = { launchctl: async () => ({ code: 0, out: "" }), uid: 0, platform: "win32", program: ["x"], log: () => {}, winRun, winDir: join(local, "Nookdeck") };
      const r = await migrate({ platform: "win32", home, winLocal: local, data: true, service: true, svc, program: ["x"], hookFiles: {}, instance: { port: 7420, home: join(home, ".nookdeck") } });
      expect(readFileSync(join(home, ".nookdeck", "devices.json"), "utf8")).toBe("{}");
      expect(existsSync(join(home, ".phonedesk", "MOVED.txt"))).toBe(true); // no symlink on Windows, the old folder stays
      expect(readFileSync(join(local, "Nookdeck", "bin", "nookdeck.exe"), "utf8")).toBe("EXE");
      expect(existsSync(join(local, "Nookdeck", "bin", "phonedesk.cmd"))).toBe(true);
      expect(ran.some((c) => c.startsWith("schtasks /Delete /TN PhoneDesk"))).toBe(true);
      expect(ran.some((c) => c.startsWith("schtasks /Create /TN Nookdeck"))).toBe(true);
      expect(ran.some((c) => c.includes("delete rule name=PhoneDesk"))).toBe(true);
      expect(ran.some((c) => c.includes("add rule name=Nookdeck") && c.includes("nookdeck.exe"))).toBe(true);
      expect(ran.some((c) => c.startsWith("powershell") && c.includes("PhoneDesk\\bin") && c.includes("Nookdeck\\bin"))).toBe(true);
      // every step is reported (and so lands in migration.log)
      const log = r.changed.join("\n");
      expect(log).toContain("startup entry");
      expect(log).toContain('removed the old firewall rule "PhoneDesk"');
      expect(log).toContain("added the firewall rule Nookdeck");
      expect(log).toContain("PATH: removed");
      expect(readFileSync(join(home, ".nookdeck", "logs", "migration.log"), "utf8")).toContain("PATH: removed");
      expect(r.notes).toEqual([]);
    } finally { delete process.env.NOOKDECK_WIN_DIR; }
  });
});

describe("migration on Windows: what cannot be done is said, what is gone is not done again", () => {
  const mk = () => { const home = tmp(); const local = tmp(); mkdirSync(join(home, ".phonedesk")); return { home, local }; };
  test("the old firewall rule cannot be removed without administrator rights: the exact commands are printed", async () => {
    const { home, local } = mk();
    const run = async (argv: string[]) => {
      if (argv[0] === "netsh" && argv.includes("delete")) return { code: 1, out: "requires elevation" };
      if (argv[0] === "netsh" && argv.includes("show")) return { code: argv.includes("name=PhoneDesk") ? 0 : 1, out: "" };
      if (argv[0] === "schtasks" || argv[0] === "reg") return { code: 1, out: "" };
      return { code: 0, out: "" };
    };
    const svc: any = { launchctl: async () => ({ code: 0, out: "" }), uid: 0, platform: "win32", program: ["x"], log: () => {}, winRun: run, winDir: join(local, "Nookdeck") };
    const r = await migrate({ platform: "win32", home, winLocal: local, data: true, service: true, svc, program: ["x"], hookFiles: {}, instance: { port: 7420, home: join(home, ".nookdeck") } });
    const note = r.notes.find((n) => n.startsWith("firewall: the old rule"))!;
    expect(note).toContain('netsh advfirewall firewall delete rule name="PhoneDesk"');
    expect(note).toContain('Remove-NetFirewallRule -DisplayName "PhoneDesk"');
  });
  test("nothing old left: nothing is done and nothing is logged (a second run)", async () => {
    const { home, local } = mk();
    const ran: string[] = [];
    const run = async (argv: string[]) => { ran.push(argv.join(" ")); return { code: 1, out: "" }; }; // no task, no run key, no rule, PATH untouched
    const svc: any = { launchctl: async () => ({ code: 0, out: "" }), uid: 0, platform: "win32", program: ["x"], log: () => {}, winRun: run, winDir: join(local, "Nookdeck") };
    await migrate({ platform: "win32", home, winLocal: local, data: true, service: true, svc, program: ["x"], hookFiles: {}, instance: { port: 7420, home: join(home, ".nookdeck") } });
    const r = await migrate({ platform: "win32", home, winLocal: local, data: true, service: true, svc, program: ["x"], hookFiles: {}, instance: { port: 7420, home: join(home, ".nookdeck") } });
    expect(r.changed).toEqual([]);
    expect(ran.some((c) => c.includes("delete") || c.includes("add rule") || c.includes("/Create"))).toBe(false);
  });
  test("the PATH script drops the old entry, keeps the new one once, and touches nothing else", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "migrate.ts"), "utf8");
    expect(src).toContain("$parts=@($p -split ';'");
    expect(src).toContain("-ieq $o");
    expect(src).toContain("-ieq $n");
  });
});

describe("compatibility with the old name", () => {
  test("PHONEDESK_* is read as a fallback, NOOKDECK_* wins", () => {
    const env: Record<string, string | undefined> = { PHONEDESK_HOME: "/old", PHONEDESK_PORT: "1", NOOKDECK_PORT: "2" };
    expect(applyLegacyEnv(env)).toEqual(["PHONEDESK_HOME"]);
    expect(env.NOOKDECK_HOME).toBe("/old");
    expect(env.NOOKDECK_PORT).toBe("2");
  });
  test("the API accepts the old and the new CSRF header", () => {
    const base = { port: 7420, method: "POST", headers: new Headers({ host: "localhost:7420", "content-type": "application/json" }) };
    const h = (extra: Record<string, string>) => { const x = new Headers(base.headers); for (const [k, v] of Object.entries(extra)) x.set(k, v); return x; };
    expect(localRequestError({ ...base, headers: h({ "x-nookdeck": "1" }) })).toBeNull();
    expect(localRequestError({ ...base, headers: h({ "x-phonedesk": "1" }) })).toBeNull();
    expect(localRequestError({ ...base, headers: h({}) })).toContain("x-nookdeck");
  });
  test("hook entries carrying the old marker are found, replaced and removed", async () => {
    const d = tmp(); const file = join(d, "settings.json");
    writeFileSync(file, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: OLD_HOOK(), timeout: 60 }] }], PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: "'/x/phonedesk' hook claude-ask # phonedesk hook claude-ask", timeout: 600 }] }] } }));
    expect(await isHookInstalled(file)).toBe(true);
    const cmd = `'/n/nookdeck' hook claude # ${HOOK_MARKER}`;
    expect((await installHook(file, cmd)).changed).toBe(true);
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j.hooks.PermissionRequest).toHaveLength(1); // replaced, not added next to the old one
    expect(j.hooks.PermissionRequest[0].hooks[0].command).toBe(cmd);
    expect((await uninstallAskHook(file)).changed).toBe(true); // the old ask hook is ours too
    expect((await uninstallHook(file)).changed).toBe(true);
  });
  test("the old-name program answers --version the way 0.1.x updaters expect", () => {
    const a: any = { version: "0.2.0", commit: "", dirty: false };
    expect(versionLine(a, "/h/.phonedesk/bin/phonedesk")).toBe("phonedesk 0.2.0");
    expect(versionLine(a, "/h/.phonedesk/bin/.phonedesk.update")).toBe("phonedesk 0.2.0");
    expect(versionLine(a, "/h/.nookdeck/bin/nookdeck")).toBe("nookdeck 0.2.0");
  });
});

describe("our old hook and plugin files are removed once the new ones are written (no double approvals)", () => {
  test("opencode plugins/phonedesk.js", async () => {
    const { installPlugin, uninstallPlugin, legacyPluginPath, isPluginInstalled } = await import("../src/ai/opencode");
    const dir = join(tmp(), "plugins"); mkdirSync(dir);
    const file = join(dir, "nookdeck.js");
    const old = legacyPluginPath(file);
    expect(old).toBe(join(dir, "phonedesk.js"));
    writeFileSync(old, "// phonedesk-plugin v1 (installed by PhoneDesk)\nmodule.exports = 1");
    expect(await isPluginInstalled(file)).toBe(true);
    await installPlugin({ port: 7420, home: "/h", major: 1 }, file);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(old)).toBe(false);
    // someone else's phonedesk.js is never touched
    writeFileSync(old, "console.log('not ours')");
    await installPlugin({ port: 7420, home: "/h", major: 1 }, file);
    await uninstallPlugin(file);
    expect(readFileSync(old, "utf8")).toBe("console.log('not ours')");
  });
  test("grok hooks/phonedesk.json", async () => {
    const { installGrokHook, uninstallGrokHook, legacyGrokHookFile, isGrokHookInstalled } = await import("../src/ai/grok");
    const dir = join(tmp(), "hooks"); mkdirSync(dir);
    const file = join(dir, "nookdeck.json");
    const old = legacyGrokHookFile(file);
    writeFileSync(old, '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"x hook grok idle # phonedesk hook grok"}]}]}}');
    expect(await isGrokHookInstalled(file)).toBe(true);
    await installGrokHook("'/n/nookdeck' hook claude # nookdeck hook", file);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(old)).toBe(false);
    writeFileSync(old, '{"hooks":{}}'); // not ours: no marker
    await uninstallGrokHook(file);
    expect(existsSync(old)).toBe(true);
  });
});

describe("release assets keep the 0.1.x updater working (R2)", () => {
  const wf = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
  test("the workflow uploads both name sets and SHA256SUMS lists both", () => {
    for (const n of ["darwin-arm64", "darwin-x64", "windows-x64.exe"]) {
      for (const p of ["nookdeck", "phonedesk"]) {
        expect(wf).toContain(`dist/${p}-${n} `);
        expect(wf).toContain(`dist/${p}-${n}.gz`);
        expect(wf.split("shasum -a 256")[1]!.split("\n")[0]).toContain(` ${p}-${n} `);
      }
    }
  });
  test("a 0.1.x updater finds phonedesk-* in the sums, checks digests, and the binary says 'phonedesk <version>'", async () => {
    const { createHash } = await import("node:crypto");
    const dir = tmp("pd-rel-");
    const bin = "BINARY-BYTES";
    const sha = createHash("sha256").update(bin).digest("hex");
    const names = ["nookdeck-darwin-arm64", "phonedesk-darwin-arm64"];
    for (const n of names) writeFileSync(join(dir, n), bin);
    writeFileSync(join(dir, "SHA256SUMS"), names.map((n) => `${sha}  ${n}`).join("\n") + "\n");
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    // what the 0.1.x updater does (src/update.ts at v0.1.5): look the asset up by its old name and compare the digest
    expect(sumFor(sums, "phonedesk-darwin-arm64")).toBe(sha);
    expect(sumFor(sums, "nookdeck-darwin-arm64")).toBe(sha);
    expect(sumFor(sums, "phonedesk-darwin-arm64.gz")).toBeNull(); // 0.1.x falls back to the plain binary when no .gz is listed
    expect(/^phonedesk (\S+)/m.exec(versionLine({ version: "0.2.0", commit: "", dirty: false } as any, "/x/.phonedesk.update"))?.[1]).toBe("0.2.0");
  });
});
