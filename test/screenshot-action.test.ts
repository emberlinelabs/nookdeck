// The `screenshot` action: one button that opens the system screenshot tool on every OS. Before it, "Screenshot" / "Capture region"
// was the macOS hotkey cmd+shift+4 everywhere (Win+Shift+4 on Windows; nothing on a Mac whose screenshot shortcuts are turned off).
// Nothing here takes a screenshot: commands are only built, and the Windows adapter runs with a fake `run` and `send`.
import { describe, expect, test } from "bun:test";
import { buildCommand, LINUX_SCREENSHOT_TOOLS, screenshotCommand } from "../src/actions";
import { defaultLayout, migrateScreenshotHotkeys, validateLayout, type Layout } from "../src/config";
import { macroSteps } from "../src/automation";
import { screenshotModeForKeys, screenshotToolsFor } from "../web/shared/screenshot";
import { automaticScreenshotTool, findScreenshotApp, installedScreenshotApps, resolveScreenshot } from "../src/screenshot";

describe("buildCommand: screenshot per system", () => {
  test("macOS: the Screenshot app through LaunchServices, every mode (no Screen Recording grant for the agent)", () => {
    for (const mode of ["region", "screen", "window"] as const) {
      expect(buildCommand({ type: "screenshot", mode }, "darwin")).toEqual(["open", "-b", "com.apple.screenshot.launcher"]);
    }
    expect(buildCommand({ type: "screenshot" }, "darwin")).toEqual(["open", "-b", "com.apple.screenshot.launcher"]);
  });
  test("Windows: the Snipping overlay (ms-screenclip:) through Start-Process", () => {
    const argv = buildCommand({ type: "screenshot" }, "win32");
    expect(argv[0]).toBe("powershell");
    expect(argv.at(-1)).toBe("Start-Process 'ms-screenclip:'");
  });
  test("Linux: gnome-screenshot, spectacle, flameshot, then the portal; started in the background", () => {
    const sh = (mode?: "region" | "screen" | "window") => buildCommand(mode ? { type: "screenshot", mode } : { type: "screenshot" }, "linux");
    const region = sh();
    expect(region.slice(0, 2)).toEqual(["sh", "-c"]);
    const lines = region[2]!.split("\n");
    expect(lines[0]).toBe("if command -v gnome-screenshot >/dev/null 2>&1; then 'gnome-screenshot' '-a' >/dev/null 2>&1 &");
    expect(lines[1]).toBe("elif command -v spectacle >/dev/null 2>&1; then 'spectacle' '-r' >/dev/null 2>&1 &");
    expect(lines[2]).toBe("elif command -v flameshot >/dev/null 2>&1; then 'flameshot' 'gui' >/dev/null 2>&1 &");
    expect(lines[3]).toContain("org.freedesktop.portal.Screenshot.Screenshot '' \"{'interactive': <true>}\"");
    expect(lines.at(-2)).toContain("exit 127");
    expect(sh("screen")[2]).toContain("'spectacle' '-f'");
    expect(sh("screen")[2]).toContain("'flameshot' 'full' '-c'");
    expect(sh("window")[2]).toContain("'gnome-screenshot' '-w'");
    expect(LINUX_SCREENSHOT_TOOLS.map((t) => t.bin)).toEqual(["gnome-screenshot", "spectacle", "flameshot"]);
  });
  test("an unknown mode is refused", () => {
    expect(() => screenshotCommand("everything" as any, "linux")).toThrow();
  });
});

describe("the Windows adapter", () => {
  const make = async () => {
    const W = await import("../src/platform/win32");
    const ran: string[][] = [];
    const sent: any[] = [];
    const p = W.createWin32({ helper: { call: async () => null, dispose() {} } as any, send: (e: unknown) => { sent.push(e); }, scan: () => 0, run: async (argv: string[]) => { ran.push(argv); return ""; } } as any);
    return { p, ran, sent };
  };
  test("region and window open the Snipping overlay and press no keys", async () => {
    const { p, ran, sent } = await make();
    await p.runAction({ type: "screenshot" });
    await p.runAction({ type: "screenshot", mode: "window" });
    expect(ran.map((a) => a.at(-1))).toEqual(["Start-Process 'ms-screenclip:'", "Start-Process 'ms-screenclip:'"]);
    expect(sent).toEqual([]);
  });
  test("screen presses PrintScreen (VK 0x2C) and runs nothing", async () => {
    const { p, ran, sent } = await make();
    await p.runAction({ type: "screenshot", mode: "screen" });
    expect(ran).toEqual([]);
    expect(sent.flat().map((e: any) => [e.vk, e.up])).toEqual([[0x2c, false], [0x2c, true]]);
  });
});

