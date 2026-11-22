import { describe, expect, test } from "bun:test";
import { MAC_FLAGS, MAC_KEY_CODES, TYPE_CHUNK_UNITS, hotkeyPlan, mediaKeyEvent, typePlan } from "../src/platform/mac-keys";
import { MacNative, type WorkerLike } from "../src/platform/mac-client";

const mac = process.platform === "darwin";

describe("hotkeyPlan", () => {
  test("a key down then up with the modifier flags", () => {
    expect(hotkeyPlan("cmd+shift+4")).toEqual([
      { keyCode: 21, down: true, flags: MAC_FLAGS.cmd | MAC_FLAGS.shift },
      { keyCode: 21, down: false, flags: MAC_FLAGS.cmd | MAC_FLAGS.shift },
    ]);
    expect(hotkeyPlan("return")[0]).toEqual({ keyCode: 36, down: true, flags: 0 });
    expect(hotkeyPlan("ctrl+up")[0]).toMatchObject({ keyCode: 126, flags: MAC_FLAGS.ctrl });
    expect(hotkeyPlan("alt+f5")[0]).toMatchObject({ keyCode: 96, flags: MAC_FLAGS.alt });
  });
  test("plus is shift + the equals key; letters and F-keys map to ANSI codes", () => {
    expect(hotkeyPlan("cmd++")[0]).toMatchObject({ keyCode: 24, flags: MAC_FLAGS.cmd | MAC_FLAGS.shift });
    expect(hotkeyPlan("cmd+c")[0]!.keyCode).toBe(8);
    for (let i = 1; i <= 12; i++) expect(MAC_KEY_CODES[`f${i}`]).toBeNumber();
    expect(new Set(Object.values(MAC_KEY_CODES)).size).toBe(Object.values(MAC_KEY_CODES).length); // no two keys share a code
  });
  test("a character without a key code is typed as Unicode; bad hotkeys throw", () => {
    expect(hotkeyPlan("cmd+é")[0]).toMatchObject({ keyCode: 0, unicode: "é", flags: MAC_FLAGS.cmd });
    expect(() => hotkeyPlan("cmd+banana")).toThrow();
  });
});

describe("typePlan", () => {
  test("text is posted as Unicode chunks of at most 20 UTF-16 units, never splitting an emoji", () => {
    const text = "Xin chào Việt Nam, đây là một câu dài 😀😀😀😀😀😀😀😀😀😀😀😀";
    const steps = typePlan(text);
    expect(steps.length % 2).toBe(0);
    const downs = steps.filter((s) => s.down).map((s) => s.unicode!);
    expect(downs.join("")).toBe(text);
    for (const d of downs) expect(d.length).toBeLessThanOrEqual(TYPE_CHUNK_UNITS);
    for (const d of downs) expect(/[\uD800-\uDBFF]$/.test(d)).toBe(false); // no lone high surrogate at a chunk end
    expect(steps.every((s) => s.keyCode === 0 && s.flags === 0)).toBe(true);
  });
  test("newline and tab are the Return and Tab keys; CRLF is one Return", () => {
    const keys = typePlan("a\r\nb\tc").map((s) => (s.unicode !== undefined ? s.unicode : `#${s.keyCode}`));
    expect(keys).toEqual(["a", "a", "#36", "#36", "b", "b", "#48", "#48", "c", "c"]);
  });
  test("empty text posts nothing", () => expect(typePlan("")).toEqual([]));
});

test("media key events: NSSystemDefined subtype 8, data1 = key << 16 | state << 8", () => {
  expect(mediaKeyEvent("playpause", true)).toEqual({ type: 14, subtype: 8, flags: 0xa00, data1: (16 << 16) | 0xa00, data2: -1 });
  expect(mediaKeyEvent("next", false).data1).toBe((17 << 16) | 0xb00);
  expect(mediaKeyEvent("previous", true).data1).toBe((18 << 16) | 0xa00);
});

