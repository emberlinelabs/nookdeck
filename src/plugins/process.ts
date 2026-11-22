/**
 * The agent's side of code plugins (spec D3): one child process per enabled code plugin (`nookdeck __plugin-host <dir>`), started lazily,
 * pinged to catch a hang, restarted with backoff after a crash, stopped when idle. A crash or hang in one plugin touches nothing else.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  CALL_TIMEOUT_MS, IDLE_STOP_MS, PING_INTERVAL_MS, PING_TIMEOUT_MS, RESTART_BACKOFF_MS, RESTART_MAX, RESTART_RESET_MS, RPC_ERR,
  type ActionRunParams, type InitParams, type InitResult, type Settings, type WidgetUpdate,
} from "./api";
import { PluginServices, type ServiceDeps } from "./capabilities";
import { RpcCallError, RpcFault, RpcPeer } from "./rpc";

export type ProcState = "running" | "stopped" | "crashed" | "failed";

export interface ChildLike {
  pid?: number;
  /** Text to the child's stdin. */
  write(s: string): void;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(): void;
  exited: Promise<number>;
}
export type SpawnFn = (argv: string[], env: Record<string, string>) => ChildLike;

/** The environment a plugin host gets: nothing of the agent's own (no tokens, no NOOKDECK_*). */
export function hostEnv(src: Record<string, string | undefined> = process.env): Record<string, string> {
  const keep = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG", "LC_ALL"];
  const out: Record<string, string> = { NOOKDECK_PLUGIN_HOST: "1", BUN_OPTIONS: "--no-install" }; // no npm auto-install: a plugin never pulls code from the network
  for (const k of keep) if (src[k]) out[k] = src[k]!;
  return out;
}

export const realSpawn: SpawnFn = (argv, env) => {
  const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env, windowsHide: true } as any);
  return {
    pid: p.pid,
    write: (s) => { (p.stdin as any).write(s); (p.stdin as any).flush?.(); },
    stdout: p.stdout as any, stderr: p.stderr as any,
    kill: () => { try { p.kill("SIGKILL"); } catch { /* gone */ } },
    exited: p.exited,
  };
};

/** `[<this program>, ..., "__plugin-host", <dir>]`: the compiled binary runs itself; from source it runs bun on src/index.ts. */
export function hostArgv(dir: string, execPath = process.execPath, indexPath = join(import.meta.dir, "..", "index.ts")): string[] {
  const isBun = /^bun(\.exe)?$/i.test(basename(execPath));
  return [...(isBun ? [execPath, indexPath] : [execPath]), "__plugin-host", dir];
}

// ---------- the log file ----------

const LOG_MAX = 512 * 1024;
/** ~/.nookdeck/logs/plugins/<id>.log, trimmed to its newest half when it passes 512 KB. */
export class PluginLog {
  constructor(readonly file: string) {}
  append(text: string): void {
    try {
      mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
      if (existsSync(this.file) && statSync(this.file).size > LOG_MAX) {
        const keep = readFileSync(this.file, "utf8").slice(-LOG_MAX / 2);
        writeFileSync(`${this.file}.tmp`, keep.slice(keep.indexOf("\n") + 1), { mode: 0o600 });
        renameSync(`${this.file}.tmp`, this.file);
      }
      const stamp = new Date().toISOString();
      appendFileSync(this.file, text.split("\n").filter((l) => l !== "").map((l) => `${stamp} ${l.slice(0, 4000)}\n`).join(""), { mode: 0o600 });
    } catch { /* logging must never break a plugin */ }
  }
  tail(lines: number): string[] {
    try { return readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-Math.max(1, Math.min(lines, 1000))); } catch { return []; }
  }
}

// ---------- one plugin's process ----------

