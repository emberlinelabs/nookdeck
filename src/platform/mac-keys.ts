import { parseHotkey, type ParsedHotkey } from "./hotkey";

/**
 * Pure planning for macOS key events: which virtual key codes, flags and Unicode chunks to post. No native calls here, so
 * tests check the plan without posting anything; mac-native.ts turns a plan into CGEvents.
 */

/** ANSI-layout virtual key codes (HIToolbox kVK_*). */
export const MAC_KEY_CODES: Record<string, number> = {
  return: 36, tab: 48, space: 49, delete: 51, escape: 53, forwarddelete: 117,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44,
  n: 45, m: 46, ".": 47, "`": 50,
};

/** Characters that need Shift on top of a base key (US layout): "+" is Shift+"=". */
const SHIFTED: Record<string, string> = { "+": "=", "_": "-", "{": "[", "}": "]", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "|": "\\", "~": "`" };

/** CGEventFlags masks. */
export const MAC_FLAGS = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, cmd: 0x100000 } as const;

export interface KeyStep {
  keyCode: number;
  down: boolean;
  flags: number;
  /** When set, the event carries this text instead of the key code's own character (keyCode is then 0). */
  unicode?: string;
}

export function flagsOf(mods: ParsedHotkey["mods"]): number {
  return mods.reduce((f, m) => f | MAC_FLAGS[m], 0);
}

/** The key presses for a hotkey string: one down + one up carrying the modifier flags. */
export function hotkeyPlan(keys: string): KeyStep[] {
  const { mods, key } = parseHotkey(keys);
  let flags = flagsOf(mods);
  let code = MAC_KEY_CODES[key];
  if (code === undefined && SHIFTED[key] !== undefined) {
    code = MAC_KEY_CODES[SHIFTED[key]!];
    flags |= MAC_FLAGS.shift;
  }
  if (code !== undefined) return [{ keyCode: code, down: true, flags }, { keyCode: code, down: false, flags }];
  // a character with no key code on this table (accented letters, symbols): type it as Unicode
  return [{ keyCode: 0, down: true, flags, unicode: key }, { keyCode: 0, down: false, flags, unicode: key }];
}

/** CGEventKeyboardSetUnicodeString handles about 20 UTF-16 units per event. */
export const TYPE_CHUNK_UNITS = 20;

/** The key events for typing `text`: newline and tab as their keys, everything else in Unicode chunks (never splitting a surrogate pair). */
export function typePlan(text: string, chunk = TYPE_CHUNK_UNITS): KeyStep[] {
  const steps: KeyStep[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    steps.push({ keyCode: 0, down: true, flags: 0, unicode: buf }, { keyCode: 0, down: false, flags: 0, unicode: buf });
    buf = "";
  };
  const press = (code: number) => steps.push({ keyCode: code, down: true, flags: 0 }, { keyCode: code, down: false, flags: 0 });
  for (const ch of text.replace(/\r\n/g, "\n")) {
    if (ch === "\n" || ch === "\r") { flush(); press(MAC_KEY_CODES.return!); continue; }
    if (ch === "\t") { flush(); press(MAC_KEY_CODES.tab!); continue; }
    if (buf.length + ch.length > chunk) flush();
    buf += ch;
  }
  flush();
  return steps;
}

/** NX_KEYTYPE_PLAY / NEXT / PREVIOUS: the codes of the keyboard's media keys. */
export const MAC_MEDIA_KEYS = { playpause: 16, next: 17, previous: 18 } as const;
export type MediaKey = keyof typeof MAC_MEDIA_KEYS;

/** NSSystemDefined subtype 8 event fields for a media key going down or up. */
export function mediaKeyEvent(command: MediaKey, down: boolean): { type: 14; subtype: 8; flags: number; data1: number; data2: -1 } {
  const flags = down ? 0xa00 : 0xb00;
  return { type: 14, subtype: 8, flags, data1: (MAC_MEDIA_KEYS[command] << 16) | (flags & 0xff00), data2: -1 };
}
