/**
 * On Air (spec specs/2026-11-26/obs-integration-and-on-air, FR-5, FR-9, FR-12): on while any chosen source is active.
 * Sources: OBS streaming / recording (a Store plugin through setPluginSource, or a client attached with attachObs), mic in use, camera in use, the manual
 * On Air button, and the API / webhook (with a label and a ttl). Manual and API are separate: turning one off leaves the other.
 *
 * Mic and camera are read every 2 s only while something needs them (`setNeeded`: a phone shows an On Air / Mic / Camera tile,
 * or keeps the full-screen sign on), NFR-4. Which apps use them never leaves this module (NFR-3): the message carries on/off,
 * the sources, the mic's mute and the start time only.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { parseOnAirSettings, type OnAirMsg, type OnAirSettings, type OnAirSource } from "../web/shared/onair";

export type { OnAirMsg, OnAirSettings, OnAirSource };

export type ObsLiveKind = "stream" | "record";
/** What On Air needs of the OBS client (src/obs/client.ts implements it). */
export interface ObsLive {
  configured(): boolean;
  live(): { stream: { active: boolean; since?: number }; record: { active: boolean; since?: number } };
  onLive(cb: (kind: ObsLiveKind, active: boolean, since?: number) => void): () => void;
}

/** Reads mic / camera use and the input mute (the platform, through src/mic-camera.ts). */
export interface AvProbe {
  usage(ignorePid?: number): Promise<{ mic: { inUse: boolean }; camera: { inUse: boolean } }>;
  micMuted(): Promise<boolean | null>;
}

export const ONAIR_POLL_MS = 1000;
export const ONAIR_TTL_MAX = 86_400;
export const ONAIR_LABEL_MAX = 60;

export interface OnAirOptions {
  probe: AvProbe;
  /** where the user's settings are kept (null: memory only, tests) */
  settingsFile: string | null;
  onChange: (msg: OnAirMsg) => void;
  now?: () => number;
  pollMs?: number;
  /** the agent's pid, left out of mic/camera use when settings.ignoreSelf */
  pid?: number;
}

export class OnAir {
  private manual = false;
  private api: { on: boolean; label?: string; timer?: ReturnType<typeof setTimeout> } = { on: false };
  private obs: ObsLive | null = null;
  private unObs: (() => void) | null = null;
  private obsState = { stream: { active: false, since: undefined as number | undefined }, record: { active: false, since: undefined as number | undefined } };
  /** stream / record state reported by Store plugins (ctx.onair.set), per plugin id */
  private plugins = new Map<string, { stream: { active: boolean; since?: number }; record: { active: boolean; since?: number } }>();
  private mic = { inUse: false, muted: null as boolean | null };
  private camera = { inUse: false };
  private since: number | undefined;
  private raw: unknown = undefined; // the stored settings as saved (missing keys take the spec defaults)
  private needed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling: Promise<void> | undefined;
  private last = "";
  private now: () => number;

  constructor(private o: OnAirOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Loads the stored settings (missing or broken file: the defaults). */
  async load(): Promise<void> {
    if (!this.o.settingsFile) return;
    try { this.raw = JSON.parse(await readFile(this.o.settingsFile, "utf8")); } catch { this.raw = undefined; }
    this.emit();
  }

  settings(): OnAirSettings {
    return parseOnAirSettings(this.raw, this.obsSetUp());
  }

  /** Validates and stores new settings (the PUT body); returns the settings in force. */
  async setSettings(body: unknown): Promise<OnAirSettings> {
    const b = body as any;
    if (!b || typeof b !== "object" || !b.sources || typeof b.sources !== "object") throw new Error("send { sources: { obs, mic, camera, manual, api }, ignoreSelf }");
    for (const k of ["obs", "mic", "camera", "manual", "api"]) if (b.sources[k] !== undefined && typeof b.sources[k] !== "boolean") throw new Error(`sources.${k} must be true or false`);
    if (b.ignoreSelf !== undefined && typeof b.ignoreSelf !== "boolean") throw new Error("ignoreSelf must be true or false");
    const s = parseOnAirSettings(b, this.obsSetUp());
    this.raw = s;
    if (this.o.settingsFile) {
      await mkdir(dirname(this.o.settingsFile), { recursive: true });
      const tmp = this.o.settingsFile + ".tmp";
      await writeFile(tmp, JSON.stringify(s, null, 2));
      await rename(tmp, this.o.settingsFile);
    }
    this.emit();
    return s;
  }

  /** Connects the OBS client's live state (PD-Worker-0's ObsClient). Re-reads configured() on every change. */
  attachObs(obs: ObsLive): void {
    this.unObs?.();
    this.obs = obs;
    const l = obs.live();
    this.obsState = { stream: { active: l.stream.active, since: l.stream.since }, record: { active: l.record.active, since: l.record.since } };
    this.unObs = obs.onLive((kind, active, since) => {
      this.obsState[kind] = { active, since: active ? since : undefined };
      this.emit();
    });
    this.emit();
  }

  /** OBS counts as set up when the built-in client is configured or a plugin has reported its live state. */
  private obsSetUp(): boolean { return !!this.obs?.configured() || this.plugins.size > 0; }

  /**
   * A Store plugin with the "onair" permission (ctx.onair.set): its stream / record state feeds the obs-stream / obs-record
   * sources. Several plugins may report; a source is on while any of them says so.
   */
  setPluginSource(pluginId: string, kind: ObsLiveKind, on: boolean, since?: number): void {
    if (kind !== "stream" && kind !== "record") throw new Error("kind must be stream or record");
    if (typeof on !== "boolean") throw new Error("on must be true or false");
    const st = this.plugins.get(pluginId) ?? { stream: { active: false }, record: { active: false } };
    st[kind] = on ? { active: true, ...(typeof since === "number" && Number.isFinite(since) && since > 0 ? { since } : {}) } : { active: false };
    this.plugins.set(pluginId, st);
    this.emit();
  }

  /** The plugin stopped, was disabled or removed: its sources no longer count. */
  clearPlugin(pluginId: string): void {
    if (this.plugins.delete(pluginId)) this.emit();
  }

  /** stream / record from the built-in client and every plugin: active when any is, since = the earliest. */
  private live(kind: ObsLiveKind): { active: boolean; since?: number } {
    const all = [...(this.obs?.configured() ? [this.obsState[kind]] : []), ...[...this.plugins.values()].map((p) => p[kind])].filter((x) => x.active);
    const times = all.map((x) => x.since).filter((x): x is number => typeof x === "number");
    return { active: all.length > 0, ...(times.length ? { since: Math.min(...times) } : {}) };
  }

  /** The manual On Air button / macro step / rule action. Returns the manual state after the change. */
  setManual(mode: "toggle" | "on" | "off" = "toggle"): boolean {
    this.manual = mode === "toggle" ? !this.manual : mode === "on";
    this.emit();
    return this.manual;
  }

  /** POST /api/onair: { on, label?, ttl? }. Throws a readable message on a bad body. */
  setApi(body: unknown): void {
    const b = body as any;
    if (!b || typeof b !== "object" || typeof b.on !== "boolean") throw new Error('send JSON { "on": true|false, "label"?: string, "ttl"?: seconds }');
    if (b.label !== undefined && typeof b.label !== "string") throw new Error("label must be a string");
    if (b.ttl !== undefined && (typeof b.ttl !== "number" || !Number.isFinite(b.ttl) || b.ttl <= 0 || b.ttl > ONAIR_TTL_MAX)) throw new Error(`ttl must be a number of seconds from 1 to ${ONAIR_TTL_MAX}`);
    if (this.api.timer) clearTimeout(this.api.timer);
    const label = typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, ONAIR_LABEL_MAX) : undefined;
    this.api = b.on ? { on: true, ...(label ? { label } : {}) } : { on: false };
    if (b.on && b.ttl) {
      const timer = setTimeout(() => { if (this.api.timer === timer) { this.api = { on: false }; this.emit(); } }, Math.round(b.ttl * 1000));
      (timer as any).unref?.();
      this.api.timer = timer;
    }
    this.emit();
  }

