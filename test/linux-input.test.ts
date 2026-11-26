import { describe, expect, test } from "bun:test";
import { linuxInputBackend, linuxSession, isWlroots, ydotoolGeneration, uinputAccess } from "../src/platform/linux-input";
import { linuxHotkeyCommand, linuxTypeCommand, wtypeText } from "../src/platform/linux-keys";
import { buildCommand } from "../src/actions";
import { createLinux, inputTool, explainInputError } from "../src/platform/linux";

const has = (...tools: string[]) => (n: string) => (tools.includes(n) ? `/usr/bin/${n}` : null);

describe("linuxSession", () => {
  test("XDG_SESSION_TYPE wins, then WAYLAND_DISPLAY, then DISPLAY", () => {
    expect(linuxSession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" })).toBe("x11");
    expect(linuxSession({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    expect(linuxSession({ XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toBe("wayland"); // XWayland sets DISPLAY too
    expect(linuxSession({ DISPLAY: ":0" })).toBe("x11");
    expect(linuxSession({})).toBe("unknown");
  });
  test("wlroots compositors", () => {
    expect(isWlroots({ XDG_CURRENT_DESKTOP: "sway" })).toBe(true);
    expect(isWlroots({ XDG_CURRENT_DESKTOP: "Hyprland" })).toBe(true);
    expect(isWlroots({ SWAYSOCK: "/run/user/1000/sway.sock" })).toBe(true);
    expect(isWlroots({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" })).toBe(false);
    expect(isWlroots({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
  });
});

describe("linuxInputBackend", () => {
  const x11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };
  const gnome = { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "ubuntu:GNOME", WAYLAND_DISPLAY: "wayland-0" };
  const sway = { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "sway", WAYLAND_DISPLAY: "wayland-1" };
  test("X11 uses xdotool", () => {
    expect(linuxInputBackend(x11, has("xdotool", "ydotool"))).toEqual({ kind: "xdotool", session: "x11" });
    expect(linuxInputBackend(x11, has("ydotool"))).toEqual({ kind: null, session: "x11", missing: "xdotool" });
  });
  test("Wayland uses ydotool, wtype on wlroots", () => {
    expect(linuxInputBackend(gnome, has("ydotool", "xdotool"))).toEqual({ kind: "ydotool", session: "wayland" });
    expect(linuxInputBackend(gnome, has("xdotool", "wtype"))).toEqual({ kind: null, session: "wayland", missing: "ydotool" });
    expect(linuxInputBackend(sway, has("ydotool", "wtype"))).toEqual({ kind: "ydotool", session: "wayland" });
    expect(linuxInputBackend(sway, has("wtype"))).toEqual({ kind: "wtype", session: "wayland" });
    expect(linuxInputBackend(sway, has())).toEqual({ kind: null, session: "wayland", missing: "wtype" });
  });
  test("no desktop session: nothing to install", () => {
    expect(linuxInputBackend({}, has("xdotool"))).toEqual({ kind: null, session: "unknown" });
  });
  test("inputTool names the package, and picks the ydotool line", async () => {
    const one = async () => "1" as const, old = async () => "0.1" as const;
    expect(await inputTool({ DISPLAY: ":0" }, has("xdotool"), one)).toBe("xdotool");
    expect(await inputTool({ WAYLAND_DISPLAY: "w" }, has("ydotool"), one)).toBe("ydotool");
    expect(await inputTool({ WAYLAND_DISPLAY: "w" }, has("ydotool"), old)).toBe("ydotool-0.1");
    await expect(inputTool({ DISPLAY: ":0" }, has(), one)).rejects.toThrow("install the xdotool package");
    await expect(inputTool({ WAYLAND_DISPLAY: "w" }, has(), one)).rejects.toThrow("install the ydotool package");
    await expect(inputTool({ WAYLAND_DISPLAY: "w", XDG_CURRENT_DESKTOP: "Hyprland" }, has(), one)).rejects.toThrow("install the wtype package");
    await expect(inputTool({}, has("xdotool"), one)).rejects.toThrow(/DISPLAY/);
  });
  test("ydotool errors say what to do", () => {
    expect(explainInputError("ydotool-0.1", new Error("terminate called ... what():  failed to open uinput device")).message).toContain("nookdeck doctor");
    expect(explainInputError("ydotool", new Error("failed to connect socket `/run/user/1000/.ydotool_socket': No such file or directory")).message).toContain("ydotoold");
    expect(explainInputError("xdotool", new Error("boom")).message).toBe("boom");
  });
  test("a hotkey with no backend fails before running anything", async () => {
    const p = createLinux("linux", has(), { WAYLAND_DISPLAY: "wayland-0" });
    await expect(p.runAction({ type: "hotkey", keys: "ctrl+c" })).rejects.toThrow("ydotool");
    await expect(p.runAction({ type: "type", text: "hi" })).rejects.toThrow("ydotool");
  });
});

describe("hotkey argv", () => {
  test("xdotool", () => {
    expect(linuxHotkeyCommand("cmd+shift+4", "xdotool")).toEqual(["xdotool", "key", "--", "super+shift+4"]);
    expect(linuxHotkeyCommand("ctrl+pagedown", "xdotool")).toEqual(["xdotool", "key", "--", "ctrl+Next"]);
  });
  test("ydotool presses event codes and releases in reverse", () => {
    expect(linuxHotkeyCommand("ctrl+c", "ydotool")).toEqual(["ydotool", "key", "29:1", "46:1", "46:0", "29:0"]);
    expect(linuxHotkeyCommand("cmd+alt+t", "ydotool")).toEqual(["ydotool", "key", "125:1", "56:1", "20:1", "20:0", "56:0", "125:0"]);
    expect(linuxHotkeyCommand("f5", "ydotool")).toEqual(["ydotool", "key", "63:1", "63:0"]);
    expect(linuxHotkeyCommand("f12", "ydotool")).toEqual(["ydotool", "key", "88:1", "88:0"]);
    expect(linuxHotkeyCommand("return", "ydotool")).toEqual(["ydotool", "key", "28:1", "28:0"]);
    expect(linuxHotkeyCommand("ctrl+shift+left", "ydotool")).toEqual(["ydotool", "key", "29:1", "42:1", "105:1", "105:0", "42:0", "29:0"]);
    // "+" is Shift and "=" on a US keyboard; Shift is not pressed twice
    expect(linuxHotkeyCommand("ctrl++", "ydotool")).toEqual(["ydotool", "key", "29:1", "42:1", "13:1", "13:0", "42:0", "29:0"]);
    expect(linuxHotkeyCommand("ctrl+shift+?", "ydotool")).toEqual(["ydotool", "key", "29:1", "42:1", "53:1", "53:0", "42:0", "29:0"]);
    expect(() => linuxHotkeyCommand("ctrl+é", "ydotool")).toThrow("ydotool cannot press");
  });
  test("wtype holds modifiers around a key", () => {
    expect(linuxHotkeyCommand("ctrl+c", "wtype")).toEqual(["wtype", "-M", "ctrl", "c", "-m", "ctrl"]);
    expect(linuxHotkeyCommand("cmd+shift+return", "wtype")).toEqual(["wtype", "-M", "logo", "-M", "shift", "-k", "Return", "-m", "shift", "-m", "logo"]);
    expect(linuxHotkeyCommand("ctrl+-", "wtype")).toEqual(["wtype", "-M", "ctrl", "-k", "minus", "-m", "ctrl"]);
    expect(linuxHotkeyCommand("f5", "wtype")).toEqual(["wtype", "-k", "F5"]);
  });
});

describe("type argv", () => {
  test("each tool", () => {
    expect(linuxTypeCommand("-rf", "xdotool")).toEqual(["xdotool", "type", "--delay", "12", "--", "-rf"]);
    expect(linuxTypeCommand("-rf x", "ydotool")).toEqual(["ydotool", "type", "--escape=0", "--", "-rf x"]);
    expect(linuxTypeCommand("hello", "wtype")).toEqual(["wtype", "hello"]);
  });
  test("wtype never gets an argument that starts with a dash", () => {
    expect(wtypeText("--force -x")).toEqual(["-k", "minus", "-k", "minus", "force -x"]);
    expect(wtypeText("-")).toEqual(["-k", "minus"]);
    expect(wtypeText("")).toEqual([]);
  });
  test("buildCommand passes the tool through and defaults to xdotool", () => {
    expect(buildCommand({ type: "hotkey", keys: "ctrl+c" }, "linux", "ydotool")).toEqual(["ydotool", "key", "29:1", "46:1", "46:0", "29:0"]);
    expect(buildCommand({ type: "type", text: "hi" }, "linux", "wtype")).toEqual(["wtype", "hi"]);
    expect(buildCommand({ type: "type", text: "hi" }, "linux")[0]).toBe("xdotool");
    expect(buildCommand({ type: "media", command: "next" }, "linux", "ydotool")).toEqual(["playerctl", "next"]);
  });
});

describe("ydotool 0.1.x (Ubuntu 22.04, Debian 12)", () => {
  test("key names, Space as \" \", shifted symbols as shift + the base key", () => {
    expect(linuxHotkeyCommand("ctrl+c", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "ctrl+c"]);
    expect(linuxHotkeyCommand("cmd+shift+return", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "super+shift+enter"]);
    expect(linuxHotkeyCommand("ctrl+space", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "ctrl+ "]);
    expect(linuxHotkeyCommand("escape", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "esc"]);
    expect(linuxHotkeyCommand("backspace", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "backspace"]);
    expect(linuxHotkeyCommand("del", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "delete"]);
    expect(linuxHotkeyCommand("alt+pagedown", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "alt+pagedown"]);
    expect(linuxHotkeyCommand("f11", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "f11"]);
    expect(linuxHotkeyCommand("ctrl++", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "ctrl+shift+="]);
    expect(linuxHotkeyCommand("ctrl+-", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "ctrl+-"]);
    expect(linuxHotkeyCommand("shift+?", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "shift+/"]);
    expect(() => linuxHotkeyCommand("ctrl+é", "ydotool-0.1")).toThrow("ydotool cannot press");
  });
  test("type has no escapes and gets -- before the text", () => {
    expect(linuxTypeCommand("-n \\x", "ydotool-0.1")).toEqual(["ydotool", "type", "--", "-n \\x"]);
    expect(buildCommand({ type: "hotkey", keys: "ctrl+v" }, "linux", "ydotool-0.1")).toEqual(["ydotool", "key", "--", "ctrl+v"]);
  });
  test("both ydotool lines refuse text they would type wrong", () => {
    expect(linuxTypeCommand("a\r\nb", "ydotool")).toEqual(["ydotool", "type", "--escape=0", "--", "a\nb"]);
    expect(() => linuxTypeCommand("café", "ydotool")).toThrow("plain ASCII");
    expect(() => linuxTypeCommand("xin chào", "ydotool-0.1")).toThrow("plain ASCII");
    expect(linuxTypeCommand("café", "xdotool")[5]).toBe("café");
  });
  test("ydotoolGeneration from `ydotool help`", () => {
    // Debian 12 ydotool 0.1.8-3+b2, run on huit-gpu (stderr, exit 1)
    expect(ydotoolGeneration("Usage: ydotool <cmd> <args>\nAvailable commands:\n  type\n  recorder\n  mousemove\n  key\n  click\n")).toBe("0.1");
    // 1.0.x Client/ydotool.c show_help
    expect(ydotoolGeneration("Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  mousemove\n  type\n  key\n  debug\n  bakers\n  stdin\nUse environment variable YDOTOOL_SOCKET to specify daemon socket.\n")).toBe("1");
    expect(ydotoolGeneration("")).toBe("1");
  });
  test("the line is asked once and cached", async () => {
    let asked = 0;
    const p = createLinux("linux", has("ydotool"), { WAYLAND_DISPLAY: "w" }, {
      code: async () => { asked++; return { code: 1, out: "Available commands:\n  type\n  recorder\n" }; },
    });
    // ydotool is not installed here: the run fails, but only after the line was picked
    await p.runAction({ type: "hotkey", keys: "ctrl+c" }).catch(() => {});
    await p.runAction({ type: "type", text: "x" }).catch(() => {});
    expect(asked).toBe(1);
  });
});

describe("uinputAccess", () => {
  const me = { uid: 1000, groups: [1000, 104] };
  test("Debian 12 default crw------- root:root is not writable; the input group fix needs a udev rule", () => {
    expect(uinputAccess({ mode: 0o20600, uid: 0, gid: 0 }, me)).toEqual({ ok: false, why: "permission", gid: 0, groupWritable: false });
  });
  test("group-writable and the user is in it", () => {
    expect(uinputAccess({ mode: 0o20660, uid: 0, gid: 104 }, me).ok).toBe(true);
    expect(uinputAccess({ mode: 0o20660, uid: 0, gid: 105 }, me)).toEqual({ ok: false, why: "permission", gid: 105, groupWritable: true });
  });
  test("an ACL answer wins over the mode bits; missing device", () => {
    expect(uinputAccess({ mode: 0o20600, uid: 0, gid: 0 }, me, true).ok).toBe(true);
    expect(uinputAccess(null, me)).toEqual({ ok: false, why: "missing" });
    expect(uinputAccess({ mode: 0o20600, uid: 0, gid: 0 }, { uid: 0, groups: [] }).ok).toBe(true);
  });
});
