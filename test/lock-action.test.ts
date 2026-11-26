// The `lock` action: one button that locks the computer on every system. Before it, "Lock computer" was the macOS hotkey ctrl+cmd+q
// everywhere (Ctrl+Win+Q = Quick Assist on Windows, nothing on Linux). Nothing here locks this machine: commands are only built,
// and the Windows adapter runs with a fake `run`.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { buildCommand, MAC_NATIVE } from "../src/actions";
import { HOME, defaultLayout, migrateLockHotkeys, validateLayout, type Layout } from "../src/config";
import { macroSteps } from "../src/automation";
import { isLockAction } from "../web/shared/lock";

describe("buildCommand: lock per system", () => {
  test("Windows: LockWorkStation", () => {
    expect(buildCommand({ type: "lock" }, "win32")).toEqual(["rundll32.exe", "user32.dll,LockWorkStation"]);
  });
  test("Linux: loginctl lock-session, else xdg-screensaver lock", () => {
    expect(buildCommand({ type: "lock" }, "linux")).toEqual(["sh", "-c", "loginctl lock-session || xdg-screensaver lock"]);
  });
  test("macOS: native (the ctrl+cmd+q shortcut through the native helper)", () => {
    expect(() => buildCommand({ type: "lock" }, "darwin")).toThrow(MAC_NATIVE);
  });
});

test("the Windows adapter runs LockWorkStation and sends no keys", async () => {
  const W = await import("../src/platform/win32");
  const ran: string[][] = [];
  const sent: unknown[] = [];
  const p = W.createWin32({ helper: { call: async () => null, dispose() {} } as any, send: (e: unknown) => { sent.push(e); }, scan: () => 0, run: async (argv: string[]) => { ran.push(argv); return ""; } } as any);
  await p.runAction({ type: "lock" });
  expect(ran).toEqual([["rundll32.exe", "user32.dll,LockWorkStation"]]);
  expect(sent).toEqual([]);
});

describe("validation", () => {
  const lay = (action: any) => ({ version: 1, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [{ id: "b", kind: "button", label: "Lock", action }] }] });
  test("a lock button keeps only its type", () => {
    expect((validateLayout(lay({ type: "lock", junk: 1 })).pages[0]!.items[0] as any).action).toEqual({ type: "lock" });
  });
  test("a lock macro step", () => {
    expect(macroSteps([{ kind: "hotkey", keys: "cmd+s" }, { kind: "lock", x: 1 }], "steps")).toEqual([{ kind: "hotkey", keys: "cmd+s" }, { kind: "lock" }]);
  });
  test("the default layout's Lock button uses the action", () => {
    const lock = defaultLayout().pages.flatMap((p) => p.items).find((i) => i.id === "b-lock") as any;
    expect(lock.action).toEqual({ type: "lock" });
  });
});

test("isLockAction: the action, the old hotkey, and macro steps of either", () => {
  expect(isLockAction({ type: "lock" })).toBe(true);
  expect(isLockAction({ type: "hotkey", keys: "ctrl+cmd+q" })).toBe(true);
  expect(isLockAction({ type: "macro", steps: [{ kind: "wait", ms: 10 }, { kind: "lock" }] })).toBe(true);
  expect(isLockAction({ type: "macro", steps: [{ kind: "wait", ms: 10 }] })).toBe(false);
});

describe("migrating stored Lock buttons at load", () => {
  const stored = (): Layout => validateLayout({ version: 1, pages: [
    { id: "p", name: "P", columns: 4, rows: 3, items: [
      { id: "lock", kind: "button", label: "Lock", action: { type: "hotkey", keys: "ctrl+cmd+q" } },
      { id: "lock2", kind: "button", label: "Lock it", action: { type: "hotkey", keys: "Cmd+Ctrl+Q" } },
      { id: "quit", kind: "button", label: "Quit", action: { type: "hotkey", keys: "cmd+q" } },
      { id: "m", kind: "button", label: "Macro", action: { type: "macro", steps: [{ kind: "wait", ms: 10 }, { kind: "hotkey", keys: "Q+Cmd+Ctrl" }, { kind: "hotkey", keys: "cmd+q" }] } },
    ] },
    { id: "q", name: "Q", columns: 4, rows: 3, items: [{ id: "x", kind: "button", label: "X", action: { type: "hotkey", keys: "cmd+x" } }] },
  ] });
  const actions = (l: Layout) => Object.fromEntries(l.pages.flatMap((p) => p.items).map((i: any) => [i.id, i.action]));

  for (const os of ["win32", "linux"] as const) {
    test(`${os}: the exact lock hotkey becomes {type:"lock"}, in a button or a macro step; other hotkeys stay`, () => {
      const before = stored();
      const a = actions(migrateLockHotkeys(before, os));
      expect(a.lock).toEqual({ type: "lock" });
      expect(a.lock2).toEqual({ type: "lock" });
      expect(a.quit).toEqual({ type: "hotkey", keys: "cmd+q" });
      // a lock step must lock the PC too: isLockAction already counts it, so the phone sleeps
      expect(a.m).toEqual({ type: "macro", steps: [{ kind: "wait", ms: 10 }, { kind: "lock" }, { kind: "hotkey", keys: "cmd+q" }] });
      expect(isLockAction(a.m)).toBe(true);
      expect(actions(before).lock).toEqual({ type: "hotkey", keys: "ctrl+cmd+q" }); // the input is not changed
    });
  }
  test("macOS: left as it is (the hotkey locks there)", () => {
    const l = stored();
    expect(migrateLockHotkeys(l, "darwin")).toBe(l);
  });
  test("nothing to migrate: the same object back", () => {
    const l = validateLayout({ version: 1, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [] }] });
    expect(migrateLockHotkeys(l, "win32")).toBe(l);
  });

  // the file config really reads: HOME is fixed when config is first imported (another test file may have changed NOOKDECK_HOME since)
  const file = join(HOME, "layout.json");
  const saved = existsSync(file) ? readFileSync(file) : null;
  afterAll(() => {
    if (saved) writeFileSync(file, saved);
    else if (existsSync(file)) unlinkSync(file);
  });
  test("loadLayout does not rewrite layout.json", async () => {
    const { loadLayout } = await import("../src/config");
    const text = JSON.stringify({ version: 1, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [{ id: "lock", kind: "button", label: "Lock", x: 0, y: 0, action: { type: "hotkey", keys: "ctrl+cmd+q" } }] }] });
    writeFileSync(file, text);
    const l = await loadLayout();
    const want = process.platform === "win32" || process.platform === "linux" ? { type: "lock" } : { type: "hotkey", keys: "ctrl+cmd+q" };
    expect((l.pages[0]!.items[0] as any).action).toEqual(want);
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});
