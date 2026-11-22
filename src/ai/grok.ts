import { platform } from "../platform";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { t } from "../i18n";
import { safeHome, clampPercent, windowLabel, type AiSession, type ProviderQuota, type QuotaExtra, type QuotaWindow } from "./types";
import { projectName, sessionState, MAX_SESSIONS } from "./sessions";
import { SESSION_WINDOW_MS } from "./opencode";
import { withToolState, type ToolStates } from "./states";

/*
 * Grok Build (`grok`, xAI). Read-only from its own files:
 *  - ~/.grok/sessions/<url-encoded cwd>/<id>/summary.json and ~/.grok/active_sessions.json (GROK_HOME overrides the base);
 *  - busy / idle / waiting come from an opt-in hook file, ~/.grok/hooks/nookdeck.json, that Nookdeck installs and removes.
 * Quota: asked of the grok CLI itself (`grok agent stdio`, ACP JSON-RPC `_x.ai/billing`), never from tokens or cookies we read.
 * A Grok hook can only deny, never approve, and cannot answer questions:
 * the phone only learns "Grok is waiting for you".
 */

export const grokDir = (): string => process.env.GROK_HOME || join(safeHome() || homedir(), ".grok");
export const grokHookFile = (): string => join(grokDir(), "hooks", "nookdeck.json");
/** The grok binary: NOOKDECK_GROK (authoritative, for tests), PATH, then ~/.grok/bin and the usual places (a service's PATH is short). */
export function grokPath(): string | null {
  const forced = process.env.NOOKDECK_GROK;
  if (forced) return existsSync(forced) ? forced : null;
  const onPath = Bun.which("grok", { PATH: process.env.PATH ?? "" });
  if (onPath) return onPath;
  const home = safeHome() || homedir();
  const exe = platform.id === "win32" ? [".exe", ".cmd"] : [""];
  for (const d of [join(grokDir(), "bin"), join(home, ".local", "bin"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) for (const e of exe) { const f = join(d, `grok${e}`); if (existsSync(f)) return f; }
  return null;
}
export const grokDataFound = (): boolean => existsSync(join(grokDir(), "sessions")) || existsSync(grokDir());
export const GROK_NO_QUOTA = () => t("Grok usage comes from the Grok CLI (grok agent stdio); it is not available");

// ---------- usage through `grok agent stdio` (internal, undocumented ACP method) ----------

export interface GrokBilling { plan?: string; window?: Omit<QuotaWindow, "id" | "label"> & { weekly: boolean }; periodEnd?: number; prepaidUsd?: number }

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const cents = (v: any): number | undefined => num(v?.val ?? v);

/**
 * Reads the result of `_x.ai/billing`. Current shape: { config: { creditUsagePercent?, currentPeriod: {type, start, end},
 * billingPeriodStart/End, prepaidBalance: {val}, onDemandUsed/onDemandCap: {val} }, subscription_tier }. The older shape has
 * monthlyLimit and usage.totalUsed (amounts as {val: cents}) and billingCycle. Returns null when there is nothing usable.
 */
export function parseGrokBilling(result: any): GrokBilling | null {
  if (!result || typeof result !== "object") return null;
  const c = result.config && typeof result.config === "object" ? result.config : result;
  const out: GrokBilling = {};
  if (typeof result.subscription_tier === "string" && result.subscription_tier) out.plan = result.subscription_tier.slice(0, 40);
  let pct = num(c.creditUsagePercent);
  if (pct === undefined) {
    const used = cents(c.onDemandUsed), cap = cents(c.onDemandCap);
    if (used !== undefined && cap && cap > 0) pct = (used / cap) * 100;
  }
  if (pct === undefined) { // legacy
    const limit = cents(result.monthlyLimit ?? c.monthlyLimit), used = cents(result.usage?.totalUsed);
    if (limit && limit > 0 && used !== undefined) pct = (used / limit) * 100;
  }
  const cur = c.currentPeriod ?? result.billingCycle;
  const startMs = toMs(cur?.start ?? c.billingPeriodStart ?? result.billingCycle?.billingPeriodStart);
  const endMs = toMs(cur?.end ?? c.billingPeriodEnd ?? result.billingCycle?.billingPeriodEnd);
  const type = String(cur?.type ?? "").toUpperCase();
  const weekly = type.includes("WEEK") || (!!startMs && !!endMs && Math.abs(endMs - startMs - 7 * 24 * 3600_000) < 3600_000);
  if (endMs) out.periodEnd = endMs;
  // a period without a percentage (Grok Free): still a window, with usedPercent null, so the phone can show the reset time
  if (pct !== undefined || endMs) out.window = { usedPercent: pct !== undefined ? clampPercent(pct) : null, ...(endMs ? { resetsAt: endMs } : {}), ...(startMs && endMs && endMs > startMs ? { windowMinutes: Math.round((endMs - startMs) / 60_000) } : weekly ? { windowMinutes: 10080 } : {}), weekly };
  const prepaid = cents(c.prepaidBalance);
  if (prepaid !== undefined) out.prepaidUsd = prepaid / 100;
  return out.plan || out.window || out.periodEnd || out.prepaidUsd !== undefined ? out : null;
}

export function grokQuotaFrom(b: GrokBilling | null, now = Date.now()): ProviderQuota {
  const base = { id: "grok" as const, name: "Grok", updatedAt: now, source: "grok-cli" as const };
  if (!b) return { ...base, windows: [], error: GROK_NO_QUOTA() };
  const extras: QuotaExtra[] = b.prepaidUsd !== undefined && b.prepaidUsd > 0 ? [{ label: t("Prepaid balance"), value: Math.round(b.prepaidUsd * 100) / 100, unit: "USD" }] : [];
  const w = b.window;
  const windows: QuotaWindow[] = w ? [{ id: w.weekly ? "weekly" : "period", label: w.usedPercent === null && w.weekly ? t("Weekly") : windowLabel(w.windowMinutes ?? (w.weekly ? 10080 : 43200)), usedPercent: w.usedPercent, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), ...(w.windowMinutes ? { windowMinutes: w.windowMinutes } : {}) }] : [];
  return {
    ...base, ...(b.plan ? { plan: b.plan } : {}), windows, ...(extras.length ? { extras } : {}),
    ...(!windows.length ? { error: t("Grok has not published this week's usage yet") } : {}),
  };
}

export class GrokRpcError extends Error { constructor(message: string, readonly code?: number) { super(message); } }

/**
 * Spawns `<grok> agent stdio`, sends the ACP `initialize` and then `_x.ai/billing` (no params; extension methods carry the `_`
 * prefix on the wire) and returns the result. Newline-delimited JSON-RPC 2.0. The child is ALWAYS killed, after at most
 * `timeoutMs`. Never reads ~/.grok/auth.json; the CLI uses its own login.
 */
export async function grokBillingRpc(bin: string, timeoutMs = 15_000, env: Record<string, string | undefined> = process.env): Promise<any> {
  const p = Bun.spawn([bin, "agent", "stdio"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: env as Record<string, string> });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (o: unknown) => { try { p.stdin.write(JSON.stringify(o) + "\n"); p.stdin.flush(); } catch { /* closed: the timeout or EOF reports it */ } };
  const run = (async () => {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1", clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      if (buf.length > 2_000_000) throw new GrokRpcError("the Grok CLI sent too much data");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === undefined || m.id === null) continue; // notifications
        if (m.error) throw new GrokRpcError(String(m.error.message ?? "JSON-RPC error").slice(0, 120), typeof m.error.code === "number" ? m.error.code : undefined);
        if (m.id === 1) send({ jsonrpc: "2.0", id: 2, method: "_x.ai/billing", params: {} });
        else if (m.id === 2) return m.result;
      }
    }
    throw new GrokRpcError("the Grok CLI closed its output");
  })();
  const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new GrokRpcError("the Grok CLI did not answer in time")), timeoutMs); });
  try { return await Promise.race([run, limit]); }
  finally { if (timer) clearTimeout(timer); try { p.stdin.end(); } catch { /* */ } try { p.kill("SIGKILL"); } catch { /* gone */ } run.catch(() => {}); }
}

