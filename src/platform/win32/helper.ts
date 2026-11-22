import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HELPER_SCRIPT from "./helper.ps1" with { type: "text" };

/**
 * The long-lived PowerShell helper (media session, audio volume, app list and icons, image resize, process list).
 * One JSON object per line each way. Requests are plain data and only name fixed commands, so nothing a phone
 * sends is ever run as code. Restarted on the next call when it dies or hangs.
 */
export interface HelperProc {
  write(line: string): void;
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
  exited: Promise<number>;
}
export type HelperSpawn = (argv: string[]) => HelperProc;

export const realHelperSpawn: HelperSpawn = (argv) => {
  const p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true } as any) as any;
  return {
    write: (line) => { p.stdin.write(line); p.stdin.flush(); },
    stdout: p.stdout,
    kill: () => { try { p.kill(); } catch { /* gone */ } },
    exited: p.exited,
  };
};

/** Where the script is written: a file named by its content hash, so an update never runs a stale copy. */
export function scriptPath(script = HELPER_SCRIPT, dir = tmpdir()): string {
  const hash = createHash("sha256").update(script).digest("hex").slice(0, 12);
  return join(dir, `nookdeck-helper-${hash}.ps1`);
}

export function helperArgv(file: string): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", file];
}

/** JSON that is pure ASCII (non-ASCII as \uXXXX), so the pipe encoding can never garble a path or a name. */
export const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class WinHelper {
  private proc: HelperProc | undefined;
  private ready: Promise<void> | undefined;
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor(private opts: { spawn?: HelperSpawn; script?: string; dir?: string; startTimeoutMs?: number } = {}) {}

  private start(): Promise<void> {
    const script = this.opts.script ?? HELPER_SCRIPT;
    const dir = this.opts.dir ?? tmpdir();
    mkdirSync(dir, { recursive: true });
    const file = scriptPath(script, dir);
    writeFileSync(file, "﻿" + script, "utf8"); // BOM: Windows PowerShell 5.1 reads a BOM-less file as ANSI
    const proc = (this.opts.spawn ?? realHelperSpawn)(helperArgv(file));
    this.proc = proc;
    let ready!: () => void;
    let failed!: (e: Error) => void;
    const up = new Promise<void>((res, rej) => { ready = res; failed = rej; });
    const startTimer = setTimeout(() => { failed(new Error("the Windows helper did not start")); this.reset(proc); }, this.opts.startTimeoutMs ?? 20_000);
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of proc.stdout as any) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let msg: any;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id === 0 && msg.ok) { clearTimeout(startTimer); ready(); continue; }
            const p = this.pending.get(msg.id);
            if (!p) continue;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.result ?? null);
            else p.reject(new Error(String(msg.error ?? "helper error").trim()));
          }
        }
      } catch { /* the process went away */ }
    })();
    void proc.exited.then(() => {
      clearTimeout(startTimer);
      failed(new Error("the Windows helper exited"));
      if (this.proc === proc) this.reset(proc);
    });
    return up;
  }

  /** Forgets this process and fails what was waiting on it; the next call starts a new one. */
  private reset(proc: HelperProc) {
    if (this.proc !== proc) return;
    this.proc = undefined;
    this.ready = undefined;
    proc.kill();
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("the Windows helper stopped")); this.pending.delete(id); }
  }

  async call<T = any>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    this.ready ??= this.start();
    await this.ready;
    const proc = this.proc;
    if (!proc) throw new Error("the Windows helper is not running");
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the Windows helper did not answer ${cmd} in ${timeoutMs / 1000}s`));
        this.reset(proc); // a wedged helper is replaced on the next call
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { proc.write(asciiJson({ ...args, id, cmd }) + "\n"); } catch (e: any) { clearTimeout(timer); this.pending.delete(id); reject(new Error(String(e?.message ?? e))); }
    });
  }

  dispose() {
    if (this.proc) this.reset(this.proc);
  }
}
