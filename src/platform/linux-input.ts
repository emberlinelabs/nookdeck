/**
 * Which tool types keys and text on this Linux session (L3 of specs/linux-support). Pure: the environment and a `which`
 * lookup decide it, so doctor and tests can ask without touching the machine.
 *
 * - The session is XDG_SESSION_TYPE when it says x11 or wayland, otherwise WAYLAND_DISPLAY (wayland) or DISPLAY (x11).
 *   XWayland sets DISPLAY on Wayland too, which is why WAYLAND_DISPLAY is looked at first.
 * - X11 uses xdotool. Wayland uses ydotool (it needs ydotoold and /dev/uinput), else wtype on a wlroots compositor
 *   (Sway, Hyprland, ...), which has the virtual keyboard protocol GNOME and KDE lack.
 * - `missing` names the package to install when no tool fits; with no graphical session there is nothing to type into,
 *   so neither a tool nor a package is named.
 */

import * as fs from "node:fs";

export type LinuxSession = "x11" | "wayland" | "unknown";
export type LinuxInputKind = "xdotool" | "ydotool" | "wtype";

export interface LinuxInputBackend {
  kind: LinuxInputKind | null;
  session: LinuxSession;
  /** The package to install when `kind` is null on a graphical session. */
  missing?: string;
}

const WLROOTS = /\b(sway|hyprland|river|wayfire|labwc|niri|dwl|wlroots)\b/i;

export function linuxSession(env: Record<string, string | undefined>): LinuxSession {
  const t = (env.XDG_SESSION_TYPE || "").toLowerCase();
  if (t === "x11" || t === "wayland") return t;
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "unknown";
}

/** True on a wlroots compositor, where wtype works. */
export function isWlroots(env: Record<string, string | undefined>): boolean {
  return WLROOTS.test([env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION].filter(Boolean).join(" ")) || !!env.SWAYSOCK || !!env.HYPRLAND_INSTANCE_SIGNATURE;
}

export function linuxInputBackend(env: Record<string, string | undefined>, which: (n: string) => string | null): LinuxInputBackend {
  const session = linuxSession(env);
  if (session === "x11") return which("xdotool") ? { kind: "xdotool", session } : { kind: null, session, missing: "xdotool" };
  if (session === "wayland") {
    if (which("ydotool")) return { kind: "ydotool", session };
    if (isWlroots(env)) return which("wtype") ? { kind: "wtype", session } : { kind: null, session, missing: "wtype" };
    return { kind: null, session, missing: "ydotool" };
  }
  return { kind: null, session };
}

/**
 * Which ydotool `ydotool help` came from. 1.x (C, event codes) lists "bakers" and "debug"; 0.1.x and 0.2.0 (C++, key
 * names) list a "recorder" tool that 1.x dropped. Unknown output is taken as 1.x.
 */
export function ydotoolGeneration(helpOut: string): "1" | "0.1" {
  return /^\s*recorder\s*$/m.test(helpOut) && !/^\s*bakers\s*$/m.test(helpOut) ? "0.1" : "1";
}

// ---------- /dev/uinput (ydotool) ----------

export interface UinputStat { mode: number; uid: number; gid: number }
export interface UinputAccess {
  ok: boolean;
  /** "missing": no /dev/uinput (module not loaded); "permission": it exists but this user cannot write it. */
  why?: "missing" | "permission";
  /** The group that owns the device (a fix is joining it when it is group-writable, e.g. "input"). */
  gid?: number;
  /** True when the group may write it, so adding the user to that group is enough. */
  groupWritable?: boolean;
}

/**
 * Can this user write /dev/uinput? Pure: `st` is its stat (null when missing), `user` the uid and group ids, and
 * `writable` an access(W_OK) answer when known, which wins because it also sees ACLs (systemd's uaccess).
 * Doctor turns `why` into the fix: `sudo modprobe uinput`, or the `input` group / a udev rule.
 */
export function uinputAccess(st: UinputStat | null, user: { uid: number; groups: number[] }, writable?: boolean): UinputAccess {
  if (!st) return { ok: false, why: "missing" };
  const groupWritable = (st.mode & 0o020) !== 0;
  const byBits = user.uid === 0
    || (st.uid === user.uid && (st.mode & 0o200) !== 0)
    || (user.groups.includes(st.gid) && groupWritable)
    || (st.mode & 0o002) !== 0;
  const ok = writable ?? byBits;
  return ok ? { ok: true, gid: st.gid, groupWritable } : { ok: false, why: "permission", gid: st.gid, groupWritable };
}

/** uinputAccess for this process (stat, access(W_OK), getuid/getgroups). Never throws. */
export function readUinputAccess(path = "/dev/uinput"): UinputAccess {
  let st: UinputStat | null = null;
  try { const s = fs.statSync(path); st = { mode: s.mode, uid: s.uid, gid: s.gid }; } catch { return uinputAccess(null, { uid: -1, groups: [] }); }
  let writable: boolean | undefined;
  try { fs.accessSync(path, fs.constants.W_OK); writable = true; } catch (e: any) { writable = e?.code === "EACCES" || e?.code === "EPERM" ? false : undefined; }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const groups = typeof process.getgroups === "function" ? process.getgroups() : [];
  return uinputAccess(st, { uid, groups }, writable);
}
