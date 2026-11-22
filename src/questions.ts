import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "./platform";
import { macIdleSeconds } from "./platform/darwin";
import { HOME } from "./config";
import { projectName } from "./ai/sessions";
import { isGrokPayload, type WaitingHint } from "./ai/types";
import { t as tr } from "./i18n";

/** The hook's own timeout is 600 s; the agent gives up a little earlier so the hook can answer "nothing" in time. */
export const QUESTION_TIMEOUT_MS = 590_000;
export const AWAY_IDLE_SECONDS = 60;
const TEXT_MAX = 500;

export interface QuestionOption { label: string; description?: string }
export interface Question { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean }
export interface QuestionRequest {
  id: string;
  /** Who asks: Claude Code (default) or the OpenCode plugin. */
  source?: "claude" | "opencode";
  project: string;
  sessionId?: string;
  questions: Question[];
  createdAt: number;
  expiresAt: number;
}
export type Answers = Record<string, string>;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validates what the hook posts: {sessionId?, cwd?, questions[1-4]}. Trims every text. */
export function parseQuestionInput(body: any): { questions: Question[]; sessionId?: string; cwd?: string; source?: "claude" | "opencode" } | { error: string } {
  if (!isObj(body)) return { error: "body must be an object" };
  const qs = body.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return { error: "questions must have 1-4 items" };
  const seen = new Set<string>();
  const questions: Question[] = [];
  for (const [i, q] of qs.entries()) {
    if (!isObj(q) || typeof q.question !== "string" || !q.question.trim()) return { error: `questions[${i}].question is required` };
    if (seen.has(q.question)) return { error: `questions[${i}] repeats an earlier question` };
    seen.add(q.question);
    if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 12) return { error: `questions[${i}].options must have 1-12 items` };
    const labels = new Set<string>();
    const options: QuestionOption[] = [];
    for (const [j, o] of q.options.entries()) {
      if (!isObj(o) || typeof o.label !== "string" || !o.label.trim()) return { error: `questions[${i}].options[${j}].label is required` };
      if (labels.has(o.label)) return { error: `questions[${i}] has a duplicate option label "${o.label}"` };
      labels.add(o.label);
      options.push({ label: o.label.slice(0, 200), ...(typeof o.description === "string" && o.description ? { description: o.description.slice(0, 500) } : {}) });
    }
    questions.push({ question: q.question.slice(0, 1000), ...(typeof q.header === "string" && q.header ? { header: q.header.slice(0, 40) } : {}), options, ...(q.multiSelect ? { multiSelect: true } : {}) });
  }
  return { questions, ...(body.source === "opencode" ? { source: "opencode" as const } : {}), ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}), ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}) };
}

/**
 * Checks the phone's answers against the questions and returns them in the form Claude Code expects
 * (`{questionText: label}`, multiSelect labels joined with ", "). Keys must be exactly the question texts. A value must be
 * an option label (multiSelect: labels, as one comma-joined string or an array); free text only for the questions listed in `other`.
 */
export function validateAnswers(questions: Question[], answers: unknown, other: unknown = []): { answers: Answers } | { error: string } {
  if (!isObj(answers)) return { error: "answers must be an object {question: answer}" };
  const texts = questions.map((q) => q.question);
  const unknown = Object.keys(answers).filter((k) => !texts.includes(k));
  if (unknown.length) return { error: tr("questions not in the request: {list}", { list: unknown.map((k) => `"${k.slice(0, 60)}"`).join(", ") }) };
  const missing = texts.filter((t) => !(t in answers));
  if (missing.length) return { error: tr("missing answers for: {list}", { list: missing.map((k) => `"${k.slice(0, 60)}"`).join(", ") }) };
  const free = new Set(Array.isArray(other) ? other.filter((x): x is string => typeof x === "string") : []);
  const out: Answers = {};
  for (const q of questions) {
    const raw = (answers as any)[q.question];
    const labels = q.options.map((o) => o.label);
    if (free.has(q.question)) {
      const t = typeof raw === "string" ? raw.trim() : "";
      if (!t) return { error: tr("the typed answer for \"{q}\" is empty", { q: q.question.slice(0, 60) }) };
      out[q.question] = t.slice(0, TEXT_MAX);
      continue;
    }
    if (q.multiSelect) {
      const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? (labels.includes(raw) ? [raw] : raw.split(",").map((s: string) => s.trim())) : null;
      if (!parts || parts.length === 0 || parts.some((p) => typeof p !== "string" || !labels.includes(p))) return { error: tr("choose from the available labels for \"{q}\" ({labels})", { q: q.question.slice(0, 60), labels: labels.join(", ") }) };
      const uniq = [...new Set(parts as string[])];
      out[q.question] = labels.filter((l) => uniq.includes(l)).join(", ");
      continue;
    }
    if (typeof raw !== "string" || !labels.includes(raw)) return { error: tr("\"{a}\" is not an option of \"{q}\"", { a: String(raw).slice(0, 60), q: q.question.slice(0, 60) }) };
    out[q.question] = raw;
  }
  return { answers: out };
}

export type QuestionEnd = "answered" | "released" | "timeout" | "cancelled";

export interface QuestionHooks {
  hasPhones: () => boolean;
  notify: (req: QuestionRequest) => void;
  resolved: (id: string, how: QuestionEnd) => void;
}

