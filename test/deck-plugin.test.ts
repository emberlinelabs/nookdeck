import { describe, expect, test } from "bun:test";
import { coreTileOf, friendlyError, mergePlugins, parsePluginItem, quotaOptionsOf, weatherOptionsOf, safeImageUrl, samplePlugin, validatePlugin } from "../web/deck/src/plugin-logic";

describe("plugin renderer validation", () => {
  test("stat", () => {
    expect(validatePlugin("stat", { value: 5, unit: "USD", delta: -1.2 })).toEqual({ render: "stat", data: { value: 5, unit: "USD", label: undefined, delta: -1.2, color: undefined } });
    expect(validatePlugin("stat", { value: "up" })).not.toBeNull();
    expect(validatePlugin("stat", { value: NaN })).toBeNull();
    expect(validatePlugin("stat", { value: {} })).toBeNull();
    expect(validatePlugin("stat", { value: 1, color: "red;x" })).toBeNull();
    expect(validatePlugin("stat", { value: 1, unit: 3 })).toBeNull();
  });
  test("gauge range", () => {
    expect(validatePlugin("gauge", { value: 0 })).not.toBeNull();
    expect(validatePlugin("gauge", { value: 100 })).not.toBeNull();
    expect(validatePlugin("gauge", { value: 101 })).toBeNull();
    expect(validatePlugin("gauge", { value: -1 })).toBeNull();
    expect(validatePlugin("gauge", { value: "50" })).toBeNull();
  });
  test("text", () => {
    expect(validatePlugin("text", { body: "hi" })).not.toBeNull();
    expect(validatePlugin("text", { title: "t" })).toBeNull();
  });
  test("list caps at 20", () => {
    const row = (i: number) => ({ title: "r" + i });
    expect(validatePlugin("list", { items: Array.from({ length: 20 }, (_, i) => row(i)) })).not.toBeNull();
    expect(validatePlugin("list", { items: Array.from({ length: 21 }, (_, i) => row(i)) })).toBeNull();
    expect(validatePlugin("list", { items: [{ subtitle: "x" }] })).toBeNull();
    const ok = validatePlugin("list", { items: [{ title: "a", value: 3 }] });
    expect(ok && ok.render === "list" && ok.data.items[0].value).toBe("3");
  });
  test("chart caps at 120 points", () => {
    expect(validatePlugin("chart", { points: Array.from({ length: 120 }, (_, i) => i) })).not.toBeNull();
    expect(validatePlugin("chart", { points: Array.from({ length: 121 }, (_, i) => i) })).toBeNull();
    expect(validatePlugin("chart", { points: [1, "2"] })).toBeNull();
    expect(validatePlugin("chart", { points: [1, Infinity] })).toBeNull();
  });
  test("image only https or data:image", () => {
    expect(safeImageUrl("https://a.b/c.png")).toBe("https://a.b/c.png");
    expect(safeImageUrl("data:image/png;base64,AAAA")).not.toBeNull();
    expect(safeImageUrl("http://a.b/c.png")).toBeNull();
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl("data:text/html;base64,AAAA")).toBeNull();
    expect(safeImageUrl("https://a.b/c d")).toBeNull();
    expect(validatePlugin("image", { url: "http://x/y.png" })).toBeNull();
    expect(validatePlugin("image", { url: "https://x/y.png", fit: "stretch" })).toBeNull();
    expect(validatePlugin("image", { url: "https://x/y.png", fit: "contain" })).not.toBeNull();
  });
  test("status", () => {
    for (const s of ["ok", "warn", "error", "off"]) expect(validatePlugin("status", { state: s, label: "x" })).not.toBeNull();
    expect(validatePlugin("status", { state: "bad", label: "x" })).toBeNull();
    expect(validatePlugin("status", { state: "ok" })).toBeNull();
  });
  test("unknown render, non-object data", () => {
    expect(validatePlugin("table", { rows: [] })).toBeNull();
    expect(validatePlugin(5, {})).toBeNull();
    expect(validatePlugin("stat", null)).toBeNull();
    expect(validatePlugin("stat", [1])).toBeNull();
    expect(validatePlugin("stat", "x")).toBeNull();
  });
});

