/**
 * The On Air contract (spec specs/2026-11-26/obs-integration-and-on-air, section "Contract"; OBS itself is a Store plugin): the `onair`
 * WebSocket message, the onair / mic / camera actions and the On Air settings. ONE file for the agent, the deck and the manage page.
 * No imports, plain data and small functions written for the deck's Safari 12 build (no includes, no Object.entries/values): keep it that way.
 */

export type OnAirSource = "obs-stream" | "obs-record" | "mic" | "camera" | "manual" | "api";
export const ONAIR_SOURCES: OnAirSource[] = ["obs-stream", "obs-record", "mic", "camera", "manual", "api"];

/** Agent to phone, on connect and on every change. GET /api/onair is this body plus `settings`. */
export interface OnAirMsg {
  type: "onair";
  on: boolean;
  since?: number;
  sources: OnAirSource[];
  /** from the API */
  label?: string;
  /** muted null: no input device, or unknown */
  mic: { inUse: boolean; muted: boolean | null };
  camera: { inUse: boolean };
}

/** PUT /api/onair/settings, and `settings` in GET /api/onair. `obs` = the OBS plugin's streaming or recording. */
export interface OnAirSettings {
  sources: { obs: boolean; mic: boolean; camera: boolean; manual: boolean; api: boolean };
  ignoreSelf: boolean;
}

export type OnAirAction = { type: "onair"; mode?: "toggle" | "on" | "off" };
export type MicAction = { type: "mic"; mode?: "toggle" | "mute" | "unmute" };
export type CameraAction = { type: "camera" };

/** Modes; the first is the default. */
export const ONAIR_MODES = ["toggle", "on", "off"];
export const MIC_MODES = ["toggle", "mute", "unmute"];

/**
 * Phone to agent: this phone shows the full-screen ON AIR sign (a per-phone setting the layout does not carry), so the agent keeps
 * checking mic and camera (NFR-4). Sent after every connect while the option is on, and when it is switched on or off.
 */
export interface OnAirWatchMsg {
  type: "onair-watch";
  on: boolean;
}

const isObj = (x: unknown): x is { [k: string]: unknown } => !!x && typeof x === "object" && !Array.isArray(x);
const inList = (v: unknown, list: string[]): boolean => typeof v === "string" && list.indexOf(v) >= 0;

/** A message (or GET /api/onair body, without its settings) as the contract defines it, or null. Unknown fields are dropped. */
export function parseOnAir(x: unknown): OnAirMsg | null {
  if (!isObj(x) || (x.type !== undefined && x.type !== "onair") || typeof x.on !== "boolean") return null;
  const mic = isObj(x.mic) ? x.mic : {};
  const cam = isObj(x.camera) ? x.camera : {};
  const out: OnAirMsg = {
    type: "onair",
    on: x.on,
    sources: Array.isArray(x.sources) ? (x.sources.filter((s) => inList(s, ONAIR_SOURCES)) as OnAirSource[]) : [],
    mic: { inUse: mic.inUse === true, muted: typeof mic.muted === "boolean" ? mic.muted : null },
    camera: { inUse: cam.inUse === true },
  };
  if (typeof x.since === "number" && isFinite(x.since)) out.since = x.since;
  if (typeof x.label === "string" && x.label) out.label = x.label.slice(0, 60);
  return out;
}

/** GET /api/onair `settings`, with the spec defaults for anything missing. */
export function parseOnAirSettings(x: unknown, obsSetUp = true): OnAirSettings {
  const o = isObj(x) ? x : {};
  const s = isObj(o.sources) ? o.sources : {};
  const b = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    sources: { obs: b(s.obs, obsSetUp), mic: b(s.mic, true), camera: b(s.camera, true), manual: b(s.manual, true), api: b(s.api, true) },
    ignoreSelf: b(o.ignoreSelf, true),
  };
}

/** Why an onair / mic / camera action (or macro step, with `kind` instead of `type`) is not valid, or null when it is. */
export function validOnairAction(a: { [k: string]: unknown }): string | null {
  const type = a.type !== undefined ? a.type : a.kind;
  if (a.mode !== undefined && typeof a.mode !== "string") return "mode must be a string";
  if (type === "onair") return a.mode === undefined || inList(a.mode, ONAIR_MODES) ? null : "On Air mode must be toggle, on or off";
  if (type === "mic") return a.mode === undefined || inList(a.mode, MIC_MODES) ? null : "Mic mode must be toggle, mute or unmute";
  if (type === "camera") return null; // takes no mode; a stray one is dropped by the agent, not refused
  return "not an On Air, mic or camera action";
}
