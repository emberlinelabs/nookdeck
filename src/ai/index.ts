import { claudeDir, claudeKeychainService, fetchClaudeQuota } from "./claude";
import { codexDir, fetchCodexQuota } from "./codex";
import type { AccountStore, AiAccountRef } from "./accounts";
import { fetchAntigravityQuota } from "./antigravity";
import { fetchOpencodeQuota, detectOpencode, readOpencodeSessions, activeOpencodeSessions } from "./opencode";
import { grokQuota, readGrokSessions } from "./grok";
import { withToolState, type ToolStates } from "./states";
import { listSessions, MAX_SESSIONS } from "./sessions";
import type { QuotaHistory } from "./history";
import { t } from "../i18n";
import type { AiProviderId, AiSession, AiSnapshot, ProviderQuota, QuotaAccount, WaitingHint } from "./types";

export * from "./types";
import { QUOTA_SOURCE } from "./types";

/** The read-only readers (Claude Code's usage API, Codex files, agy) run at most this often. */
export const LOCAL_REFRESH_MS = 5 * 60_000;
/** The hub checks whether a refresh is due at most this often. */
export const QUOTA_REFRESH_MS = 60_000;

export interface AiSources {
  claude: (last?: ProviderQuota) => Promise<ProviderQuota>;
  codex: () => Promise<ProviderQuota>;
  antigravity: (force?: boolean) => Promise<ProviderQuota>;
  /** Optional: a source set without them (older tests) shows these providers as "not read". */
  opencode?: () => Promise<ProviderQuota>;
  grok?: () => Promise<ProviderQuota>;
  sessions: (hints: WaitingHint[]) => Promise<AiSession[]>;
}

/**
 * Reads every account of a tool and merges them: the provider keeps the default account's reading (so a single-account setup
 * looks as before), and with two or more accounts `accounts` lists each one by id and name. Each account keeps its own last
 * reading for the "stale" fallback.
 */
export function multiAccount(
  /** the provider a failed read with no earlier reading stands for */
  provider: { id: AiProviderId; name: string },
  refs: AiAccountRef[],
  read: (ref: AiAccountRef, last?: ProviderQuota) => Promise<ProviderQuota>,
  lastBy: Map<string, ProviderQuota>,
): Promise<ProviderQuota> {
  return Promise.all(refs.map(async (r) => {
    let q: ProviderQuota;
    try { q = await read(r, lastBy.get(r.id)); } catch (err: any) {
      const l = lastBy.get(r.id);
      q = { id: provider.id, name: l?.name ?? provider.name, windows: l?.windows ?? [], error: String(err?.message ?? err), updatedAt: Date.now(), ...(l?.windows.length ? { stale: true } : {}) };
    }
    lastBy.set(r.id, q);
    return { r, q };
  })).then((all) => {
    for (const k of [...lastBy.keys()]) if (!refs.some((r) => r.id === k)) lastBy.delete(k); // removed accounts
    const base = all[0]!.q;
    if (all.length < 2) return base;
    const accounts: QuotaAccount[] = all.map(({ r, q }) => ({
      id: r.id,
      label: r.name,
      ...(q.plan ? { plan: q.plan } : {}),
      windows: q.windows,
      ...(q.status ? { status: q.status } : {}),
      ...(q.stale ? { stale: true } : {}),
      ...(q.error ? { error: q.error } : {}),
      fetchedAt: q.updatedAt,
    }));
    return { ...base, accounts };
  });
}

const defaultRef = (dir: string): AiAccountRef[] => [{ id: "default", name: "", dir, isDefault: true }];

export const realAiSources = (states?: ToolStates, accounts?: AccountStore): AiSources => {
  const lastClaude = new Map<string, ProviderQuota>(), lastCodex = new Map<string, ProviderQuota>();
  return {
  claude: () => multiAccount({ id: "claude", name: "Claude" }, accounts?.list("claude") ?? defaultRef(claudeDir()), (r, last) =>
    fetchClaudeQuota(r.isDefault ? {} : { dir: r.dir, keychainService: claudeKeychainService(r.dir, false) }, last), lastClaude),
  codex: () => multiAccount({ id: "codex", name: "Codex" }, accounts?.list("codex") ?? defaultRef(codexDir()), (r) => fetchCodexQuota(r.isDefault ? undefined : r.dir), lastCodex),
  antigravity: (force) => fetchAntigravityQuota(undefined, undefined, undefined, { force }),
  opencode: async () => fetchOpencodeQuota({ version: await detectOpencode() }),
  grok: () => grokQuota(),
  sessions: async (hints) => {
    const [base, oc, active, grok] = await Promise.all([
      listSessions(hints),
      Promise.resolve().then(() => readOpencodeSessions()).catch(() => [] as AiSession[]),
      activeOpencodeSessions().catch(() => [] as string[]),
      readGrokSessions({ states }).catch(() => [] as AiSession[]),
    ]);
    const opencode = oc.map((s) => {
      let r: AiSession = active.includes(s.id) ? { ...s, state: "working", running: true } : s;
      r = withToolState(r, states?.get("opencode", s.id));
      const prompt = hints.some((h) => h.source === "opencode" && (h.sessionId ? h.sessionId === s.id : false));
      return prompt ? { ...r, state: "waiting" as const, prompt: true as const } : r;
    });
    const grokOut = grok.map((s) => (hints.some((h) => h.source === "grok" && h.sessionId === s.id) ? { ...s, state: "waiting" as const, prompt: true as const } : s));
        return [...base, ...opencode, ...grokOut].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
  },
  };
};

