export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** "Fill" when the part takes the width its parent offers (within a pixel), otherwise "Hug" (it sizes to its content). */
export function sizing(width: number, parentContentWidth: number): { kind: "Fill" | "Hug"; px: number } {
  const px = Math.round(width);
  return { kind: parentContentWidth > 0 && Math.abs(width - parentContentWidth) <= 1 ? "Fill" : "Hug", px };
}

export function sizingLabel(width: number, parentContentWidth: number): string {
  const s = sizing(width, parentContentWidth);
  return `W ${s.kind} ${s.px}px`;
}

export interface Band {
  side: keyof Sides;
  box: Box;
  px: number;
}

/** The padding as bands inside the part's box, one per side that has any. */
export function paddingBands(b: Box, p: Sides): Band[] {
  const out: Band[] = [];
  const r = (n: number) => Math.round(n * 10) / 10;
  if (p.top > 0) out.push({ side: "top", px: r(p.top), box: { x: b.x, y: b.y, w: b.w, h: p.top } });
  if (p.bottom > 0) out.push({ side: "bottom", px: r(p.bottom), box: { x: b.x, y: b.y + b.h - p.bottom, w: b.w, h: p.bottom } });
  if (p.left > 0) out.push({ side: "left", px: r(p.left), box: { x: b.x, y: b.y + p.top, w: p.left, h: Math.max(0, b.h - p.top - p.bottom) } });
  if (p.right > 0) out.push({ side: "right", px: r(p.right), box: { x: b.x + b.w - p.right, y: b.y + p.top, w: p.right, h: Math.max(0, b.h - p.top - p.bottom) } });
  return out;
}

export interface Gap {
  /** The space between the two boxes (zero width or height when they touch). */
  box: Box;
  px: number;
  axis: "x" | "y";
}

/**
 * The space between a part and a sibling: along y when the sibling is below or above, along x when it is beside.
 * `declared` (the parent's flex or grid gap) wins over the measured distance when it is set.
 */
export function gapBetween(a: Box, b: Box, declared?: number): Gap {
  const below = b.y >= a.y + a.h - 0.5;
  const above = b.y + b.h <= a.y + 0.5;
  const r = (n: number) => Math.max(0, Math.round(n));
  if (below || above) {
    const top = below ? a.y + a.h : b.y + b.h;
    const bottom = below ? b.y : a.y;
    const x = Math.max(a.x, b.x);
    const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x) || Math.min(a.w, b.w);
    return { axis: "y", px: declared ?? r(bottom - top), box: { x, y: top, w, h: Math.max(0, bottom - top) } };
  }
  const right = b.x >= a.x + a.w - 0.5;
  const left = right ? a.x + a.w : b.x + b.w;
  const end = right ? b.x : a.x;
  const y = Math.max(a.y, b.y);
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) || Math.min(a.h, b.h);
  return { axis: "x", px: declared ?? r(end - left), box: { x: left, y, w: Math.max(0, end - left), h } };
}

export interface Guide {
  axis: "x" | "y";
  /** The shared edge. */
  at: number;
  from: number;
  to: number;
}

/**
 * Dashed guides where the part's left or right edge lines up with another box (within `tol` px), spanning both
 * boxes plus `reach` px. At most one per edge, the nearest box first.
 */
export function alignGuides(b: Box, others: readonly Box[], tol = 0.75, reach = 10): Guide[] {
  const out: Guide[] = [];
  const edges: [number, (o: Box) => number][] = [
    [b.x, (o) => o.x],
    [b.x + b.w, (o) => o.x + o.w],
  ];
  for (const [edge, of] of edges) {
    const hits = others.filter((o) => Math.abs(of(o) - edge) <= tol && !(o.x === b.x && o.y === b.y && o.w === b.w && o.h === b.h));
    if (!hits.length) continue;
    hits.sort((p, q) => Math.abs(p.y - b.y) - Math.abs(q.y - b.y));
    const o = hits[0]!;
    out.push({ axis: "x", at: edge, from: Math.min(b.y, o.y) - reach, to: Math.max(b.y + b.h, o.y + o.h) + reach });
  }
  return out;
}