export interface ProcessOptions {
  id: string;
  /** Where the plugin's files are (the `<dir>` argument of the host). */
  dir: string;
  /** Absolute path of the entry module. */
  entry: string;
  version: string;
  spawn?: SpawnFn;
  argv?: string[];
  log: PluginLog;
  services: PluginServices;
  granted: () => InitParams["granted"];
  settings: () => Settings;
  /** Timing (tests use small values). */
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  callTimeoutMs?: number;
  idleStopMs?: number;
  backoffMs?: readonly number[];
  restartResetMs?: number;
  restartMax?: number;
  onPush?: (update: { widgetId: string; update: WidgetUpdate }) => void;
  /** After too many crashes in a row: the plugin is given up on. */
  onFailed?: (message: string) => void;
  /** The widget refresh intervals the plugin registered, in seconds (after every (re)start). */
  onRegistered?: (r: InitResult) => void;
}

export interface ProcessInfo { state: ProcState; pid?: number; restarts: number; lastError?: string; startedAt?: number }

export class PluginProcess {
  private child: ChildLike | null = null;
  private peer: RpcPeer | null = null;
  private starting: Promise<void> | null = null;
  private state: ProcState = "stopped";
  private restarts = 0;
  private consecutive = 0;
  private lastError: string | undefined;
  private startedAt: number | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private wanted = true;
  private stopRequested = false;
  registered: InitResult = { widgets: [], actions: [] };

  constructor(private o: ProcessOptions) {}

  info(): ProcessInfo {
    return { state: this.state, ...(this.child?.pid ? { pid: this.child.pid } : {}), restarts: this.restarts, ...(this.lastError ? { lastError: this.lastError } : {}), ...(this.startedAt ? { startedAt: this.startedAt } : {}) };
  }

  /** Starts the host if it is not running; concurrent callers share one start. */
  ensureStarted(): Promise<void> {
    if (this.state === "running") return Promise.resolve();
    if (this.state === "failed") return Promise.reject(new Error(this.lastError ?? "the plugin keeps crashing"));
    if (this.state === "crashed") return Promise.reject(new Error("the plugin crashed and is restarting"));
    this.wanted = true;
    this.stopRequested = false;
    return (this.starting ??= this.start().finally(() => { this.starting = null; }));
  }

  private async start(): Promise<void> {
    const spawn = this.o.spawn ?? realSpawn;
    const child = spawn(this.o.argv ?? hostArgv(this.o.dir), hostEnv());
    this.child = child;
    const peer = new RpcPeer((l) => child.write(l), {
      request: (method, params) => this.o.services.request(method, params),
      notify: (method, params) => {
        if (method === "log") this.o.log.append(((params?.args ?? []) as unknown[]).map(String).join(" "));
        else if (method === "widget.push" && typeof params?.id === "string") this.o.onPush?.({ widgetId: params.id, update: params.update });
      },
      onGarbage: (line) => this.o.log.append(`[stdout] ${line}`),
    });
    this.peer = peer;
    const pump = async (s: ReadableStream<Uint8Array>, on: (t: string) => void) => {
      const dec = new TextDecoder();
      try { for await (const c of s as any) on(dec.decode(c, { stream: true })); } catch { /* closed */ }
    };
    void pump(child.stdout, (t) => peer.feed(t));
    void pump(child.stderr, (t) => this.o.log.append(`[stderr] ${t.trimEnd()}`));
    const began = Date.now();
    void child.exited.then((code) => this.exited(child, code, began));
    const params: InitParams = { protocol: 1, id: this.o.id, version: this.o.version, entry: this.o.entry, granted: this.o.granted(), settings: this.o.settings() };
    try {
      this.registered = await peer.call<InitResult>("init", params, this.o.callTimeoutMs ?? CALL_TIMEOUT_MS);
    } catch (e: any) {
      this.lastError = String(e?.message ?? e).slice(0, 300);
      if ((e as any)?.data?.fatal) this.fatal = true; // a load or syntax error: restarting would fail the same way
      this.o.log.append(`[agent] start failed: ${this.lastError}`);
      this.kill(child);
      throw new Error(this.lastError);
    }
    this.state = "running";
    this.startedAt = Date.now();
    this.pingTimer = setInterval(() => void this.heartbeat(child), this.o.pingIntervalMs ?? PING_INTERVAL_MS);
    (this.pingTimer as any).unref?.();
    this.touch();
    this.o.onRegistered?.(this.registered);
  }

