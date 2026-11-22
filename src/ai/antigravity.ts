import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "../platform";
import { findCli } from "./find-cli";
import { safeHome, clampPercent, type ProviderQuota, type QuotaWindow } from "./types";
import { t as tr } from "../i18n";

export const AGY_TIMEOUT_MS = 20_000;

/** The agy binary: NOOKDECK_AGY, PATH, then the places its installers use (a service's PATH lacks ~/.local/bin). */
export function agyPath(): string | null {
  const forced = process.env.NOOKDECK_AGY;
  if (forced) return forced;
  const home = safeHome() || homedir();
  const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return findCli("agy", platform.id === "win32" ? [join(local, "agy", "bin")] : []);
}

/** agy asked for a sign-in: the message never carries the OAuth URL on purpose. */
export class AgyAuthRequired extends Error {
  constructor() { super("agy is not signed in"); }
}
const AUTH_RE = /authentication required/i;
/** After "not signed in", agy is not started again for this long (until the user refreshes by hand). */
export const AGY_AUTH_BACKOFF_MS = 30 * 60_000;
let authUntil = 0;
export const resetAgyBackoff = (): void => { authUntil = 0; };

/**
 * Runs agy and stops at once when it prints "Authentication required" (it would otherwise wait a minute for a pasted code).
 * Output is read as it arrives; nothing of it is logged.
 */
export async function runAgy(argv: string[], timeoutMs: number): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true } as any);
  } catch (err: any) {
    throw new Error(`cannot start agy: ${err?.message ?? err}`);
  }
  let out = "", err = "", auth = false, timedOut = false;
  let wake: () => void = () => {};
  const authSeen = new Promise<void>((r) => { wake = r; });
  const pump = async (s: ReadableStream | null | undefined, add: (c: string) => void) => {
    if (!s) return;
    const dec = new TextDecoder();
    try {
      for await (const chunk of s as any) {
        add(dec.decode(chunk, { stream: true }));
        if (AUTH_RE.test(out) || AUTH_RE.test(err)) { auth = true; wake(); return; }
      }
    } catch { /* stream closed */ }
  };
  const done = Promise.all([pump(proc.stdout as any, (c) => (out += c)), pump(proc.stderr as any, (c) => (err += c)), proc.exited]);
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); wake(); }, timeoutMs);
  await Promise.race([done, authSeen]);
  clearTimeout(timer);
  if (auth) { proc.kill("SIGKILL"); throw new AgyAuthRequired(); }
  if (timedOut) throw new Error(`agy timed out after ${timeoutMs / 1000}s`);
  const code = await proc.exited;
  if (code !== 0) throw new Error(err.trim().split("\n")[0]?.slice(0, 200) || `agy exited with code ${code}`);
  return out;
}

const GROUP_SHORT = (name: string): string =>
  /^gemini models?$/i.test(name) ? "Gemini" : /claude.*gpt/i.test(name) ? "Claude/GPT" : name;

const WINDOWS: Record<string, { label: string; minutes: number }> = {
  weekly: { label: "7 days", minutes: 10080 },
  "5h": { label: "5 hours", minutes: 300 },
};

function windowOf(text: string): { label: string; minutes: number } | undefined {
  const k = text.toLowerCase();
  const w = WINDOWS[k] ?? (/five hour|5 ?h/.test(k) ? WINDOWS["5h"] : /week/.test(k) ? WINDOWS.weekly : undefined);
  return w ? { ...w, label: tr(w.label) } : undefined;
}

/**
 * Parses `agy -p /usage --output-format json`. Primary source: command.data.groups[].buckets[]
 * ({id, name, window, remaining_fraction, reset_time}); fallback: the tab separated `response` text
 * (group, name, "NN%", ISO time) where NN is the REMAINING percent.
 */
export function parseAgyUsage(stdout: string): QuotaWindow[] {
  let o: any;
  try {
    o = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out: QuotaWindow[] = [];
  const groups = o?.command?.data?.groups;
  if (Array.isArray(groups)) {
    for (const g of groups) {
      for (const b of g?.buckets ?? []) {
        if (typeof b?.remaining_fraction !== "number") continue;
        const w = windowOf(String(b.window ?? "")) ?? windowOf(String(b.name ?? ""));
        const reset = Date.parse(b.reset_time);
        out.push({
          id: String(b.id ?? `${g.name}-${b.window}`),
          label: `${GROUP_SHORT(String(g.name ?? ""))} · ${w?.label ?? String(b.name ?? "")}`,
          usedPercent: clampPercent((1 - b.remaining_fraction) * 100),
          ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
          ...(w ? { windowMinutes: w.minutes } : {}),
        });
      }
    }
    if (out.length) return out;
  }
  if (typeof o?.response === "string") {
    for (const [i, line] of o.response.split("\n").entries()) {
      const [group, name, pct, time] = line.split("\t");
      const remaining = /^(\d+(?:\.\d+)?)%$/.exec(pct ?? "")?.[1];
      if (!group || !name || remaining === undefined) continue;
      const w = windowOf(name);
      const reset = Date.parse(time ?? "");
      out.push({
        id: `${group}-${i}`.replace(/\s+/g, "-").toLowerCase(),
        label: `${GROUP_SHORT(group)} · ${w?.label ?? name}`,
        usedPercent: clampPercent(100 - Number(remaining)),
        ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
        ...(w ? { windowMinutes: w.minutes } : {}),
      });
    }
  }
  return out;
}

export async function fetchAntigravityQuota(
  run: (argv: string[], timeoutMs: number) => Promise<string> = runAgy,
  now = Date.now(),
  bin: string | null = agyPath(),
  o: { force?: boolean } = {},
): Promise<ProviderQuota> {
  const fail = (error: string): ProviderQuota => ({ id: "antigravity", name: "Antigravity", windows: [], error, updatedAt: now });
  if (!bin) return fail(tr("Antigravity CLI (agy) was not found. Install it, or set NOOKDECK_AGY to its path."));
  if (o.force) authUntil = 0;
  if (now < authUntil) return fail(tr("Antigravity CLI is not signed in on this computer. Open a terminal, run `agy` once and sign in."));
  try {
    const windows = parseAgyUsage(await run([bin, "-p", "/usage", "--output-format", "json"], AGY_TIMEOUT_MS));
    return windows.length ? { id: "antigravity", name: "Antigravity", windows, updatedAt: now } : fail(tr("Could not read the Antigravity quota"));
  } catch (err: any) {
    if (err instanceof AgyAuthRequired) {
      authUntil = now + AGY_AUTH_BACKOFF_MS;
      return fail(tr("Antigravity CLI is not signed in on this computer. Open a terminal, run `agy` once and sign in."));
    }
    return fail(tr("Could not run agy: {msg}", { msg: err?.message ?? err }));
  }
}
