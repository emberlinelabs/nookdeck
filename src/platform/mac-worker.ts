/**
 * The one long-lived worker that makes every macOS native call (see mac-native.ts). Apple Events and CoreAudio can block, so
 * they never run on the agent's main thread; mac-client.ts sends requests here with a timeout and replaces the worker when
 * one does not come back.
 */
import * as N from "./mac-native";

declare var self: Worker;

export interface MacRequest { id: number; op: string; args?: any }
export interface MacResponse { id: number; ok: boolean; value?: any; error?: string }

const handlers: Record<string, (a: any) => any> = {
  ping: () => "pong",
  hotkey: (a) => N.hotkey(String(a.keys), !!a.dryRun),
  type: (a) => N.typeText(String(a.text), !!a.dryRun),
  media: (a) => N.mediaKey(a.command, !!a.dryRun),
  volumeGet: () => N.readVolume(),
  volumeSet: (a) => N.setVolume(Number(a.level)),
  gpu: () => N.readGpu(),
  jpeg: (a) => N.toJpegBase64(String(a.b64), Number(a.max) || 300),
  mute: (a) => N.setMuted(!!a.muted),
  volumeStep: (a) => N.volumeStep(a.command),
  avUsage: (a) => ({ mic: N.micUsage(Number(a.ignorePid) || 0), camera: N.cameraInUse() }),
  micRead: () => N.readMic(),
  micMute: (a) => N.setMicMuted(!!a.muted),
  micVolume: (a) => N.setMicVolume(Number(a.level)),
  frontApp: () => N.frontApp(),
  activate: (a) => N.activateApp(String(a.bundle)),
  running: (a) => Object.fromEntries((a.bundles as string[]).map((b) => [b, N.isRunning(b)])),
  /** Runs one script; `requires` (a bundle id) makes it a no-op unless that app is already running, so polling never launches anything. */
  script: (a) => (a.requires && !N.isRunning(a.requires) ? "" : N.runScript(String(a.source))),
  /** One script per player, run only for players that are running; the outputs are joined. With none running no Apple Event is sent. */
  readMedia: (a) => {
    let out = "";
    for (const s of a.scripts as { bundle: string; source: string }[]) {
      if (!N.isRunning(s.bundle)) continue;
      try { out += N.runScript(s.source); } catch { /* one player failing must not hide the other */ }
    }
    return out;
  },
};

self.onmessage = (e: MessageEvent<MacRequest>) => {
  const { id, op, args } = e.data;
  let res: MacResponse;
  try {
    const h = handlers[op];
    if (!h) throw new Error(`unknown op ${op}`);
    res = { id, ok: true, value: h(args ?? {}) ?? null };
  } catch (err: any) {
    res = { id, ok: false, error: String(err?.message ?? err) };
  }
  self.postMessage(res);
};
