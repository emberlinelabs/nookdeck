/**
 * Plugin system, P1 (agent side): manifests, stored state, and what the deck receives.
 * Spec: Knowns doc specs/plugin-system. Contracts other code builds on (keep exactly):
 *   WS      {type:"plugin", items:{[tileId]: {render,data} | {error}}}
 *   REST    GET /api/plugins, POST /api/plugins {source}, DELETE /api/plugins/:id, POST /api/plugins/:id/grant {permissions},
 *           POST /api/plugins/:id/enabled {enabled}, PUT /api/plugins/:id/settings
 *   Layout  widget {kind:"widget", widget:"plugin", plugin:{id,widget,settings}}, action {type:"plugin", plugin, action, settings}
 */
import type { Layout, MacroStep, Theme } from "../config";

export const RENDERERS = ["stat", "gauge", "text", "list", "chart", "image", "status"] as const;
export type Renderer = (typeof RENDERERS)[number];
/** A renderer only core plugins may use: the deck draws its own tile (custom:weather, custom:quota). parseManifest never produces one. */
export type CustomRenderer = `custom:${string}`;

/** What a plugin may do. The manifest declares it, the user grants it, the agent enforces it on every call. */
export interface Permissions {
  /** Host names the plugin may call (exact, or `*.example.com` for subdomains). Always present, [] when none. */
  network: string[];
  shell?: boolean;
  keyboard?: boolean;
  storage?: boolean;
}

export const SETTING_TYPES = ["string", "number", "boolean", "select", "secret", "entity"] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
export interface SettingField {
  key: string;
  type: SettingType;
  label: string;
  default?: string | number | boolean;
  options?: string[]; // select
}
export type SettingValue = string | number | boolean;
export type Settings = Record<string, SettingValue>;

export interface HttpSource { http: { url: string; every?: number; headers?: Record<string, string> }; map?: Record<string, unknown> }
export interface CommandSource { command: { run: string; every?: number; parse?: "json" | "text" }; map?: Record<string, unknown> }
/** The data comes from the plugin's code (`main`): `every` is the default refresh in seconds (the plugin may change it in provide()). */
export interface AgentSource { agent: { every?: number } }
export type WidgetSource = HttpSource | CommandSource | AgentSource;

export interface WidgetDef {
  id: string;
  name: string;
  render: Renderer | CustomRenderer;
  sizes: string[]; // "2x1"
  settings: SettingField[];
  /** Sample `data` for the renderer (validated at parse time), so the UI can show the tile before install. */
  preview?: unknown;
  source: WidgetSource;
}

export type PluginActionRun =
  | { macro: MacroStep[] }
  | { http: { url: string; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; headers?: Record<string, string>; body?: string } }
  /** Handled by the plugin's code: ctx.actions.handle(id, fn). */
  | { agent: true };
export interface ActionDef { id: string; name: string; settings: SettingField[]; run: PluginActionRun }

export interface Manifest {
  id: string;
  name: string;
  version: string;
  nookdeck?: string;
  author?: string;
  description?: string;
  icon?: string;
  permissions: Permissions;
  /** Plugin-wide settings (an API key ...); same field shape as a widget's. */
  settings: SettingField[];
  widgets: WidgetDef[];
  actions: ActionDef[];
  themes: { id: string; name: string; theme: Theme }[];
  layouts: { id: string; name: string; layout: Layout }[];
  /** Code entry, a relative path inside the plugin folder (P2); null for a no-code plugin. */
  main: string | null;
}

/** One entry of ~/.nookdeck/plugins.json. */
export interface PluginState {
  version: string;
  sha256: string;
  source: string;
  installedAt: number;
  enabled: boolean;
  /** What the user allowed; null = never granted. */
  granted: Permissions | null;
  /** Plugin-level settings (the layout tile can override per tile). Secret values live here and are never sent to phones. */
  settings: Settings;
  /** `nookdeck plugin dev`: the files are read in place from `source` (a folder), not copied, and not pinned by hash. */
  linked?: boolean;
  /** Installed from the registry with files that matched its sha256: shown as reviewed. A plain install clears it. */
  reviewed?: boolean;
  /** The registry version it was reviewed at (only with `reviewed`). */
  registryVersion?: string;
}
/** `core` keeps what the user changed on a built-in plugin (the plugin itself ships with the agent and is never stored in `plugins`). */
export interface StateFile { version: 1; plugins: Record<string, PluginState>; core?: Record<string, { enabled: boolean; settings: Settings }> }

/** What the deck gets for one tile. `error` is a short human message. */
export type TileItem = { render: Renderer; data: unknown } | { error: string };
export type TileItems = Record<string, TileItem>;

export const ERR_MISSING = "plugin missing";
export const ERR_DISABLED = "plugin disabled";
export const ERR_NOT_GRANTED = "plugin not granted";
