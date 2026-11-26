/**
 * What the AGENT does for a code plugin when its host process asks (storage, net, shell, keys). Every call checks the permission the
 * user granted RIGHT NOW (not what was granted when the host started), so revoking takes effect at once.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  FETCH_MAX_BYTES, FETCH_MAX_REDIRECTS, FETCH_TIMEOUT_MS, RPC_ERR, SHELL_TIMEOUT_MS, STORAGE_MAX_BYTES, WS_MAX_MESSAGE_BYTES, WS_MAX_SOCKETS, WS_OPEN_TIMEOUT_MS,
  type FetchResult, type OnAirKind, type Permissions, type PluginFetchInit, type PermissionName,
} from "./api";
import { hostMatches, networkLabel, wsOrigin } from "./manifest";
import { RpcFault } from "./rpc";

export interface ServiceDeps {
  /** What the user allows now; null = nothing. */
  granted: () => Permissions | null;
  fetch: typeof fetch;
  shell: (cmd: string, timeoutMs: number) => Promise<{ code: number; stdout: string }>;
  keys: { hotkey(k: string): Promise<void>; type(t: string): Promise<void> };
  /** The plugin's JSON file (permission: storage). */
  dataFile: string;
  /** Opens a client WebSocket (tests pass their own); the real one is the runtime's WebSocket. */
  websocket?: (url: string, protocols: string[]) => WebSocketLike;
  /** ctx.onair.set, after the permission check (On Air keeps it per plugin). */
  onair?: (kind: OnAirKind, on: boolean, since?: number) => void;
}

/** The part of a WebSocket the agent uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((e: any) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  onerror: ((e: any) => void) | null;
}

const realWebSocket = (url: string, protocols: string[]): WebSocketLike => new WebSocket(url, protocols.length ? protocols : undefined) as unknown as WebSocketLike;
/** A Sec-WebSocket-Protocol token (RFC 6455: an HTTP token). */
const PROTOCOL_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

interface Sock { ws: WebSocketLike; origin: string; open: boolean; forced?: { code: number; reason: string } }

const denied = (p: PermissionName, detail?: string): RpcFault =>
  new RpcFault(RPC_ERR.permissionDenied, `permission denied: ${p}${detail ? ` (${detail})` : ""}`, { permission: p });

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const BLOCKED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade"]);

export class PluginServices {
  private data: Map<string, unknown> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private sockets = new Map<number, Sock>();
  private nextSid = 1;
  /** Sends a notification to the plugin's host (set by the process when the host starts). */
  private notify: (method: string, params: unknown) => void = () => {};

  constructor(private d: ServiceDeps) {}

  /** Where WebSocket frames and closes go: the running host. */
  attach(notify: (method: string, params: unknown) => void): void { this.notify = notify; }

  // ----- storage -----

