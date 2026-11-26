/**
 * The `screenshot` action: one button that starts the system's own screenshot tool on every OS (src/actions.ts buildCommand). Before
 * it, "Screenshot" / "Capture region" was the macOS hotkey cmd+shift+4 everywhere: Win+Shift+4 (nothing) on Windows, and on a Mac it
 * did nothing whenever the system screenshot shortcuts are turned off or changed in Keyboard settings. One file for the agent and
 * the manage page. No imports, ES5-safe like the other web/shared files.
 */

/** region: pick an area (the default); screen: the whole screen; window: one window. */
export type ScreenshotMode = "region" | "screen" | "window";
export const SCREENSHOT_MODES: ScreenshotMode[] = ["region", "screen", "window"];

/**
 * The screenshot shortcut a stored button may hold, as the mode it meant: cmd+shift+4 is region, cmd+shift+3 is screen. Any order
 * and case; anything else (another key, an extra modifier) is null.
 */
export function screenshotModeForKeys(keys: unknown): ScreenshotMode | null {
  if (typeof keys !== "string") return null;
  const parts = keys.toLowerCase().replace(/\s+/g, "").split("+").filter((p) => p.length > 0);
  if (parts.length !== 3 || parts.indexOf("cmd") < 0 || parts.indexOf("shift") < 0) return null;
  if (parts.indexOf("4") >= 0) return "region";
  if (parts.indexOf("3") >= 0) return "screen";
  return null;
}

/**
 * Which app takes the screenshot. "system" is the OS tool; the apps are driven the way their makers document it (URL scheme or
 * command line); "hotkey" presses the person's own shortcut; "command" runs a shell command (same rules as the shell action).
 * - snapzy: snapzy://capture/area | fullscreen | application (Snapzy: "Allow external triggers via snapzy:// URLs" must be on)
 * - cleanshot: cleanshot://capture-area | capture-fullscreen | capture-window (cleanshot.com/docs-api)
 * - shottr: shottr://grab/area | fullscreen | window (shottr.cc/kb/urlschemes, Shottr 1.8+)
 * - sharex: ShareX.exe -RectangleRegion | -PrintScreen | -ActiveWindow (getsharex.com/docs/command-line-arguments: any hotkey action)
 * - greenshot: its default keys, PrintScreen (region), Alt+PrintScreen (window), Ctrl+PrintScreen (screen) (getgreenshot.org/help)
 */
export type ScreenshotTool = "system" | "snapzy" | "cleanshot" | "shottr" | "sharex" | "greenshot" | "hotkey" | "command";
export const SCREENSHOT_TOOLS: ScreenshotTool[] = ["system", "snapzy", "cleanshot", "shottr", "sharex", "greenshot", "hotkey", "command"];

/** The apps each OS knows, in the order the automatic choice tries them (the first installed one wins). */
export const SCREENSHOT_APPS: { [os: string]: ScreenshotTool[] } = { darwin: ["snapzy", "cleanshot", "shottr"], win32: ["sharex", "greenshot"], linux: [] };

/** Names to show (app names stay as they are; "System", "Keyboard shortcut" and "Command" are translated by the manage page). */
export const SCREENSHOT_TOOL_LABEL: { [tool: string]: string } = {
  system: "System tool", snapzy: "Snapzy", cleanshot: "CleanShot X", shottr: "Shottr", sharex: "ShareX", greenshot: "Greenshot",
  hotkey: "Keyboard shortcut", command: "Command",
};

/** The tools to offer on an OS: the system tool, that OS's apps, the person's own shortcut, a command. */
export function screenshotToolsFor(os: string): ScreenshotTool[] {
  return (["system"] as ScreenshotTool[]).concat(SCREENSHOT_APPS[os] || [], ["hotkey", "command"]);
}

/** A tool choice: on a button (its own), or the screen's default (theme.screen.screenshot). keys for hotkey, command for command. */
export interface ScreenshotChoice {
  tool?: ScreenshotTool;
  keys?: string;
  command?: string;
}

/** The URL that starts an app's capture on macOS, or null when the tool is not a URL-scheme app. */
export function screenshotUrl(tool: ScreenshotTool, mode: ScreenshotMode): string | null {
  if (tool === "snapzy") return "snapzy://capture/" + (mode === "screen" ? "fullscreen" : mode === "window" ? "application" : "area");
  if (tool === "cleanshot") return "cleanshot://capture-" + (mode === "screen" ? "fullscreen" : mode === "window" ? "window" : "area");
  if (tool === "shottr") return "shottr://grab/" + (mode === "screen" ? "fullscreen" : mode === "window" ? "window" : "area");
  return null;
}

/** ShareX's hotkey action for a mode, used as its command-line argument. */
export function sharexArg(mode: ScreenshotMode): string {
  return mode === "screen" ? "-PrintScreen" : mode === "window" ? "-ActiveWindow" : "-RectangleRegion";
}
