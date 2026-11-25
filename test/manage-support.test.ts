import { describe, expect, test } from "bun:test";
import { ASK_AFTER_MS, SNOOZE_MS, SUPPORT_KEY, answer, shouldAsk } from "../web/manage/src/lib/support";

const memory = () => {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  return Object.assign(() => s, { m });
};
const T = 1_800_000_000_000;

describe("the support card", () => {
  test("waits three days from the first visit", () => {
    const store = memory();
    expect(shouldAsk(store, T)).toBe(false);
    expect(shouldAsk(store, T + ASK_AFTER_MS - 1)).toBe(false);
    expect(shouldAsk(store, T + ASK_AFTER_MS)).toBe(true);
    expect(JSON.parse(store.m.get(SUPPORT_KEY)!).first).toBe(T);
  });
  test("Later snoozes for two weeks", () => {
    const store = memory();
    shouldAsk(store, T);
    const asked = T + ASK_AFTER_MS;
    answer(store, asked, "later");
    expect(shouldAsk(store, asked + SNOOZE_MS - 1)).toBe(false);
    expect(shouldAsk(store, asked + SNOOZE_MS)).toBe(true);
  });
  test("done is for good", () => {
    const store = memory();
    shouldAsk(store, T);
    answer(store, T + ASK_AFTER_MS, "done");
    expect(shouldAsk(store, T + ASK_AFTER_MS + 365 * SNOOZE_MS)).toBe(false);
  });
  test("without storage it never asks and never throws", () => {
    const broken = () => { throw new Error("blocked"); };
    expect(shouldAsk(broken, T)).toBe(false);
    expect(() => answer(broken, T, "later")).not.toThrow();
    const full = () => ({ getItem: () => JSON.stringify({ first: 0 }), setItem: () => { throw new Error("full"); } });
    expect(shouldAsk(full, T)).toBe(false);
  });
  test("junk or a clock set back starts the wait again", () => {
    for (const junk of ["nonsense", "null", "{}", JSON.stringify({ first: "yesterday" }), JSON.stringify({ first: T + SNOOZE_MS })]) {
      const store = memory();
      store.m.set(SUPPORT_KEY, junk);
      expect(shouldAsk(store, T)).toBe(false);
      expect(shouldAsk(store, T + ASK_AFTER_MS)).toBe(true);
    }
  });
});