const ORDER: AiProviderId[] = ["claude", "codex", "antigravity", "opencode", "grok"];
const NAMES: Record<AiProviderId, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", grok: "Grok" };

/**
 * Keeps the latest quotas and sessions; a refresh reports whether the snapshot changed.
 * Quotas are read-only (no own sign-in): Claude Code's token, Codex's local session files, local Antigravity tools.
 * Each reader runs at most every 5 minutes.
 */
export class AiHub {
  private providers = new Map<AiProviderId, ProviderQuota>();
  private local = new Map<AiProviderId, { q: ProviderQuota; at: number }>();
  private sessions: AiSession[] = [];
  private quotaAt = Number.NEGATIVE_INFINITY;
  private quotaBusy = false;
  /** the read in progress: a second caller (the manage page asks from two places at once) waits for it instead of answering "Reading…" */
  private quotaRun: Promise<void> | undefined;
  private sessionsBusy = false;
  private lastJson = "";

  constructor(private src: AiSources, private now: () => number = Date.now, private history?: QuotaHistory) {}

  snapshot(): AiSnapshot {
    const providers = ORDER.map(
      (id) => this.providers.get(id) ?? { id, name: NAMES[id], windows: [], error: t("Reading…"), updatedAt: 0 },
    );
    return { providers: this.history ? this.history.decorate(providers) : providers, sessions: this.sessions };
  }

  get quotasStale(): boolean {
    return this.now() - this.quotaAt >= QUOTA_REFRESH_MS;
  }

  private changed(): boolean {
    const json = JSON.stringify(this.snapshot());
    if (json === this.lastJson) return false;
    this.lastJson = json;
    return true;
  }

  private async localQuota(id: AiProviderId, force = false): Promise<ProviderQuota> {
    const cached = this.local.get(id);
    if (!force && cached && this.now() - cached.at < LOCAL_REFRESH_MS) return cached.q;
    let q: ProviderQuota;
    try {
      const fn = id === "claude" ? undefined : this.src[id];
      q = id === "claude" ? await this.src.claude(cached?.q) : fn ? await (id === "antigravity" ? this.src.antigravity(force) : fn()) : { id, name: NAMES[id], windows: [], error: t("Reading…"), updatedAt: this.now() };
    } catch (err: any) {
      q = { id, name: NAMES[id], windows: cached?.q.windows ?? [], error: String(err?.message ?? err), updatedAt: this.now() };
    }
    q = { ...q, source: QUOTA_SOURCE[id] };
    this.local.set(id, { q, at: this.now() });
    return q;
  }

  /** Reads the quotas. At most once per minute unless forced. True when the snapshot changed. */
  async refreshQuotas(force = false): Promise<boolean> {
    if (this.quotaBusy) { await this.quotaRun?.catch(() => {}); return false; }
    if (!force && !this.quotasStale) return false;
    this.quotaBusy = true;
    this.quotaAt = this.now();
    this.quotaRun = (async () => {
      await Promise.all(ORDER.map(async (id) => { this.providers.set(id, await this.localQuota(id, force)); }));
      this.history?.record([...this.providers.values()]);
    })();
    try {
      await this.quotaRun;
    } finally {
      this.quotaBusy = false;
      this.quotaRun = undefined;
    }
    return this.changed();
  }

  async refreshSessions(hints: WaitingHint[]): Promise<boolean> {
    if (this.sessionsBusy) return false;
    this.sessionsBusy = true;
    try {
      this.sessions = await this.src.sessions(hints).catch(() => this.sessions);
    } finally {
      this.sessionsBusy = false;
    }
    return this.changed();
  }
}
