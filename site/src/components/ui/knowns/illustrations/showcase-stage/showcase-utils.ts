import type { Box } from "../inspect/measure-utils";

export type CommentSide = "left" | "right" | "above" | "below";

export interface CommentPlace {
  box: Box;
  side: CommentSide;
  /** The leader line as an SVG path, from the comment's inner edge to the part's edge. */
  leader: string;
  /** Where the leader meets the part. */
  end: { x: number; y: number };
}

export interface PlaceInput {
  /** The card (the focal item). */
  card: Box;
  /** Each comment's part, or null when it is not found. */
  parts: readonly (Box | null)[];
  /** Each comment's size, measured. */
  sizes: readonly { w: number; h: number }[];
  /** A side asked for per comment (left or right); otherwise the side nearer the part. */
  sides?: readonly (CommentSide | undefined)[];
  /** Flat and narrow: one comment at a time, above or below the card. */
  narrow?: boolean;
  /** The space between the card and a comment. Default 28. */
  gap?: number;
  /** Keep comments inside this box (the plane's side room). */
  bounds?: Box;
}

const hit = (a: Box, b: Box, pad: number) => a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
const within = (a: Box, b?: Box) => !b || (a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const r = (n: number) => Math.round(n * 10) / 10;

/** The side a comment takes beside the card when none is asked for: the one nearer its part. */
export function nearerSide(part: Box, card: Box): "left" | "right" {
  return part.x + part.w / 2 >= card.x + card.w / 2 ? "right" : "left";
}

/** A hairline from the comment to the part: straight when level, otherwise bent once in the gap beside the card. */
export function leaderPath(box: Box, side: CommentSide, part: Box, card: Box, gap: number): { d: string; end: { x: number; y: number } } {
  if (side === "left" || side === "right") {
    const right = side === "right";
    const y1 = part.y + part.h / 2;
    const y0 = clamp(y1, box.y + 10, box.y + box.h - 10);
    const x0 = right ? box.x : box.x + box.w;
    const x1 = right ? part.x + part.w : part.x;
    if (Math.abs(y0 - y1) < 1) return { d: `M${r(x0)} ${r(y0)}H${r(x1)}`, end: { x: x1, y: y1 } };
    const xm = right ? card.x + card.w + gap / 2 : card.x - gap / 2;
    return { d: `M${r(x0)} ${r(y0)}H${r(xm)}V${r(y1)}H${r(x1)}`, end: { x: x1, y: y1 } };
  }
  const above = side === "above";
  const x1 = clamp(part.x + part.w / 2, part.x + 4, part.x + part.w - 4);
  const x0 = clamp(x1, box.x + 12, box.x + box.w - 12);
  const y0 = above ? box.y + box.h : box.y;
  const y1 = above ? part.y : part.y + part.h;
  if (Math.abs(x0 - x1) < 1) return { d: `M${r(x0)} ${r(y0)}V${r(y1)}`, end: { x: x1, y: y1 } };
  const ym = above ? card.y - gap / 2 : card.y + card.h + gap / 2;
  return { d: `M${r(x0)} ${r(y0)}V${r(ym)}H${r(x1)}V${r(y1)}`, end: { x: x1, y: y1 } };
}

/**
 * Where each comment goes. Beside the card, on its asked side or the side nearer its part, level with the part
 * and nudged up or down until it clears the comments already placed; the other side when that side is full.
 * Narrow: above the card when the part is in its top half, below otherwise, the card's width wide (only the active
 * one shows, so they may share the spot). Comments never sit on the card, so they never cover a part. Null when a
 * part is missing or nothing fits.
 */
export function placeComments({ card, parts, sizes, sides = [], narrow = false, gap = 28, bounds }: PlaceInput): (CommentPlace | null)[] {
  const placed: Box[] = [];
  return parts.map((part, i) => {
    const size = sizes[i];
    if (!part || !size) return null;
    if (narrow) {
      const above = part.y + part.h / 2 < card.y + card.h / 2;
      const w = card.w;
      const box: Box = { x: card.x, y: above ? card.y - gap / 2 - size.h : card.y + card.h + gap / 2, w, h: size.h };
      const side: CommentSide = above ? "above" : "below";
      const l = leaderPath(box, side, part, card, gap / 2);
      return { box, side, leader: l.d, end: l.end };
    }
    const asked = sides[i];
    const first: "left" | "right" = asked === "left" || asked === "right" ? asked : nearerSide(part, card);
    for (const side of [first, first === "right" ? "left" : "right"] as const) {
      const x = side === "right" ? card.x + card.w + gap : card.x - gap - size.w;
      const want = part.y + part.h / 2 - size.h / 2;
      for (let k = 0; k < 60; k++) {
        const dy = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 6;
        const box: Box = { x, y: want + dy, w: size.w, h: size.h };
        if (!within(box, bounds) || placed.some((p) => hit(box, p, 8))) continue;
        placed.push(box);
        const l = leaderPath(box, side, part, card, gap);
        return { box, side, leader: l.d, end: l.end };
      }
    }
    return null;
  });
}

/** Room a narrow stage keeps above and below the card for the tallest comment on each side. */
export function narrowRoom(places: readonly (CommentPlace | null)[], gap = 28): { top: number; bottom: number } {
  let top = 0;
  let bottom = 0;
  for (const p of places) {
    if (p?.side === "above") top = Math.max(top, p.box.h + gap / 2);
    if (p?.side === "below") bottom = Math.max(bottom, p.box.h + gap / 2);
  }
  return { top: Math.ceil(top), bottom: Math.ceil(bottom) };
}