  /** Mic / camera checks run only while this is true (NFR-4). Turning it off forgets their state (nobody shows it). */
  setNeeded(needed: boolean): void {
    if (needed === this.needed) return;
    this.needed = needed;
    if (needed) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), this.o.pollMs ?? ONAIR_POLL_MS);
      (this.timer as any).unref?.();
    } else {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.mic = { inUse: false, muted: this.mic.muted };
      this.camera = { inUse: false };
      this.emit();
    }
  }

  isNeeded(): boolean { return this.needed; }

  /** One mic / camera / mute read now (the poll, GET /api/onair, right after the Mic button). Never overlaps itself. */
  refresh(): Promise<void> {
    this.polling ??= (async () => {
      const s = this.settings();
      const ignore = s.ignoreSelf ? (this.o.pid ?? process.pid) : undefined;
      const [u, muted] = await Promise.all([
        this.o.probe.usage(ignore).catch(() => null),
        this.o.probe.micMuted().catch(() => undefined), // a failed read (helper still starting) keeps the last value
      ]);
      if (u) { this.mic.inUse = !!u.mic.inUse; this.camera.inUse = !!u.camera.inUse; }
      if (muted !== undefined) this.mic.muted = muted;
      this.emit();
    })().finally(() => { this.polling = undefined; });
    return this.polling;
  }

  /** The `onair` message. */
  snapshot(): OnAirMsg {
    const s = this.settings().sources;
    const sources: OnAirSource[] = [];
    if (s.obs && this.live("stream").active) sources.push("obs-stream");
    if (s.obs && this.live("record").active) sources.push("obs-record");
    if (s.mic && this.mic.inUse) sources.push("mic");
    if (s.camera && this.camera.inUse) sources.push("camera");
    if (s.manual && this.manual) sources.push("manual");
    if (s.api && this.api.on) sources.push("api");
    const on = sources.length > 0;
    const msg: OnAirMsg = { type: "onair", on, sources, mic: { inUse: this.mic.inUse, muted: this.mic.muted }, camera: { inUse: this.camera.inUse } };
    if (on && this.since !== undefined) msg.since = this.since;
    if (sources.includes("api") && this.api.label) msg.label = this.api.label;
    return msg;
  }

  /** Recomputes; tells the phones only when something they show changed. */
  private emit(): void {
    const wasOn = this.since !== undefined;
    let msg = this.snapshot();
    if (msg.on && !wasOn) {
      // went on: from now, or from when OBS went live when that is what turned it on (the agent started mid-stream)
      const obsSince = [msg.sources.includes("obs-stream") ? this.live("stream").since : undefined, msg.sources.includes("obs-record") ? this.live("record").since : undefined]
        .filter((x): x is number => typeof x === "number");
      this.since = Math.min(this.now(), ...obsSince);
      msg = this.snapshot();
    } else if (!msg.on && wasOn) {
      this.since = undefined;
      msg = this.snapshot();
    }
    const key = JSON.stringify(msg);
    if (key === this.last) return;
    this.last = key;
    this.o.onChange(msg);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.api.timer) clearTimeout(this.api.timer);
    this.unObs?.();
  }
}
