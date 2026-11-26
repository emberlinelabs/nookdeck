// 0.7 deck ideas from PhoneBox: wrap-around page swiping (#651/#487), hidden page dots (#475), lock sleeps the phone (#520) and the
// now-playing title that shrinks to fit (#643). The pure logic, the screen settings validation and the agent's {type:"sleep"} message.
import "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dotsVisible, edgeWrap, swipeTarget, DOTS_FLASH_MS } from "../web/deck/src/page-logic";
import { fitTextSize, textEm } from "../web/deck/src/now-playing-utils";
import { isLockAction, isLockKeys, sleepTargets } from "../web/shared/lock";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-pages-lock-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("swipeTarget: the page a swipe lands on", () => {
  test("without wrap the ends stay put", () => {
    expect(swipeTarget(0, 1, 3, false)).toBe(1);
    expect(swipeTarget(2, 1, 3, false)).toBe(2);
    expect(swipeTarget(0, -1, 3, false)).toBe(0);
    expect(swipeTarget(1, -1, 3, false)).toBe(0);
  });
  test("with wrap: next from the last is the first, previous from the first is the last", () => {
    expect(swipeTarget(2, 1, 3, true)).toBe(0);
    expect(swipeTarget(0, -1, 3, true)).toBe(2);
    expect(swipeTarget(1, 1, 3, true)).toBe(2);
  });
  test("one page or none: always 0; an index out of range is clamped first", () => {
    expect(swipeTarget(0, 1, 1, true)).toBe(0);
    expect(swipeTarget(0, -1, 0, true)).toBe(0);
    expect(swipeTarget(9, 1, 3, true)).toBe(0);
    expect(swipeTarget(-4, -1, 3, true)).toBe(2);
  });
});

describe("edgeWrap: a swipe past the end of the native strip", () => {
  test("left on the last page goes to the first, right on the first goes to the last", () => {
    expect(edgeWrap(2, 3, -80, 5, -0.2, true)).toBe(0);
    expect(edgeWrap(0, 3, 80, -5, 0.2, true)).toBe(2);
  });
  test("a short fast flick counts, a short slow drag does not", () => {
    expect(edgeWrap(2, 3, -30, 0, -0.8, true)).toBe(0);
    expect(edgeWrap(2, 3, -30, 0, -0.1, true)).toBe(-1);
  });
  test("nothing in the middle pages, the wrong direction, a vertical drag, one page, or with wrap off", () => {
    expect(edgeWrap(1, 3, -80, 0, -1, true)).toBe(-1);
    expect(edgeWrap(2, 3, 80, 0, 1, true)).toBe(-1);
    expect(edgeWrap(2, 3, -80, 90, -1, true)).toBe(-1);
    expect(edgeWrap(0, 1, -80, 0, -1, true)).toBe(-1);
    expect(edgeWrap(2, 3, -80, 0, -1, false)).toBe(-1);
  });
});

test("dotsVisible: always when not hidden; hidden dots only during the flash", () => {
  expect(dotsVisible(undefined, 0, 1000)).toBe(true);
  expect(dotsVisible(false, 0, 1000)).toBe(true);
  expect(dotsVisible(true, 0, 1000)).toBe(false);
  expect(dotsVisible(true, 1000 + DOTS_FLASH_MS, 1000)).toBe(true);
  expect(dotsVisible(true, 999, 1000)).toBe(false);
});

