import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_LIMITS, card, validateCard, type CardNode } from "../src/plugins/card";
import { cleanRender } from "../src/plugins/sources";
import { parseManifest } from "../src/plugins/manifest";
import { CARD_REFRESH_MS, PluginRuntime } from "../src/plugins/runtime";
import { PluginStore } from "../src/plugins/store";
import type { MacroStep } from "../src/config";
import { cardBase, parsePluginItem, validatePlugin } from "../web/deck/src/plugin-logic";

const err = (d: unknown): string => { const r = validateCard(d); return "error" in r ? r.error : ""; };
const root = (r: unknown) => ({ root: r });
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("validateCard", () => {
  test("every part with every field passes and comes back unchanged", () => {
    const data = card.root(card.col([
      card.row([card.icon("battery", { tone: "ok" }), card.text("Mac", { size: "s", tone: "muted", bold: true }), card.spacer(), card.pill("live", { tone: "accent" })], { gap: 2, align: "between", grow: true }),
      card.number(42, { unit: "%", size: "xl", tone: "default" }),
      card.progress(0.4, { tone: "warn" }),
      card.sparkline([1, 2, 3], { tone: "bad" }),
      card.image(PNG, { fit: "contain" }),
      card.button("Start", "start", { icon: "player-play", args: { name: "A b \"c\" é", minutes: 5, on: true }, tone: "accent", active: true }),
    ]));
    expect(validateCard(data)).toEqual({ data });
  });
  test("builders drop undefined fields and empty children", () => {
    expect(card.text("x", { tone: undefined })).toEqual({ t: "text", text: "x" });
    expect(card.row([false, null, undefined, card.spacer()])).toEqual({ t: "row", children: [{ t: "spacer" }] });
    expect((card.sparkline(Array.from({ length: 90 }, (_, i) => i)) as any).points.length).toBe(60);
  });
  test("progress is clamped to 0..1", () => {
    expect(validateCard(root({ t: "progress", value: 4 }))).toEqual({ data: { root: { t: "progress", value: 1 } } });
    expect(err(root({ t: "progress", value: "1" }))).toContain("from 0 to 1");
  });
  test("depth: 6 levels pass, 7 do not", () => {
    const nest = (n: number): CardNode => (n === 1 ? card.spacer() : card.col([nest(n - 1)]));
    expect(err(root(nest(CARD_LIMITS.depth)))).toBe("");
    expect(err(root(nest(CARD_LIMITS.depth + 1)))).toContain("more than 6 levels");
  });
  test("nodes: 60 pass, 61 do not", () => {
    const n = (k: number) => root(card.col(Array.from({ length: k - 1 }, () => card.spacer())));
    expect(err(n(60))).toBe("");
    expect(err(n(61))).toContain("more than 60 parts");
    expect(err(root({ t: "col", children: Array(100000).fill({ t: "spacer" }) }))).toContain("more than 60 parts");
  });
  test("texts: 200 characters pass, 201 do not, wherever a text is", () => {
    const ok = "a".repeat(200), long = "a".repeat(201);
    expect(err(root(card.text(ok)))).toBe("");
    for (const n of [card.text(long), card.number(long), card.number(1, { unit: long }), card.pill(long), card.button(long, "a"), card.button("x", "a", { args: { k: long } })]) expect(err(root(n))).toContain("longer than 200");
  });
  test("sparkline: at most 60 finite points", () => {
    expect(err(root({ t: "sparkline", points: Array(61).fill(1) }))).toContain("at most 60");
    expect(err(root({ t: "sparkline", points: [1, NaN] }))).toContain("at most 60");
  });
  test("32 KB of JSON without image sources; images have their own 200 KB total", () => {
    const many = (len: number) => root(card.col(Array.from({ length: 59 }, () => card.button("é".repeat(len), "a", { args: { a: "é".repeat(len), b: "é".repeat(len) } }))));
    expect(err(many(20))).toBe("");
    expect(err(many(200))).toContain("larger than 32 KB");
    const img = (chars: number) => `data:image/jpeg;base64,${"A".repeat(chars - 23)}`;
    expect(img(204800).length).toBe(204800);
    expect(err(root(card.image(img(204800))))).toBe("");
    expect(err(root(card.image(img(204801))))).toContain("larger than 200 KB");
    expect(err(root(card.col([card.image(img(102401)), card.image(img(102400))])))).toContain("larger than 200 KB");
  });
  test("only base64 png and jpeg images", () => {
    for (const src of ["https://example.com/a.png", "data:image/svg+xml;base64,AAAA", "data:image/gif;base64,AAAA", 'data:image/png;base64,AA");x:url("http://evil', "data:image/png,raw"]) expect(err(root({ t: "image", src }))).toContain("base64 data:image/png or data:image/jpeg");
  });
  test("unknown parts and fields are refused", () => {
    expect(err(root({ t: "html", html: "<b>" }))).toContain('unknown part "html"');
    expect(err(root({ t: "constructor" }))).toContain("unknown part");
    expect(err(root({ t: "text", text: "x", style: "color:red" }))).toContain('"style" is not a field of text');
    expect(err(root({ t: "spacer", children: [] }))).toContain('"children" is not a field of spacer');
    expect(err({ root: { t: "spacer" }, css: "x" })).toContain('only "root"');
    expect(err({})).toContain("root must be an object");
    expect(err([])).toContain("needs { root }");
    expect(err(root({ t: "text", text: "x", tone: "red" }))).toContain("tone must be one of");
    expect(err(root({ t: "row", gap: 4, children: [] }))).toContain("gap must be one of");
    expect(err(root({ t: "button", label: "x", action: "Not An Id" }))).toContain("action must be the id");
    expect(err(root({ t: "button", label: "x", action: "a", args: { k: { deep: 1 } } }))).toContain("must be text");
    expect(err(root({ t: "button", label: "", action: "a" }))).toContain("a label or an icon");
    expect(err(root({ t: "icon", name: "<svg>" }))).toContain("icon name");
  });
  test("the agent's renderer check and the deck use the same rules", () => {
    expect(cleanRender("card", { root: { t: "spacer" } })).toEqual({ data: { root: { t: "spacer" } } });
    expect("error" in cleanRender("card", { root: { t: "nope" } })).toBe(true);
    expect(validatePlugin("card", { root: { t: "spacer" } })).toEqual({ render: "card", data: { root: { t: "spacer" } } });
    expect(validatePlugin("card", { root: { t: "nope" } })).toBeNull();
    expect(parsePluginItem({ render: "card", data: { root: { t: "nope" } } })).toEqual({ error: "" });
  });
  test("base text size follows the tile", () => {
    expect(cardBase(80, 80)).toBe(11);
    expect(cardBase(180, 180)).toBe(15);
  });
});

