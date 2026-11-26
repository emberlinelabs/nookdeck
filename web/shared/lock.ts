/**
 * "Lock sleeps the phone": which button actions lock the computer, and which phones go to sleep after one. One file for the agent
 * (src/server.ts sends {type:"sleep"}) and the deck. No imports, ES5-safe for the Safari 12 deck build.
 */

/** Screen setting theme.screen.lockSleep: the phone that pressed the lock button (default), every phone, or none. */
export type LockSleep = "phone" | "all" | "off";
export const LOCK_SLEEP: LockSleep[] = ["phone", "all", "off"];

/** Agent to phone: go to the black sleep screen until tapped. */
export interface SleepMsg {
  type: "sleep";
}

/** The lock shortcut as the layout stores it ("Lock computer" in the palette): ctrl+cmd+q, in any order and case. */
export function isLockKeys(keys: unknown): boolean {
  if (typeof keys !== "string") return false;
  const parts = keys.toLowerCase().replace(/\s+/g, "").split("+").filter((p) => p.length > 0);
  if (parts.length !== 3) return false;
  const want = ["ctrl", "cmd", "q"];
  for (let i = 0; i < want.length; i++) if (parts.indexOf(want[i]!) < 0) return false;
  return true;
}

/** Does pressing this action lock the computer? The lock action, the old lock hotkey, or a macro with either as a step. */
export function isLockAction(a: unknown): boolean {
  if (!a || typeof a !== "object") return false;
  const o = a as { type?: unknown; keys?: unknown; steps?: unknown };
  if (o.type === "lock") return true;
  if (o.type === "hotkey") return isLockKeys(o.keys);
  if (o.type === "macro" && Array.isArray(o.steps)) {
    for (let i = 0; i < o.steps.length; i++) {
      const s = o.steps[i] as { kind?: unknown; keys?: unknown } | null;
      if (s && (s.kind === "lock" || (s.kind === "hotkey" && isLockKeys(s.keys)))) return true;
    }
  }
  return false;
}

/** Who gets the sleep message after a lock press: "presser", "all" or nobody. Missing or unknown setting = the presser. */
export function sleepTargets(setting: unknown): "presser" | "all" | null {
  if (setting === "off") return null;
  if (setting === "all") return "all";
  return "presser";
}