  private async heartbeat(child: ChildLike): Promise<void> {
    if (this.child !== child || this.state !== "running") return;
    try { await this.peer!.call("ping", undefined, this.o.pingTimeoutMs ?? PING_TIMEOUT_MS); }
    catch {
      if (this.child !== child) return;
      this.lastError = "the plugin stopped answering and was killed";
      this.o.log.append(`[agent] ${this.lastError}`);
      this.kill(child);
    }
  }

  private fatal = false;

  private kill(child: ChildLike): void { try { child.kill(); } catch { /* gone */ } }

  private exited(child: ChildLike, code: number, began: number): void {
    if (this.child !== child) return; // an old process of an earlier start
    clearInterval(this.pingTimer);
    clearTimeout(this.idleTimer);
    this.peer?.close("the plugin process ended");
    this.child = null; this.peer = null; this.startedAt = undefined;
    if (this.stopRequested) { this.state = "stopped"; return; }
    if (this.fatal) {
      this.fatal = false;
      this.state = "failed";
      this.o.onFailed?.(this.lastError ?? "the plugin cannot be loaded");
      return;
    }
    // a crash (or a kill after a hang): restart with backoff
    const ranMs = Date.now() - began;
    if (ranMs >= (this.o.restartResetMs ?? RESTART_RESET_MS)) this.consecutive = 0;
    this.consecutive++;
    this.restarts++;
    this.lastError ??= `the plugin process ended (exit code ${code})`;
    this.o.log.append(`[agent] process ended with code ${code}; restart ${this.consecutive}`);
    if (this.consecutive > (this.o.restartMax ?? RESTART_MAX)) {
      this.state = "failed";
      this.lastError = `the plugin crashed ${this.consecutive} times in a row and was stopped`;
      this.o.onFailed?.(this.lastError);
      return;
    }
    this.state = "crashed";
    const table = this.o.backoffMs ?? RESTART_BACKOFF_MS;
    const wait = table[Math.min(this.consecutive - 1, table.length - 1)]!;
    this.restartTimer = setTimeout(() => {
      if (!this.wanted || this.state !== "crashed") return;
      this.state = "stopped";
      this.ensureStarted().catch(() => { /* a failed start is a crash too: exited() handles the next round */ });
    }, wait);
    (this.restartTimer as any).unref?.();
    // a start that failed before "running" has no ping and may leave nothing to schedule the next round: handled by exited() above
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop(), this.o.idleStopMs ?? IDLE_STOP_MS);
    (this.idleTimer as any).unref?.();
  }

  /** One call into the plugin. Errors: RpcCallError (the plugin threw, timed out, ...) or Error (could not start). */
  async call<T>(method: "widget.get" | "action.run", params: { id: string; settings: Settings } & Partial<ActionRunParams>): Promise<T> {
    await this.ensureStarted();
    this.touch();
    try { return await this.peer!.call<T>(method, params, this.o.callTimeoutMs ?? CALL_TIMEOUT_MS); }
    catch (e) {
      if (e instanceof RpcCallError && e.code === RPC_ERR.timeout) this.o.log.append(`[agent] ${method} ${params.id} timed out`);
      throw e;
    }
  }

  notifySettings(settings: Settings): void { this.peer?.notify("settings.changed", { settings }); }

  /** Stops the host (deactivate() runs; killed after 2 s). It starts again on the next call. */
  async stop(): Promise<void> {
    this.wanted = false;
    this.stopRequested = true;
    clearTimeout(this.restartTimer); clearTimeout(this.idleTimer); clearInterval(this.pingTimer);
    const child = this.child;
    if (!child) { if (this.state !== "failed") this.state = "stopped"; return; }
    this.state = "stopped";
    this.peer?.notify("shutdown");
    await Promise.race([child.exited, new Promise((r) => setTimeout(r, 2000))]);
    if (this.child === child) { this.kill(child); await Promise.race([child.exited, new Promise((r) => setTimeout(r, 500))]); }
  }

  /** Stop, forget the failure and let the next call start it again. */
  async restart(): Promise<void> {
    await this.stop();
    this.state = "stopped"; this.consecutive = 0; this.lastError = undefined; this.wanted = true; this.stopRequested = false;
  }
}

export { RpcFault };
export type { ServiceDeps };