describe("fitTextSize: the now-playing title shrinks to fit", () => {
  test("a short title keeps the full size; a long one shrinks; a very long one stops at the minimum", () => {
    expect(fitTextSize("Hello", 200, 1, 14, 10)).toBe(14);
    const s = fitTextSize("A Fairly Long Song Title Here", 150, 1, 14, 10);
    expect(s).toBeLessThan(14);
    expect(s).toBeGreaterThanOrEqual(10);
    expect(s * textEm("A Fairly Long Song Title Here")).toBeLessThanOrEqual(150);
    expect(fitTextSize("x".repeat(200), 150, 1, 14, 10)).toBe(10);
  });
  test("two lines give more room than one", () => {
    const t = "Something Just Like This (Remix)";
    expect(fitTextSize(t, 120, 2, 13, 9)).toBeGreaterThan(fitTextSize(t, 120, 1, 13, 9));
  });
  test("not measured yet or empty: the full size; half-pixel steps", () => {
    expect(fitTextSize("Song", 0, 1, 18, 12)).toBe(18);
    expect(fitTextSize("", 100, 1, 18, 12)).toBe(18);
    expect((fitTextSize("A Long Title For A Song", 140, 1, 18, 9) * 2) % 1).toBe(0);
  });
  test("CJK counts wider than Latin; an emoji counts once", () => {
    expect(textEm("你好")).toBe(2);
    expect(textEm("ab")).toBeLessThan(textEm("你好"));
    expect(textEm("😀")).toBe(1);
  });
});

describe("lock sleeps the phone", () => {
  test("the lock shortcut in any order and case", () => {
    expect(isLockKeys("ctrl+cmd+q")).toBe(true);
    expect(isLockKeys("Cmd + Ctrl + Q")).toBe(true);
    expect(isLockKeys("cmd+q")).toBe(false);
    expect(isLockKeys("ctrl+cmd+shift+q")).toBe(false);
    expect(isLockKeys(undefined)).toBe(false);
  });
  test("a lock hotkey, or a macro with a lock step; nothing else", () => {
    expect(isLockAction({ type: "hotkey", keys: "ctrl+cmd+q" })).toBe(true);
    expect(isLockAction({ type: "macro", steps: [{ kind: "delay", ms: 100 }, { kind: "hotkey", keys: "cmd+ctrl+q" }] })).toBe(true);
    expect(isLockAction({ type: "macro", steps: [{ kind: "hotkey", keys: "cmd+c" }] })).toBe(false);
    expect(isLockAction({ type: "hotkey", keys: "cmd+c" })).toBe(false);
    expect(isLockAction({ type: "onair" })).toBe(false);
    expect(isLockAction(null)).toBe(false);
  });
  test("targets: the presser by default, every phone, or none", () => {
    expect(sleepTargets(undefined)).toBe("presser");
    expect(sleepTargets("phone")).toBe("presser");
    expect(sleepTargets("all")).toBe("all");
    expect(sleepTargets("off")).toBe(null);
    expect(sleepTargets("weird")).toBe("presser");
  });
});

describe("theme.screen: wrap, hideDots, lockSleep", async () => {
  const { validateLayout } = await import("../src/config");
  const lay = (screen: any) => ({ version: 1, theme: { screen }, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [] }] });
  test("kept when valid", () => {
    expect(validateLayout(lay({ wrap: true, hideDots: true, lockSleep: "all" })).theme!.screen).toMatchObject({ wrap: true, hideDots: true, lockSleep: "all" });
  });
  test("refused when the type is wrong", () => {
    expect(() => validateLayout(lay({ wrap: "yes" }))).toThrow(/wrap/);
    expect(() => validateLayout(lay({ hideDots: 1 }))).toThrow(/hideDots/);
    expect(() => validateLayout(lay({ lockSleep: "everyone" }))).toThrow(/phone, all, off/);
  });
});

