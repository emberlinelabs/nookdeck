/**
 * Plugin API, P2: the ONE place where the shapes of the code-plugin API live. Everyone imports from here and nobody retypes them:
 *   - plugin authors and the SDK (`@nookdeck/plugin` re-exports these types),
 *   - the in-process core plugins (core.weather, core.quota ...) that get the same PluginContext,
 *   - the plugin host (`nookdeck __plugin-host <dir>`, a child process) and the agent that talks to it.
 * Spec: Knowns doc specs/plugin-system (D3, D5, "Code plugin API"). Types and constants only: no runtime code, no imports of the agent.
 *
 * Process model (D3): one host process per enabled code plugin, started lazily. Agent and host speak JSON-RPC 2.0, one JSON object per
 * line, over the host's stdin (agent -> host) and stdout (host -> agent). stderr is the plugin's own log noise (the agent appends it
 * to ~/.nookdeck/logs/plugins/<id>.log). Everything a plugin may touch in the world goes THROUGH the agent (storage, net, shell, keys),
 * so permissions (D5) are enforced in the agent, not in the child that could be tampered with.
 */
import type { Permissions, Renderer, SettingValue, Settings } from "./types";
/** The `card` renderer's data (`{ root: CardNode }`); build it with `card.col(...)` etc. */
export type { CardData, CardNode, CardTone, CardGap, CardAlign, CardArgs, CardChildren } from "./card";

export type { Permissions, Renderer, SettingValue, Settings };

// ------------------------------------------------------------------------------------------------ permissions

/** Permission names as they appear in the manifest `permissions` object and in error messages. */
export const PERMISSION_NAMES = ["network", "shell", "keyboard", "storage", "onair", "notify"] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

/** Thrown (and sent over RPC as `error.data.permission`) when a plugin uses something it was not granted. */
export class PluginPermissionError extends Error {
  readonly permission: PermissionName;
  constructor(permission: PermissionName, detail?: string) {
    super(`permission denied: ${permission}${detail ? ` (${detail})` : ""}`);
    this.name = "PluginPermissionError";
    this.permission = permission;
  }
}

// ------------------------------------------------------------------------------------------------ what a plugin returns and receives

/**
 * The `data` each renderer takes (the deck validates it and shows a neutral error when it does not fit). `WidgetUpdate.data` stays `unknown`
 * so a plugin can return a plain object; use these to type it, e.g. `const data: StatusData = {...}`.
 */
export interface StatData { value: string | number; unit?: string; label?: string; delta?: number; color?: string; /** up to 60 finite numbers; the "spark" style draws them as a sparkline */ points?: number[] }
export interface GaugeData { value: number; label?: string; color?: string }
export interface TextData { title?: string; body: string }
export interface ListData { items: { title: string; subtitle?: string; value?: string; icon?: string }[] }
export interface ChartData { points: number[]; label?: string; unit?: string }
export interface ImageData { url: string; fit?: "cover" | "contain" }
export interface StatusData {
  state: "ok" | "warn" | "error" | "off";
  label: string;
  /** up to 40 characters */
  title?: string;
  /** up to 12 characters */
  value?: number | string;
  /** up to 8 characters */
  unit?: string;
  /** up to 60 characters */
  detail?: string;
  /** up to 60 finite numbers, drawn as a small trend */
  points?: number[];
}

/** What a widget shows: a built-in renderer and its data (the contract table in the spec). `data` is validated by the deck per renderer. */
export interface WidgetUpdate {
  render: Renderer;
  data: unknown;
}

/** A tile's size in grid cells, as the layout has it (not pixels, and the same however the phone is turned). */
export interface TileSize { w: number; h: number }

/**
 * What `ctx.widgets.push` takes: one update for every tile of the widget, or a function that makes one for each tile from its size
 * and its settings (the same `settings` a provider gets: plugin-wide overlaid with the tile's own; Nookdeck 0.7).
 */
export type PushUpdate = WidgetUpdate | ((tile: TileSize, settings: Settings) => WidgetUpdate | Promise<WidgetUpdate>);

/**
 * Provides the data of a widget. Called by the agent when a phone is connected, every `every` seconds (and once at start).
 * `settings` = plugin-level settings overlaid with the tile's own settings (the tile wins). May throw: the tile shows a neutral error.
 * It is called once for each tile, with that tile's size as `tile`, so each can get its own layout (Nookdeck 0.5.1).
 */
export type Provider = (settings: Settings, tile: TileSize) => Promise<WidgetUpdate> | WidgetUpdate;