const MANIFEST = {
  id: "dev.t.card", name: "Card", version: "1.0.0", main: "index.js", permissions: {},
  settings: [{ key: "place", type: "string", label: "Place", default: "home" }, { key: "token", type: "secret", label: "Token" }],
  widgets: [{ id: "w", name: "W", render: "card", sizes: ["2x2"] }],
  actions: [
    { id: "run", name: "Run", settings: [{ key: "name", type: "string", label: "Name" }, { key: "minutes", type: "number", label: "Minutes", default: 5 }, { key: "mode", type: "select", label: "Mode", options: ["a", "b"] }, { key: "key", type: "secret", label: "Key" }] },
    { id: "hidden", name: "Hidden" },
  ],
};

describe("manifest preview of a card", () => {
  test("a valid preview is kept, an invalid one fails the manifest", () => {
    const m = (preview: unknown) => ({ ...MANIFEST, widgets: [{ id: "w", name: "W", render: "card", preview }] });
    expect(parseManifest(m({ root: card.text("hi") })).widgets[0]!.preview).toEqual({ root: { t: "text", text: "hi" } });
    expect(() => parseManifest(m({ root: { t: "video" } }))).toThrow('unknown part "video"');
    expect(() => parseManifest({ ...MANIFEST, widgets: [{ id: "w", render: "card", style: "plain" }] })).toThrow("style");
  });
});

