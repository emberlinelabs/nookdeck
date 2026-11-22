/**
 * A small JSON-RPC 2.0 peer over a line stream, used by BOTH ends (the agent and `nookdeck __plugin-host`).
 * One JSON object per line. Lines that are not JSON (a plugin that prints to stdout) go to `onGarbage`, never to the handlers.
 */
import { RPC_ERR, type RpcError, type RpcMessage } from "./api";

/** Thrown by a request handler to answer with a specific error. Any other Error becomes `internal` with its (clipped) message. */
export class RpcFault extends Error {
  constructor(readonly code: number, message: string, readonly data?: RpcError["data"]) { super(message); }
}

/** A call that came back as an error (or never came back). */
export class RpcCallError extends Error {
  constructor(readonly code: number, message: string, readonly data?: RpcError["data"]) { super(message); }
}

export const MAX_LINE = 16 * 1024 * 1024;

export interface PeerHandlers {
  request(method: string, params: any): Promise<unknown> | unknown;
  notify(method: string, params: any): void;
  onGarbage?(line: string): void;
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class RpcPeer {
  private next = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;

  constructor(private write: (line: string) => void, private handlers: PeerHandlers) {}

  /** Sends a request and waits for its answer. Rejects with RpcCallError on an error answer or after `timeoutMs`. */
  call<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new RpcCallError(RPC_ERR.internal, "the connection is closed"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcCallError(RPC_ERR.timeout, `${method} timed out`)); }, timeoutMs);
      (timer as any).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); }
      catch (e: any) { clearTimeout(timer); this.pending.delete(id); reject(new RpcCallError(RPC_ERR.internal, String(e?.message ?? e))); }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try { this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }); } catch { /* the other end is gone */ }
  }

  private send(msg: RpcMessage): void { this.write(JSON.stringify(msg) + "\n"); }

  /** Feeds text from the stream; complete lines are dispatched. */
  feed(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i < 0) break;
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line) this.dispatch(line);
    }
    if (this.buf.length > MAX_LINE) { this.handlers.onGarbage?.("(a line longer than the limit was dropped)"); this.buf = ""; }
  }

  private dispatch(line: string): void {
    let m: any;
    try { m = JSON.parse(line); } catch { this.handlers.onGarbage?.(line.slice(0, 500)); return; }
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") { this.handlers.onGarbage?.(line.slice(0, 500)); return; }
    if (typeof m.method === "string") {
      if (typeof m.id === "number") void this.serve(m.id, m.method, m.params);
      else { try { this.handlers.notify(m.method, m.params); } catch { /* a notification handler must not break the stream */ } }
      return;
    }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error && typeof m.error === "object") p.reject(new RpcCallError(Number(m.error.code) || RPC_ERR.internal, String(m.error.message ?? "error").slice(0, 300), m.error.data));
      else p.resolve(m.result);
    }
  }

  private async serve(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.request(method, params);
      this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (e: any) {
      const error: RpcError = e instanceof RpcFault
        ? { code: e.code, message: e.message.slice(0, 300), ...(e.data ? { data: e.data } : {}) }
        : { code: RPC_ERR.internal, message: String(e?.message ?? e).slice(0, 300) };
      try { this.send({ jsonrpc: "2.0", id, error }); } catch { /* gone */ }
    }
  }

  /** Fails every waiting call (the other end died) and refuses new ones. */
  close(reason = "the connection closed"): void {
    this.closed = true;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new RpcCallError(RPC_ERR.internal, reason)); this.pending.delete(id); }
  }
}
