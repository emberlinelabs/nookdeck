// The test suite must never touch the real home of whoever runs it. test/_preload.ts sandboxes NOOKDECK_HOME and blocks
// writes under the real ~/.nookdeck, ~/.claude, ~/.codex and ~/Library/LaunchAgents; this file proves both hold.
import { describe, expect, test } from "bun:test";
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as fsNs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const realHome = join(homedir(), ".nookdeck");
const probe = join(realHome, "__test_guard_probe__");

describe("the real home is off limits to tests", () => {
  test("NOOKDECK_HOME is a sandbox under the temp dir, not the real home", async () => {
    const { HOME } = await import("../src/config");
    expect(process.env.NOOKDECK_TEST_SANDBOX).toBe("1");
    expect(resolve(HOME)).not.toBe(resolve(realHome));
    expect(resolve(HOME).startsWith(resolve(tmpdir()))).toBe(true);
  });

  test("writes under the real ~/.nookdeck throw, by every import style, and leave nothing behind", async () => {
    const dyn = await import("node:fs");
    const attempts: Array<[string, () => unknown]> = [
      ["writeFileSync named", () => writeFileSync(probe, "x")],
      ["writeFileSync namespace", () => fsNs.writeFileSync(probe, "x")],
      ["writeFileSync default", () => fs.writeFileSync(probe, "x")],
      ["writeFileSync dynamic", () => dyn.writeFileSync(probe, "x")],
      ["mkdirSync", () => mkdirSync(join(realHome, "__test_guard_dir__"), { recursive: true })],
      ["openSync for writing", () => fs.openSync(probe, "w")],
      ["appendFileSync", () => fs.appendFileSync(probe, "x")],
      ["renameSync into", () => { const a = join(tmpdir(), "pd-guard-src-" + process.pid); writeFileSync(a, "x"); try { fs.renameSync(a, probe); } finally { fs.rmSync(a, { force: true }); } }],
      ["rmSync", () => fs.rmSync(realHome, { recursive: true, force: true })],
      ["chmodSync", () => fs.chmodSync(realHome, 0o700)],
    ];
    for (const [name, f] of attempts) expect(f, name).toThrow("test guard");
    await expect(writeFile(probe, "x")).rejects.toThrow("test guard");
    await expect(mkdir(join(realHome, "__test_guard_dir__"), { recursive: true })).rejects.toThrow("test guard");
    await expect(fs.promises.writeFile(probe, "x")).rejects.toThrow("test guard");
    await expect(Bun.write(probe, "x")).rejects.toThrow("test guard");
    expect(existsSync(probe)).toBe(false);
    expect(existsSync(join(realHome, "__test_guard_dir__"))).toBe(false);
  });

  test("the other config folders of the person running the tests are guarded too", () => {
    for (const d of [".claude", ".codex"]) expect(() => writeFileSync(join(homedir(), d, "__test_guard_probe__"), "x")).toThrow("test guard");
    if (process.platform === "darwin") expect(() => writeFileSync(join(homedir(), "Library", "LaunchAgents", "__test_guard_probe__.plist"), "x")).toThrow("test guard");
  });

  test("reads and writes in the temp dir are untouched by the guard", () => {
    const f = join(tmpdir(), "pd-guard-ok-" + process.pid);
    writeFileSync(f, "ok");
    expect(readFileSync(f, "utf8")).toBe("ok");
    fs.rmSync(f);
    expect(Array.isArray(existsSync(realHome) ? readdirSync(realHome) : [])).toBe(true); // reading the real home is allowed
  });

  test("every subprocess a test starts gets its own NOOKDECK_HOME (or a fake HOME / install home)", () => {
    const dir = join(import.meta.dir);
    const bad: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".test.ts") || name === "home-guard.test.ts") continue;
      const src = readFileSync(join(dir, name), "utf8");
      const lines = src.split("\n");
      lines.forEach((l, i) => {
        if (!/Bun\.spawn(Sync)?\(/.test(l)) return;
        // the call plus the lines that build its env: no env at all inherits the sandboxed process.env, an explicit env must name its home
        const ctx = lines.slice(Math.max(0, i - 20), i + 4).join("\n");
        const explicitEnv = /\benv\b/.test(l) || /\benv\b\s*[:=]/.test(lines.slice(i, i + 4).join("\n"));
        if (explicitEnv && !/NOOKDECK_HOME|NOOKDECK_INSTALL_HOME|HOME:|\.\.\.process\.env/.test(ctx)) bad.push(`${name}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
