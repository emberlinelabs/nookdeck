// The On Air / Mic / Camera button form on the manage page: modes and validation (web/manage/src/lib/live-form.ts), and that every
// action the form or the palette can make passes the agent's check (validOnairAction in web/shared/onair.ts).
import { expect, test } from "bun:test";
import { validOnairAction } from "../web/shared/onair";
import { formProblem, modesFor, withMode } from "../web/manage/src/lib/live-form";

test("modes per action; toggle is stored as no mode", () => {
  expect(modesFor("onair")).toEqual(["toggle", "on", "off"]);
  expect(modesFor("mic")).toEqual(["toggle", "mute", "unmute"]);
  expect(modesFor("camera")).toEqual([]);
  expect(withMode({ type: "onair", mode: "on" } as { mode?: string }, "toggle")).toEqual({ type: "onair" } as never);
  expect(withMode({ type: "mic" } as { mode?: string }, "mute")).toEqual({ type: "mic", mode: "mute" } as never);
});

test("every mode the form offers saves; a bad one is reported", () => {
  for (const type of ["onair", "mic"]) {
    for (const m of modesFor(type)) {
      const a = withMode({ type } as { type: string; mode?: string }, m);
      expect([a, formProblem(a), validOnairAction(a)]).toEqual([a, null, null]);
    }
  }
  expect(formProblem({ type: "camera" })).toBeNull();
  expect(formProblem({ type: "onair", mode: "blink" })).toBe("Choose a valid mode.");
  expect(formProblem({ type: "mic", mode: "on" })).toBe("Choose a valid mode.");
});
