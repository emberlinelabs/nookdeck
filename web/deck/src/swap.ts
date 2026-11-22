/**
 * Drop-preview rule for an edit-mode drag: does dropping a tile on a covered spot swap it with the tiles there?
 * A pure port of swapTiles / swapPreview from web/manage/src/lib/layout.ts (that file needs the manage aliases, i18n and
 * platform, so the deck cannot import it); test/deck-swap.test.ts checks both give the same answer.
 */
import { pageMove, type PageLike, type TileLike } from '../../shared/reflow'

interface Rect { x: number; y: number; w: number; h: number }
const rectOf = (it: TileLike): Rect => ({ x: it.x || 0, y: it.y || 0, w: it.w || 1, h: it.h || 1 })
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const inside = (r: Rect, g: { columns: number; rows: number }) => r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= g.columns && r.y + r.h <= g.rows
const area = (r: Rect) => r.w * r.h
const within = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

const itemsIn = (items: TileLike[], r: Rect, ignore?: string) => items.filter((o) => o.id !== ignore && overlaps(rectOf(o), r))

function exactlyCovered(others: TileLike[], t: Rect): boolean {
  return others.length > 0 && others.every((o) => within(rectOf(o), t)) && others.reduce((n, o) => n + area(rectOf(o)), 0) === area(t)
}

function validItems(g: { columns: number; rows: number }, items: TileLike[]): boolean {
  const rs = items.map(rectOf)
  return rs.every((r, i) => inside(r, g) && rs.every((o, j) => i === j || !overlaps(r, o)))
}

/** First free cell (row by row) where w x h fits among `items` in a columns x rows grid. */
function findFree(items: TileLike[], columns: number, rows: number, w: number, h: number): { x: number; y: number } | undefined {
  for (let y = 0; y + h <= rows; y++) for (let x = 0; x + w <= columns; x++) if (itemsIn(items, { x, y, w, h }).length === 0) return { x, y }
  return undefined
}

/** Where the swapped tiles end up (their new x/y), or null when the swap is impossible. */
function swapTiles<T extends TileLike>(page: PageLike<T>, id: string, x: number, y: number): { moved: T[]; swapped: T[] } | null {
  const d = page.items.find((i) => i.id === id)
  if (!d) return null
  const from = rectOf(d)
  const to: Rect = { x, y, w: from.w, h: from.h }
  if (!inside(to, page)) return null
  const others = itemsIn(page.items, to, id) as T[]
  if (!others.length) return null
  const rest = page.items.filter((i) => i.id !== id && others.indexOf(i) < 0)
  const dd = Object.assign({}, d, { x: x, y: y })
  // 1) same relative offsets
  const kept = others.map((o) => Object.assign({}, o, { x: from.x + (o.x || 0) - x, y: from.y + (o.y || 0) - y }))
  if (validItems(page, rest.concat(kept, [dd])) && kept.every((k) => within(rectOf(k), from))) return { moved: kept, swapped: others }
  // 2) pack them row by row inside the old rectangle
  let cur: T[] = []
  const sorted = others.slice().sort((a, b) => (a.y || 0) - (b.y || 0) || (a.x || 0) - (b.x || 0))
  for (let i = 0; i < sorted.length; i++) {
    const r = rectOf(sorted[i])
    const cell = findFree(cur, from.w, from.h, r.w, r.h)
    if (!cell) return null
    cur = cur.concat([Object.assign({}, sorted[i], cell)])
  }
  const packed = cur.map((o) => Object.assign({}, o, { x: from.x + (o.x || 0), y: from.y + (o.y || 0) }))
  if (!validItems(page, rest.concat(packed, [dd]))) return null
  return { moved: packed, swapped: others }
}

/**
 * What dropping tile `id` at (x, y) would swap with, with the rectangle each of those tiles lands in (inside the dragged
 * tile's old spot); null when the drop is a plain move or impossible. Same rule as manage's swapPreview.
 */
export function swapPreview<T extends TileLike>(page: PageLike<T>, id: string, x: number, y: number): { id: string; x: number; y: number; w: number; h: number }[] | null {
  const d = page.items.find((i) => i.id === id)
  if (!d) return null
  const to: Rect = { x, y, w: d.w || 1, h: d.h || 1 }
  const others = itemsIn(page.items, to, id)
  const r = swapTiles(page, id, x, y)
  if (!r) return null
  if (!exactlyCovered(others, to) && pageMove(page, id, x, y).ok) return null
  return r.moved.map((m) => ({ id: m.id, x: m.x || 0, y: m.y || 0, w: m.w || 1, h: m.h || 1 }))
}