describe("plugin messages", () => {
  test("{error}, missing render and junk are null, never throw", () => {
    expect(parsePluginItem({ error: "boom" })).toEqual({ error: "boom" });
    // a core plugin's own renderer (the legacy weather / quota tiles): only the fact is kept, the built-in tile uses its own data
    expect(parsePluginItem({ render: "custom:weather", data: { temp: 20 } })).toEqual({ custom: "weather", data: { temp: 20 } });
    expect(parsePluginItem({ render: "custom:quota" })).toEqual({ custom: "quota" });
    expect(parsePluginItem({ render: "custom:quota", error: "plugin disabled" })).toEqual({ error: "plugin disabled" });
    expect(parsePluginItem({ render: "stat", data: { value: 1 }, error: "x" })).toEqual({ error: "x" });
    expect(parsePluginItem(null)).toEqual({ error: "" });
    expect(parsePluginItem(undefined)).toEqual({ error: "" });
    expect(parsePluginItem(7)).toEqual({ error: "" });
    expect(parsePluginItem({})).toEqual({ error: "" });
    expect(parsePluginItem({ error: 5 })).toEqual({ error: "" });
    expect(parsePluginItem({ render: "stat", data: { value: 2 } })).not.toBeNull();
  });
  test("latest value per tile wins; other tiles are kept", () => {
    const a = mergePlugins(undefined, { t1: { render: "stat", data: { value: 1 } }, t2: { render: "gauge", data: { value: 5 } } });
    const b = mergePlugins(a, { t1: { render: "stat", data: { value: 2 } } });
    expect((b.t1 as any).data.value).toBe(2);
    expect((b.t2 as any).data.value).toBe(5);
    expect((a.t1 as any).data.value).toBe(1);
    const c = mergePlugins(b, { t1: { error: "down" } });
    expect(c.t1).toEqual({ error: "down" });
    expect(c.t2).not.toBeNull();
  });
  test("full map on connect, then partial messages merge by tile id", () => {
    const full = mergePlugins(undefined, { a: { render: "stat", data: { value: 1 } }, b: { render: "status", data: { state: "ok", label: "x" } }, c: { error: "plugin disabled" } });
    const p1 = mergePlugins(full, { b: { render: "status", data: { state: "warn", label: "y" } } });
    expect(Object.keys(p1).sort()).toEqual(["a", "b", "c"]);
    expect((p1.a as any).data.value).toBe(1);
    expect((p1.b as any).data.state).toBe("warn");
    expect(p1.c).toEqual({ error: "plugin disabled" });
    const p2 = mergePlugins(p1, { c: { render: "stat", data: { value: 9 } }, d: { render: "stat", data: { value: 4 } } });
    expect(Object.keys(p2).sort()).toEqual(["a", "b", "c", "d"]);
    expect((p2.c as any).data.value).toBe(9);
    expect(mergePlugins(p2, {})).toEqual(p2);
  });
  test("friendly error labels", () => {
    expect(friendlyError("plugin missing")).toBe("Plugin missing");
    expect(friendlyError("plugin disabled")).toBe("Plugin off");
    expect(friendlyError("plugin not granted")).toBe("Needs approval");
    expect(friendlyError("plugin widget missing")).toBe("Tile removed");
    expect(friendlyError("the server answered 500")).toBeNull();
    expect(friendlyError("")).toBeNull();
  });
  test("bad items argument keeps the map", () => {
    const a = mergePlugins(undefined, { t1: { render: "stat", data: { value: 1 } } });
    expect(mergePlugins(a, "nope").t1).not.toBeNull();
    expect(mergePlugins(a, [1, 2]).t1).not.toBeNull();
    expect(mergePlugins(a, null).t1).not.toBeNull();
  });
  test("sample data is valid for every widget name", () => {
    for (const n of ["price", "a", "weather", "x1", "zz", "disk", "cpu"]) {
      const s = samplePlugin(n);
      expect(validatePlugin(s.render, s.data)).not.toBeNull();
    }
  });
});

describe("previewSlot (manage preview data)", () => {
  const { previewSlot, samplePlugin } = require("../web/deck/src/plugin-logic");
  test("uses the data sent for the tile, validated", () => {
    const s = previewSlot({ t: { render: "stat", data: { value: 5, unit: "x" } } }, "t", "w");
    expect(s).toEqual({ render: "stat", data: { value: 5, unit: "x" } });
  });
  test("invalid data gives the neutral error tile, not a throw", () => {
    expect(previewSlot({ t: { render: "stat", data: { nope: 1 } } }, "t", "w")).toEqual({ error: "invalid data" });
    expect(previewSlot({ t: 5 }, "t", "w")).toEqual({ error: "invalid data" });
  });
  test("another tile, no data or inherited keys keep the sample", () => {
    expect(previewSlot({ t: { render: "stat", data: { value: 1 } } }, "other", "w")).toEqual({ error: "no preview|" });
    expect(previewSlot({ t: { error: "plugin disabled" } }, "t", "w")).toEqual({ error: "plugin disabled" });
    expect(previewSlot(undefined, "t", "w")).toEqual({ error: "no preview|" });
    expect(previewSlot({}, "toString", "w")).toEqual({ error: "no preview|" });
  });
});

