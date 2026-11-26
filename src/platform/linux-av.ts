/**
 * Linux mic and camera use (On Air, FR-6) and the default source's mute (Mic button, FR-10).
 * - Mic in use: PulseAudio / PipeWire (pipewire-pulse) source outputs that record from a real source (not a ".monitor" of an
 *   output) and are not corked (paused).
 * - Camera in use: a process of this user holds /dev/video* open (/proc/<pid>/fd links; other users' processes are not readable
 *   without root, which is fine for a desktop session).
 * - Mute: pactl get/set-source-mute on @DEFAULT_SOURCE@.
 * Nothing here records or opens a device.
 */
import { readdir, readlink, readFile } from "node:fs/promises";

export interface SourceOutput { index: number; source: number; corked: boolean; app: string; pid?: number }

/** `pactl list source-outputs` (long form): one entry per "Source Output #N" block. */
export function parseSourceOutputs(text: string): SourceOutput[] {
  const out: SourceOutput[] = [];
  for (const block of text.split(/^Source Output #/m).slice(1)) {
    const index = Number(/^(\d+)/.exec(block)?.[1]);
    const source = Number(/^\s*Source:\s*(\d+)/m.exec(block)?.[1]);
    if (!Number.isFinite(index) || !Number.isFinite(source)) continue;
    const prop = (k: string) => new RegExp(`^\\s*${k.replace(/\./g, "\\.")}\\s*=\\s*"([^"]*)"`, "m").exec(block)?.[1];
    const pid = Number(prop("application.process.id"));
    out.push({
      index,
      source,
      corked: /^\s*Corked:\s*yes/im.test(block),
      app: prop("application.process.binary") || prop("application.name") || "?",
      ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
    });
  }
  return out;
}

/** `pactl list short sources`: index -> name. */
export function parseShortSources(text: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of text.split("\n")) {
    const [i, name] = line.split("\t");
    if (i && name && /^\d+$/.test(i.trim())) m.set(Number(i), name.trim());
  }
  return m;
}

/** The apps recording from a microphone: outputs on a non-monitor source, not corked, not `ignorePid`. */
export function micApps(outputs: SourceOutput[], sources: Map<number, string>, ignorePid?: number): string[] {
  return outputs
    .filter((o) => !o.corked && !(ignorePid && o.pid === ignorePid))
    .filter((o) => { const name = sources.get(o.source); return name !== undefined && !name.endsWith(".monitor"); })
    .map((o) => o.app);
}

/** `pactl get-source-mute` -> true/false, or null when the answer is not understood. */
export function parseSourceMute(text: string): boolean | null {
  const m = /Mute:\s*(yes|no)/i.exec(text);
  return m ? m[1]!.toLowerCase() === "yes" : null;
}

export const PACTL_SOURCE_OUTPUTS = ["pactl", "list", "source-outputs"];
export const PACTL_SHORT_SOURCES = ["pactl", "list", "short", "sources"];
export const pactlSourceMuteCommand = (muted: boolean) => ["pactl", "set-source-mute", "@DEFAULT_SOURCE@", muted ? "1" : "0"];
export const PACTL_GET_SOURCE_MUTE = ["pactl", "get-source-mute", "@DEFAULT_SOURCE@"];
export const PACTL_GET_SOURCE_VOLUME = ["pactl", "get-source-volume", "@DEFAULT_SOURCE@"];

export interface ProcFs {
  readdir(p: string): Promise<string[]>;
  readlink(p: string): Promise<string>;
  readFile(p: string): Promise<string>;
}
export const realProcFs: ProcFs = { readdir: (p) => readdir(p), readlink: (p) => readlink(p), readFile: (p) => readFile(p, "utf8") };

/** Processes (their comm names) of this user that hold a /dev/video* node open; `ignorePid` left out. */
export async function cameraApps(fs: ProcFs = realProcFs, ignorePid?: number): Promise<string[]> {
  const apps: string[] = [];
  let pids: string[];
  try { pids = (await fs.readdir("/proc")).filter((p) => /^\d+$/.test(p)); } catch { return apps; }
  for (const pid of pids) {
    if (ignorePid && Number(pid) === ignorePid) continue;
    let fds: string[];
    try { fds = await fs.readdir(`/proc/${pid}/fd`); } catch { continue; } // another user's process, or gone
    for (const fd of fds) {
      let target: string;
      try { target = await fs.readlink(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (!/^\/dev\/video\d+$/.test(target)) continue;
      let name = `pid:${pid}`;
      try { name = (await fs.readFile(`/proc/${pid}/comm`)).trim() || name; } catch { /* keep the pid */ }
      apps.push(name);
      break;
    }
  }
  return apps;
}
