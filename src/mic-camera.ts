/**
 * The Mic button (FR-10) and the Camera button (FR-11), and the mic / camera probe On Air reads (FR-6).
 *
 * Mic: mutes the default input device for every app. A device with a mute control is muted; a macOS device without one gets
 * input volume 0, and the volume it had is written to a file first, so unmute, the agent stopping, and the next start after a
 * crash all put it back (NFR-6: never left muted by surprise).
 */
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Platform } from "./platform/types";
import type { AvProbe } from "./onair";
import { BROWSERS, matchesNative, osKey, pickMeetingApp, MEETING_APPS } from "./meeting-apps";
import { t } from "./i18n";

export type AvPlatform = Pick<Platform, "id" | "avUsage" | "readMic" | "setMicMuted" | "setMicVolume" | "frontApp" | "activateApp" | "runningApps" | "runAction">;

/** The probe On Air polls. */
export function avProbe(p: AvPlatform): AvProbe {
  return {
    usage: (ignorePid) => p.avUsage(ignorePid),
    micMuted: async () => (await p.readMic())?.muted ?? null,
  };
}

/** Saved before a volume-0 mute; the volume to restore (0-1). */
interface Saved { volume: number }

export class MicControl {
  constructor(private p: AvPlatform, private file: string | null) {}

  private async saved(): Promise<Saved | null> {
    if (!this.file) return this.mem;
    try {
      const v = JSON.parse(await readFile(this.file, "utf8"));
      return typeof v?.volume === "number" && v.volume > 0 && v.volume <= 1 ? { volume: v.volume } : null;
    } catch { return null; }
  }
  private mem: Saved | null = null;
  private async save(s: Saved | null): Promise<void> {
    if (!this.file) { this.mem = s; return; }
    if (s) { await mkdir(dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(s)); }
    else await rm(this.file, { force: true });
  }

  /** Mute, unmute or toggle; returns the muted state after the change. */
  async set(mode: "toggle" | "mute" | "unmute" = "toggle"): Promise<boolean> {
    const m = await this.p.readMic();
    if (!m) throw new Error(t("No microphone found"));
    const target = mode === "toggle" ? !m.muted : mode === "mute";
    if (m.canMute) {
      await this.p.setMicMuted(target);
      return target;
    }
    if (m.volume === null) throw new Error(t("This microphone cannot be muted"));
    if (target) {
      if (m.volume > 0) await this.save({ volume: m.volume });
      await this.p.setMicVolume(0);
    } else {
      const s = await this.saved();
      await this.p.setMicVolume(s?.volume ?? 1);
      await this.save(null);
    }
    return target;
  }

  /** Puts back a volume the Mic button set to 0 (agent stop, and the next start after a crash). No-op otherwise. */
  async restore(): Promise<boolean> {
    const s = await this.saved();
    if (!s) return false;
    try {
      const m = await this.p.readMic();
      // only when it is still at 0: a volume the user changed since stays theirs
      if (m && !m.canMute && m.volume === 0) await this.p.setMicVolume(s.volume);
    } finally {
      await this.save(null);
    }
    return true;
  }
}

/**
 * The Camera button: sends the camera shortcut of the meeting app in use. Returns the app's name; throws "no known meeting app"
 * (nothing sent) when none is found.
 */
export async function cameraToggle(p: AvPlatform, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  const os = osKey(p.id);
  const usage = await p.avUsage(process.pid).catch(() => ({ mic: { inUse: false, apps: [] }, camera: { inUse: false, apps: [] } }));
  let front = await p.frontApp(false);
  if (front && (BROWSERS[os] as string[]).some((b) => (os === "mac" ? b === front!.id : b === front!.id.toLowerCase())) && !front.title) front = await p.frontApp(true);
  const running = os === "mac" ? await p.runningApps(MEETING_APPS.flatMap((a) => a.mac ?? [])) : [];
  const pick = pickMeetingApp({ os, cameraApps: usage.camera.apps, front, running, cameraInUse: usage.camera.inUse });
  if (!pick) throw new Error(t("No Zoom, Google Meet or Teams call found for the camera"));
  if (pick.activate) {
    // the keys go to the app in front: send them only when the meeting app really came forward, never to another app
    // (Chrome takes ctrl+shift+o for bookmarks). Linux on Wayland cannot bring an app forward: no keys there.
    const ok = await p.activateApp(pick.activate).catch(() => false);
    if (ok) await sleep(350);
    const now = ok ? await p.frontApp(false).catch(() => null) : null;
    if (!now || !matchesNative(pick.app, os, now.id)) throw new Error(t("No Zoom, Google Meet or Teams call found for the camera"));
  }
  await p.runAction({ type: "hotkey", keys: pick.keys });
  return pick.app.name;
}