/** Glide time for the cursor (ms): longer for a longer trip, never under 240 and never over 600 (canvas travel). */
export function glideMs(from: { x: number; y: number }, to: { x: number; y: number }): number {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.round(Math.min(600, Math.max(240, 240 + d * 1.1)));
}

/** Where the cursor rests on a part: inside it, a little right of and below the centre, like a hand would. */
export function restPoint(b: Box): { x: number; y: number } {
  return { x: b.x + Math.min(b.w * 0.62, b.w - 4), y: b.y + Math.min(b.h * 0.62, b.h - 4) };
}

/** The part a pointer is over: the smallest box that contains the point. */
export function partAt(boxes: readonly (Box | null)[], x: number, y: number): number {
  let best = -1;
  let area = Infinity;
  boxes.forEach((b, i) => {
    if (!b || x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return;
    const a = b.w * b.h;
    if (a < area) {
      area = a;
      best = i;
    }
  });
  return best;
}

/* ── Badge placement ── */

/** A badge's size for its text: 10.5px tabular figures, 4px side padding, 14px line. Close enough to keep them apart. */
export function badgeSize(text: string): { w: number; h: number } {
  return { w: Math.ceil(text.length * 6.2 + 9), h: 16 };
}

/** True when `a` lies wholly inside `bounds`. */
export const inside = (a: Box, bounds?: Box) => !bounds || (a.x >= bounds.x && a.y >= bounds.y && a.x + a.w <= bounds.x + bounds.w && a.y + a.h <= bounds.y + bounds.h);

/** Moves `a` the least distance that puts it inside `bounds` (as far as it fits). */
export function clampBox(a: Box, bounds?: Box): Box {
  if (!bounds) return a;
  const x = Math.min(Math.max(a.x, bounds.x), bounds.x + bounds.w - a.w);
  const y = Math.min(Math.max(a.y, bounds.y), bounds.y + bounds.h - a.h);
  return { ...a, x: Math.max(bounds.x, x), y: Math.max(bounds.y, y) };
}

export const overlaps = (a: Box, b: Box, pad = 2) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

/**
 * Where a badge goes around `rect` without touching anything in `taken`: below, then above, then to the right,
 * then to the left (each right-aligned or centred on the rect). With `bounds` (the visible stage), a place
 * that would leave it is skipped, so a badge flips to the side that has room. Falls back to the first place,
 * clamped into the bounds.
 */
export function placeBadge(size: { w: number; h: number }, rect: Box, taken: readonly Box[], gap = 6, bounds?: Box): Box {
  const { w, h } = size;
  const tries: Box[] = [
    { x: rect.x + rect.w - w, y: rect.y + rect.h + gap, w, h },
    { x: rect.x + rect.w - w, y: rect.y - gap - h, w, h },
    { x: rect.x + rect.w + gap, y: rect.y + rect.h / 2 - h / 2, w, h },
    { x: rect.x - gap - w, y: rect.y + rect.h / 2 - h / 2, w, h },
    { x: rect.x, y: rect.y + rect.h + gap, w, h },
  ];
  const free = (t: Box) => !taken.some((o) => overlaps(t, o));
  return tries.find((t) => inside(t, bounds) && free(t)) ?? tries.map((t) => clampBox(t, bounds)).find(free) ?? clampBox(tries[0]!, bounds);
}

/**
 * Where a padding band's px badge goes: centred inside the band when it fits, otherwise just outside the part on
 * that side. Null when neither place is free (the band itself still shows).
 */
export function placeBandBadge(size: { w: number; h: number }, band: Band, part: Box, taken: readonly Box[], gap = 3, bounds?: Box, avoid: readonly Box[] = []): Box | null {
  const { w, h } = size;
  const b = band.box;
  // Inside only when the band holds the whole badge, so it never touches the part's own text.
  const fits = b.w >= w && b.h >= h;
  const centred: Box = { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h };
  if (fits && !taken.some((o) => overlaps(centred, o, 0)) && !avoid.some((o) => overlaps(centred, o, 0))) return centred;
  // Otherwise above or below the part, lined up with the band (beside it is where the neighbours' text is).
  const cx = b.x + b.w / 2 - w / 2;
  const below: Box = { x: cx, y: part.y + part.h + gap, w, h };
  const above: Box = { x: cx, y: part.y - gap - h, w, h };
  const order = band.side === "top" ? [above, below] : [below, above];
  return order.find((o) => inside(o, bounds) && !taken.some((t) => overlaps(o, t)) && !avoid.some((t) => overlaps(o, t, 1))) ?? null;
}

/** True when `outer` holds `inner` (within half a pixel): a part's parent part, which a badge beside it cannot avoid. */
export const contains = (outer: Box, inner: Box) =>
  outer.x <= inner.x + 0.5 && outer.y <= inner.y + 0.5 && outer.x + outer.w >= inner.x + inner.w - 0.5 && outer.y + outer.h >= inner.y + inner.h - 0.5;

/** The places around `rect`, in the order placeBadge tries them: below, above, right, left, below-left. */
export function aroundTries(size: { w: number; h: number }, rect: Box, gap = 6): Box[] {
  const { w, h } = size;
  return [
    { x: rect.x + rect.w - w, y: rect.y + rect.h + gap, w, h },
    { x: rect.x + rect.w - w, y: rect.y - gap - h, w, h },
    { x: rect.x + rect.w + gap, y: rect.y + rect.h / 2 - h / 2, w, h },
    { x: rect.x - gap - w, y: rect.y + rect.h / 2 - h / 2, w, h },
    { x: rect.x, y: rect.y + rect.h + gap, w, h },
  ];
}

/**
 * Outside the card, where nothing of it is: level with `cy` to the right of its edge, then to the left; then (a
 * narrow stage has no side room) above and below the card, at either end.
 */
export function besideCard(size: { w: number; h: number }, card: Box, cy: number, gap = 6): Box[] {
  const { w, h } = size;
  const above = card.y - gap - h;
  const below = card.y + card.h + gap;
  return [
    { x: card.x + card.w + gap, y: cy - h / 2, w, h },
    { x: card.x - gap - w, y: cy - h / 2, w, h },
    { x: card.x, y: above, w, h },
    { x: card.x + card.w - w, y: below, w, h },
    { x: card.x, y: below, w, h },
    { x: card.x + card.w - w, y: above, w, h },
  ];
}

/**
 * The first place that stays in `bounds`, keeps clear of the other badges (`taken`) and never covers a part
 * (`avoid`). Then the same places moved into the bounds. Null when every one would cover something.
 */
export function firstFree(tries: readonly Box[], taken: readonly Box[], avoid: readonly Box[], bounds?: Box): Box | null {
  const ok = (t: Box) => inside(t, bounds) && !taken.some((o) => overlaps(t, o)) && !avoid.some((o) => overlaps(t, o, 1));
  return tries.find(ok) ?? tries.map((t) => clampBox(t, bounds)).find(ok) ?? null;
}

/** The compact px badge inside a padding band: 10px figures, 2px side padding. */
export function bandBadgeSize(text: string): { w: number; h: number } {
  return { w: Math.ceil(text.length * 6 + 4), h: 15 };
}

/**
 * Which side of the part a badge sits on: outside the card ("card-right", "card-left", "card-above",
 * "card-below"), else beside the part ("above", "below", "right", "left"), else "inside". A badge that changes
 * side fades across instead of gliding, so it never crosses the card's text on the way.
 */
export function badgeSide(b: Box, part: Box, card: Box): string {
  if (b.x >= card.x + card.w - 0.5) return "card-right";
  if (b.x + b.w <= card.x + 0.5) return "card-left";
  if (b.y + b.h <= card.y + 0.5) return "card-above";
  if (b.y >= card.y + card.h - 0.5) return "card-below";
  if (b.y >= part.y + part.h - 0.5) return "below";
  if (b.y + b.h <= part.y + 0.5) return "above";
  if (b.x >= part.x + part.w - 0.5) return "right";
  if (b.x + b.w <= part.x + 0.5) return "left";
  return "inside";
}
