
import { userHome } from "./home";
import type { Action } from "./config.ts";
import { platform } from "./platform";

/**
 * OS actions.
 *
 * Contract:
 * - `buildCommand(action, platform)` is pure and always returns ONE argv (`string[]`). On macOS, hotkey / type / media /
 *   volume have no argv: they are native calls (src/platform/mac-native.ts) and buildCommand throws MAC_NATIVE for them.
 *   `page` actions have no command and make buildCommand throw.
 * - `runAction(action)` resolves on exit code 0 and throws an Error otherwise
 *   (stderr trimmed, or "timed out" after 10 s). `page` resolves immediately.
 *
 * Hotkey format: "cmd+shift+4", "ctrl+alt+t", "f5", "return", "space", "up".
 * On Windows, cmd/command/meta/win map to Ctrl because SendKeys cannot press the Win key.
 */

export { ACTION_TIMEOUT_MS } from "./platform/exec";

export { parseHotkey, type ParsedHotkey } from "./platform/hotkey";
import { parseHotkey, type ParsedHotkey } from "./platform/hotkey";

// ---------- macOS ----------
// Keys, typing, media keys and volume on macOS are native calls (src/platform/mac-native.ts), not commands:
// buildCommand has no argv for them. `open` and `shell` still are commands.

/** Thrown by buildCommand for actions macOS runs natively. */
export const MAC_NATIVE = "this action runs natively on macOS (platform.runAction)";

function looksLikeUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^(mailto|tel|sms|facetime|slack|spotify):/i.test(target);
}

function looksLikePath(target: string): boolean {
  return /^(\/|~|\.{1,2}\/)/.test(target) || /^[a-z]:[\\/]/i.test(target);
}

function expandHome(p: string): string {
  return p === "~" ? userHome() : p.startsWith("~/") ? userHome() + p.slice(1) : p;
}

// ---------- Windows ----------

const WIN_NAMED: Record<string, string> = {
  return: "{ENTER}", tab: "{TAB}", space: " ", delete: "{BACKSPACE}", forwarddelete: "{DELETE}", escape: "{ESC}",
  up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}", home: "{HOME}", end: "{END}",
  pageup: "{PGUP}", pagedown: "{PGDN}",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `{F${i + 1}}`])),
};

/** Escapes one literal character for SendKeys (+^%~(){}[] are special). */
export function escapeSendKeysChar(ch: string): string {
  if (ch === "\n" || ch === "\r") return "{ENTER}";
  if (ch === "\t") return "{TAB}";
  return "+^%~(){}[]".includes(ch) ? `{${ch}}` : ch;
}

export function escapeSendKeys(text: string): string {
  return text.replace(/\r\n/g, "\n").split("").map(escapeSendKeysChar).join("");
}

