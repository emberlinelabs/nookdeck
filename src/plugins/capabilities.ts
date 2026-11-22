/**
 * What the AGENT does for a code plugin when its host process asks (storage, net, shell, keys). Every call checks the permission the
 * user granted RIGHT NOW (not what was granted when the host started), so revoking takes effect at once.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  FETCH_MAX_BYTES, FETCH_MAX_REDIRECTS, FETCH_TIMEOUT_MS, RPC_ERR, SHELL_TIMEOUT_MS, STORAGE_MAX_BYTES,
  type FetchResult, type Permissions, type PluginFetchInit, type PermissionName,
} from "./api";
import { hostMatches } from "./manifest";
import { RpcFault } from "./rpc";

export interface ServiceDeps {
  /** What the user allows now; null = nothing. */
  granted: () => Permissions | null;
  fetch: typeof fetch;
  shell: (cmd: string, timeoutMs: number) => Promise<{ code: number; stdout: string }>;
  keys: { hotkey(k: string): Promise<void>; type(t: string): Promise<void> };
  /** The plugin's JSON file (permission: storage). */
  dataFile: string;
}

const denied = (p: PermissionName, detail?: string): RpcFault =>
  new RpcFault(RPC_ERR.permissionDenied, `permission denied: ${p}${detail ? ` (${detail})` : ""}`, { permission: p });

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const BLOCKED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade"]);

export class PluginServices {
  private data: Map<string, unknown> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private d: ServiceDeps) {}

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
