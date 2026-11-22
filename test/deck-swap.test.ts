import { describe, expect, test } from "bun:test";
import { swapPreview as managePreview } from "../web/manage/src/lib/layout";
import { swapPreview as deckPreview } from "../web/deck/src/swap";

const b = (id: string, x: number, y: number, w = 1, h = 1) => ({ id, kind: "button" as const, label: id, x, y, ...(w > 1 ? { w } : {}), ...(h > 1 ? { h } : {}) });
const page = (columns: number, rows: number, items: any[]) => ({ id: "p", name: "p", columns, rows, items }) as any;
const ids = (r: { id: string }[] | null) => (r ? r.map((i) => i.id).sort() : null);

describe("deck swap preview", () => {
  test("1x1 onto 1x1 on a full page swaps", () => {
    const p = page(2, 1, [b("a", 0, 0), b("c", 1, 0)]);
    const r = deckPreview(p, "a", 1, 0)!;
    expect(r).toEqual([{ id: "c", x: 0, y: 0, w: 1, h: 1 }]);
  });
  test("a free spot is a plain move", () => {
    expect(deckPreview(page(3, 1, [b("a", 0, 0)]), "a", 2, 0)).toBeNull();
  });
  test("2x1 over two 1x1: both land in the old rect", () => {
    const p = page(4, 1, [b("a", 0, 0, 2), b("c", 2, 0), b("d", 3, 0)]);
    const r = deckPreview(p, "a", 2, 0)!;
    expect(r.map((i) => [i.id, i.x]).sort()).toEqual([["c", 0], ["d", 1]]);
  });
  test("parity with manage swapPreview on every drop of every tile", () => {
    const layouts = [
      page(4, 2, [b("a", 0, 0, 2), b("c", 2, 0, 2), b("d", 0, 1), b("e", 1, 1), b("f", 2, 1, 2)]),
      page(3, 2, [b("a", 0, 0), b("c", 1, 0), b("d", 2, 0), b("e", 0, 1, 2), b("f", 2, 1)]),
      page(4, 2, [b("a", 0, 0, 2, 2), b("c", 2, 0), b("d", 3, 0), b("e", 2, 1), b("f", 3, 1)]),
      page(5, 3, [b("a", 0, 0), b("c", 1, 0, 2)]),
    ];
    for (const p of layouts)
      for (const it of p.items)
        for (let y = 0; y < p.rows; y++)
          for (let x = 0; x < p.columns; x++) expect(ids(deckPreview(p, it.id, x, y))).toEqual(ids(managePreview(p, it.id, x, y)));
  });
});
