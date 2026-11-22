import { describe, expect, test } from "bun:test";
import { moveTile, moveToPage, swapPreview, swapTiles } from "../web/manage/src/lib/layout";

const b = (id: string, x: number, y: number, w = 1, h = 1) => ({ id, kind: "button" as const, label: id, x, y, ...(w > 1 ? { w } : {}), ...(h > 1 ? { h } : {}) });
const page = (columns: number, rows: number, items: any[], id = "p") => ({ id, name: id, columns, rows, items }) as any;
const at = (p: any, id: string) => p.items.find((i: any) => i.id === id);

describe("swap on a full page", () => {
  test("1x1 onto 1x1 swaps places", () => {
    const p = page(2, 1, [b("a", 0, 0), b("c", 1, 0)]);
    const r: any = moveTile(p, "a", 1, 0);
    expect(r.ok).toBe(true);
    expect([at(r.page, "a").x, at(r.page, "c").x]).toEqual([1, 0]);
    expect(r.swapped.map((i: any) => i.id)).toEqual(["c"]);
  });
  test("2x1 onto 2x1 swaps", () => {
    const p = page(4, 1, [b("a", 0, 0, 2), b("c", 2, 0, 2)]);
    const r: any = moveTile(p, "a", 2, 0);
    expect(r.ok).toBe(true);
    expect([at(r.page, "a").x, at(r.page, "c").x]).toEqual([2, 0]);
  });
  test("a big tile onto two small ones that fit its old rect", () => {
    const p = page(4, 1, [b("big", 0, 0, 2), b("s1", 2, 0), b("s2", 3, 0)]);
    const r: any = moveTile(p, "big", 2, 0);
    expect(r.ok).toBe(true);
    expect(at(r.page, "big").x).toBe(2);
    expect([at(r.page, "s1").x, at(r.page, "s2").x].sort()).toEqual([0, 1]);
  });
  test("refused when the displaced tiles do not fit", () => {
    const p = page(3, 1, [b("a", 0, 0), b("big", 1, 0, 2)]);
    const r: any = moveTile(p, "a", 1, 0);
    expect(r.ok).toBe(false);
  });
  test("a free target is a plain move, not a swap", () => {
    const p = page(3, 1, [b("a", 0, 0)]);
    const r: any = moveTile(p, "a", 2, 0);
    expect(r.ok).toBe(true);
    expect(r.swapped).toBeUndefined();
  });
  test("swapPreview names the tile that would swap", () => {
    const p = page(2, 1, [b("a", 0, 0), b("c", 1, 0)]);
    expect(swapPreview(p, "a", 1, 0)?.map((i: any) => i.id)).toEqual(["c"]);
    expect(swapTiles(page(2, 1, [b("a", 0, 0)]), "a", 1, 0)).toBeNull();
  });
});

describe("move to another screen", () => {
  const layout = (a: any[], c: any[]) => ({ version: 1, pages: [page(2, 1, a, "one"), page(2, 1, c, "two")] }) as any;
  test("goes to the first free spot", () => {
    const r: any = moveToPage(layout([b("a", 0, 0)], [b("x", 0, 0)]), "one", "a", "two");
    expect(r.ok).toBe(true);
    expect(r.layout.pages[0].items.length).toBe(0);
    expect(at(r.layout.pages[1], "a").x).toBe(1);
  });
  test("a full screen asks for a swap partner, then trades", () => {
    const l = layout([b("a", 0, 0)], [b("x", 0, 0), b("y", 1, 0)]);
    const first: any = moveToPage(l, "one", "a", "two");
    expect(first.ok).toBe(false);
    expect(first.full).toBe(true);
    const r: any = moveToPage(l, "one", "a", "two", "y");
    expect(r.ok).toBe(true);
    expect(at(r.layout.pages[1], "a").x).toBe(1);
    expect(at(r.layout.pages[0], "y").x).toBe(0);
    expect(r.layout.pages[1].items.length).toBe(2);
  });
  test("refuses when the other tile cannot go back", () => {
    const l = layout([b("a", 0, 0), b("z", 1, 0)], [b("wide", 0, 0, 2)]);
    const r: any = moveToPage(l, "one", "a", "two", "wide");
    expect(r.ok).toBe(false);
  });
});
