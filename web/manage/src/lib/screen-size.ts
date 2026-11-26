import { useCallback, useState } from "react";

/** Landscape W x H in CSS px. Labels are English source text (translated where shown). */
export const SCREEN_PRESETS: { id: string; label: string; w: number; h: number }[] = [
  { id: "se1", label: "iPhone SE 1st / 5s", w: 568, h: 320 },
  { id: "se2", label: "iPhone SE 2/3 / 8", w: 667, h: 375 },
  { id: "iphone", label: "iPhone 14/15", w: 844, h: 390 },
  { id: "promax", label: "iPhone Pro Max", w: 932, h: 430 },
  { id: "android-s", label: "Android small", w: 640, h: 360 },
  { id: "android", label: "Android", w: 915, h: 412 },
  { id: "ipad-mini", label: "iPad mini", w: 1133, h: 744 },
  { id: "ipad", label: "iPad", w: 1180, h: 820 },
];
/** Follows a connected phone's own screen size (see resolveScreen); falls back to iPhone 14/15 when none is online. */
export const AUTO = "auto";
export const DEFAULT_PRESET = AUTO;
/** "device:<id>": one paired phone's size, kept with the last size it reported so it still works while that phone is offline. */
export const DEVICE_PREFIX = "device:";
export const CUSTOM_MIN = 320;
export const CUSTOM_MAX = 1400;
const KEY = "pd.manage.screenSize";

export interface ScreenChoice { preset: string; w: number; h: number }
const clamp = (n: number) => Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Math.round(n) || CUSTOM_MIN));

function read(): ScreenChoice {
  const fallback = { preset: DEFAULT_PRESET, w: 844, h: 390 };
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ScreenChoice> | null;
    if (!o) return fallback;
    if ((o.preset === "custom" || o.preset?.startsWith(DEVICE_PREFIX)) && typeof o.w === "number" && typeof o.h === "number") return { preset: o.preset, w: clamp(o.w), h: clamp(o.h) };
    if (o.preset === AUTO) return fallback;
    const p = SCREEN_PRESETS.find((x) => x.id === o.preset);
    return p ? { preset: p.id, w: p.w, h: p.h } : fallback;
  } catch {
    return fallback;
  }
}

/** The screen size being previewed (landscape W x H), remembered per viewer in the browser, never in the layout. */
export function useScreenSize(): [ScreenChoice, (c: { preset: string; w?: number; h?: number }) => void] {
  const [choice, setChoice] = useState<ScreenChoice>(read);
  const set = useCallback((c: { preset: string; w?: number; h?: number }) => {
    const p = SCREEN_PRESETS.find((x) => x.id === c.preset);
    const next: ScreenChoice = p ? { preset: p.id, w: p.w, h: p.h }
      : c.preset === AUTO ? { preset: AUTO, w: 844, h: 390 }
      : { preset: c.preset.startsWith(DEVICE_PREFIX) ? c.preset : "custom", w: clamp(c.w ?? 844), h: clamp(c.h ?? 390) };
    setChoice(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }, []);
  return [choice, set];
}

export interface OnlinePhone { id: string; name: string; w: number; h: number }

/** Online paired phones that reported their screen size, most recently seen first. */
export function onlinePhones(devices: { id: string; name: string; online?: boolean; lastSeen?: string; viewport?: { w: number; h: number } }[]): OnlinePhone[] {
  return devices
    .filter((d) => d.online && d.viewport && d.viewport.w > 0 && d.viewport.h > 0)
    .sort((a, b) => String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")))
    .map((d) => ({ id: d.id, name: d.name, w: clamp(d.viewport!.w), h: clamp(d.viewport!.h) }));
}

/**
 * The size to preview: "auto" takes the first online phone (else iPhone 14/15); "device:<id>" takes that phone's size while it is
 * online, else the size saved when it was picked; presets and custom are what they say. `from` names the phone used, if any.
 */
export function resolveScreen(choice: ScreenChoice, phones: OnlinePhone[]): { w: number; h: number; from?: OnlinePhone } {
  if (choice.preset === AUTO) return phones[0] ? { w: phones[0].w, h: phones[0].h, from: phones[0] } : { w: 844, h: 390 };
  if (choice.preset.startsWith(DEVICE_PREFIX)) {
    const p = phones.find((x) => DEVICE_PREFIX + x.id === choice.preset);
    return p ? { w: p.w, h: p.h, from: p } : { w: choice.w, h: choice.h };
  }
  return { w: choice.w, h: choice.h };
}