describe("agent: {type:'sleep'} after a lock button", () => {
  const ran: any[] = [];
  let app: any, base: string, token: string, token2: string;
  beforeAll(async () => {
    const { startServer } = await import("../src/server");
    app = await startServer({
      port: 0, pin: "565656", hostName: async () => "my-mac",
      layoutHistoryDir: mkdtempSync(join(tmpdir(), "pd-lock-hist-")),
      onairFile: join(mkdtempSync(join(tmpdir(), "pd-lock-s-")), "onair.json"),
      micSavedFile: join(mkdtempSync(join(tmpdir(), "pd-lock-m-")), "mic.json"),
      deps: { runAction: async (a: any) => void ran.push(a), startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => ({ id: "claude", name: "c", windows: [], updatedAt: 1 }), codex: async () => ({ id: "codex", name: "c", windows: [], updatedAt: 1 }), antigravity: async () => ({ id: "antigravity", name: "a", windows: [], updatedAt: 1 }), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
    const pair = async (name: string) => ((await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: app.pin, name }) })).json()) as any).token;
    token = await pair("a");
    token2 = await pair("b"); // a second phone: one socket per paired device
  });
  afterAll(async () => {
    // the layout file is shared by every test file in this run: put the default back, like test/onair.test.ts
    const { defaultLayout } = await import("../src/config");
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(defaultLayout()) });
    app?.stop();
  });

  function connect(tk = token) {
    const ws = new WebSocket(`ws://localhost:${app.port}/ws?token=${tk}`);
    const msgs: any[] = [];
    ws.onmessage = (e) => { msgs.push(JSON.parse(String(e.data))); };
    const has = (pred: (m: any) => boolean) => msgs.some(pred);
    const next = async (pred: (m: any) => boolean, ms = 2000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const i = msgs.findIndex(pred); if (i >= 0) return msgs.splice(i, 1)[0]; await sleep(10); }
      throw new Error("timeout");
    };
    return { ws, msgs, has, next, open: new Promise((r) => (ws.onopen = r)) };
  }
  const putLayout = async (screen: any) => {
    const layout = { version: 1, theme: { screen }, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [
      { id: "lock", kind: "button", label: "Lock", action: { type: "hotkey", keys: "ctrl+cmd+q" } },
      { id: "copy", kind: "button", label: "Copy", action: { type: "hotkey", keys: "cmd+c" } },
      { id: "lockact", kind: "button", label: "Lock", action: { type: "lock" } },
    ] }] };
    expect((await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(layout) })).status).toBe(200);
  };

  test("default: only the phone that pressed it; a non-lock button sends nothing", async () => {
    await putLayout({});
    const a = connect(), b = connect(token2);
    await Promise.all([a.open, b.open]);
    await Promise.all([a.next((m) => m.type === "onair"), b.next((m) => m.type === "onair")]); // both joined (the last hello message)
    a.ws.send(JSON.stringify({ type: "press", pageId: "p", itemId: "copy", reqId: "c" }));
    await a.next((m) => m.type === "result" && m.reqId === "c");
    a.ws.send(JSON.stringify({ type: "press", pageId: "p", itemId: "lock", reqId: "l" }));
    await a.next((m) => m.type === "result" && m.reqId === "l" && m.ok);
    await a.next((m) => m.type === "sleep");
    await sleep(100);
    expect(a.has((m) => m.type === "sleep")).toBe(false); // exactly one, the copy press sent none
    expect(b.has((m) => m.type === "sleep")).toBe(false);
    expect(ran.at(-1)).toEqual({ type: "hotkey", keys: "ctrl+cmd+q" });
    a.ws.send(JSON.stringify({ type: "press", pageId: "p", itemId: "lockact", reqId: "la" })); // the lock action sleeps the phone too
    await a.next((m) => m.type === "sleep");
    expect(ran.at(-1)).toEqual({ type: "lock" });
    a.ws.close(); b.ws.close();
  });

  test("lockSleep all: every phone; off: none", async () => {
    await putLayout({ lockSleep: "all" });
    const a = connect(), b = connect(token2);
    await Promise.all([a.open, b.open]);
    await Promise.all([a.next((m) => m.type === "onair"), b.next((m) => m.type === "onair")]); // both joined (the last hello message)
    a.ws.send(JSON.stringify({ type: "press", pageId: "p", itemId: "lock", reqId: "l" }));
    await a.next((m) => m.type === "sleep");
    await b.next((m) => m.type === "sleep");
    await putLayout({ lockSleep: "off" });
    a.ws.send(JSON.stringify({ type: "press", pageId: "p", itemId: "lock", reqId: "l2" }));
    await a.next((m) => m.type === "result" && m.reqId === "l2");
    await sleep(100);
    expect(a.has((m) => m.type === "sleep") || b.has((m) => m.type === "sleep")).toBe(false);
    a.ws.close(); b.ws.close();
  });
});