/** Escapes for a PowerShell single-quoted string (also doubles the typographic quotes PowerShell treats as quotes). */
export function escapePowerShell(text: string): string {
  return text.replace(/['‘’‚‛]/g, (c) => c + c);
}

function winSendKeysHotkey(keys: string): string {
  const { mods, key } = parseHotkey(keys);
  let prefix = "";
  if (mods.includes("cmd") || mods.includes("ctrl")) prefix += "^";
  if (mods.includes("alt")) prefix += "%";
  if (mods.includes("shift")) prefix += "+";
  const k = WIN_NAMED[key] ?? escapeSendKeysChar(key);
  return prefix + k;
}

function ps(script: string): string[] {
  return ["powershell", "-NoProfile", "-NonInteractive", "-Command", script];
}

const WIN_MEDIA: Record<string, number> = { playpause: 179, next: 176, previous: 177 };
const WIN_VOLUME: Record<string, number> = { mute: 173, down: 174, up: 175 };

// ---------- Linux ----------

const XDO_MODS: Record<ParsedHotkey["mods"][number], string> = { cmd: "super", ctrl: "ctrl", alt: "alt", shift: "shift" };
const XDO_KEYS: Record<string, string> = {
  return: "Return", tab: "Tab", space: "space", delete: "BackSpace", forwarddelete: "Delete", escape: "Escape",
  up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

function xdotoolKey(keys: string): string {
  const { mods, key } = parseHotkey(keys);
  return [...mods.map((m) => XDO_MODS[m]), XDO_KEYS[key] ?? key].join("+");
}

// ---------- buildCommand ----------

export function buildCommand(a: Action, platform: NodeJS.Platform): string[] {
  if (a.type === "page") throw new Error("page actions do not run OS commands");
  // The soundboard is played by the server (afplay with its own process tracking) and/or the phone, not from here.
  if (a.type === "sound" || a.type === "sound-stop") throw new Error("sound actions are handled by the sound player");
  if (a.type === "hass") throw new Error("Home Assistant actions are handled by the HA client");
  if (a.type === "macro") throw new Error("macros are run step by step by the macro runner");
  if (a.type === "plugin") throw new Error("plugin actions are run by the plugin host");

  const isWin = platform === "win32";
  const isMac = platform === "darwin";
  if (!isWin && !isMac && platform !== "linux") throw new Error(`unsupported platform: ${platform}`);

  switch (a.type) {
    case "shell":
      return isWin ? ["cmd", "/c", a.command] : ["sh", "-c", a.command];

    case "open": {
      const target = a.target.trim();
      if (!target) throw new Error("open target is empty");
      if (target.startsWith("bundle:")) {
        const id = target.slice(7);
        if (!/^[A-Za-z0-9][A-Za-z0-9.\-]{0,127}$/.test(id)) throw new Error("invalid bundle id");
        if (!isMac) throw new Error("bundle: targets are only supported on macOS");
        return ["open", "-b", id];
      }
      if (isMac) {
        if (looksLikeUrl(target)) return ["open", target];
        if (looksLikePath(target)) return ["open", expandHome(target)];
        return ["open", "-a", target];
      }
      if (isWin) return ps(`Start-Process -FilePath '${escapePowerShell(target)}'`);
      return ["xdg-open", looksLikePath(target) ? expandHome(target) : target];
    }

    case "hotkey":
      if (isMac) throw new Error(MAC_NATIVE);
      if (isWin) return ps(`(New-Object -ComObject WScript.Shell).SendKeys('${escapePowerShell(winSendKeysHotkey(a.keys))}')`);
      return ["xdotool", "key", "--", xdotoolKey(a.keys)];

    case "type":
      if (isMac) throw new Error(MAC_NATIVE);
      if (isWin) return ps(`(New-Object -ComObject WScript.Shell).SendKeys('${escapePowerShell(escapeSendKeys(a.text))}')`);
      return ["xdotool", "type", "--delay", "12", "--", a.text];

    case "media":
      if (isMac) throw new Error(MAC_NATIVE);
      if (isWin) return ps(`(New-Object -ComObject WScript.Shell).SendKeys([char]${WIN_MEDIA[a.command]})`);
      return ["playerctl", a.command === "playpause" ? "play-pause" : a.command];

    case "volume":
      if (isMac) throw new Error(MAC_NATIVE);
      if (isWin) {
        const code = WIN_VOLUME[a.command];
        const times = a.command === "mute" ? 1 : 3;
        return ps(`$w = New-Object -ComObject WScript.Shell; 1..${times} | ForEach-Object { $w.SendKeys([char]${code}) }`);
      }
      if (a.command === "mute") return ["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"];
      return ["pactl", "set-sink-volume", "@DEFAULT_SINK@", a.command === "up" ? "+5%" : "-5%"];
  }
}

// ---------- volume ----------

export type VolumeChange = { level: number } | { muted: boolean };
export interface VolumeState { level: number; muted: boolean }

/** Pure: argv that sets an absolute volume (0-100) or the mute state (Linux/Windows; macOS sets it natively but is validated here). */
export function buildVolumeCommand(v: VolumeChange, platform: NodeJS.Platform): string[] {
  if ("level" in v) {
    if (!Number.isInteger(v.level) || v.level < 0 || v.level > 100) throw new Error("volume level must be an integer 0-100");
    if (platform === "darwin") throw new Error(MAC_NATIVE);
    if (platform === "linux") return ["pactl", "set-sink-volume", "@DEFAULT_SINK@", `${v.level}%`];
    if (platform === "win32") {
      // Best effort: each volume key step is 2%. Go to 0, then step up.
      return ps(`$w = New-Object -ComObject WScript.Shell; 1..50 | ForEach-Object { $w.SendKeys([char]174) }; 1..${Math.round(v.level / 2)} | ForEach-Object { $w.SendKeys([char]175) }`);
    }
  } else {
    if (typeof v.muted !== "boolean") throw new Error("muted must be a boolean");
    if (platform === "darwin") throw new Error(MAC_NATIVE);
    if (platform === "linux") return ["pactl", "set-sink-mute", "@DEFAULT_SINK@", v.muted ? "1" : "0"];
    if (platform === "win32") throw new Error("setting mute state is not supported on Windows");
  }
  throw new Error(`unsupported platform: ${platform}`);
}

export async function setVolume(v: VolumeChange): Promise<void> {
  await platform.setVolume(v);
  volumeCache = undefined;
}

/** Parses `pactl get-sink-volume` and `pactl get-sink-mute` output. */
export function parsePactlVolume(volumeOut: string, muteOut: string): VolumeState | null {
  const pct = /(\d+)%/.exec(volumeOut)?.[1];
  if (pct === undefined) return null;
  return { level: Math.min(100, Number(pct)), muted: /yes/i.test(muteOut) };
}

let volumeCache: { value: VolumeState | null; at: number } | undefined;
let volumeInflight: Promise<VolumeState | null> | undefined;
export const VOLUME_REFRESH_MS = 2000;

async function readVolumeNow(): Promise<VolumeState | null> {
  try {
    return await platform.readVolume();
  } catch {
    return null; // no audio tooling: report unknown volume
  }
}

/** Fresh volume read (used right after a change). */
export function readVolume(): Promise<VolumeState | null> {
  volumeInflight ??= readVolumeNow()
    .then((value) => {
      volumeCache = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      volumeInflight = undefined;
    });
  return volumeInflight;
}

/** Never blocks: returns the last known volume and refreshes in the background at most every 2 s. */
export function getVolumeCached(): VolumeState | null {
  if (!volumeCache || Date.now() - volumeCache.at >= VOLUME_REFRESH_MS) void readVolume();
  return volumeCache?.value ?? null;
}

// ---------- runAction ----------

export { runCapture } from "./platform/exec";
import { runCapture } from "./platform/exec";

async function exec(argv: string[]): Promise<void> {
  await runCapture(argv);
}

export async function runAction(a: Action): Promise<void> {
  if (a.type === "page") return;
  return platform.runAction(a);
}