let quotaCache: { at: number; bin: string; q: ProviderQuota } | null = null;
let inflight: Promise<ProviderQuota> | null = null;
export const GROK_QUOTA_TTL_MS = 5 * 60_000;
export const resetGrokQuotaCache = () => { quotaCache = null; inflight = null; };

/** Grok usage via the CLI: cached 5 minutes (also failures, so a broken CLI is not spawned on every poll), one call in flight. */
export function grokQuota(o: { now?: number; timeoutMs?: number; bin?: string | null } = {}): Promise<ProviderQuota> {
  const now = o.now ?? Date.now();
  const bin = o.bin === undefined ? grokPath() : o.bin;
  if (!bin) return Promise.resolve({ id: "grok", name: "Grok", windows: [], error: t("Grok was not found"), updatedAt: now });
  if (quotaCache && quotaCache.bin === bin && now - quotaCache.at < GROK_QUOTA_TTL_MS) return Promise.resolve(quotaCache.q);
  if (inflight) return inflight;
  inflight = (async () => {
    let q: ProviderQuota;
    try { q = grokQuotaFrom(parseGrokBilling(await grokBillingRpc(bin, o.timeoutMs)), now); }
    catch (e: any) {
      const missing = e instanceof GrokRpcError && e.code === -32601;
      q = { id: "grok", name: "Grok", windows: [], error: missing ? t("This Grok CLI has no usage method (update it)") : t("Could not read Grok usage: {m}", { m: String(e?.message ?? e).slice(0, 80) }), updatedAt: now, source: "grok-cli" };
    }
    quotaCache = { at: now, bin, q };
    return q;
  })().finally(() => { inflight = null; });
  return inflight;
}

