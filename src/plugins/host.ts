/**
 * `nookdeck __plugin-host`: the child process that runs ONE code plugin (spec D3). Talks to the agent over stdio JSON-RPC (see api.ts).
 * It builds the PluginContext from the RPC calls: the agent does the real work and checks the permissions, so a tampered host gains nothing.
 */
import { pathToFileURL } from "node:url";
import { lockDown } from "./guards";
import * as api from "./api";
import type { PushUpdate, WidgetTile } from "./api";
import { CARD_LIMITS, card, validateCard } from "./card";
import {
  CALL_TIMEOUT_MS, EVERY_DEFAULT_S, EVERY_MIN_S, OPTIONS_MAX, OPTION_MAX_CHARS, PluginPermissionError, RPC_ERR, WS_MAX_MESSAGE_BYTES, WS_OPEN_TIMEOUT_MS,
  type ActionHandler, type FetchResult, type InitParams, type InitResult, type OptionsProvider, type PluginContext, type PluginFetchInit, type PluginModule,
  type PluginWebSocket, type PluginWebSocketOptions, type Provider, type Settings, type WidgetUpdate,
} from "./api";
import { createPushQueue } from "./push-queue";
import { RpcCallError, RpcFault, RpcPeer } from "./rpc";

export const SDK_NAME = "@nookdeck/plugin";

/**
 * "@nookdeck/plugin" is the host's own copy (so a plugin needs no node_modules and always matches the agent). Every other bare package
 * import fails (the child runs with --no-install, see process.ts hostEnv) and the error is reworded at load: a plugin is one folder.
 */
function registerSdk(): void {
  const sdk = { ...api, card, validateCard, CARD_LIMITS, definePlugin: (m: unknown) => m };
  Bun.plugin({
    name: "nookdeck-sdk",
    setup(b) {
      b.module(SDK_NAME, () => ({ exports: { ...sdk, default: sdk }, loader: "object" }));
    },
  });
}

const text = (a: unknown): string => {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack?.split("\n").slice(0, 4).join("\n") ?? a.message;
  try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
};

export interface HostIO {
  /** Text coming from the agent (stdin). */
  input: AsyncIterable<string>;
  write(line: string): void;
  exit(code: number): never;
}

/** Turns an RPC error into what the plugin would expect: a PluginPermissionError for a denied permission. */
function rethrow(e: unknown): never {
  if (e instanceof RpcCallError && e.data?.permission) throw new PluginPermissionError(e.data.permission, e.message.replace(/^permission denied: \w+ ?\(?|\)$/g, "") || undefined);
  throw e;
}

