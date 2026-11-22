import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "../platform";
import { safeHome } from "./types";

/**
 * The directories CLIs usually live in but a service's short PATH (launchd, a scheduled task) lacks.
 * Used by findCli and also to widen the PATH the macOS service starts with.
 */
export function cliDirs(home: string = safeHome() || homedir(), id: string = platform.id, env: Record<string, string | undefined> = process.env): string[] {
  if (id === "win32") {
    const roaming = env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(roaming, "npm"), join(home, ".bun", "bin"), join(home, ".local", "bin")];
  }
  return [join(home, ".local", "bin"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/**
 * Finds a CLI: PATH first, then the usual install folders, then `extraDirs` (for example %LOCALAPPDATA%\agy\bin).
 * A service often runs with a short PATH, so PATH alone misses a working install.
 */
export function findCli(name: string, extraDirs: string[] = [], o: { home?: string; id?: string; env?: Record<string, string | undefined> } = {}): string | null {
  const env = o.env ?? process.env;
  const onPath = Bun.which(name, { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const id = o.id ?? platform.id;
  const exts = id === "win32" ? [".exe", ".cmd"] : [""];
  for (const d of [...extraDirs, ...cliDirs(o.home, id, env)]) for (const e of exts) { const f = join(d, `${name}${e}`); if (existsSync(f)) return f; }
  return null;
}
