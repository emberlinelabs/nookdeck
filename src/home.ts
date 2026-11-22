import { homedir, tmpdir } from "node:os";

/**
 * The user's home folder that never throws. os.homedir() fails (ENOENT uv_os_homedir) when HOME is unset and the user has no
 * passwd entry, which a stripped environment (a service manager, a test) can produce; at import time that would kill the CLI.
 * Order: HOME, USERPROFILE, os.homedir(), then the temp folder (so paths stay absolute and writable).
 */
export function userHome(): string {
  const env = process.env.HOME || process.env.USERPROFILE;
  if (env) return env;
  try { return homedir(); } catch { return tmpdir(); }
}
