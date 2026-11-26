import { useSyncExternalStore } from "react";
import { VI } from "@/i18n/vi";
import { ZH } from "@/i18n/zh";
import { FR } from "@/i18n/fr";
import { PT } from "@/i18n/pt";

/**
 * Tiny i18n. English is the source language: the English text IS the key, `t("Save")`.
 * Vietnamese lives in `src/i18n/vi/*.ts`, Simplified Chinese in `src/i18n/zh/*.ts`, French in `src/i18n/fr/*.ts` and
 * Brazilian Portuguese in `src/i18n/pt/*.ts`
 * (English text -> translation). A missing entry falls back to the English text.
 * `{name}` placeholders are filled from the second argument: `t("Sent to {n} devices", { n: 3 })`.
 * Call `t` at render time (never at module load) so a language change shows up; data tables keep English text
 * and call `t(label)` where they render it.
 */
export type Language = "en" | "vi" | "zh" | "fr" | "pt";
export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "en", label: "English" },
  { id: "vi", label: "Tiếng Việt" },
  { id: "zh", label: "简体中文" },
  { id: "fr", label: "Français" },
  { id: "pt", label: "Português" },
];
const EXTRA: Language[] = ["vi", "zh", "fr", "pt"];
const isExtra = (v: unknown): v is Language => EXTRA.includes(v as Language);
/** The first two letters of a browser language ("fr-CA", "pt-PT" and "pt-BR" all count), English otherwise. */
export function fromBrowser(tag: string): Language {
  const p = tag.toLowerCase().slice(0, 2);
  return isExtra(p) ? p : "en";
}

const KEY = "pd.manage.lang";
const DICTS: { [lang: string]: Record<string, string> } = { vi: VI, zh: ZH, fr: FR, pt: PT };
/** Last language shown (browser only): avoids a flash of English before the layout loads. */
function initial(): Language {
  try {
    const s = localStorage.getItem(KEY);
    if (isExtra(s)) return s;
    // First visit, before the layout arrives: follow the browser's language.
    return fromBrowser(navigator.language || "");
  } catch {
    return "en";
  }
}
let current: Language = initial();
const listeners = new Set<() => void>();

export const getLanguage = (): Language => current;
export function setLanguage(l: Language): void {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* storage unavailable */
  }
  try {
    document.documentElement.lang = l;
  } catch {
    /* no document (tests) */
  }
  listeners.forEach((f) => f());
}
/** Normalises whatever the agent stored: "vi", "zh", "fr" and "pt" are the extra languages, anything else is English. */
export const asLanguage = (v: unknown): Language => (isExtra(v) ? v : "en");

/** BCP 47 tag for Intl, toLocaleString and localeCompare. */
export const localeTag = (l: Language = current): string => ({ en: "en-US", vi: "vi-VN", zh: "zh-CN", fr: "fr-FR", pt: "pt-BR" })[l];

/** Every translation of an English text (used to spot a default label the user never changed). */
export const translationsOf = (text: string): string[] => Object.values(DICTS).map((d) => d[text]).filter((v): v is string => !!v);

export function t(text: string, params?: Record<string, string | number>): string {
  const dict = DICTS[current];
  const base = dict ? dict[text] ?? text : text;
  return params ? base.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : base;
}

/** Re-renders the calling component when the language changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => "en",
  );
}
