import type { Theme } from "@/types";

export interface ThemePreset {
  name: string;
  hint: string;
  theme: Theme;
}

/** One-click looks. They set every visual field at once (orientation is kept by the panel). */
export const THEME_PRESETS: ThemePreset[] = [
  { name: "iOS Shortcuts", hint: "Rounded color tiles", theme: { mode: "dark", accent: "#22d3ee", background: "#0b0b0d", tile: "#141417", radius: 14, gap: 10, fontScale: 1, tileStyle: "ios", iconScale: 1, iconStroke: 2.25, showLabels: true } },
  { name: "Nookdeck cyan", hint: "Default", theme: { mode: "dark", accent: "#22d3ee", background: "#0b0b0d", tile: "#141417", radius: 14, gap: 10, fontScale: 1, tileStyle: "tint", iconScale: 1, showLabels: true } },
  { name: "Violet", hint: "The former default", theme: { mode: "dark", accent: "#8b5cf6", background: "#0b0b0d", tile: "#141417", radius: 14, gap: 10, fontScale: 1, tileStyle: "tint", iconScale: 1, showLabels: true } },
  { name: "Knowns purple", hint: "Deep purple background", theme: { mode: "dark", accent: "#a78bfa", background: "#0e0a1c", tile: "#191330", radius: 18, gap: 10, fontScale: 1, tileStyle: "tint", iconScale: 1, showLabels: true } },
  { name: "OLED black", hint: "Pure black background", theme: { mode: "dark", accent: "#34d399", background: "#000000", tile: "#0a0a0a", radius: 18, gap: 8, fontScale: 1, tileStyle: "outline", iconScale: 1.1, showLabels: true } },
  { name: "Warm wood", hint: "Neutral brown", theme: { mode: "dark", accent: "#e0a96d", background: "#17120e", tile: "#241d17", text: "#f3e9dc", radius: 12, gap: 10, fontScale: 1, tileStyle: "tint", iconScale: 1, showLabels: true } },
  { name: "Light", hint: "Light background", theme: { mode: "light", accent: "#0e7490", background: "#f4f4f6", tile: "#ffffff", text: "#111113", radius: 14, gap: 10, fontScale: 1, tileStyle: "tint", iconScale: 1, showLabels: true } },
  { name: "High contrast", hint: "Easy to read", theme: { mode: "dark", accent: "#facc15", background: "#000000", tile: "#1a1a1a", text: "#ffffff", radius: 8, gap: 12, fontScale: 1.15, tileStyle: "solid", iconScale: 1.25, showLabels: true } },
];

const KEYS = ["mode", "accent", "background", "tile", "text", "radius", "gap", "fontScale", "tileStyle", "iconScale", "iconStroke", "showLabels"] as const;

/** True when the saved theme equals the preset (orientation is not part of a preset). Missing fields count as defaults. */
export function presetMatches(current: Theme, preset: Theme, defaults: Record<string, unknown>): boolean {
  return KEYS.every((k) => {
    const a = (current as Record<string, unknown>)[k] ?? defaults[k];
    const b = (preset as Record<string, unknown>)[k] ?? defaults[k];
    return typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
  });
}