/** Runs a button of the deck. `settings` is resolved like a provider's. A thrown error is shown to the owner. */
export type ActionHandler = (settings: Settings) => Promise<void> | void;

export interface ProvideOptions {
  /** Refresh interval in seconds (default 60, minimum 5). */
  every?: number;
}

/** What `ctx.net.fetch` accepts: the part of RequestInit that survives JSON-RPC. The body is text. */
export interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/** `ctx.net.websocket` options. */
export interface PluginWebSocketOptions {
  /** Sec-WebSocket-Protocol values to offer (for example "obswebsocket.json"). */
  protocols?: string[];
}

/**
 * An open WebSocket of a plugin (`ctx.net.websocket`). The connection itself lives in the agent, which checked its origin. Text frames
 * only; a message over WS_MAX_MESSAGE_BYTES (either way) closes it. Closed by the agent when the plugin stops or is disabled.
 */
export interface PluginWebSocket {
  /** Sends one text frame. Throws when the socket is closed or the text is too long. */
  send(text: string): void;
  /** Each text frame from the server, in order. */
  onMessage(fn: (text: string) => void): void;
  /** Once, when the connection ends for any reason (by either side, or the agent). 1006 = it dropped without a close frame. */
  onClose(fn: (code: number, reason: string) => void): void;
  close(): void;
}

/** `ctx.onair`: what a plugin reports to On Air (permission: onair). */
export type OnAirKind = "stream" | "record";

/** The sounds a phone can play with a notification (synthesized on the phone, no files). */
export const NOTIFY_SOUNDS = ["chime", "soft", "birds"] as const;
export type NotifySound = (typeof NOTIFY_SOUNDS)[number];
/** `ctx.notify` options. `level` colours the toast; `sound` plays on phones that have been tapped once (browsers need that). */
export interface NotifyOptions { body?: string; level?: "info" | "warn" | "alert"; sound?: NotifySound }

/** What `ctx.settings.options` providers return: the choices of a select with `optionsFrom`. */
export type OptionsProvider = (settings: Settings) => Promise<string[]> | string[];

/**
 * The object `activate(ctx)` receives. Same type for community plugins (out of process) and core plugins (in the agent).
 * Optional members (`shell`, `keys`) are present ONLY when the user granted that permission; the others exist always, and calls
 * the user did not allow reject with a PluginPermissionError.
 */
export interface PluginContext {
  /** The plugin id from its manifest, e.g. `dev.alice.crypto`. */
  readonly id: string;
  /** Appends a line to ~/.nookdeck/logs/plugins/<id>.log. Never throws. */
  log(...args: unknown[]): void;
  settings: {
    /** Plugin-level settings now (secrets included; they never leave this computer). */
    get(): Settings;
    /** Called after the user changes the plugin's settings. */
    onChange?(fn: (settings: Settings) => void): void;
    /**
     * Provides the choices of every select setting with `"optionsFrom": id` (up to OPTIONS_MAX). Called when the owner opens a form
     * that has such a field, with the settings the form has so far. A thrown error shows the field as a plain text box with the saved value.
     */
    options(id: string, fn: OptionsProvider): void;
  };
  /** JSON values kept in ~/.nookdeck/plugins-data/<id>.json (permission: storage). Total size is capped (STORAGE_MAX_BYTES). */
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  /** HTTP(S) only to the hosts of `permissions.network`, checked on every redirect hop. Response bodies are capped (FETCH_MAX_BYTES). */
  net: {
    fetch(url: string, init?: PluginFetchInit): Promise<Response>;
    /**
     * Opens a WebSocket to a ws:// or wss:// origin listed in `permissions.network` (scheme, host and port exactly). Resolves once it is
     * open; rejects when the origin is not allowed, the server cannot be reached, or the plugin already has WS_MAX_SOCKETS open.
     */
    websocket(url: string, o?: PluginWebSocketOptions): Promise<PluginWebSocket>;
  };
  /** Runs a command line with the OS shell (permission: shell). */
  shell?: {
    run(cmd: string): Promise<{ code: number; stdout: string }>;
  };
  /** Reports to On Air that this plugin is live or recording (permission: onair). `since` = when it started, ms since 1970. */
  onair?: {
    set(kind: OnAirKind, on: boolean, since?: number): void;
  };
  /**
   * Shows a notification on every phone, like the notify webhook (permission: notify): a toast and the notification list, with an
   * optional sound. At most NOTIFY_PER_MINUTE a minute; more are refused. Present only when granted.
   */
  notify?(title: string, o?: NotifyOptions): Promise<void>;
  /** Presses keys on this computer (permission: keyboard). */
  keys?: {
    hotkey(k: string): Promise<void>;
    type(t: string): Promise<void>;
  };
  widgets: {
    /** Registers the provider of a widget declared in the manifest (`render` is the manifest's; a provider may not change it). */
    provide(id: string, fn: Provider, o?: ProvideOptions): void;
    /**
     * Pushes an update now, outside the polling (for example from a webhook or a timer of the plugin). Given a function, it is
     * called once for each tile of the widget with that tile's size (Nookdeck 0.5.1); pushes of a widget arrive in order.
     * While one is under way only the newest later push waits; the function has CALL_TIMEOUT_MS per tile.
     */
    push(id: string, u: PushUpdate): void;
  };
  actions: {
    handle(id: string, fn: ActionHandler): void;
  };
}

