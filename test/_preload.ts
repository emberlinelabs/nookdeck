// Loaded before every test file (bunfig.toml).
//
// 1. A test must never touch the real home of the person running it. Whichever test file first imports src/config.ts
//    fixes HOME for the whole process, and importing most modules pulls config in, so the sandbox has to exist before
//    any of them: NOOKDECK_HOME is ALWAYS replaced (an exported NOOKDECK_HOME, even the real one, must not leak in).
// 2. A hard guard on top: any write under the real ~/.nookdeck, ~/.claude, ~/.codex or ~/Library/LaunchAgents throws,
//    whatever the cause (a test that forgot an env var, a module that resolved HOME early, a new code path).
//    It covers node:fs, node:fs/promises (named, default, namespace and dynamic imports) and Bun.write. A subprocess
//    started by a test is outside this process: tests must give it its own NOOKDECK_HOME (test/home-guard.test.ts
//    checks the spawn sites).
import { mock } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const nodeFs = require("node:fs");
const nodeFsp = require("node:fs/promises");

const sandbox = mkdtempSync(join(tmpdir(), "pd-test-home-"));
process.env.NOOKDECK_HOME = sandbox;
process.env.NOOKDECK_TEST_SANDBOX = "1";
// the OpenCode / Grok readers look at the tools' own data: point them into the sandbox so no test ever reads (or writes) the real ones
process.env.GROK_HOME = join(sandbox, "grok-home");
process.env.OPENCODE_DB = join(sandbox, "opencode-data", "opencode.db");
process.env.XDG_DATA_HOME = join(sandbox, "xdg-data");
process.env.XDG_STATE_HOME = join(sandbox, "xdg-state");
process.env.NOOKDECK_OPENCODE_CONFIG_DIR = join(sandbox, "opencode-config");
process.env.NOOKDECK_OPENCODE = join(sandbox, "no-such-opencode"); // `opencode --version` never runs the real one
process.env.NOOKDECK_GROK = join(sandbox, "no-such-grok");

const real = homedir();
const norm = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);
const protectedDirs = [join(real, ".nookdeck"), join(real, ".claude"), join(real, ".codex"), join(real, "Library", "LaunchAgents"), join(real, ".grok"), join(real, ".config", "opencode"), join(real, ".local", "share", "opencode"), join(real, ".local", "state", "opencode")]
  .flatMap((d) => { try { return [d, realpathSync(d)]; } catch { return [d]; } })
  .map((d) => norm(resolve(d)));
(globalThis as any).__pdProtectedDirs = protectedDirs;

const asPath = (v: unknown): string | null => {
  if (typeof v === "string") return v;
  if (v instanceof URL) return v.protocol === "file:" ? decodeURIComponent(v.pathname.replace(/^\/([A-Za-z]:)/, "$1")) : null;
  if (Buffer.isBuffer(v)) return v.toString();
  return null;
};
export function isProtected(p: unknown): boolean {
  const s = asPath(p);
  if (!s) return false;
  const r = norm(resolve(s));
  return protectedDirs.some((d) => r === d || r.startsWith(d + sep));
}
const deny = (fn: string, p: unknown): never => {
  throw new Error(`test guard: ${fn}(${String(asPath(p))}) would write under the real home (${real}). Tests must use their own NOOKDECK_HOME / NOOKDECK_CLAUDE_DIR / NOOKDECK_CODEX_DIR.`);
};

// functions whose FIRST argument is a path that gets written, and the ones that also write a SECOND path
const FIRST = ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "chmod", "chown", "lchmod", "lchown", "truncate", "utimes", "lutimes", "mkdtemp", "createWriteStream", "rename", "copyFile", "link", "symlink", "cp", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "chmodSync", "chownSync", "truncateSync", "utimesSync", "mkdtempSync", "renameSync", "copyFileSync", "linkSync", "symlinkSync", "cpSync", "lchmodSync", "lchownSync", "lutimesSync"];
const RENAMES = new Set(["rename", "renameSync", "copyFile", "copyFileSync", "link", "linkSync", "cp", "cpSync"]);
const SYMLINK = new Set(["symlink", "symlinkSync"]); // (target, path): the second one is created
const OPENERS = new Set(["open", "openSync"]); // only when opened for writing
const writing = (flags: unknown) => typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" ? (flags & 3) !== 0 : false;

function guarded<T extends Record<string, any>>(mod: T, promises = false): T {
  const out: Record<string, any> = { ...mod };
  for (const name of FIRST) {
    const f = mod[name];
    if (typeof f !== "function") continue;
    out[name] = function (...a: any[]) {
      const targets = SYMLINK.has(name) ? [a[1]] : RENAMES.has(name) ? [a[0], a[1]] : [a[0]];
      for (const t of targets) {
        if (!isProtected(t)) continue;
        try { deny(name, t); } catch (e) { if (promises) return Promise.reject(e); throw e; }
      }
      return f.apply(mod, a);
    };
  }
  for (const name of OPENERS) {
    const f = mod[name];
    if (typeof f !== "function") continue;
    out[name] = function (...a: any[]) {
      if (writing(a[1]) && isProtected(a[0])) {
        try { deny(name, a[0]); } catch (e) { if (promises) return Promise.reject(e); throw e; }
      }
      return f.apply(mod, a);
    };
  }
  return out as T;
}

const fsp = guarded(nodeFsp, true);
const fsMod = guarded(nodeFs);
(fsMod as any).promises = fsp;
for (const spec of ["node:fs", "fs"]) mock.module(spec, () => ({ ...fsMod, default: fsMod }));
for (const spec of ["node:fs/promises", "fs/promises"]) mock.module(spec, () => ({ ...fsp, default: fsp }));

const realWrite = Bun.write.bind(Bun);
try {
  (Bun as any).write = (dest: any, ...rest: any[]) => {
    const target = typeof dest === "string" || dest instanceof URL ? dest : dest && typeof dest.name === "string" ? dest.name : null;
    if (target !== null && isProtected(target)) { try { deny("Bun.write", target); } catch (e) { return Promise.reject(e); } }
    return (realWrite as any)(dest, ...rest);
  };
} catch { /* a read-only Bun.write: the node:fs guard still stands */ }