interface Pending {
  req: QuestionRequest;
  hint: WaitingHint;
  settle: (a: Answers | null, how: QuestionEnd) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Pending questions from Claude Code. First answer wins; a release, timeout or closed hook gives null (Claude asks in the terminal). */
export class QuestionBroker {
  private pending = new Map<string, Pending>();
  constructor(private hooks: QuestionHooks, private timeoutMs = QUESTION_TIMEOUT_MS) {}

  request(input: { questions: Question[]; sessionId?: string; cwd?: string; source?: "claude" | "opencode" }, signal?: AbortSignal): Promise<Answers | null> {
    if (!this.hooks.hasPhones()) return Promise.resolve(null);
    const now = Date.now();
    const req: QuestionRequest = {
      id: randomBytes(8).toString("hex"),
      ...(input.source && input.source !== "claude" ? { source: input.source } : {}),
      project: input.cwd ? projectName(input.cwd) : input.source ?? "claude",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      questions: input.questions,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
    };
    return new Promise((resolve) => {
      const finish = (a: Answers | null, how: QuestionEnd) => {
        const p = this.pending.get(req.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(req.id);
        this.hooks.resolved(req.id, how);
        resolve(a);
      };
      const timer = setTimeout(() => finish(null, "timeout"), this.timeoutMs);
      this.pending.set(req.id, { req, hint: { source: input.source ?? "claude", sessionId: input.sessionId, cwd: input.cwd }, settle: finish, timer });
      signal?.addEventListener("abort", () => finish(null, "cancelled"), { once: true });
      this.hooks.notify(req);
    });
  }

  /** Validates and settles. Returns an error message for a bad answer (the question stays open), or null when it was taken. */
  answer(id: string, answers: unknown, other?: unknown): { ok: true } | { ok: false; error: string } {
    const p = this.pending.get(id);
    if (!p) return { ok: false, error: tr("question already answered or expired") };
    const v = validateAnswers(p.req.questions, answers, other);
    if ("error" in v) return { ok: false, error: v.error };
    p.settle(v.answers, "answered");
    return { ok: true };
  }

  /** The phone hands the question back to the terminal. */
  release(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.settle(null, "released");
    return true;
  }

  list(): QuestionRequest[] { return [...this.pending.values()].map((p) => p.req); }
  hints(): WaitingHint[] { return [...this.pending.values()].map((p) => p.hint); }
  get size() { return this.pending.size; }
  clear() { for (const p of [...this.pending.values()]) p.settle(null, "cancelled"); }
}

// ---------- "only when I am away from the keyboard" ----------

/** Seconds since the last keyboard/mouse input (macOS HIDIdleTime, Windows GetLastInputInfo), or null when unknown. */
export async function readIdleSeconds(run?: (argv: string[]) => Promise<string>, id?: NodeJS.Platform): Promise<number | null> {
  // an injected runner / platform id is the macOS `ioreg` path with fakes (tests); otherwise ask this OS
  if (run || id) return (id ?? "darwin") === "darwin" ? macIdleSeconds(run) : null;
  return platform.idleSeconds();
}

export interface AskSettings { onlyWhenAway: boolean }

export class AskSettingsStore {
  constructor(private file: string = join(HOME, "ask-hook.json")) {}
  async get(): Promise<AskSettings> {
    try { return { onlyWhenAway: JSON.parse(await readFile(this.file, "utf8"))?.onlyWhenAway === true }; } catch { return { onlyWhenAway: false }; }
  }
  async set(s: Partial<AskSettings>): Promise<AskSettings> {
    const next = { ...(await this.get()), ...(typeof s.onlyWhenAway === "boolean" ? { onlyWhenAway: s.onlyWhenAway } : {}) };
    await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
    return next;
  }
}

// ---------- hook process side (`nookdeck hook claude-ask`) ----------

/** The PreToolUse JSON Claude Code expects: allow, with the original input plus the answers. */
export function formatAskOutput(toolInput: Record<string, any>, answers: Answers): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...toolInput, questions: toolInput.questions, answers },
    },
  });
}

/** stdin -> agent long-poll -> stdout. Prints nothing (null) for any other tool, no phone, release, timeout or agent down. */
export async function runAskHook(io: { stdin: string; port: number; secret: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<string | null> {
  let o: any;
  try { o = JSON.parse(io.stdin); } catch { return null; }
  if (isGrokPayload(o)) return null; // a Grok payload through ~/.claude/settings.json: print nothing
  if ((o?.tool_name ?? o?.toolName) !== "AskUserQuestion") return null;
  const toolInput = o.tool_input ?? o.toolInput;
  if (!isObj(toolInput) || !Array.isArray(toolInput.questions)) return null;
  // an explicit timer, not AbortSignal.timeout: Bun on Windows does not always fire the latter while nothing else keeps the loop alive
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), io.timeoutMs ?? 590_000);
  try {
    const res = await (io.fetch ?? fetch)(`http://127.0.0.1:${io.port}/api/hooks/question`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-nookdeck-hook": io.secret },
      body: JSON.stringify({ questions: toolInput.questions, ...(typeof (o.session_id ?? o.sessionId) === "string" ? { sessionId: o.session_id ?? o.sessionId } : {}), ...(typeof o.cwd === "string" ? { cwd: o.cwd } : {}) }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const answers = ((await res.json()) as any)?.answers;
    if (!isObj(answers) || Object.keys(answers).length === 0) return null;
    return formatAskOutput(toolInput, answers as Answers);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