describe("card buttons", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function setup() {
    dir = mkdtempSync(join(tmpdir(), "pd-card-"));
    const src = join(dir, "src");
    await Bun.write(join(src, "nookdeck.json"), JSON.stringify(MANIFEST));
    writeFileSync(join(src, "index.js"), "export function activate() {}");
    const store = new PluginStore({ dir: join(dir, "plugins"), stateFile: join(dir, "plugins.json") });
    await store.load();
    await store.link(src);
    await store.setSettings("dev.t.card", { token: "s3cret" });
    const ran: Array<{ action: string; settings: Record<string, unknown> }> = [];
    const logs: string[] = [];
    let polls = 0;
    let buttons: CardNode[] = [card.button("Go", "run", { args: { name: 'my "shortcut" é', minutes: 10, extra: "x", place: "evil", token: "evil", key: "evil" } })];
    const hosts: any = {
      onPush: () => {}, onRegistered: () => {}, every: () => 3600,
      widget: async () => { polls++; return { render: "card", data: card.root(card.col(buttons)) }; },
      action: async (_p: string, action: string, settings: Record<string, unknown>) => { if (settings.name === "boom") throw new Error("it broke"); ran.push({ action, settings }); },
    };
    const items: any[] = [];
    const rt = new PluginRuntime(store, { hosts, fetch, shell: async () => ({ code: 0, stdout: "" }), onItems: (i) => items.push(i), log: (_p, l) => logs.push(l) });
    rt.setLayout({ pages: [{ id: "p", name: "P", items: [{ id: "t1", kind: "widget", widget: "plugin", x: 0, y: 0, w: 2, h: 2, plugin: { id: "dev.t.card", widget: "w" } }] }] } as any);
    rt.setActive(true);
    const settle = () => Bun.sleep(20);
    await settle();
    const tap = (action: unknown, args?: unknown, tile: unknown = "t1") => rt.cardAction(tile, action, args, async (_s: MacroStep[]) => {});
    const shown = async (b: CardNode[]) => { buttons = b; rt.rebuild(); await settle(); };
    return { rt, store, ran, logs, tap, shown, settle, polls: () => polls, args: (buttons[0] as any).args };
  }

  test("runs the declared action with args as the action's own settings; unknown keys, plugin settings and secrets are dropped", async () => {
    const s = await setup();
    const before = s.polls();
    await s.tap("run", s.args);
    expect(s.ran).toEqual([{ action: "run", settings: { place: "home", token: "s3cret", name: 'my "shortcut" é', minutes: 10 } }]);
    await Bun.sleep(CARD_REFRESH_MS + 50);
    expect(s.polls()).toBe(before + 1); // the card is asked again soon after
    s.rt.stop();
  });
  test("taps close together share one refresh, a later one gets its own, and none runs after stop", async () => {
    const s = await setup();
    const before = s.polls();
    for (let i = 0; i < 5; i++) await s.tap("run", s.args);
    expect([s.ran.length, s.polls() - before]).toEqual([5, 0]);
    await Bun.sleep(CARD_REFRESH_MS + 50);
    expect(s.polls() - before).toBe(1);
    await s.tap("run", s.args);
    await Bun.sleep(CARD_REFRESH_MS + 50);
    expect(s.polls() - before).toBe(2);
    await s.tap("run", s.args);
    s.rt.stop();
    await Bun.sleep(CARD_REFRESH_MS + 50);
    expect(s.polls() - before).toBe(2);
  });
  test("an undeclared action is refused and logged", async () => {
    const s = await setup();
    await s.shown([card.button("Bad", "format-disk")]);
    await expect(s.tap("format-disk")).rejects.toThrow("no such action");
    expect(s.ran).toEqual([]);
    expect(s.logs.join()).toContain('declares no action "format-disk"');
    s.rt.stop();
  });
  test("a phone cannot make up a button: another action, other args, another tile", async () => {
    const s = await setup();
    await expect(s.tap("hidden")).rejects.toThrow("no longer on the card");
    await expect(s.tap("run", { ...s.args, name: "other" })).rejects.toThrow("no longer on the card");
    await expect(s.tap("run", s.args, "nope")).rejects.toThrow("not on the layout");
    await expect(s.tap("run", "text")).rejects.toThrow("not on the layout");
    expect(s.ran).toEqual([]);
    s.rt.stop();
  });
  test("a tap on the card that was just replaced still runs; two cards later it does not", async () => {
    const s = await setup();
    await s.shown([card.button("Pause", "run", { args: { name: "pause" } })]);
    await s.tap("run", s.args);
    expect(s.ran.length).toBe(1);
    await s.settle();
    await s.shown([card.button("Reset", "run", { args: { name: "reset" } })]);
    await s.shown([card.button("Skip", "run", { args: { name: "skip" } })]);
    await expect(s.tap("run", s.args)).rejects.toThrow("no longer on the card");
    s.rt.stop();
  });
  test("a value that does not fit its field is refused; a thrown error reaches the phone; a disabled plugin does nothing", async () => {
    const s = await setup();
    await s.shown([card.button("x", "run", { args: { mode: "z" } }), card.button("y", "run", { args: { name: "boom" } })]);
    await expect(s.tap("run", { mode: "z" })).rejects.toThrow('invalid value for "Mode"');
    await expect(s.tap("run", { name: "boom" })).rejects.toThrow("it broke");
    await s.store.setEnabled("dev.t.card", false);
    await expect(s.tap("run", { name: "boom" })).rejects.toThrow();
    expect(s.ran).toEqual([]);
    s.rt.stop();
  });
});