describe("MacNative client (fake worker)", () => {
  function fake(behave: (m: any, w: FakeWorker) => void) {
    const made: FakeWorker[] = [];
    class FakeWorker implements WorkerLike {
      onmessage: WorkerLike["onmessage"] = null;
      onerror: WorkerLike["onerror"] = null;
      terminated = false;
      postMessage(m: any) { behave(m, this); }
      terminate() { this.terminated = true; }
      reply(id: number, value: any) { this.onmessage?.({ data: { id, ok: true, value } }); }
      fail(id: number, error: string) { this.onmessage?.({ data: { id, ok: false, error } }); }
    }
    const mn = new MacNative(() => { const w = new FakeWorker(); made.push(w); return w; });
    return { mn, made };
  }

  test("the worker is created lazily, reused, and answers resolve or reject by id", async () => {
    const { mn, made } = fake((m, w) => (m.op === "boom" ? w.fail(m.id, "nope") : w.reply(m.id, m.args.x)));
    expect(made.length).toBe(0);
    expect(await mn.call("echo", { x: 1 })).toBe(1);
    expect(await mn.call("echo", { x: 2 })).toBe(2);
    await expect(mn.call("boom")).rejects.toThrow("nope");
    expect(made.length).toBe(1);
  });

  test("a request that does not come back times out, the worker is terminated and the next call gets a new one", async () => {
    let stuck = true;
    const { mn, made } = fake((m, w) => { if (!stuck) w.reply(m.id, "ok"); });
    await expect(mn.call("read", {}, 30)).rejects.toThrow("macOS did not answer");
    expect(made[0]!.terminated).toBe(true);
    expect(mn.restarts).toBe(1);
    stuck = false;
    expect(await mn.call("read", {}, 1000)).toBe("ok");
    expect(made.length).toBe(2);
  });

  test("a crashing worker fails what is waiting and is replaced", async () => {
    const { mn, made } = fake((_m, w) => queueMicrotask(() => w.onerror?.(new Error("x"))));
    await expect(mn.call("read", {}, 1000)).rejects.toThrow("crashed");
    expect(made[0]!.terminated).toBe(true);
  });
});

describe.skipIf(!mac)("native calls on this Mac (read-only or built-without-posting)", () => {
  test("the real worker answers; key, type and media events are built but not posted; volume and app state are read", async () => {
    const mn = new MacNative();
    try {
      expect(await mn.call("ping")).toBe("pong");
      expect(await mn.call("hotkey", { keys: "cmd+shift+4", dryRun: true })).toBe(2);
      expect(await mn.call("type", { text: "Xin chào 😀\nok", dryRun: true })).toBeGreaterThan(0);
      for (const [cmd, key] of [["playpause", 16], ["next", 17], ["previous", 18]] as const) {
        const ev = await mn.call<{ data1: number; subtype: number }[]>("media", { command: cmd, dryRun: true });
        expect(ev.map((e) => e.data1)).toEqual([(key << 16) | 0xa00, (key << 16) | 0xb00]);
        expect(ev.every((e) => e.subtype === 8)).toBe(true);
      }
      const vol = await mn.call<{ level: number; muted: boolean } | null>("volumeGet");
      if (vol) { expect(vol.level).toBeGreaterThanOrEqual(0); expect(vol.level).toBeLessThanOrEqual(100); expect(typeof vol.muted).toBe("boolean"); }
      const run = await mn.call<Record<string, boolean>>("running", { bundles: ["com.apple.finder", "com.example.not-installed"] });
      expect(run["com.example.not-installed"]).toBe(false);
      expect(await mn.call("script", { source: 'return "ok"' })).toBe("ok");
      // a player that is not running is skipped: no Apple Event, empty result
      expect(await mn.call("script", { source: 'tell application "Nope" to play', requires: "com.example.not-installed" })).toBe("");
      await expect(mn.call("script", { source: "this is not applescript" })).rejects.toThrow();
      expect(await mn.call("ping")).toBe("pong"); // still alive after a script error
    } finally { mn.dispose(); }
  }, 20_000);
});

describe.skipIf(process.platform !== "darwin")("gpu read (read-only)", () => {
  test("readGpu answers with a utilisation in range when an accelerator exists", async () => {
    const { readGpu } = await import("../src/platform/mac-native");
    const g = readGpu();
    if (g) {
      expect(g.util).toBeGreaterThanOrEqual(0);
      expect(g.util).toBeLessThanOrEqual(100);
      if (g.memUsed !== undefined) expect(g.memUsed).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(process.platform !== "darwin")("cover conversion (ImageIO, in process)", () => {
  // a 2x2 PNG
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCAr7sH0gAAAAASUVORK5CYII=";
  test("a PNG comes back as a JPEG; garbage is null", async () => {
    const { toJpegBase64 } = await import("../src/platform/mac-native");
    const j = toJpegBase64(PNG, 300);
    expect(j?.startsWith("/9j/")).toBe(true); // JPEG magic ff d8 ff
    expect(toJpegBase64(Buffer.from("not an image at all").toString("base64"), 300)).toBeNull();
    expect(toJpegBase64("", 300)).toBeNull();
  });
});
