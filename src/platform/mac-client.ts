import type { MacRequest, MacResponse } from "./mac-worker";

/** What the client needs of a Worker (so tests can fake it). */
export interface WorkerLike {
  postMessage(m: MacRequest): void;
  terminate(): void;
  onmessage: ((e: { data: MacResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
export type WorkerFactory = () => WorkerLike;

export const MAC_READ_TIMEOUT_MS = 4000;
export const MAC_LAUNCH_TIMEOUT_MS = 15000;

/** In the compiled binary the worker is an extra entry point (package.json build, release.yml), embedded relative to the entries' common folder (src/); from source it sits next to this file. */
function realWorker(): WorkerLike {
  const spec = import.meta.url.includes("$bunfs") ? "./platform/mac-worker.ts" : new URL("./mac-worker.ts", import.meta.url).href;
  return new Worker(spec) as unknown as WorkerLike;
}

/**
 * One persistent worker for all native macOS calls. Each request has a timeout; on timeout the worker is terminated (it may be
 * stuck in an Apple Event) and a fresh one is created for the next request. Created on first use only.
 */
export class MacNative {
  private worker: WorkerLike | null = null;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  restarts = 0;

  constructor(private factory: WorkerFactory = realWorker) {}

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.factory();
    w.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok) p.resolve(e.data.value);
      else p.reject(new Error(e.data.error ?? "native call failed"));
    };
    w.onerror = () => this.reset(new Error("the macOS helper crashed"));
    this.worker = w;
    return w;
  }

  /** Drops the worker and fails everything waiting on it. */
  private reset(err: Error) {
    const w = this.worker;
    this.worker = null;
    this.restarts++;
    try { w?.terminate(); } catch { /* already gone */ }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  call<R = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = MAC_READ_TIMEOUT_MS): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const id = this.next++;
      let w: WorkerLike;
      try { w = this.ensure(); } catch (e: any) { return reject(new Error(`cannot start the macOS helper: ${e?.message ?? e}`)); }
      const timer = setTimeout(() => this.reset(new Error("macOS did not answer")), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.postMessage({ id, op, args });
    });
  }

  dispose() { if (this.worker) this.reset(new Error("stopped")); }
}

let shared: MacNative | undefined;
export const macNative = (): MacNative => (shared ??= new MacNative());
