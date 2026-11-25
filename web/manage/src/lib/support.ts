/**
 * The project's two support links, and when the manage page may ask for them once. Kept in this browser only (localStorage):
 * nothing is sent anywhere, and without storage the card never shows, because a "no" could not be remembered.
 */
export const GITHUB_URL = "https://github.com/howznguyen/nookdeck";
export const KOFI_URL = "https://ko-fi.com/howznguyen";

export const SUPPORT_KEY = "pd.manage.support";
const DAY = 86_400_000;
export const ASK_AFTER_MS = 3 * DAY;
export const SNOOZE_MS = 14 * DAY;

export interface SupportState {
  /** when this browser first opened the manage page */
  first: number;
  /** "Later": not before this */
  until?: number;
  /** a link was opened, or "Don't show again" */
  done?: boolean;
}

export type SupportStore = Pick<Storage, "getItem" | "setItem">;

function parse(raw: string | null, now: number): SupportState {
  try {
    const v = JSON.parse(raw ?? "") as Partial<SupportState>;
    if (v && typeof v.first === "number" && Number.isFinite(v.first)) {
      // a clock that was set back starts the wait again
      return { first: Math.min(v.first, now), ...(typeof v.until === "number" ? { until: v.until } : {}), ...(v.done === true ? { done: true } : {}) };
    }
  } catch {
    /* nothing saved yet, or not ours */
  }
  return { first: now };
}

export const due = (s: SupportState, now: number): boolean => !s.done && now - s.first >= ASK_AFTER_MS && now >= (s.until ?? 0);

/** Reads the state, remembering the first visit. False when storage cannot be used. */
export function shouldAsk(store: () => SupportStore, now: number): boolean {
  try {
    const s = parse(store().getItem(SUPPORT_KEY), now);
    store().setItem(SUPPORT_KEY, JSON.stringify(s));
    return due(s, now);
  } catch {
    return false;
  }
}

export function answer(store: () => SupportStore, now: number, choice: "later" | "done"): void {
  try {
    const s = parse(store().getItem(SUPPORT_KEY), now);
    store().setItem(SUPPORT_KEY, JSON.stringify(choice === "done" ? { ...s, done: true } : { ...s, until: now + SNOOZE_MS }));
  } catch {
    /* storage unavailable: the card is gone for this visit anyway */
  }
}