  private async load(): Promise<Map<string, unknown>> {
    if (this.data) return this.data;
    const m = new Map<string, unknown>();
    try {
      const o = JSON.parse(await readFile(this.d.dataFile, "utf8"));
      if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) m.set(k, v);
    } catch { /* no file yet, or unreadable: start empty */ }
    return (this.data = m);
  }

  private needStorage(): void { if (!this.d.granted()?.storage) throw denied("storage"); }

  async storageGet(key: unknown): Promise<unknown> {
    this.needStorage();
    if (typeof key !== "string" || !key || key.length > 200) throw new RpcFault(RPC_ERR.invalidParams, "the key must be a string of 1-200 characters");
    const v = (await this.load()).get(key);
    return v === undefined ? null : v;
  }

  async storageSet(key: unknown, value: unknown): Promise<null> {
    this.needStorage();
    if (typeof key !== "string" || !key || key.length > 200) throw new RpcFault(RPC_ERR.invalidParams, "the key must be a string of 1-200 characters");
    const m = await this.load();
    const next = new Map(m);
    if (value === undefined || value === null) next.delete(key); else next.set(key, value);
    const json = JSON.stringify(Object.fromEntries(next));
    if (Buffer.byteLength(json) > STORAGE_MAX_BYTES) throw new RpcFault(RPC_ERR.limit, `the plugin's storage is limited to ${STORAGE_MAX_BYTES} bytes`);
    // serialized writes, atomic replace
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.d.dataFile), { recursive: true, mode: 0o700 });
      const tmp = `${this.d.dataFile}.tmp`;
      await writeFile(tmp, json + "\n", { mode: 0o600 });
      await rename(tmp, this.d.dataFile);
    });
    await this.chain;
    this.data = next;
    return null;
  }

  // ----- net -----

  /** http(s) only, to the granted hosts; redirects are followed by hand and every hop is checked; the body is capped. */
  async netFetch(url: unknown, init?: PluginFetchInit): Promise<FetchResult> {
    const hosts = this.d.granted()?.network ?? [];
    if (!hosts.length) throw denied("network", "no hosts granted");
    if (typeof url !== "string") throw new RpcFault(RPC_ERR.invalidParams, "url must be a string");
    const method = (init?.method ?? "GET").toUpperCase();
    if (!METHODS.has(method)) throw new RpcFault(RPC_ERR.invalidParams, `method ${method} is not allowed`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) if (!BLOCKED_HEADERS.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let target = url;
    for (let hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
      let u: URL;
      try { u = new URL(target); } catch { throw new RpcFault(RPC_ERR.invalidParams, "bad address"); }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new RpcFault(RPC_ERR.invalidParams, "only http and https addresses are allowed");
      if (u.username || u.password) throw new RpcFault(RPC_ERR.invalidParams, "addresses with a user name or password are not allowed");
      if (!hosts.some((h) => hostMatches(u.hostname, h))) throw new RpcFault(RPC_ERR.hostNotAllowed, `${u.hostname} is not in this plugin's allowed hosts`, { permission: "network" });
      const crossHost = hop > 0 && new URL(url).hostname !== u.hostname;
      const res = await this.d.fetch(target, {
        method: hop === 0 ? method : "GET",
        headers: crossHost ? Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|x-api-key)$/i.test(k))) : headers,
        ...(hop === 0 && init?.body !== undefined && method !== "GET" && method !== "HEAD" ? { body: String(init.body) } : {}),
        redirect: "manual", signal,
      });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) { target = new URL(loc, target).toString(); continue; }
      const bytes = await readCapped(res, FETCH_MAX_BYTES);
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (k.toLowerCase() !== "set-cookie") out[k] = v; });
      return { status: res.status, statusText: res.statusText, headers: out, bodyBase64: Buffer.from(bytes).toString("base64"), url: target };
    }
    throw new RpcFault(RPC_ERR.limit, "too many redirects");
  }

  // ----- WebSocket -----

  /** Sockets open or opening now (a host with one is not stopped for being idle). */
  openSockets(): number { return this.sockets.size; }

  /** ws:// or wss:// only, to an origin `permissions.network` lists exactly; resolves once open. */
  async wsOpen(url: unknown, protocols: unknown): Promise<{ sid: number }> {
    const net = this.d.granted()?.network ?? [];
    if (typeof url !== "string" || url.length > 2000) throw new RpcFault(RPC_ERR.invalidParams, "url must be a string");
    const origin = wsOrigin(url);
    if (!origin) throw new RpcFault(RPC_ERR.invalidParams, "only ws:// and wss:// addresses without a user name or password are allowed");
    if (!net.includes(origin)) throw new RpcFault(RPC_ERR.hostNotAllowed, `${networkLabel(origin)} is not in this plugin's allowed hosts`, { permission: "network" });
    const protos = protocols === undefined || protocols === null ? [] : protocols;
    if (!Array.isArray(protos) || protos.length > 8 || protos.some((p) => typeof p !== "string" || !PROTOCOL_RE.test(p))) throw new RpcFault(RPC_ERR.invalidParams, "protocols must be a list of up to 8 protocol names");
    if (this.sockets.size >= WS_MAX_SOCKETS) throw new RpcFault(RPC_ERR.limit, `a plugin can have at most ${WS_MAX_SOCKETS} WebSockets open`);
    const sid = this.nextSid++;
    let ws: WebSocketLike;
    try { ws = (this.d.websocket ?? realWebSocket)(url, protos as string[]); }
    catch (e: any) { throw new RpcFault(RPC_ERR.internal, `cannot open ${networkLabel(origin)}: ${String(e?.message ?? e).slice(0, 160)}`); }
    const s: Sock = { ws, origin, open: false };
    this.sockets.set(sid, s);
    return await new Promise<{ sid: number }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail("did not answer in time"), WS_OPEN_TIMEOUT_MS);
      (timer as any).unref?.();
      const fail = (why: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sockets.delete(sid);
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch { /* not open */ }
        reject(new RpcFault(RPC_ERR.internal, `cannot connect to ${networkLabel(origin)}: ${why}`));
      };
      ws.onopen = () => {
        if (settled) return;
        if (this.sockets.get(sid) !== s) return fail("closed"); // the plugin was stopped while it connected
        settled = true;
        clearTimeout(timer);
        s.open = true;
        resolve({ sid });
      };
      ws.onerror = () => { /* onclose follows */ };
      ws.onmessage = (e) => {
        if (this.sockets.get(sid) !== s) return;
        if (typeof e.data !== "string") return this.force(sid, 1003, "text frames only");
        if (Buffer.byteLength(e.data) > WS_MAX_MESSAGE_BYTES) return this.force(sid, 1009, `a message was larger than ${WS_MAX_MESSAGE_BYTES} bytes`);
        this.notify("net.ws.message", { sid, text: e.data });
      };
      ws.onclose = (e) => {
        if (!settled) return fail(`connection closed (${e?.code ?? 1006})`);
        if (this.sockets.get(sid) !== s) return;
        this.sockets.delete(sid);
        const code = s.forced?.code ?? (Number(e?.code) || 1006);
        const reason = s.forced?.reason ?? String(e?.reason ?? "").slice(0, 200);
        this.notify("net.ws.closed", { sid, code, reason });
      };
    });
  }

  /** The agent closes a socket (a rule was broken): the plugin's onClose gets `code` and `reason`. */
  private force(sid: number, code: number, reason: string): void {
    const s = this.sockets.get(sid);
    if (!s) return;
    s.forced = { code, reason };
    try { s.ws.close(1000, reason); } catch { /* already closing */ }
  }

  private sock(sid: unknown): Sock & { sid: number } {
    const s = typeof sid === "number" ? this.sockets.get(sid) : undefined;
    if (!s || !s.open) throw new RpcFault(RPC_ERR.invalidParams, "this WebSocket is closed");
    return { ...s, sid: sid as number };
  }

  async wsSend(sid: unknown, text: unknown): Promise<null> {
    const s = this.sock(sid);
    // the grant is checked again on every frame: removing the host from the plugin's permissions cuts the connection
    if (!(this.d.granted()?.network ?? []).includes(s.origin)) {
      this.force(s.sid, 1008, "the permission was withdrawn");
      throw new RpcFault(RPC_ERR.hostNotAllowed, `${networkLabel(s.origin)} is not in this plugin's allowed hosts`, { permission: "network" });
    }
    if (typeof text !== "string") throw new RpcFault(RPC_ERR.invalidParams, "only text can be sent");
    if (Buffer.byteLength(text) > WS_MAX_MESSAGE_BYTES) throw new RpcFault(RPC_ERR.limit, `a message is limited to ${WS_MAX_MESSAGE_BYTES} bytes`);
    s.ws.send(text);
    return null;
  }

  async wsClose(sid: unknown): Promise<null> {
    const s = typeof sid === "number" ? this.sockets.get(sid) : undefined;
    if (s) { try { s.ws.close(1000, ""); } catch { /* closing */ } }
    return null;
  }

  /** The plugin stopped: every socket is closed without telling it (its host is gone). */
  closeAllSockets(): void {
    const all = [...this.sockets.values()];
    this.sockets.clear();
    for (const s of all) {
      s.ws.onmessage = s.ws.onclose = null;
      try { s.ws.close(1000, "the plugin stopped"); } catch { /* closing */ }
    }
  }

  // ----- On Air -----

  async onairSet(kind: unknown, on: unknown, since: unknown): Promise<null> {
    if (!this.d.granted()?.onair) throw denied("onair");
    if (kind !== "stream" && kind !== "record") throw new RpcFault(RPC_ERR.invalidParams, 'kind must be "stream" or "record"');
    if (typeof on !== "boolean") throw new RpcFault(RPC_ERR.invalidParams, "on must be true or false");
    if (since !== undefined && since !== null && (typeof since !== "number" || !Number.isFinite(since) || since <= 0 || since > Date.now() + 60_000)) throw new RpcFault(RPC_ERR.invalidParams, "since must be a time in ms since 1970, not in the future");
    this.d.onair?.(kind, on, on && typeof since === "number" ? since : undefined);
    return null;
  }

  // ----- shell and keys -----

  async shellRun(cmd: unknown): Promise<{ code: number; stdout: string }> {
    if (!this.d.granted()?.shell) throw denied("shell");
    if (typeof cmd !== "string" || !cmd.trim() || cmd.length > 4000) throw new RpcFault(RPC_ERR.invalidParams, "cmd must be a command line of up to 4000 characters");
    const r = await this.d.shell(cmd, SHELL_TIMEOUT_MS);
    return { code: r.code, stdout: r.stdout.slice(0, 1_000_000) };
  }

  async hotkey(k: unknown): Promise<null> {
    if (!this.d.granted()?.keyboard) throw denied("keyboard");
    if (typeof k !== "string" || !k || k.length > 100) throw new RpcFault(RPC_ERR.invalidParams, "k must be a key combination like cmd+shift+4");
    await this.d.keys.hotkey(k);
    return null;
  }

  async type(t: unknown): Promise<null> {
    if (!this.d.granted()?.keyboard) throw denied("keyboard");
    if (typeof t !== "string" || t.length > 2000) throw new RpcFault(RPC_ERR.invalidParams, "t must be text of up to 2000 characters");
    await this.d.keys.type(t);
    return null;
  }

  /** The host's request, by RPC method name. */
  request(method: string, p: any): Promise<unknown> {
    switch (method) {
      case "storage.get": return this.storageGet(p?.key);
      case "storage.set": return this.storageSet(p?.key, p?.value);
      case "net.fetch": return this.netFetch(p?.url, p?.init);
      case "shell.run": return this.shellRun(p?.cmd);
      case "keys.hotkey": return this.hotkey(p?.k);
      case "keys.type": return this.type(p?.t);
      case "net.ws.open": return this.wsOpen(p?.url, p?.protocols);
      case "net.ws.send": return this.wsSend(p?.sid, p?.text);
      case "net.ws.close": return this.wsClose(p?.sid);
      case "onair.set": return this.onairSet(p?.kind, p?.on, p?.since);
      default: return Promise.reject(new RpcFault(RPC_ERR.methodNotFound, `unknown method ${method}`));
    }
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new RpcFault(RPC_ERR.limit, `the answer is larger than ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
