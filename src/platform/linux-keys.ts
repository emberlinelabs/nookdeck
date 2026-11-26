/**
 * Hotkey and typing argv for the three Linux input tools (L3 of specs/linux-support). Pure.
 *
 * - xdotool (X11): key names joined with "+", `xdotool type`.
 * - ydotool 1.x (Wayland, any compositor): raw Linux input event codes, `ydotool key 29:1 46:1 46:0 29:0`, so keys
 *   are mapped here for a US layout. `ydotool type` also types as a US keyboard.
 * - ydotool 0.1.x (Ubuntu 22.04, Debian 12): key names from libevdevPlus (`ydotool key ctrl+c`), see ydotool0Key.
 * - wtype (wlroots Wayland): `-M mod ... -m mod` around a key (`-k Name`) or a character, and text as arguments.
 */
import { parseHotkey, type ParsedHotkey } from "./hotkey";
import { t } from "../i18n";
import type { LinuxInputKind } from "./linux-input";

/** The tool plus, for ydotool, its line: 1.x takes event codes, 0.1.x (Ubuntu 22.04, Debian 12) key names. */
export type LinuxInputTool = LinuxInputKind | "ydotool-0.1";

type Mod = ParsedHotkey["mods"][number];

// ---------- xdotool ----------

const XDO_MODS: Record<Mod, string> = { cmd: "super", ctrl: "ctrl", alt: "alt", shift: "shift" };
/** X keysym names, used by xdotool and wtype -k. */
const KEYSYMS: Record<string, string> = {
  return: "Return", tab: "Tab", space: "space", delete: "BackSpace", forwarddelete: "Delete", escape: "Escape",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

function xdotoolKey(keys: string): string {
  const { mods, key } = parseHotkey(keys);
  return [...mods.map((m) => XDO_MODS[m]), KEYSYMS[key] ?? key].join("+");
}

// ---------- ydotool (linux/input-event-codes.h) ----------

const EV_MODS: Record<Mod, number> = { ctrl: 29, shift: 42, alt: 56, cmd: 125 };
const EV_NAMED: Record<string, number> = {
  return: 28, tab: 15, space: 57, delete: 14, forwarddelete: 111, escape: 1,
  up: 103, down: 108, left: 105, right: 106, home: 102, end: 107, pageup: 104, pagedown: 109,
  f1: 59, f2: 60, f3: 61, f4: 62, f5: 63, f6: 64, f7: 65, f8: 66, f9: 67, f10: 68, f11: 87, f12: 88,
};
const EV_CHARS: Record<string, number> = {
  "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11, "-": 12, "=": 13,
  q: 16, w: 17, e: 18, r: 19, t: 20, y: 21, u: 22, i: 23, o: 24, p: 25, "[": 26, "]": 27,
  a: 30, s: 31, d: 32, f: 33, g: 34, h: 35, j: 36, k: 37, l: 38, ";": 39, "'": 40, "`": 41, "\\": 43,
  z: 44, x: 45, c: 46, v: 47, b: 48, n: 49, m: 50, ",": 51, ".": 52, "/": 53,
};
/** Characters typed with Shift on a US keyboard, and the unshifted key. */
const US_SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "~": "`", "<": ",", ">": ".", "?": "/",
};

/** Event code of a parsed key, and whether Shift is needed for it; null when ydotool cannot press it. */
function evKey(key: string): { code: number; shift: boolean } | null {
  if (EV_NAMED[key] !== undefined) return { code: EV_NAMED[key]!, shift: false };
  if (EV_CHARS[key] !== undefined) return { code: EV_CHARS[key]!, shift: false };
  const lower = key.toLowerCase();
  if (lower !== key && EV_CHARS[lower] !== undefined) return { code: EV_CHARS[lower]!, shift: true };
  const base = US_SHIFTED[key];
  return base ? { code: EV_CHARS[base]!, shift: true } : null;
}

function ydotoolKey(keys: string): string[] {
  const { mods, key } = parseHotkey(keys);
  const k = evKey(key);
  if (!k) throw new Error(t("ydotool cannot press \"{key}\"", { key }));
  const held = mods.map((m) => EV_MODS[m]);
  if (k.shift && !mods.includes("shift")) held.push(EV_MODS.shift);
  return [...held.map((c) => `${c}:1`), `${k.code}:1`, `${k.code}:0`, ...held.reverse().map((c) => `${c}:0`)];
}

// ---------- wtype ----------

const WTYPE_MODS: Record<Mod, string> = { cmd: "logo", ctrl: "ctrl", alt: "alt", shift: "shift" };

