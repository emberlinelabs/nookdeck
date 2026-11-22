import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./config";
import { projectName } from "./ai/sessions";
import { isGrokPayload, type WaitingHint } from "./ai/types";
import type { Risk } from "./risk";
import { t } from "./i18n";

export const PERMISSION_TIMEOUT_MS = 55_000;
export const SUMMARY_MAX = 300;
export type PermissionSource = "claude" | "codex" | "opencode";
export type Decision = "allow" | "deny";

export interface PermissionRequest {
  id: string;
  source: PermissionSource;
  project: string;
  tool: string;
  summary: string;
  detail?: string;
  risk: Risk;
  riskReason?: string;
  sessionId?: string;
  createdAt: number;
  expiresAt: number;
}

/** What the hook process posts to /api/hooks/permission (the tool's own hook JSON, trimmed). */
export interface HookInput {
  source: PermissionSource;
  sessionId?: string;
  cwd?: string;
  toolName: string;
  toolInput?: unknown;
}

const trunc = (s: string, n = SUMMARY_MAX) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Short human summary of a tool call: Bash -> command, Edit/Write -> path, MCP -> server/tool. */
export function summarizeTool(toolName: string, input: unknown): { summary: string; detail?: string } {
  const i: any = input && typeof input === "object" ? input : {};
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  if (mcp) return { summary: trunc(`${mcp[1]}/${mcp[2]}`) };
  const cmd = Array.isArray(i.command) ? i.command.join(" ") : i.command;
  if (typeof cmd === "string" && cmd) {
    return { summary: trunc(cmd), ...(typeof i.description === "string" && i.description ? { detail: trunc(i.description) } : {}) };
  }
  const path = i.file_path ?? i.path ?? i.notebook_path;
  if (typeof path === "string" && path) return { summary: trunc(path) };
  if (typeof i.url === "string") return { summary: trunc(i.url) };
  if (typeof i.pattern === "string") return { summary: trunc(i.pattern) };
  return { summary: trunc(toolName) };
}


export interface BrokerHooks {
  /** Anyone able to answer (a connected phone). */
  hasPhones: () => boolean;
  notify: (req: PermissionRequest) => void;
  resolved: (id: string, decision: Decision | "timeout") => void;
}

/** Risk shown next to a request (display only, it never decides anything). */
export interface RequestExtra {
  risk: Risk;
  riskReason?: string;
}

interface Pending {
  req: PermissionRequest;
  hint: WaitingHint;
  settle: (d: Decision | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Holds pending permission requests. The first answer wins; a timeout or a closed hook resolves to "timeout". */
export class PermissionBroker {
  private pending = new Map<string, Pending>();

  constructor(private hooks: BrokerHooks, private timeoutMs = PERMISSION_TIMEOUT_MS) {}

  /** Resolves with the decision, or null (nobody can answer, timeout, or cancelled). */
  request(input: HookInput, signal?: AbortSignal, extra: RequestExtra = { risk: "low" }): Promise<Decision | null> {
    if (!this.hooks.hasPhones()) return Promise.resolve(null);
    const now = Date.now();
    const { summary, detail } = summarizeTool(input.toolName, input.toolInput);
    const req: PermissionRequest = {
      id: randomBytes(8).toString("hex"),
      source: input.source,
      project: input.cwd ? projectName(input.cwd) : input.source,
      tool: input.toolName,
      summary,
      ...(detail ? { detail } : {}),
      risk: extra.risk,
      ...(extra.riskReason ? { riskReason: extra.riskReason } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    };
    return new Promise((resolve) => {
      const finish = (d: Decision | null) => {
        const p = this.pending.get(req.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(req.id);
        this.hooks.resolved(req.id, d ?? "timeout");
        resolve(d);
      };
      const timer = setTimeout(() => finish(null), this.timeoutMs);
      this.pending.set(req.id, { req, hint: { source: input.source, sessionId: input.sessionId, cwd: input.cwd }, settle: finish, timer });
      signal?.addEventListener("abort", () => finish(null), { once: true });
      this.hooks.notify(req);
    });
  }

  /** First answer wins. Returns false when the id is unknown or already resolved. */
  answer(id: string, decision: Decision): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.settle(decision);
    return true;
  }

  list(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  hints(): WaitingHint[] {
    return [...this.pending.values()].map((p) => p.hint);
  }

  get size(): number {
    return this.pending.size;
  }

  clear() {
    for (const p of this.pending.values()) p.settle(null);
  }
}

// ---------- shared secret ----------

export const hookSecretPath = () => join(HOME, "hook-secret");

/** Creates ~/.nookdeck/hook-secret (0600) on first use and returns it. */
export async function ensureHookSecret(file = hookSecretPath()): Promise<string> {
  try {
    const s = (await readFile(file, "utf8")).trim();
    if (s) return s;
  } catch {
    // create below
  }
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const secret = randomBytes(24).toString("hex");
  await writeFile(file, secret + "\n", { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return secret;
}

export function secretMatches(given: string | null | undefined, secret: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validates the body posted by `nookdeck hook`. */
export function parseHookInput(body: any): HookInput | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  if (body.source !== "claude" && body.source !== "codex" && body.source !== "opencode") return { error: "source must be claude, codex or opencode" };
  if (typeof body.toolName !== "string" || !body.toolName) return { error: "toolName is required" };
  return {
    source: body.source,
    toolName: body.toolName.slice(0, 200),
    ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    toolInput: body.toolInput,
  };
}

// ---------- hook process side (`nookdeck hook claude|codex`) ----------

/** The JSON a tool expects on stdout for a decision, or null to print nothing (the tool then asks in the terminal). */
export function formatHookOutput(decision: Decision | null | undefined): string | null {
  if (decision !== "allow" && decision !== "deny") return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: t("Denied from Nookdeck") },
    },
  });
}

/** Maps the tool's hook stdin JSON to the agent request body. Returns null for an unusable payload. */
export function hookInputFromStdin(source: PermissionSource, stdin: string): HookInput | null {
  try {
    const o = JSON.parse(stdin);
    if (isGrokPayload(o)) return null; // Grok reads ~/.claude/settings.json too: never forward its tool calls as Claude's
    const toolName = o?.tool_name ?? o?.toolName;
    if (typeof toolName !== "string" || !toolName) return null;
    return {
      source,
      toolName,
      toolInput: o.tool_input ?? o.toolInput,
      ...(typeof (o.session_id ?? o.sessionId) === "string" ? { sessionId: o.session_id ?? o.sessionId } : {}),
      ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}),
    };
  } catch {
    return null;
  }
}

/** Runs the hook: stdin -> agent long-poll -> stdout JSON. Always exits 0; prints nothing when there is no decision. */
export async function runHook(
  source: PermissionSource,
  io: { stdin: string; port: number; secret: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<string | null> {
  const input = hookInputFromStdin(source, io.stdin);
  if (!input) return null;
  const ctl = new AbortController(); // explicit timer: AbortSignal.timeout is not reliable on Windows
  const timer = setTimeout(() => ctl.abort(), io.timeoutMs ?? 58_000);
  try {
    const res = await (io.fetch ?? fetch)(`http://127.0.0.1:${io.port}/api/hooks/permission`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nookdeck-hook": io.secret },
      body: JSON.stringify(input),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return formatHookOutput(((await res.json()) as any)?.decision);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