/** The shape of a plugin's entry module (`main` in nookdeck.json). */
export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ------------------------------------------------------------------------------------------------ limits (the agent enforces them)

export const PROTOCOL_VERSION = 1;
/** Widget refresh interval bounds, seconds. */
export const EVERY_DEFAULT_S = 60;
export const EVERY_MIN_S = 5;
/** A plugin's whole storage file, bytes. */
export const STORAGE_MAX_BYTES = 1_000_000;
/** One `net.fetch` response body, bytes; and how long one fetch (with its redirects) may take. */
export const FETCH_MAX_BYTES = 5_000_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_REDIRECTS = 5;
/** `ctx.net.websocket`: open sockets per plugin, and the largest text frame either way (bytes). */
export const WS_MAX_SOCKETS = 4;
export const WS_MAX_MESSAGE_BYTES = 1_000_000;
/** How long opening a WebSocket may take. */
export const WS_OPEN_TIMEOUT_MS = 10_000;
/** `ctx.settings.options`: the most choices a provider may return (longer lists are cut), and the longest choice. */
export const OPTIONS_MAX = 200;
/** ctx.notify: notifications a plugin may show in one minute, and the title / body lengths kept. */
export const NOTIFY_PER_MINUTE = 6;
export const NOTIFY_TITLE_MAX = 120;
export const NOTIFY_BODY_MAX = 500;
export const OPTION_MAX_CHARS = 200;
/** `shell.run` timeout, ms. */
export const SHELL_TIMEOUT_MS = 30_000;
/** The agent pings an idle host every PING_INTERVAL_MS; no answer within PING_TIMEOUT_MS = hung, killed and restarted. */
export const PING_INTERVAL_MS = 5_000;
export const PING_TIMEOUT_MS = 10_000;
/** How long a provider / action / activate may take before the agent gives up on that call (the host stays, unless it also fails its ping). */
export const CALL_TIMEOUT_MS = 20_000;
/** Restart delays after a crash, ms (index = consecutive crashes, last value repeats); a run of RESTART_RESET_MS resets the count. */
export const RESTART_BACKOFF_MS = [500, 2_000, 10_000, 60_000] as const;
export const RESTART_RESET_MS = 60_000;
/** After this many crashes in a row the plugin is marked failed (disabled with an error) until the user enables it again. */
export const RESTART_MAX = 8;
/** A host with no calls for this long is stopped (it starts again on the next call). */
export const IDLE_STOP_MS = 5 * 60_000;

// ------------------------------------------------------------------------------------------------ JSON-RPC 2.0 (one JSON object per line)

export interface RpcRequest<M extends string = string, P = unknown> { jsonrpc: "2.0"; id: number; method: M; params?: P }
export interface RpcNotification<M extends string = string, P = unknown> { jsonrpc: "2.0"; method: M; params?: P }
export interface RpcSuccess<R = unknown> { jsonrpc: "2.0"; id: number; result: R }
export interface RpcFailure { jsonrpc: "2.0"; id: number; error: RpcError }
export interface RpcError {
  code: number;
  /** A short human message. Never a path, a secret or a stack. */
  message: string;
  data?: { permission?: PermissionName; [k: string]: unknown };
}
export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

/** Error codes: the standard ones plus ours (-32000..-32099 is the implementation range). */
export const RPC_ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** The plugin used a permission it was not granted (data.permission names it). */
  permissionDenied: -32001,
  /** net.fetch to a host that is not declared / was not granted (also on a redirect hop). */
  hostNotAllowed: -32002,
  timeout: -32003,
  /** A provider or action id the plugin never registered. */
  unknownId: -32004,
  /** A limit was hit (storage size, response size, too many redirects). */
  limit: -32005,
  /** The plugin's own code threw (message = its message). */
  pluginError: -32006,
} as const;

// -- agent -> host (requests; the host answers) --------------------------------------------------