describe("validation", () => {
  const lay = (action: any) => ({ version: 1, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [{ id: "b", kind: "button", label: "Shot", action }] }] });
  test("a screenshot button keeps type and a known mode only", () => {
    expect((validateLayout(lay({ type: "screenshot", junk: 1 })).pages[0]!.items[0] as any).action).toEqual({ type: "screenshot" });
    expect((validateLayout(lay({ type: "screenshot", mode: "window" })).pages[0]!.items[0] as any).action).toEqual({ type: "screenshot", mode: "window" });
    expect(() => validateLayout(lay({ type: "screenshot", mode: "all" }))).toThrow(/region, screen or window/);
  });
  test("a screenshot macro step", () => {
    expect(macroSteps([{ kind: "screenshot", x: 1 }, { kind: "screenshot", mode: "screen" }], "steps")).toEqual([{ kind: "screenshot" }, { kind: "screenshot", mode: "screen" }]);
    expect(() => macroSteps([{ kind: "screenshot", mode: 3 }], "steps")).toThrow();
  });
  test("the default layout's Screenshot button uses the action", () => {
    const shot = defaultLayout().pages.flatMap((p) => p.items).find((i) => i.id === "b-shot") as any;
    expect(shot.action).toEqual({ type: "screenshot" });
  });
});

test("screenshotModeForKeys: the two macOS shortcuts, in any order and case", () => {
  expect(screenshotModeForKeys("cmd+shift+4")).toBe("region");
  expect(screenshotModeForKeys("Shift+Cmd+4")).toBe("region");
  expect(screenshotModeForKeys("cmd+shift+3")).toBe("screen");
  for (const k of ["cmd+shift+5", "cmd+4", "ctrl+cmd+shift+4", "cmd+alt+4", "", 4]) expect(screenshotModeForKeys(k)).toBeNull();
});

describe("migrating stored Screenshot buttons at load (every OS)", () => {
  const stored = (): Layout => validateLayout({ version: 1, pages: [
    { id: "p", name: "P", columns: 4, rows: 3, items: [
      { id: "area", kind: "button", label: "Shot", action: { type: "hotkey", keys: "cmd+shift+4" } },
      { id: "full", kind: "button", label: "Full", action: { type: "hotkey", keys: "Shift+Cmd+3" } },
      { id: "other", kind: "button", label: "Other", action: { type: "hotkey", keys: "cmd+shift+5" } },
      { id: "m", kind: "button", label: "Macro", action: { type: "macro", steps: [{ kind: "hotkey", keys: "cmd+shift+4" }, { kind: "hotkey", keys: "cmd+shift+3" }, { kind: "hotkey", keys: "cmd+s" }] } },
    ] },
    { id: "q", name: "Q", columns: 4, rows: 3, items: [{ id: "x", kind: "button", label: "X", action: { type: "hotkey", keys: "cmd+x" } }] },
  ] });
  const actions = (l: Layout) => Object.fromEntries(l.pages.flatMap((p) => p.items).map((i: any) => [i.id, i.action]));

  test("cmd+shift+4 becomes region, cmd+shift+3 screen, in a button or a macro step; other hotkeys stay; the input is not changed", () => {
    const before = stored();
    const after = migrateScreenshotHotkeys(before);
    const a = actions(after);
    expect(a.area).toEqual({ type: "screenshot" });
    expect(a.full).toEqual({ type: "screenshot", mode: "screen" });
    expect(a.other).toEqual({ type: "hotkey", keys: "cmd+shift+5" });
    expect(a.m).toEqual({ type: "macro", steps: [{ kind: "screenshot" }, { kind: "screenshot", mode: "screen" }, { kind: "hotkey", keys: "cmd+s" }] });
    expect(after.pages[1]).toBe(before.pages[1]!);
    expect(actions(before).area).toEqual({ type: "hotkey", keys: "cmd+shift+4" });
  });
  test("nothing to migrate: the same object back", () => {
    const l = validateLayout({ version: 1, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [] }] });
    expect(migrateScreenshotHotkeys(l)).toBe(l);
  });
});