describe("core plugin tiles draw the legacy quota / weather tile", () => {
  const quota = { id: "claude", name: "Claude", windows: [{ id: "five_hour", label: "5h", usedPercent: 34 }], updatedAt: 1 };
  const slot = (c: string, data: unknown) => parsePluginItem({ render: "custom:" + c, data });
  test("core.quota: the provider block becomes the AI data, the flat settings become the quota options", () => {
    const c = coreTileOf({ id: "core.quota", widget: "quota", settings: { provider: "claude", chart: "rings", windows: "five_hour, seven_day", showReset: false, account: "me@x" } }, slot("quota", quota));
    expect(c).toMatchObject({ kind: "quota", provider: "claude", quota: { chart: "rings", windows: ["five_hour", "seven_day"], showReset: false, account: "me@x" } });
    expect(c!.ai!.providers[0]).toBe(quota);
    expect(c!.ai!.sessions).toEqual([]);
    // no settings: the provider comes from the data, options are empty
    expect(coreTileOf({ id: "core.quota", widget: "quota" }, slot("quota", { ...quota, id: "codex" }))).toMatchObject({ provider: "codex", quota: {} });
  });
  test("core.weather: the answer is used as is, the settings become weather options", () => {
    const wx = { now: { temp: 20 }, hourly: [], daily: [], location: "Hue" };
    const c = coreTileOf({ id: "core.weather", widget: "weather", settings: { source: "open-meteo", locationName: "Hue", lat: 16.4, lon: 107.6, show: "daily", units: "metric" } }, slot("weather", wx));
    expect(c).toMatchObject({ kind: "weather", weather: { source: "open-meteo", location: { name: "Hue", lat: 16.4, lon: 107.6 }, show: "daily", units: "metric" } });
    expect(c!.wx).toBe(slot("weather", wx) && c!.wx);
  });
  test("community plugins can never use custom:*, and a mismatched widget or junk data is refused", () => {
    expect(coreTileOf({ id: "dev.evil.x", widget: "quota" }, slot("quota", quota))).toBeNull();
    expect(coreTileOf({ id: "dev.core.x", widget: "quota" }, slot("quota", quota))).toBeNull();
    expect(coreTileOf({ id: "core.quota", widget: "weather" }, slot("quota", quota))).toBeNull();
    expect(coreTileOf({ id: "core.quota", widget: "quota" }, slot("quota", { nope: 1 }))).toBeNull();
    expect(coreTileOf({ id: "core.weather", widget: "weather" }, slot("weather", { nope: 1 }))).toBeNull();
    expect(coreTileOf({ id: "core.quota", widget: "quota" }, parsePluginItem({ error: "plugin disabled" }))).toBeNull();
    expect(coreTileOf({ id: "core.quota", widget: "quota" }, parsePluginItem({ render: "stat", data: { value: 1 } }))).toBeNull();
    expect(coreTileOf(undefined, slot("quota", quota))).toBeNull();
    expect(coreTileOf({ id: "core.quota", widget: "quota" }, null)).toBeNull();
  });
  test("option parsing ignores junk", () => {
    expect(quotaOptionsOf({ chart: "pie", windows: "  ", showReset: "no", account: 5 })).toEqual({});
    expect(quotaOptionsOf({ windows: "main" })).toEqual({ windows: "main" });
    expect(weatherOptionsOf({ source: "x", lat: 1 })).toEqual({});
  });
});

describe("previewSlot for core plugin tiles", () => {
  const { previewSlot, coreTileOf } = require("../web/deck/src/plugin-logic");
  const quota = { id: "claude", name: "Claude", plan: "Max", windows: [{ id: "seven_day", label: "7 days", usedPercent: 34 }] };
  test("data sent for a core.* tile (custom:quota / custom:weather) is kept and draws the legacy tile", () => {
    const s = previewSlot({ t: { render: "custom:quota", data: quota } }, "t", "quota", "core.quota");
    expect(s).toEqual({ custom: "quota", data: quota });
    expect(coreTileOf({ id: "core.quota", widget: "quota" }, s)).toMatchObject({ kind: "quota", provider: "claude" });
  });
  test("community ids stay refused, also with sample data", () => {
    expect(previewSlot({ t: { render: "custom:quota", data: quota } }, "t", "quota", "dev.evil.x")).toEqual({ error: "invalid data" });
    expect(previewSlot({ t: { render: "custom:quota", data: quota } }, "t", "quota")).toEqual({ error: "invalid data" });
    const s = previewSlot({}, "t", "quota", "dev.evil.x");
    expect(s).not.toHaveProperty("custom");
    expect(coreTileOf({ id: "dev.evil.x", widget: "quota" }, { custom: "quota", data: quota })).toBeNull();
  });
  test("a core tile with no data sent gets a demo sample that the legacy tile accepts", () => {
    const q = previewSlot(undefined, "t", "quota", "core.quota");
    expect(coreTileOf({ id: "core.quota", widget: "quota" }, q)).toMatchObject({ kind: "quota", provider: "claude" });
    expect(JSON.stringify(q)).toContain("Max");
    const w = previewSlot(undefined, "t", "weather", "core.weather");
    const ct = coreTileOf({ id: "core.weather", widget: "weather" }, w);
    expect(ct).toMatchObject({ kind: "weather" });
    expect(ct.wx.now.temp).toBe(31);
    expect(ct.wx.location).toBe("Home");
    expect(ct.wx.hourly.length).toBeGreaterThan(2);
  });
});
