/**
 * Which screenshot tool a press uses, and which known screenshot apps are installed (web/shared/screenshot.ts has the tools).
 * A button's own tool wins; else the screen's default (theme.screen.screenshot); else the first installed known app; else the system
 * tool. The OS is passed in (only src/platform looks at which OS this is).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "./config";
import { SCREENSHOT_APPS, screenshotToolsFor, type ScreenshotChoice, type ScreenshotTool } from "../web/shared/screenshot";

type Env = Record<string, string | undefined>;

/** Where each app is installed by default (the first path that exists counts). */
export function screenshotAppPaths(tool: ScreenshotTool, os: string, env: Env, home: string): string[] {
  const win = (base: string | undefined, rel: string) => (base ? `${base.replace(/[\\/]+$/, "")}\\${rel}` : "");
  if (os === "darwin") {
    const app = tool === "snapzy" ? "Snapzy.app" : tool === "cleanshot" ? "CleanShot X.app" : tool === "shottr" ? "Shottr.app" : "";
    if (!app) return [];
    return [join("/Applications", app), join("/Applications/Setapp", app), join(home, "Applications", app)];
  }
  if (os === "win32") {
    const pf = [env.ProgramFiles, env["ProgramFiles(x86)"]];
    if (tool === "sharex") return pf.map((b) => win(b, "ShareX\\ShareX.exe")).filter(Boolean);
    if (tool === "greenshot") return [...pf.map((b) => win(b, "Greenshot\\Greenshot.exe")), win(env.LOCALAPPDATA, "Programs\\Greenshot\\Greenshot.exe")].filter(Boolean);
  }
  return [];
}

/** The installed path of an app, or null. */
export function findScreenshotApp(tool: ScreenshotTool, os: string, env: Env, home: string, exists: (p: string) => boolean = existsSync): string | null {
  for (const p of screenshotAppPaths(tool, os, env, home)) if (exists(p)) return p;
  return null;
}

/** The known apps installed on this computer, in preference order. */
export function installedScreenshotApps(os: string, env: Env, home: string, exists: (p: string) => boolean = existsSync): ScreenshotTool[] {
  return (SCREENSHOT_APPS[os] ?? []).filter((t) => findScreenshotApp(t, os, env, home, exists) !== null);
}

/** The tool used when neither the button nor the screen picks one. */
export function automaticScreenshotTool(installed: ScreenshotTool[]): ScreenshotTool {
  return installed[0] ?? "system";
}

/**
 * The action a screenshot press really runs: the person's shortcut (a hotkey action), their command (a shell action), or the
 * screenshot action with a concrete tool. A tool of another OS falls back to the system tool.
 */
export function resolveScreenshot(a: Extract<Action, { type: "screenshot" }>, screenDefault: ScreenshotChoice | undefined, installed: ScreenshotTool[], os: string): Action {
  const pick: ScreenshotChoice = a.tool ? a : screenDefault?.tool ? screenDefault : { tool: automaticScreenshotTool(installed) };
  const tool = pick.tool && screenshotToolsFor(os).includes(pick.tool) ? pick.tool : "system";
  if (tool === "hotkey") {
    if (!pick.keys) throw new Error("the screenshot shortcut is not set");
    return { type: "hotkey", keys: pick.keys };
  }
  if (tool === "command") {
    if (!pick.command) throw new Error("the screenshot command is not set");
    return { type: "shell", command: pick.command };
  }
  return { type: "screenshot", ...(a.mode ? { mode: a.mode } : {}), tool };
}
