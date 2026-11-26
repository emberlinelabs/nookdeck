/** Pure logic of the On Air / Mic / Camera button form (components/live-fields.tsx). No React, no DOM: tested in test/manage-live-form.test.ts. */
import { validOnairAction, MIC_MODES, ONAIR_MODES } from "../../../shared/onair";

/** Sets the mode; the default (toggle) is stored as no mode, like a hand-written layout would be. */
export function withMode<T extends { mode?: string }>(a: T, mode: string): T {
  const next = { ...a };
  if (!mode || mode === "toggle") delete next.mode;
  else next.mode = mode;
  return next;
}

/** Modes the form offers for an action type (the first is the default); camera has none. */
export const modesFor = (type: string): string[] => (type === "onair" ? ONAIR_MODES : type === "mic" ? MIC_MODES : []);

/** English message when the action cannot be saved (the same check the agent runs), or null. */
export function formProblem(a: { type: string; [k: string]: unknown }): string | null {
  return validOnairAction(a) ? "Choose a valid mode." : null;
}