function wtypeKey(keys: string): string[] {
  const { mods, key } = parseHotkey(keys);
  const named = KEYSYMS[key];
  // a character is sent as text (wtype finds its key); "-" would read as an option, so it goes by name
  const press = named ? ["-k", named] : key === "-" ? ["-k", "minus"] : [key];
  return [...mods.flatMap((m) => ["-M", WTYPE_MODS[m]]), ...press, ...mods.slice().reverse().flatMap((m) => ["-m", WTYPE_MODS[m]])];
}

/** Text as wtype arguments: an argument may not start with "-", so leading dashes are pressed as keys. */
export function wtypeText(text: string): string[] {
  const dashes = /^-*/.exec(text)![0].length;
  const out: string[] = [];
  for (let i = 0; i < dashes; i++) out.push("-k", "minus");
  if (text.length > dashes) out.push(text.slice(dashes));
  return out;
}

// ---------- ydotool 0.1.x (libevdevPlus Resource.cpp tables, ydotool v0.1.8 Tools/Key/Key.cpp) ----------
// `key` splits each argument on "+", upper-cases every part and looks it up in Table_ModifierKeys (ALT, SHIFT, CTRL,
// SUPER, META), then Table_FunctionKeys (ENTER, ESC, TAB, BACKSPACE, DELETE, arrows, HOME, END, PAGEUP, PAGEDOWN, F1-F12),
// and otherwise takes only the FIRST character of the part, lower-cased, from Table_LowerKeys. So "space" would press
// S: Space is the part " ". Shifted symbols are not in that table, so they are Shift plus the unshifted key.

const Y0_MODS: Record<Mod, string> = { cmd: "super", ctrl: "ctrl", alt: "alt", shift: "shift" };
const Y0_NAMED: Record<string, string> = {
  return: "enter", tab: "tab", space: " ", delete: "backspace", forwarddelete: "delete", escape: "esc",
  up: "up", down: "down", left: "left", right: "right", home: "home", end: "end", pageup: "pageup", pagedown: "pagedown",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `f${i + 1}`])),
};

function ydotool0Key(keys: string): string {
  const { mods, key } = parseHotkey(keys);
  let part = Y0_NAMED[key];
  let shift = false;
  if (!part) {
    if (EV_CHARS[key] !== undefined) part = key;
    else if (key.toLowerCase() !== key && EV_CHARS[key.toLowerCase()] !== undefined) { part = key.toLowerCase(); shift = true; }
    else if (US_SHIFTED[key]) { part = US_SHIFTED[key]; shift = true; }
    else throw new Error(t("ydotool cannot press \"{key}\"", { key }));
  }
  const ms = mods.map((m) => Y0_MODS[m]);
  if (shift && !mods.includes("shift")) ms.push("shift");
  return [...ms, part].join("+");
}

// ---------- argv ----------

/** ydotool types a US keyboard from a table of ASCII characters; anything else is refused instead of typed wrong. */
function asciiOnly(text: string): string {
  const s = text.replace(/\r\n?/g, "\n");
  const bad = /[^\t\n\x20-\x7e]/.exec(s);
  if (bad) throw new Error(t("ydotool can only type plain ASCII text (not \"{c}\")", { c: bad[0] }));
  return s;
}

export function linuxHotkeyCommand(keys: string, tool: LinuxInputTool): string[] {
  if (tool === "ydotool") return ["ydotool", "key", ...ydotoolKey(keys)];
  // "--" ends the options for boost::program_options, so a key like "-" is not read as one
  if (tool === "ydotool-0.1") return ["ydotool", "key", "--", ydotool0Key(keys)];
  if (tool === "wtype") return ["wtype", ...wtypeKey(keys)];
  return ["xdotool", "key", "--", xdotoolKey(keys)];
}

export function linuxTypeCommand(text: string, tool: LinuxInputTool): string[] {
  // 1.0.4+ turns "\n", "\t", "\\" and "\xNN" in arguments into keys unless --escape=0; 1.0.0-1.0.3 do not know the
  // option and getopt skips it (it is one argument, so nothing is left over to be typed)
  if (tool === "ydotool") return ["ydotool", "type", "--escape=0", "--", asciiOnly(text)];
  if (tool === "ydotool-0.1") return ["ydotool", "type", "--", asciiOnly(text)];
  if (tool === "wtype") return ["wtype", ...wtypeText(text)];
  return ["xdotool", "type", "--delay", "12", "--", text];
}
