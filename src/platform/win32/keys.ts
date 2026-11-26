import { parseHotkey } from "../hotkey";

/** Pure builders for Win32 SendInput: which key events a hotkey / text / media key needs, and the INPUT array bytes. */

export const VK = {
  back: 0x08, tab: 0x09, return: 0x0d, shift: 0x10, control: 0x11, menu: 0x12, escape: 0x1b, space: 0x20,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, delete: 0x2e,
  f1: 0x70,
  volumeMute: 0xad, volumeDown: 0xae, volumeUp: 0xaf, mediaNext: 0xb0, mediaPrev: 0xb1, mediaPlayPause: 0xb3,
} as const;

const NAMED: Record<string, number> = {
  return: VK.return, tab: VK.tab, space: VK.space, delete: VK.back, forwarddelete: VK.delete, escape: VK.escape,
  up: VK.up, down: VK.down, left: VK.left, right: VK.right, home: VK.home, end: VK.end, pageup: VK.pageup, pagedown: VK.pagedown,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, VK.f1 + i])),
};

/** Keys that need the extended-key flag (arrows, navigation block, media/volume keys). */
const EXTENDED = new Set<number>([VK.pageup, VK.pagedown, VK.end, VK.home, VK.left, VK.up, VK.right, VK.down, VK.delete]);

export interface KeyEvent {
  /** Virtual key code (0 for a unicode character). */
  vk: number;
  /** UTF-16 code unit when `unicode`. */
  scan: number;
  up: boolean;
  unicode: boolean;
}

const key = (vk: number, up: boolean): KeyEvent => ({ vk, scan: 0, up, unicode: false });

/** VkKeyScanW result for one character: the virtual key and the shift state it needs; null when the layout has no key for it. */
export type VkScan = (ch: string) => { vk: number; shift: boolean; ctrl: boolean; alt: boolean } | null;

/** Decodes the 16-bit VkKeyScanW value (low byte = vk, high byte = shift state), -1 = none. */
export function decodeVkScan(v: number): ReturnType<VkScan> {
  if (v === -1 || (v & 0xffff) === 0xffff) return null;
  const vk = v & 0xff;
  const st = (v >> 8) & 0xff;
  return { vk, shift: !!(st & 1), ctrl: !!(st & 2), alt: !!(st & 4) };
}

/**
 * Events for a hotkey. cmd/win/super map to Ctrl (the Win key cannot be pressed reliably), option to Alt.
 * Letters and digits use their fixed virtual keys; other single characters go through the layout (`scan`).
 */
export function hotkeyEvents(keys: string, scan: VkScan): KeyEvent[] {
  const { mods, key: k } = parseHotkey(keys);
  const down: number[] = [];
  const add = (vk: number) => { if (!down.includes(vk)) down.push(vk); };
  if (mods.includes("cmd") || mods.includes("ctrl")) add(VK.control);
  if (mods.includes("alt")) add(VK.menu);
  if (mods.includes("shift")) add(VK.shift);
  let vk = NAMED[k];
  if (vk === undefined) {
    if (/^[a-z]$/.test(k)) vk = k.toUpperCase().charCodeAt(0);
    else if (/^[0-9]$/.test(k)) vk = k.charCodeAt(0);
    else {
      const s = scan(k);
      if (!s) throw new Error(`the key "${k}" is not on the current keyboard layout`);
      vk = s.vk;
      if (s.shift) add(VK.shift);
      if (s.ctrl) add(VK.control);
      if (s.alt) add(VK.menu);
    }
  }
  return [...down.map((m) => key(m, false)), key(vk, false), key(vk, true), ...[...down].reverse().map((m) => key(m, true))];
}

/** Types text as Unicode input (works for any layout and any character); newline = Enter, tab = Tab. */
export function typeEvents(text: string): KeyEvent[] {
  const out: KeyEvent[] = [];
  const t = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const code = t.charCodeAt(i);
    if (t[i] === "\n" || t[i] === "\r") { out.push(key(VK.return, false), key(VK.return, true)); continue; }
    if (t[i] === "\t") { out.push(key(VK.tab, false), key(VK.tab, true)); continue; }
    out.push({ vk: 0, scan: code, up: false, unicode: true }, { vk: 0, scan: code, up: true, unicode: true });
  }
  return out;
}

/** The PrintScreen key (VK_SNAPSHOT), with Alt or Ctrl held when asked (Greenshot: Alt = window, Ctrl = whole screen). */
export function printScreenEvents(mod?: "alt" | "ctrl"): KeyEvent[] {
  const m = mod === "alt" ? VK.menu : mod === "ctrl" ? VK.control : 0;
  const press = [key(0x2c, false), key(0x2c, true)];
  return m ? [key(m, false), ...press, key(m, true)] : press;
}

export function mediaEvents(command: "playpause" | "next" | "previous"): KeyEvent[] {
  const vk = command === "playpause" ? VK.mediaPlayPause : command === "next" ? VK.mediaNext : VK.mediaPrev;
  return [key(vk, false), key(vk, true)];
}

/** One volume key press per step (Windows moves 2 % per press); `times` presses for up/down. */
export function volumeKeyEvents(command: "up" | "down" | "mute", times = command === "mute" ? 1 : 3): KeyEvent[] {
  const vk = command === "up" ? VK.volumeUp : command === "down" ? VK.volumeDown : VK.volumeMute;
  return Array.from({ length: times }).flatMap(() => [key(vk, false), key(vk, true)]);
}

export const INPUT_SIZE = 40; // sizeof(INPUT) on x64

/** The INPUT[] block SendInput wants: type=KEYBOARD, then KEYBDINPUT {wVk, wScan, dwFlags, time, dwExtraInfo} at offset 8. */
export function packInputs(events: KeyEvent[]): Buffer {
  const buf = Buffer.alloc(INPUT_SIZE * events.length);
  events.forEach((e, i) => {
    const o = i * INPUT_SIZE;
    let flags = 0;
    if (e.up) flags |= 0x0002; // KEYEVENTF_KEYUP
    if (e.unicode) flags |= 0x0004; // KEYEVENTF_UNICODE
    else if (EXTENDED.has(e.vk)) flags |= 0x0001; // KEYEVENTF_EXTENDEDKEY
    buf.writeUInt32LE(1, o); // INPUT_KEYBOARD
    buf.writeUInt16LE(e.unicode ? 0 : e.vk, o + 8);
    buf.writeUInt16LE(e.unicode ? e.scan : 0, o + 10);
    buf.writeUInt32LE(flags, o + 12);
  });
  return buf;
}