describe("card classes", () => {
  // .pd-card is the pairing screen's form: a plugin card that shared it got its max-width, padding and border
  test("every class card.tsx uses is under its own prefix, which nothing else styles or uses", async () => {
    const src = join(import.meta.dir, "../web/deck/src");
    const tsx = await Bun.file(join(src, "card.tsx")).text();
    const used = tsx.match(/pd-[A-Za-z0-9_-]+/g)!.filter((c) => !tsx.includes("var(--" + c));
    expect(used.filter((c) => !c.startsWith("pd-pcard"))).toEqual([]);
    const css = await Bun.file(join(src, "deck.css")).text();
    const block = css.indexOf("/* ---------- plugin card renderer");
    expect(block).toBeGreaterThan(0);
    expect(css.slice(0, block)).not.toContain("pd-pcard");
    // a gap is a margin on the next sibling: its rule needs more classes than the button's margin reset, or buttons touch
    const classes = (sel: string) => (sel.match(/\.[A-Za-z_-]|\[/g) ?? []).length;
    const reset = css.match(/^([^{\n]*\.pd-pcard__btn) \{[^}]*margin: 0/m)![1]!;
    const gaps = css.match(/^[^{\n]*\[data-gap="\d+px"\] > \* \+ \*/gm)!;
    expect(gaps.length).toBe(6);
    for (const g of gaps) expect(classes(g)).toBeGreaterThan(classes(reset));
    const next = css.indexOf("/* ----------", block + 10); // the section after the card's, if any
    const own = css.slice(block, next < 0 ? undefined : next);
    expect(css.slice(block + own.length)).not.toContain("pd-pcard");
    for (const rule of own.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
      const selectors = rule.split("{")[0]!.trim();
      if (selectors) for (const one of selectors.split(",")) expect(one.trim()).toStartWith(".pd-pcard");
    }
    for (const f of new Bun.Glob("*.{ts,tsx}").scanSync(src)) if (f !== "card.tsx") expect(await Bun.file(join(src, f)).text()).not.toContain("pd-pcard");
  });
});
