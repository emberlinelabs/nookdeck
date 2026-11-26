import { describe, expect, test } from "bun:test";
import { ASSETS_PART_MAX, layoutFrames, splitAssets, unusualClose } from "../src/ws-frames";

const icon = (n: number) => ({ img: "data:image/png;base64," + "A".repeat(n) });

describe("layoutFrames", () => {
  test("small asset maps stay inline in one layout message", () => {
    const frames = layoutFrames({ pages: [] }, { "app:a": icon(100) });
    expect(frames.length).toBe(1);
    expect(JSON.parse(frames[0]!)).toEqual({ type: "layout", layout: { pages: [] }, assets: { "app:a": icon(100) } });
  });

  test("big asset maps go in parts before the layout, every message under the cap, nothing lost", () => {
    const assets: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) assets[`app:${i}`] = icon(30_000); // ~1.8 MB: the size that breaks Safari on iOS 16
    const frames = layoutFrames({ pages: [1] }, assets);
    const msgs = frames.map((f) => JSON.parse(f));
    const last = msgs.at(-1);
    expect(last.type).toBe("layout");
    expect(last.assets).toBeUndefined();
    expect(last.assetParts).toBe(msgs.length - 1);
    expect(msgs.slice(0, -1).every((m) => m.type === "assets")).toBe(true);
    for (const f of frames.slice(0, -1)) expect(f.length).toBeLessThan(ASSETS_PART_MAX + 100);
    expect(Object.assign({}, ...msgs.slice(0, -1).map((m) => m.assets))).toEqual(assets);
  });

  test("an entry bigger than the cap goes alone", () => {
    const parts = splitAssets({ a: icon(10), big: icon(300_000), b: icon(10) }, 1000);
    expect(parts.map((p) => Object.keys(p))).toEqual([["a"], ["big"], ["b"]]);
  });

  test("an empty map is one inline layout", () => {
    expect(layoutFrames({}, {}).length).toBe(1);
  });
});

test("unusualClose skips normal, abnormal (sleep) and our own codes", () => {
  for (const c of [1000, 1001, 1005, 1006, 4401, 4403]) expect(unusualClose(c)).toBe(false);
  for (const c of [1002, 1007, 1009, 1011]) expect(unusualClose(c)).toBe(true);
});