describe("screenshot apps", () => {
  test("macOS: Snapzy, CleanShot X and Shottr through their documented URL schemes", () => {
    const url = (tool: any, mode?: any) => buildCommand({ type: "screenshot", tool, ...(mode ? { mode } : {}) }, "darwin");
    expect(url("snapzy")).toEqual(["open", "snapzy://capture/area"]);
    expect(url("snapzy", "screen")).toEqual(["open", "snapzy://capture/fullscreen"]);
    expect(url("snapzy", "window")).toEqual(["open", "snapzy://capture/application"]);
    expect(url("cleanshot")).toEqual(["open", "cleanshot://capture-area"]);
    expect(url("cleanshot", "screen")).toEqual(["open", "cleanshot://capture-fullscreen"]);
    expect(url("cleanshot", "window")).toEqual(["open", "cleanshot://capture-window"]);
    expect(url("shottr")).toEqual(["open", "shottr://grab/area"]);
    expect(url("shottr", "screen")).toEqual(["open", "shottr://grab/fullscreen"]);
    expect(url("shottr", "window")).toEqual(["open", "shottr://grab/window"]);
    expect(url("system")).toEqual(["open", "-b", "com.apple.screenshot.launcher"]);
  });
  test("Windows: ShareX with its hotkey action as the argument, through Start-Process", () => {
    const arg = (mode: any) => screenshotCommand(mode, "win32", "sharex", "C:\\Program Files\\ShareX\\ShareX.exe").at(-1);
    expect(arg("region")).toBe("Start-Process -FilePath 'C:\\Program Files\\ShareX\\ShareX.exe' -ArgumentList '-RectangleRegion'");
    expect(arg("screen")).toContain("'-PrintScreen'");
    expect(arg("window")).toContain("'-ActiveWindow'");
    expect(() => screenshotCommand("region", "win32", "sharex")).toThrow(/ShareX was not found/);
  });
  test("the Windows adapter: ShareX from Program Files, Greenshot by its keys", async () => {
    const W = await import("../src/platform/win32");
    const ran: string[][] = [];
    const sent: any[] = [];
    const exe = "C:\\Program Files\\ShareX\\ShareX.exe";
    const old = process.env.ProgramFiles;
    process.env.ProgramFiles = "C:\\Program Files";
    try {
      const p = W.createWin32({ helper: { call: async () => null, dispose() {} } as any, send: (e: unknown) => { sent.push(e); }, scan: () => 0, run: async (argv: string[]) => { ran.push(argv); return ""; }, exists: (f: string) => f === exe } as any);
      await p.runAction({ type: "screenshot", tool: "sharex", mode: "window" });
      expect(ran.at(-1)!.at(-1)).toBe(`Start-Process -FilePath '${exe}' -ArgumentList '-ActiveWindow'`);
      await p.runAction({ type: "screenshot", tool: "greenshot" });
      await p.runAction({ type: "screenshot", tool: "greenshot", mode: "window" });
      await p.runAction({ type: "screenshot", tool: "greenshot", mode: "screen" });
      const keys = sent.map((evs: any[]) => evs.map((e) => `${e.vk.toString(16)}${e.up ? "^" : "v"}`).join(" "));
      expect(keys).toEqual(["2cv 2c^", "12v 2cv 2c^ 12^", "11v 2cv 2c^ 11^"]);
    } finally {
      if (old === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = old;
    }
  });
  test("detection: installed known apps in preference order, by their default install paths", () => {
    const mac = new Set(["/Applications/Snapzy.app", "/Users/me/Applications/Shottr.app"]);
    expect(installedScreenshotApps("darwin", {}, "/Users/me", (p) => mac.has(p))).toEqual(["snapzy", "shottr"]);
    expect(installedScreenshotApps("darwin", {}, "/Users/me", (p) => p === "/Applications/Setapp/CleanShot X.app")).toEqual(["cleanshot"]);
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    expect(installedScreenshotApps("win32", env, "", (p) => p === "C:\\Users\\me\\AppData\\Local\\Programs\\Greenshot\\Greenshot.exe")).toEqual(["greenshot"]);
    expect(findScreenshotApp("sharex", "win32", env, "", (p) => p === "C:\\Program Files (x86)\\ShareX\\ShareX.exe")).toBe("C:\\Program Files (x86)\\ShareX\\ShareX.exe");
    expect(installedScreenshotApps("linux", env, "/home/me", () => true)).toEqual([]);
    expect(automaticScreenshotTool([])).toBe("system");
    expect(automaticScreenshotTool(["snapzy", "shottr"])).toBe("snapzy");
  });
  test("each OS offers only its own tools", () => {
    expect(screenshotToolsFor("darwin")).toEqual(["system", "snapzy", "cleanshot", "shottr", "hotkey", "command"]);
    expect(screenshotToolsFor("win32")).toEqual(["system", "sharex", "greenshot", "hotkey", "command"]);
    expect(screenshotToolsFor("linux")).toEqual(["system", "hotkey", "command"]);
  });
});

describe("which tool a press uses", () => {
  const shot = (x: object = {}) => ({ type: "screenshot" as const, ...x });
  test("the button's tool, else the screen's default, else the first installed app, else the system tool", () => {
    expect(resolveScreenshot(shot({ tool: "cleanshot", mode: "window" }), { tool: "shottr" }, ["snapzy"], "darwin")).toEqual({ type: "screenshot", mode: "window", tool: "cleanshot" });
    expect(resolveScreenshot(shot(), { tool: "shottr" }, ["snapzy"], "darwin")).toEqual({ type: "screenshot", tool: "shottr" });
    expect(resolveScreenshot(shot({ mode: "screen" }), undefined, ["snapzy"], "darwin")).toEqual({ type: "screenshot", mode: "screen", tool: "snapzy" });
    expect(resolveScreenshot(shot(), undefined, [], "darwin")).toEqual({ type: "screenshot", tool: "system" });
  });
  test("the person's shortcut is a hotkey press, their command a shell action", () => {
    expect(resolveScreenshot(shot({ tool: "hotkey", keys: "cmd+shift+3" }), undefined, [], "darwin")).toEqual({ type: "hotkey", keys: "cmd+shift+3" });
    expect(resolveScreenshot(shot(), { tool: "command", command: "flameshot gui" }, [], "linux")).toEqual({ type: "shell", command: "flameshot gui" });
    expect(() => resolveScreenshot(shot({ tool: "hotkey" }), undefined, [], "darwin")).toThrow(/shortcut is not set/);
  });
  test("a tool of another OS falls back to the system tool", () => {
    expect(resolveScreenshot(shot({ tool: "snapzy" }), undefined, [], "win32")).toEqual({ type: "screenshot", tool: "system" });
    expect(resolveScreenshot(shot(), { tool: "sharex" }, [], "darwin")).toEqual({ type: "screenshot", tool: "system" });
  });
});

describe("validation of tools", () => {
  const lay = (action: any, screen?: any) => ({ version: 1, ...(screen ? { theme: { screen } } : {}), pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [{ id: "b", kind: "button", label: "Shot", action }] }] });
  const act = (action: any) => (validateLayout(lay(action)).pages[0]!.items[0] as any).action;
  test("a known tool; keys only for hotkey, command only for command", () => {
    expect(act({ type: "screenshot", tool: "snapzy", keys: "x", command: "y" })).toEqual({ type: "screenshot", tool: "snapzy" });
    expect(act({ type: "screenshot", tool: "hotkey", keys: "cmd+shift+3", command: "y" })).toEqual({ type: "screenshot", tool: "hotkey", keys: "cmd+shift+3" });
    expect(act({ type: "screenshot", tool: "command", command: "flameshot gui" })).toEqual({ type: "screenshot", tool: "command", command: "flameshot gui" });
    expect(() => act({ type: "screenshot", tool: "paint" })).toThrow(/tool must be one of/);
    expect(() => act({ type: "screenshot", tool: "hotkey" })).toThrow();
    // empty while the form is being filled, like the hotkey and shell actions; a press then says it is not set
    expect(act({ type: "screenshot", tool: "command", command: "" })).toEqual({ type: "screenshot", tool: "command", command: "" });
  });
  test("the screen's default tool", () => {
    expect(validateLayout(lay({ type: "screenshot" }, { screenshot: { tool: "sharex" } })).theme!.screen!.screenshot).toEqual({ tool: "sharex" });
    expect(validateLayout(lay({ type: "screenshot" }, { screenshot: {} })).theme?.screen?.screenshot).toBeUndefined();
    expect(() => validateLayout(lay({ type: "screenshot" }, { screenshot: { tool: "nope" } }))).toThrow(/theme.screen.screenshot.tool/);
  });
});
