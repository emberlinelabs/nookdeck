import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asTileMessage, tileEntry, tileLook, TILE_PACKS } from "../web/deck/src/tile-lib";

const msg = { type: "nookdeck-tile", render: "stat", data: { value: 1 }, w: 2, h: 2 };

describe("the demo's tile page: the message", () => {
  test("only the exact shape is taken", () => {
    expect(asTileMessage(msg)).toEqual(msg as any);
    expect(asTileMessage({ ...msg, style: "big", theme: "dev.nookdeck.nookdeck", mode: "light", lang: "zh" })).not.toBeNull();
    expect(asTileMessage({ ...msg, theme: { accent: "#fff" }, style: undefined })).not.toBeNull();
    expect(asTileMessage({ ...msg, data: null })).not.toBeNull(); // judged by the validators: an error tile
    for (const bad of [null, "x", [], { ...msg, type: "nd-demo" }, { ...msg, render: 1 }, { type: "nookdeck-tile", render: "stat", w: 2, h: 2 },
      { ...msg, w: 0 }, { ...msg, h: 1.5 }, { ...msg, w: 25 }, { ...msg, w: "2" }, { ...msg, extra: 1 }, { ...msg, style: 1 }, { ...msg, theme: 5 }, { ...msg, theme: [] },
      { ...msg, mode: "auto" }, { ...msg, lang: "fr" }]) expect(asTileMessage(bad)).toBeNull();
  });
  test("data goes through the agent's checks, then the deck's", () => {
    expect(tileEntry("stat", { value: 12, junk: 1 })).toMatchObject({ render: "stat", data: { value: 12 } });
    expect(tileEntry("gauge", { value: 150 })).toMatchObject({ data: { value: 100 } }); // clipped by the agent's clean-up
    expect(tileEntry("text", { body: "hi" }, "minimal")).toMatchObject({ render: "text", style: "minimal" });
    expect(tileEntry("list", { items: [{ title: "a" }] })).toMatchObject({ render: "list" });
    expect(tileEntry("chart", { points: [1, 2] })).toMatchObject({ render: "chart" });
    expect(tileEntry("status", { state: "ok", label: "up" })).toMatchObject({ render: "status" });
    expect(tileEntry("image", { url: "data:image/png;base64,AAAA" })).toMatchObject({ render: "image" });
    const card = { root: { t: "col", children: [{ t: "ring", value: 0.5, text: "50" }, { t: "button", label: "Go", action: "go" }, { t: "month", month: "2026-11" }] } };
    expect(tileEntry("card", card)).toMatchObject({ render: "card" });
  });
  test("invalid data is the tile's normal error", () => {
    expect(tileEntry("card", { root: { t: "nope" } })).toHaveProperty("error");
    expect(tileEntry("stat", {})).toEqual({ error: "no value to show" });
    expect(tileEntry("status", null)).toHaveProperty("error");
    expect(tileEntry("custom:quota", {})).toEqual({ error: "unknown renderer" });
    expect(tileEntry("text", { body: { toString: 1 } })).toEqual({ error: "invalid data" });
    expect(tileEntry("image", { url: "https://a.test/x.png" })).toEqual({ error: "this preview loads no remote images" });
  });
});

describe("the demo's tile page: the look", () => {
  test("a built-in pack id gives its look for the mode", () => {
    expect(TILE_PACKS).toEqual(["dev.nookdeck.nookdeck", "dev.nookdeck.nookdeck-classic"]);
    expect(tileLook("dev.nookdeck.nookdeck", undefined)).toMatchObject({ mode: "dark", tile: "#151923", radius: 14, source: { variant: "midnight" } });
    expect(tileLook("dev.nookdeck.nookdeck", "light")).toMatchObject({ mode: "light", tile: "#ffffff", source: { variant: "paper" } });
    expect(tileLook("dev.nookdeck.nookdeck-classic", "light")).toMatchObject({ mode: "light", source: { variant: "light" } });
    expect(tileLook("dev.other.pack", "light")).toEqual({ mode: "light" } as any);
  });
  test("an object is taken as it is; mode settles its auto pair", () => {
    expect(tileLook(undefined, undefined)).toEqual({ mode: "dark" } as any);
    expect(tileLook({ accent: "#f00" }, undefined)).toEqual({ accent: "#f00", mode: "dark" } as any);
    const auto = { mode: "auto", auto: { light: { tile: "#fff" }, dark: { tile: "#000" } } };
    expect(tileLook(auto, "light")).toMatchObject({ mode: "light", tile: "#fff" });
    expect(tileLook(auto, "dark")).toMatchObject({ mode: "dark", tile: "#000" });
    expect(auto.mode).toBe("auto"); // the message is not changed
  });
});

describe("the demo's tile page: the build", () => {
  const root = join(import.meta.dir, "..", "web", "deck");
  test("tile.html is built beside the demo, with the same closed policy", () => {
    expect(readFileSync(join(root, "vite.demo.config.ts"), "utf8")).toContain("'tile.html'");
    const csp = (f: string) => /Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(root, f), "utf8"))?.[1];
    expect(csp("tile.html")).toBe(csp("demo.html"));
  });
});