export interface InitParams {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  version: string;
  /** Absolute path of the entry module (inside the plugin's install folder). */
  entry: string;
  /** What the user granted: the host builds `ctx.shell` / `ctx.keys` from it (the agent checks again on every call). */
  granted: Permissions;
  /** Plugin-level settings at start. */
  settings: Settings;
}
export interface InitResult {
  /** Widget and action ids the plugin registered during activate(). */
  widgets: string[];
  actions: string[];
  /** Refresh interval in seconds per widget id, from `provide(id, fn, {every})` (already clamped to EVERY_MIN_S..). */
  every?: Record<string, number>;
  /** Ids of the ctx.settings.options providers it registered. */
  options?: string[];
}
export interface WidgetGetParams { id: string; settings: Settings; tile: TileSize }
/** One tile of a widget on the layout: `key` only names it in a push for that tile; the plugin never sees it. */
export interface WidgetTile { key: string; size: TileSize; settings?: Settings }
export interface ActionRunParams { id: string; settings: Settings }

export interface AgentToHost {
  init: { params: InitParams; result: InitResult };
  "widget.get": { params: WidgetGetParams; result: WidgetUpdate };
  "action.run": { params: ActionRunParams; result: null };
  /** The choices of a select with `optionsFrom` (ctx.settings.options). */
  "settings.options": { params: { id: string; settings: Settings }; result: string[] };
  /** Answer "pong": the heartbeat. */
  ping: { params?: undefined; result: "pong" };
}
/** agent -> host, no answer: a settings change, and "stop now" (the host runs deactivate() and exits). */
export interface AgentNotifications {
  "settings.changed": { settings: Settings };
  shutdown: undefined;
  /** A text frame on one of the plugin's WebSockets. */
  "net.ws.message": { sid: number; text: string };
  /** That socket ended (any reason); no more messages for this sid. */
  "net.ws.closed": { sid: number; code: number; reason: string };
}

// -- host -> agent (requests; the agent enforces permissions, then answers) -----------------------

export interface FetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** The response body, base64. */
  bodyBase64: string;
  /** The final URL after redirects. */
  url: string;
}

export interface HostToAgent {
  "storage.get": { params: { key: string }; result: unknown };
  "storage.set": { params: { key: string; value: unknown }; result: null };
  "net.fetch": { params: { url: string; init?: PluginFetchInit }; result: FetchResult };
  "shell.run": { params: { cmd: string }; result: { code: number; stdout: string } };
  "keys.hotkey": { params: { k: string }; result: null };
  "keys.type": { params: { t: string }; result: null };
  /** The tiles of one of the plugin's own widgets, for `ctx.widgets.push(id, fn)`. */
  "widget.tiles": { params: { id: string }; result: WidgetTile[] };
  /** ctx.net.websocket: open (resolves when the connection is up), send one text frame, close. */
  "net.ws.open": { params: { url: string; protocols?: string[] }; result: { sid: number } };
  "net.ws.send": { params: { sid: number; text: string }; result: null };
  "net.ws.close": { params: { sid: number }; result: null };
  /** ctx.onair.set (permission: onair). */
  "onair.set": { params: { kind: OnAirKind; on: boolean; since?: number }; result: null };
  /** ctx.notify (permission: notify). */
  "notify": { params: { title: string } & NotifyOptions; result: null };
}
/** host -> agent, no answer. */
export interface HostNotifications {
  log: { args: string[] };
  /** `ctx.widgets.push`; with `key`, for that tile alone. */
  "widget.push": { id: string; update: WidgetUpdate; key?: string };
}

export type AgentMethod = keyof AgentToHost;
export type HostMethod = keyof HostToAgent;
export type ParamsOf<T extends { params?: unknown }, K extends keyof T> = T[K] extends { params?: infer P } ? P : never;
export type ResultOf<T extends { result: unknown }, K extends keyof T> = T[K] extends { result: infer R } ? R : never;

/** Method names the host accepts / the agent accepts, for validating incoming messages. */
export const AGENT_METHODS = ["init", "widget.get", "action.run", "settings.options", "ping"] as const;
export const AGENT_NOTIFICATIONS = ["settings.changed", "shutdown", "net.ws.message", "net.ws.closed"] as const;
export const HOST_METHODS = ["storage.get", "storage.set", "net.fetch", "shell.run", "keys.hotkey", "keys.type", "widget.tiles", "net.ws.open", "net.ws.send", "net.ws.close", "onair.set", "notify"] as const;
export const HOST_NOTIFICATIONS = ["log", "widget.push"] as const;
