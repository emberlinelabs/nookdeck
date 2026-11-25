import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultLayout, validateLayout } from "../src/config";
import { SHIFT_MS, SHIFT_PATH, inDimWindow, runShift, shiftAt, shiftOn, type ShiftHost } from "../web/deck/src/screen-logic";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", p), "utf8");

describe("burn-in shift", () => {
  test("new layouts start with it on, existing ones stay off", () => {
    expect(validateLayout(defaultLayout()).theme?.screen).toEqual({ burnInShift: true });
    const old = validateLayout({ ...defaultLayout(), theme: { mode: "dark" } } as any);
    expect(old.theme?.screen).toBeUndefined();
    expect(shiftOn(old.theme?.screen)).toBe(false);
    expect(shiftOn({ keepAwake: false })).toBe(false);
    expect(shiftOn({ burnInShift: true })).toBe(true);
  });

  test("the config accepts a boolean only and keeps an explicit off", () => {
    const withShift = (v: unknown) => validateLayout({ ...defaultLayout(), theme: { screen: { burnInShift: v } } } as any);
    expect(withShift(false).theme?.screen).toEqual({ burnInShift: false });
    expect(() => withShift("yes")).toThrow(/theme\.screen\.burnInShift/);
  });

  test("every position is within 2 px, each step is small, and the cycle comes back", () => {
    for (let i = 0; i < SHIFT_PATH.length; i++) {
      const [x, y] = SHIFT_PATH[i]!;
      const [nx, ny] = SHIFT_PATH[(i + 1) % SHIFT_PATH.length]!;
      expect(Math.max(Math.abs(x), Math.abs(y))).toBeLessThanOrEqual(2);
      expect(Math.max(Math.abs(nx - x), Math.abs(ny - y))).toBeLessThanOrEqual(4);
    }
    expect(shiftAt(0)).toEqual(shiftAt(SHIFT_PATH.length * SHIFT_MS));
    expect(shiftAt(SHIFT_MS - 1)).toEqual(shiftAt(0));
    expect(shiftAt(SHIFT_MS)).not.toEqual(shiftAt(0));
  });

  test("the page padding is at least 2 px on every screen, so the grid never leaves it", () => {
    const css = src("web/deck/src/deck.css");
    const pads = [...css.matchAll(/\.pd-page \{[^}]*?\bpadding(?:-top|-bottom)?:\s*([^;}]+)/g)].flatMap((m) => m[1]!.trim().split(/\s+/));
    expect(pads.length).toBeGreaterThan(2);
    for (const p of pads) expect(parseFloat(p)).toBeGreaterThanOrEqual(2);
  });

  test("steps on the 3 minute mark and has no timer while the page is hidden", () => {
    let hidden = false;
    let now = 10 * SHIFT_MS + 1000;
    let vis: (() => void) | undefined;
    const timers = new Map<number, number>();
    let id = 0;
    const host: ShiftHost = {
      hidden: () => hidden,
      onVisibility: (fn) => { vis = fn; return () => { vis = undefined; }; },
      now: () => now,
      setTimeout: (_fn, ms) => { timers.set(++id, ms); return id; },
      clearTimeout: (i) => { timers.delete(i); },
    };
    const seen: { x: number; y: number }[] = [];
    const stop = runShift(host, (p) => seen.push(p));
    expect(seen).toEqual([shiftAt(now)]);
    expect([...timers.values()]).toEqual([SHIFT_MS - 1000 + 50]);
    hidden = true;
    vis!();
    expect(timers.size).toBe(0);
    now += 5 * SHIFT_MS; // asleep for 15 minutes
    hidden = false;
    vis!();
    expect(seen.at(-1)).toEqual(shiftAt(now));
    expect(timers.size).toBe(1);
    stop();
    expect(timers.size).toBe(0);
    expect(vis).toBeUndefined();
  });

  test("off means the grid has no position style at all", () => {
    expect(src("web/deck/src/Deck.tsx")).toContain("left: shift ? shift.x + 'px' : '', top: shift ? shift.y + 'px' : ''");
  });
});

describe("night dim", () => {
  const night = { dim: { level: 0.6, from: "23:00", to: "07:00" } };
  const at = (h: number, m = 0) => new Date(2026, 10, 25, h, m);

  test("the range wraps midnight and uses the phone's local time", () => {
    for (const [h, m, on] of [[22, 59, false], [23, 0, true], [3, 0, true], [6, 59, true], [7, 0, false], [12, 0, false]] as const) {
      expect(inDimWindow(night, at(h, m))).toBe(on);
    }
    expect(inDimWindow({ dim: { level: 0.6 } }, at(3))).toBe(false);
  });

  test("the layer takes the first tap, and only then", () => {
    const tsx = src("web/deck/src/screen.tsx");
    expect(tsx).toContain("const dimBlocks = !preview && dimWin && !standby && !cur && dimLevel(s) > 0");
    expect(tsx).toContain("onTouchStart={dimBlocks ? wakeFromStandby : undefined}");
    const css = src("web/deck/src/deck.css");
    expect(css).toMatch(/\.pd-dim\.pd-dim--tap \{[^}]*pointer-events: auto/);
    // without the extra class the layer still lets everything through (standby, preview)
    expect(css).toMatch(/\.pd-dim \{[^}]*pointer-events: none/);
  });

  test("the manage page fills 23:00 to 07:00 when it is switched on", () => {
    expect(src("web/manage/src/components/screen-panel.tsx")).toContain('const NIGHT_DEFAULT = { from: "23:00", to: "07:00" };');
  });
});