const toMs = (v: unknown): number => {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const p = Date.parse(String(v ?? ""));
  return Number.isFinite(p) ? p : 0;
};

/** Ids in active_sessions.json: an array of ids or objects, or an object keyed by id (or holding such a list). */
export function parseActiveSessions(j: any): string[] {
  const list = Array.isArray(j) ? j : Array.isArray(j?.sessions) ? j.sessions : j && typeof j === "object" ? Object.keys(j) : [];
  return list.map((x: any) => (typeof x === "string" ? x : x?.id ?? x?.session_id ?? x?.sessionId)).filter((x: unknown): x is string => typeof x === "string");
}

/**
 * Recent sessions: every folder under sessions/<url-encoded cwd>/<id>/ whose summary.json was updated in the last 7 days
 * (newest first, at most 12), shown idle unless the session is listed in active_sessions.json (running), was written to in the
 * last 20 s (working) or a hook told us otherwise (busy / idle / waiting). The real summary.json has info.{id,cwd},
 * session_summary / generated_title, current_model_id, updated_at, last_active_at.
 */
export async function readGrokSessions(opts: { dir?: string; now?: number; states?: ToolStates; limit?: number; windowMs?: number } = {}): Promise<AiSession[]> {
  const dir = opts.dir ?? grokDir(), now = opts.now ?? Date.now(), win = opts.windowMs ?? SESSION_WINDOW_MS;
  const root = join(dir, "sessions");
  const active = new Set(parseActiveSessions(await readFile(join(dir, "active_sessions.json"), "utf8").then(JSON.parse, () => null)));
  const cands: { id: string; folder: string; file: string; mtime: number }[] = [];
  for (const folder of await readdir(root).catch(() => [] as string[])) {
    for (const id of await readdir(join(root, folder)).catch(() => [] as string[])) {
      const file = join(root, folder, id, "summary.json");
      try { cands.push({ id, folder, file, mtime: (await stat(file)).mtimeMs }); } catch { /* a folder without a summary (prompt_history.jsonl ...) */ }
    }
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  const out: AiSession[] = [];
  for (const c of cands.slice(0, 60)) {
    let j: any;
    try { j = JSON.parse(await readFile(c.file, "utf8")); } catch { continue; }
    const at = Math.max(toMs(j?.updated_at), toMs(j?.last_active_at)) || c.mtime;
    const id = typeof j?.info?.id === "string" ? j.info.id : c.id;
    const isActive = active.has(id) || active.has(c.id);
    if (now - at >= win && !isActive) continue;
    let cwd = typeof j?.info?.cwd === "string" ? j.info.cwd : c.folder;
    if (cwd === c.folder) { try { cwd = decodeURIComponent(c.folder); } catch { /* raw */ } }
    const title = [j?.generated_title, j?.session_summary, j?.title].find((x) => typeof x === "string" && x);
    const model = typeof j?.current_model_id === "string" ? j.current_model_id : undefined;
    const base: AiSession = {
      id, tool: "grok", project: projectName(cwd),
      ...(title ? { title: String(title).slice(0, 80) } : {}),
      ...(model ? { model } : {}),
      state: sessionState(at, now, false),
      updatedAt: Math.round(at),
      ...(isActive ? { running: true as const } : {}),
    };
    out.push(withToolState(base, opts.states?.get("grok", id)));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, opts.limit ?? MAX_SESSIONS);
}

// ---------- the opt-in hook file ----------

export const GROK_STATES = [
  { event: "UserPromptSubmit", state: "busy" },
  { event: "Stop", state: "idle" },
  { event: "StopFailure", state: "idle" },
  { event: "StopCancelled", state: "idle" },
  { event: "Notification", state: "waiting", matcher: "idle_prompt|permission_prompt" },
] as const;
export const GROK_HOOK_TIMEOUT_S = 5;
export const GROK_MARKER = "nookdeck hook grok";
const LEGACY_GROK_MARKER = "phonedesk hook grok";
/** The file 0.1.x wrote; removed (by marker) once the new one is written, or both hooks would fire. */
export const legacyGrokHookFile = (file = grokHookFile()) => join(dirname(file), "phonedesk.json");
async function removeLegacyGrokHook(file: string): Promise<boolean> {
  const old = legacyGrokHookFile(file);
  const text = await readFile(old, "utf8").catch(() => null);
  if (text === null || !text.includes(LEGACY_GROK_MARKER)) return false;
  await rm(old, { force: true });
  return true;
}

/** The command text for one state, built from the usual `<exe> hook claude ...` command (same --port/--home conventions). */
export const grokCommandFor = (base: string, state: string) => base.replace(/ hook claude/, ` hook grok ${state}`).replace(/# nookdeck hook$/, `# ${GROK_MARKER}`);

export function grokHookContent(base: string): string {
  const hooks: Record<string, unknown[]> = {};
  for (const e of GROK_STATES) {
    hooks[e.event] = [{ ...("matcher" in e ? { matcher: e.matcher } : {}), hooks: [{ type: "command", command: grokCommandFor(base, e.state), timeout: GROK_HOOK_TIMEOUT_S }] }];
  }
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

export async function isGrokHookInstalled(file = grokHookFile()): Promise<boolean> {
  try { return (await readFile(file, "utf8")).includes(GROK_MARKER); } catch { return (await readFile(legacyGrokHookFile(file), "utf8").catch(() => "")).includes(LEGACY_GROK_MARKER); }
}

/** Writes ~/.grok/hooks/nookdeck.json (a file of our own). Refuses to overwrite a file that is not ours. */
export async function installGrokHook(baseCommand: string, file = grokHookFile()): Promise<{ changed: boolean }> {
  let cur: string | null = null;
  try { cur = await readFile(file, "utf8"); } catch { /* new */ }
  if (cur !== null && !cur.includes(GROK_MARKER)) throw new Error(`${file} exists and was not written by Nookdeck; refusing to overwrite it`);
  const next = grokHookContent(baseCommand);
  if (cur === next) return { changed: await removeLegacyGrokHook(file) };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next);
  await chmod(file, 0o644).catch(() => {});
  await removeLegacyGrokHook(file);
  return { changed: true };
}

export async function uninstallGrokHook(file = grokHookFile()): Promise<{ changed: boolean }> {
  let cur: string;
  try { cur = await readFile(file, "utf8"); } catch { return { changed: await removeLegacyGrokHook(file) }; }
  if (!cur.includes(GROK_MARKER)) return { changed: await removeLegacyGrokHook(file) };
  await rm(file, { force: true });
  await removeLegacyGrokHook(file);
  return { changed: true };
}

/** `nookdeck hook grok <state>` stdin -> the fields the agent needs (Grok sends camelCase; snake_case tolerated). */
export function grokStateFromStdin(stdin: string): { sessionId?: string; cwd?: string } {
  try {
    const o = JSON.parse(stdin);
    const sessionId = o?.sessionId ?? o?.session_id;
    return { ...(typeof sessionId === "string" ? { sessionId } : {}), ...(typeof o?.cwd === "string" ? { cwd: o.cwd } : {}) };
  } catch { return {}; }
}
