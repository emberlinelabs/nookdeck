import { useEffect, useState } from "react";
import { api, type ScreenshotTools } from "@/api";
import { Field, Input } from "@/components/ui/knowns/input";
import { Select } from "@/components/ui/knowns/select";
import { HotkeyField } from "@/components/hotkey-field";
import { t, useLanguage } from "@/lib/i18n";
import { usePlatform } from "@/lib/platform";
import { SCREENSHOT_TOOL_LABEL, screenshotToolsFor, type ScreenshotChoice, type ScreenshotTool } from "@shared/screenshot";

let cache: ScreenshotTools | null = null;
let pending: Promise<ScreenshotTools | null> | null = null;

/** GET /api/screenshot-tools once per page load; null until it answers (or when the agent is older and has no such route). */
export function useScreenshotTools(): ScreenshotTools | null {
  const [v, setV] = useState(cache);
  useEffect(() => {
    if (cache) return;
    pending ??= api.getScreenshotTools().then((r) => (cache = r)).catch(() => null);
    let live = true;
    void pending.then((r) => { if (live && r) setV(r); });
    return () => { live = false; };
  }, []);
  return v;
}

/** A tool's name in the UI language (app names are not translated). */
export function toolName(tool: ScreenshotTool): string {
  const label = SCREENSHOT_TOOL_LABEL[tool] ?? tool;
  return tool === "system" || tool === "hotkey" || tool === "command" ? t(label) : label;
}

const HINT: Record<ScreenshotTool, string> = {
  system: "Opens the system's screenshot tool: the Screenshot app on macOS (it starts in the mode you used last), Snipping Tool on Windows, the desktop's screenshot tool on Linux.",
  snapzy: "Starts Snapzy through its snapzy:// links. If nothing happens, turn on \"Allow external triggers via snapzy:// URLs\" in Snapzy's settings.",
  cleanshot: "Starts CleanShot X through its cleanshot:// links.",
  shottr: "Starts Shottr through its shottr:// links (Shottr 1.8 or later).",
  sharex: "Runs ShareX with its capture action, as its own hotkeys do.",
  greenshot: "Presses Greenshot's default keys: Print Screen for a region, Alt+Print Screen for a window, Ctrl+Print Screen for the whole screen.",
  hotkey: "Presses the shortcut of your screenshot app.",
  command: "Runs this command on the computer, like the Command action.",
};

/** The tool that runs when a button sets none: the screen's default, else the automatic choice. */
export function effectiveTool(own: ScreenshotChoice | undefined, screen: ScreenshotChoice | undefined, info: ScreenshotTools | null): ScreenshotTool {
  return own?.tool ?? screen?.tool ?? info?.auto ?? "system";
}

/**
 * Tool picker for a screenshot button or for the screen's default. The first option inherits: on a button, the screen's default;
 * for the screen, the automatic choice (the first installed known app). Only the current OS's tools are listed.
 */
export function ScreenshotToolFields({ value, onChange, inheritLabel, inherited, id }: {
  value: ScreenshotChoice;
  onChange: (c: ScreenshotChoice) => void;
  /** e.g. "Screen default (Snapzy)" */
  inheritLabel: string;
  /** the tool the inherit option stands for, for the hint */
  inherited: ScreenshotTool;
  id: string;
}) {
  useLanguage();
  const info = useScreenshotTools();
  const os = usePlatform();
  const tools = info?.tools ?? screenshotToolsFor(os);
  const installed = info?.installed ?? [];
  const shown = value.tool ?? inherited;
  return (
    <>
      <Field label={t("Screenshot tool")} id={id}>
        <Select id={id} value={value.tool ?? ""}
          onChange={(e) => {
            const tool = e.target.value as ScreenshotTool | "";
            if (!tool) return onChange({});
            onChange(tool === "hotkey" ? { tool, keys: value.keys ?? "" } : tool === "command" ? { tool, command: value.command ?? "" } : { tool });
          }}
          options={[{ value: "", label: inheritLabel }, ...tools.map((tl) => ({ value: tl, label: installed.includes(tl) ? t("{name} (installed)", { name: toolName(tl) }) : toolName(tl) }))]} />
        <span className="text-xs text-muted-foreground">{t(HINT[shown])}</span>
      </Field>
      {value.tool === "hotkey" && <HotkeyField id={`${id}-keys`} label={t("Shortcut")} value={value.keys ?? ""} onChange={(keys) => onChange({ tool: "hotkey", keys })} />}
      {value.tool === "command" && (
        <Field label={t("Command")} id={`${id}-cmd`}>
          <Input id={`${id}-cmd`} value={value.command ?? ""} placeholder="flameshot gui" onChange={(e) => onChange({ tool: "command", command: e.target.value })} />
        </Field>
      )}
    </>
  );
}