export async function runPluginHost(io: HostIO): Promise<void> {
  const real = { write: io.write, exit: io.exit };
  // the plugin's stdout must not corrupt the channel: console goes to the log (and to stderr for the agent's log file)
  const peer: RpcPeer = new RpcPeer((l) => real.write(l), {
    request: (method, params) => handle(method, params),
    notify: (method, params) => {
      if (method === "settings.changed") { settings = params?.settings ?? {}; for (const fn of changeListeners) { try { fn({ ...settings }); } catch { /* the plugin's bug */ } } }
      else if (method === "shutdown") void shutdown();
      else if (method === "net.ws.message" || method === "net.ws.closed") {
        const sid = Number(params?.sid);
        const ev: { text: string } | { code: number; reason: string } = method === "net.ws.message" ? { text: String(params?.text ?? "") } : { code: Number(params?.code) || 1006, reason: String(params?.reason ?? "") };
        const s = sockets.get(sid);
        if (s) { if ("text" in ev) s.message(ev.text); else s.closed(ev.code, ev.reason); }
        else {
          // the first frames can arrive before the answer to net.ws.open that names the socket: kept for it
          const q = orphans.get(sid) ?? (orphans.set(sid, []).get(sid)!);
          if (q.length < 100) q.push(ev);
          if (orphans.size > 8) orphans.delete(orphans.keys().next().value!);
        }
      }
    },
  });
  const log = (...a: unknown[]) => peer.notify("log", { args: a.map(text).map((s) => s.slice(0, 2000)) });
  for (const k of ["log", "info", "debug", "warn", "error", "trace"] as const) (console as any)[k] = log;

  let settings: Settings = {};
  const changeListeners: Array<(s: Settings) => void> = [];
  const providers = new Map<string, { fn: Provider; every: number }>();
  const optionProviders = new Map<string, OptionsProvider>();
  /** The plugin's WebSockets by the agent's socket id; frames arrive as notifications. */
  const sockets = new Map<number, { message(t: string): void; closed(code: number, reason: string): void }>();
  const orphans = new Map<number, Array<{ text: string } | { code: number; reason: string }>>();

  /** ctx.net.websocket: the agent opens the connection (and checks the origin); this is the plugin's handle on it. */
  async function openSocket(url: string, o?: PluginWebSocketOptions): Promise<PluginWebSocket> {
    const { sid } = await (async () => { try { return await peer.call<{ sid: number }>("net.ws.open", { url: String(url), ...(o?.protocols ? { protocols: o.protocols.map(String) } : {}) }, WS_OPEN_TIMEOUT_MS + 2_000); } catch (e) { return rethrow(e); } })();
    const onMsg: Array<(t: string) => void> = [];
    const onClose: Array<(code: number, reason: string) => void> = [];
    // frames that arrive before the plugin set onMessage are kept for it (the server may speak first, like OBS's Hello)
    const early: string[] = [];
    let closed: { code: number; reason: string } | null = null;
    sockets.set(sid, {
      message(t) { if (onMsg.length) for (const f of onMsg) { try { f(t); } catch (e) { log("WebSocket onMessage threw:", e); } } else if (early.length < 100) early.push(t); },
      closed(code, reason) {
        if (closed) return;
        closed = { code, reason };
        sockets.delete(sid);
        for (const f of onClose) { try { f(code, reason); } catch (e) { log("WebSocket onClose threw:", e); } }
      },
    });
    const held = orphans.get(sid);
    orphans.delete(sid);
    for (const ev of held ?? []) { const s = sockets.get(sid); if (!s) break; if ("text" in ev) s.message(ev.text); else s.closed(ev.code, ev.reason); }
    return {
      send(text: string) {
        if (closed) throw new Error("this WebSocket is closed");
        const s = String(text);
        if (Buffer.byteLength(s) > WS_MAX_MESSAGE_BYTES) throw new Error(`a WebSocket message is limited to ${WS_MAX_MESSAGE_BYTES} bytes`);
        // fire and forget keeps the frames in order (one channel); an error (closed, permission withdrawn) is logged
        peer.call("net.ws.send", { sid, text: s }, CALL_TIMEOUT_MS).catch((e) => log("WebSocket send failed:", e?.message ?? e));
      },
      onMessage(fn) { onMsg.push(fn); while (early.length) { const t = early.shift()!; try { fn(t); } catch (e) { log("WebSocket onMessage threw:", e); } } },
      onClose(fn) { if (closed) { const c = closed; queueMicrotask(() => fn(c.code, c.reason)); } else onClose.push(fn); },
      close() { if (!closed) peer.call("net.ws.close", { sid }, CALL_TIMEOUT_MS).catch(() => {}); },
    };
  }
  const handlers = new Map<string, ActionHandler>();
  let mod: PluginModule | null = null;
  let started = false;

  const rpc = async <T>(method: string, params: unknown): Promise<T> => { try { return await peer.call<T>(method, params, CALL_TIMEOUT_MS); } catch (e) { return rethrow(e); } };

  const push = createPushQueue({
    tiles: (id) => rpc<WidgetTile[]>("widget.tiles", { id }),
    send: (id, update, key) => peer.notify("widget.push", { id, update, ...(key === undefined ? {} : { key }) }),
    log: (m) => log(m),
  });

  function makeContext(p: InitParams): PluginContext {
    const ctx: PluginContext = {
      id: p.id,
      log,
      settings: {
        get: () => ({ ...settings }),
        onChange: (fn) => { changeListeners.push(fn); },
        options: (id, fn) => { optionProviders.set(String(id), fn); },
      },
      storage: {
        get: (key) => rpc("storage.get", { key: String(key) }),
        set: async (key, value) => { await rpc("storage.set", { key: String(key), value }); },
      },
      net: {
        async fetch(url: string, init?: PluginFetchInit): Promise<Response> {
          const r = await rpc<FetchResult>("net.fetch", { url: String(url), ...(init ? { init: { method: init.method, headers: init.headers, body: init.body } } : {}) });
          const body = Buffer.from(r.bodyBase64, "base64");
          const noBody = r.status === 204 || r.status === 205 || r.status === 304 || (r.status >= 100 && r.status < 200);
          const res = new Response(noBody ? null : body, { status: r.status >= 200 && r.status <= 599 ? r.status : 200, statusText: r.statusText, headers: r.headers });
          try { Object.defineProperty(res, "url", { value: r.url }); } catch { /* read-only in some runtimes */ }
          return res;
        },
        websocket: openSocket,
      },
      widgets: {
        provide(id, fn, o) {
          const every = Math.max(EVERY_MIN_S, Math.round(Number(o?.every ?? EVERY_DEFAULT_S)) || EVERY_DEFAULT_S);
          providers.set(String(id), { fn, every });
        },
        push(id, u: PushUpdate) { push(String(id), u); },
      },
      actions: { handle(id, fn) { handlers.set(String(id), fn); } },
    };
    if (p.granted.shell) ctx.shell = { run: (cmd) => rpc("shell.run", { cmd: String(cmd) }) };
    if (p.granted.notify) ctx.notify = async (title, o) => { await rpc("notify", { title, ...(o ?? {}) }); };
    if (p.granted.onair) ctx.onair = { set: (kind, on, since) => { rpc("onair.set", { kind, on: !!on, ...(since !== undefined ? { since } : {}) }).catch((e) => log("onair.set failed:", e?.message ?? e)); } };
    if (p.granted.keyboard) ctx.keys = { hotkey: async (k) => { await rpc("keys.hotkey", { k: String(k) }); }, type: async (t) => { await rpc("keys.type", { t: String(t) }); } };
    return ctx;
  }

  async function handle(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "ping": return "pong";
      case "init": {
        if (started) throw new RpcFault(RPC_ERR.invalidRequest, "already initialised");
        started = true;
        const p = params as InitParams;
        settings = { ...(p.settings ?? {}) };
        const ctx = makeContext(p);
        let loaded: any;
        try {
          registerSdk(); loaded = await import(pathToFileURL(p.entry).href); }
        catch (e: any) {
          const msg = String(e?.message ?? e);
          const pkg = /(?:Cannot find package|Could not resolve:?) ['"]([^'"]+)['"]/.exec(msg)?.[1];
          const shown = pkg && !pkg.startsWith(".") && !pkg.startsWith("/")
            ? `cannot import "${pkg}": a plugin can only import "${SDK_NAME}", Node built-ins and its own files. Bundle your dependencies into one file (bun build index.ts --outfile index.js --target bun --external ${SDK_NAME}) and set that as main`
            : msg;
          throw new RpcFault(RPC_ERR.pluginError, `cannot load the plugin: ${shown.slice(0, 400)}`, { fatal: true });
        }
        mod = typeof loaded?.activate === "function" ? loaded : typeof loaded?.default?.activate === "function" ? loaded.default : null;
        if (!mod) throw new RpcFault(RPC_ERR.pluginError, "the plugin does not export activate(ctx)", { fatal: true });
        try { await mod.activate(ctx); }
        catch (e: any) { throw new RpcFault(RPC_ERR.pluginError, `activate failed: ${String(e?.message ?? e).slice(0, 200)}`); }
        const every: Record<string, number> = {};
        for (const [id, v] of providers) every[id] = v.every;
        const result: InitResult = { widgets: [...providers.keys()], actions: [...handlers.keys()], every, options: [...optionProviders.keys()] };
        return result;
      }
      case "widget.get": {
        const prov = providers.get(String(params?.id));
        if (!prov) throw new RpcFault(RPC_ERR.unknownId, `the plugin has no provider "${params?.id}"`);
        try { return await prov.fn(params.settings ?? {}, { w: Number(params.tile?.w) || 1, h: Number(params.tile?.h) || 1 }); }
        catch (e: any) { throw new RpcFault(RPC_ERR.pluginError, String(e?.message ?? e).slice(0, 200)); }
      }
      case "settings.options": {
        const fn = optionProviders.get(String(params?.id));
        if (!fn) throw new RpcFault(RPC_ERR.unknownId, `the plugin has no options provider "${params?.id}"`);
        let list: unknown;
        try { list = await fn(params.settings ?? {}); }
        catch (e: any) { throw new RpcFault(RPC_ERR.pluginError, String(e?.message ?? e).slice(0, 200)); }
        if (!Array.isArray(list)) throw new RpcFault(RPC_ERR.pluginError, "an options provider must return a list of strings");
        const out: string[] = [];
        for (const x of list) {
          if (typeof x !== "string" || !x || x.length > OPTION_MAX_CHARS || out.includes(x)) continue;
          out.push(x);
          if (out.length >= OPTIONS_MAX) break;
        }
        return out;
      }
      case "action.run": {
        const fn = handlers.get(String(params?.id));
        if (!fn) throw new RpcFault(RPC_ERR.unknownId, `the plugin has no action "${params?.id}"`);
        try { await fn(params.settings ?? {}); return null; }
        catch (e: any) { throw new RpcFault(RPC_ERR.pluginError, String(e?.message ?? e).slice(0, 200)); }
      }
      default: throw new RpcFault(RPC_ERR.methodNotFound, `unknown method ${method}`);
    }
  }

  async function shutdown(): Promise<never> {
    try { await Promise.race([Promise.resolve(mod?.deactivate?.()), new Promise((r) => setTimeout(r, 2000))]); } catch { /* leaving anyway */ }
    return real.exit(0);
  }

  // a plugin bug must not take the host down silently: a rejection is logged and the host goes on; a thrown error ends it (the agent restarts it)
  process.on("unhandledRejection", (e) => log("unhandled rejection:", e));
  process.on("uncaughtException", (e) => { log("uncaught exception:", e); setTimeout(() => real.exit(1), 50); });

  lockDown();
  for await (const chunk of io.input) peer.feed(chunk);
  peer.close("the agent closed the connection");
  real.exit(0);
}

/** Wires the real stdio and runs the host (`nookdeck __plugin-host`). */
export async function runPluginHostFromStdio(): Promise<void> {
  const out = process.stdout;
  const dec = new TextDecoder();
  async function* input(): AsyncGenerator<string> { for await (const c of Bun.stdin.stream()) yield dec.decode(c, { stream: true }); }
  await runPluginHost({ input: input(), write: (l) => { out.write(l); }, exit: (c) => process.exit(c) });
}
