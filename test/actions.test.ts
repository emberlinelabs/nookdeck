import { expect, test } from "bun:test";
import {
  buildCommand, MAC_NATIVE, escapePowerShell, escapeSendKeys, parseHotkey, runAction,
} from "../src/actions.ts";

test("parseHotkey", () => {
  expect(parseHotkey("cmd+shift+4")).toEqual({ mods: ["cmd", "shift"], key: "4" });
  expect(parseHotkey("Option+Control+T")).toEqual({ mods: ["alt", "ctrl"], key: "t" });
  expect(parseHotkey("f5")).toEqual({ mods: [], key: "f5" });
  expect(parseHotkey("enter")).toEqual({ mods: [], key: "return" });
  expect(parseHotkey("cmd++")).toEqual({ mods: ["cmd"], key: "+" });
  expect(() => parseHotkey("")).toThrow();
  expect(() => parseHotkey("cmd+shift")).toThrow();
  expect(() => parseHotkey("cmd+a+b")).toThrow();
  expect(() => parseHotkey("cmd+banana")).toThrow();
});

test("darwin keys, typing, media and volume are native, not commands", () => {
  for (const a of [
    { type: "hotkey", keys: "cmd+shift+4" }, { type: "type", text: "hi" }, { type: "media", command: "playpause" },
    { type: "volume", command: "up" }, { type: "volume", command: "mute" },
  ] as const) expect(() => buildCommand(a, "darwin")).toThrow(MAC_NATIVE);
});

test("darwin open", () => {
  expect(buildCommand({ type: "open", target: "https://example.com" }, "darwin")).toEqual(["open", "https://example.com"]);
  expect(buildCommand({ type: "open", target: "/Applications/Foo.app" }, "darwin")).toEqual(["open", "/Applications/Foo.app"]);
  expect(buildCommand({ type: "open", target: "Safari" }, "darwin")).toEqual(["open", "-a", "Safari"]);
  expect(buildCommand({ type: "open", target: "~/x" }, "darwin")[1]).not.toStartWith("~");
});

test("linux mappings", () => {
  expect(buildCommand({ type: "hotkey", keys: "cmd+shift+4" }, "linux")).toEqual(["xdotool", "key", "--", "super+shift+4"]);
  expect(buildCommand({ type: "hotkey", keys: "ctrl+alt+return" }, "linux")).toEqual(["xdotool", "key", "--", "ctrl+alt+Return"]);
  expect(buildCommand({ type: "hotkey", keys: "f5" }, "linux")[3]).toBe("F5");
  expect(buildCommand({ type: "type", text: "-rf" }, "linux")).toEqual(["xdotool", "type", "--delay", "12", "--", "-rf"]);
  expect(buildCommand({ type: "open", target: "https://a.b" }, "linux")).toEqual(["xdg-open", "https://a.b"]);
  expect(buildCommand({ type: "media", command: "playpause" }, "linux")).toEqual(["playerctl", "play-pause"]);
  expect(buildCommand({ type: "media", command: "previous" }, "linux")).toEqual(["playerctl", "previous"]);
  expect(buildCommand({ type: "volume", command: "up" }, "linux")).toEqual(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "+5%"]);
  expect(buildCommand({ type: "volume", command: "mute" }, "linux")).toEqual(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"]);
  expect(buildCommand({ type: "shell", command: "ls | wc" }, "linux")).toEqual(["sh", "-c", "ls | wc"]);
});

test("win32 sendkeys escaping", () => {
  expect(escapeSendKeys("a+b^c%d~e(f)g{h}i[j]")).toBe("a{+}b{^}c{%}d{~}e{(}f{)}g{{}h{}}i{[}j{]}");
  expect(escapeSendKeys("x\ny")).toBe("x{ENTER}y");
  expect(escapePowerShell("it's")).toBe("it''s");
  expect(escapePowerShell("’")).toBe("’’");
});

test("win32 mappings", () => {
  const sk = (argv: string[]) => argv[argv.length - 1]!;
  expect(sk(buildCommand({ type: "hotkey", keys: "cmd+c" }, "win32"))).toContain("SendKeys('^c')");
  expect(sk(buildCommand({ type: "hotkey", keys: "ctrl+alt+shift+t" }, "win32"))).toContain("SendKeys('^%+t')");
  expect(sk(buildCommand({ type: "hotkey", keys: "f5" }, "win32"))).toContain("SendKeys('{F5}')");
  expect(sk(buildCommand({ type: "hotkey", keys: "ctrl++" }, "win32"))).toContain("SendKeys('^{+}')");
  expect(sk(buildCommand({ type: "type", text: "it's 50%" }, "win32"))).toContain("SendKeys('it''s 50{%}')");
  expect(sk(buildCommand({ type: "open", target: "https://a.b/?x=1&y=2" }, "win32"))).toContain("Start-Process -FilePath 'https://a.b/?x=1&y=2'");
  expect(sk(buildCommand({ type: "media", command: "playpause" }, "win32"))).toContain("[char]179");
  expect(sk(buildCommand({ type: "media", command: "next" }, "win32"))).toContain("[char]176");
  expect(sk(buildCommand({ type: "volume", command: "up" }, "win32"))).toContain("[char]175");
  expect(sk(buildCommand({ type: "volume", command: "mute" }, "win32"))).toContain("[char]173");
  expect(buildCommand({ type: "shell", command: "dir" }, "win32")).toEqual(["cmd", "/c", "dir"]);
  expect(buildCommand({ type: "type", text: "a" }, "win32")[0]).toBe("powershell");
});

test("buildCommand rejects page and unknown platforms", () => {
  expect(() => buildCommand({ type: "page", page: "x" }, "darwin")).toThrow();
  expect(() => buildCommand({ type: "shell", command: "x" }, "freebsd")).toThrow(/unsupported/);
});

test("runAction page is a no-op", async () => {
  await runAction({ type: "page", page: "home" });
});

test.skipIf(process.platform === "win32")("runAction shell success and failure", async () => {
  await runAction({ type: "shell", command: "echo hi" });
  await expect(runAction({ type: "shell", command: "echo boom >&2; exit 1" })).rejects.toThrow("boom");
  await expect(runAction({ type: "shell", command: "exit 3" })).rejects.toThrow(/code 3/);
});
