"use client";
/**
 * InspectMeasure: a real component on a dark stage, in a gentle 3D tilt, with a design-tool inspect overlay on one
 * part at a time. Everything is measured live from the DOM (offsets and computed style), never typed in:
 * a selection rect with corner handles, the padding as hatched bands with px badges, the gap to the next sibling
 * (red when 0), a layer tag with the part's name, a sizing badge ("W Fill 236px", "W Hug 84px") and a dashed
 * guide where an edge lines up with another box.
 *
 * Parts: `parts` (selector, ref or function, with a name) plus any element inside marked `data-inspect="Name"`,
 * so a buyer measures their own UI. A cursor glides from part to part while the stage is on screen (canvas
 * travel, at most 600ms) until the visitor points, taps or uses the keyboard; then the part under the pointer is
 * measured. Arrow keys move between parts when the stage has focus.
 *
 * Motion: the selection frame and its badges glide from part to part (280ms when the visitor moves, the cursor's
 * 240 to 600ms on the tour, so frame, cursor and camera arrive together); a badge's text settles in place; padding,
 * gap and guides crossfade over 120ms; a state switch crossfades the whole overlay. Nothing plays on mount. Reduced
 * motion: everything snaps, no autoplay, one part measured. Under 640px of container the tilt is off and a tap measures.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/knowns/utils";
import { MOTION, MotionStyle, SwapText } from "@/lib/knowns/motion";
import { useReducedMotion } from "../use-in-view";
import { Cursor, NARROW, StageFrame, cardBox, findTarget as find, localBox, stageGeometry, useStageView, type InspectTarget } from "./stage";
import { alignGuides, aroundTries, badgeSide, badgeSize, bandBadgeSize, besideCard, contains, firstFree, gapBetween, glideMs, paddingBands, partAt, placeBandBadge, restPoint, sizingLabel, type Band, type Box, type Gap, type Guide } from "./measure-utils";

export type { InspectTarget } from "./stage";

export interface MeasurePart {
  /** What to measure, inside the stage: a CSS selector, a ref, or a function of the root. */
  target: InspectTarget;
  /** The layer tag: "Task", "Status", "Cost". */
  name: string;
}

export interface InspectMeasureProps {
  /** Parts to measure, in the order the cursor visits them. Elements marked data-inspect="Name" are added after them. */
  parts?: readonly MeasurePart[];
  /** The real component. */
  children: ReactNode;
  /** Names the figure for screen readers. */
  label?: string;
  /** The part measured at rest, and the one shown under reduced motion. Default 0. */
  hold?: number;
  /** The cursor tours the parts while the stage is on screen. Default true; off under reduced motion. */
  autoplay?: boolean;
  /** The gentle 3D tilt. Default true; always off under 640px of container. */
  tilt?: boolean;
  /** Changes when the component switches state: the parts are found again. */
  swapKey?: string;
  /** Under the stage, on the left. */
  controls?: ReactNode;
  /** A link under the stage. */
  link?: { href: string; label: ReactNode };
  /** Tilt the other way, for the left one of a pair beside a headline. */
  mirror?: boolean;
  /** Wait this long (ms) before the tour starts, so two figures side by side take turns. */
  delay?: number;
  /** A still frame (launch posts, OG images): the held part measured, no cursor tour. */
  still?: boolean;
  /** Show the neighbouring items (`before`, `after`) around the component, so it reads as a list. Default true. */
  stack?: boolean;
  /** The item before this one in its list, shown faded above (inert, hidden from screen readers). */
  before?: ReactNode;
  /** The item after this one, shown faded below. */
  after?: ReactNode;
  /** Under this container width there is no tilt and no stack, and a tap measures. Default 640. */
  narrowBelow?: number;
  className?: string;
}

interface Measured {
  /** The state (swapKey) it was measured in: a new one crossfades the overlay instead of gliding it. */
  swap?: string;
  name: string;
  box: Box;
  /** The part's neighbours, so no badge lands on their text. */
  near: Box[];
  /** The other parts, except the ones that hold this part: no badge covers them. */
  avoid: Box[];
  /** The focal item (the card), so a badge can sit outside its edge. */
  card: Box | null;
  bands: Band[];
  gap: Gap | null;
  guides: Guide[];
  size: string;
}

/** How long the cursor rests on a part during the tour (ms). */
export const TOUR_MS = 1900;

/*
 * The selection frame and its badges glide with the stage's cursor and camera (stage.tsx): canvas travel
 * (kn-motion: up to 600ms, ease in and out). The frame moves by @property lengths, placed with translate, so no
 * layout property is transitioned. Detail layers (padding, gap, guides) and a state switch crossfade fast.
 */
const EASE_INOUT = "var(--kn-ease-inout, cubic-bezier(0.65, 0, 0.35, 1))";
const EASE_OUT = "var(--kn-ease-out, cubic-bezier(0.22, 1, 0.36, 1))";
const CSS = `
@property --knin-x { syntax: "<length>"; inherits: true; initial-value: 0px }
@property --knin-y { syntax: "<length>"; inherits: true; initial-value: 0px }
@property --knin-w { syntax: "<length>"; inherits: true; initial-value: 0px }
@property --knin-h { syntax: "<length>"; inherits: true; initial-value: 0px }
@keyframes knin-show { from { opacity: 0 } to { opacity: 1 } }
@keyframes knin-hide { from { opacity: 1 } to { opacity: 0 } }
[data-inspect-overlay] { transition: --knin-x var(--knin-glide, 600ms) ${EASE_INOUT}, --knin-y var(--knin-glide, 600ms) ${EASE_INOUT}, --knin-w var(--knin-glide, 600ms) ${EASE_INOUT}, --knin-h var(--knin-glide, 600ms) ${EASE_INOUT} }
[data-inspect-badge] { transition: translate var(--knin-glide, 600ms) ${EASE_INOUT}, opacity var(--kn-dur-fast, 120ms) ${EASE_OUT} }
[data-inspect-enter] { animation: knin-show var(--kn-dur-fast, 120ms) ${EASE_OUT} both }
[data-inspect-leaving] { animation: knin-hide var(--kn-dur-fast, 120ms) ${EASE_OUT} both }
[data-inspect-swap] { animation: knin-show var(--kn-dur-fast, 120ms) ${EASE_OUT} var(--kn-dur-fast, 120ms) backwards }
@media (prefers-reduced-motion: reduce) {
  [data-inspect-overlay], [data-inspect-badge] { transition: none !important }
  [data-inspect-enter], [data-inspect-leaving], [data-inspect-swap] { animation: none !important }
}
`;

/**
 * The last value seen under the previous `key`, for MOTION.fast after the key changes, so it can fade out while the
 * new one fades in. At most one at a time: a fast run of changes never stacks layers. Null when `off`.
 */
function useLeaving<T>(key: string, value: T | null, off: boolean): { key: string; value: T } | null {
  const [leaving, setLeaving] = useState<{ key: string; value: T } | null>(null);
  const last = useRef<{ key: string; value: T } | null>(null);
  // Runs before the effect below updates `last`, so it still holds the previous key's value.
  useLayoutEffect(() => {
    const prev = last.current;
    if (off || !prev || prev.key === key) return;
    setLeaving(prev);
    const t = setTimeout(() => setLeaving(null), MOTION.fast + 20);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, off]);
  useLayoutEffect(() => {
    if (value) last.current = { key, value };
  });
  return off ? null : leaving;
}

const px = (v: string) => parseFloat(v) || 0;

function measureOne(el: Element, name: string, plane: HTMLElement, others: Box[], card: Box | null = null): Measured | null {
  const box = localBox(el, plane);
  if (!box) return null;
  const cs = getComputedStyle(el);
  const bands = paddingBands(box, { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) });
  const parent = el.parentElement;
  let contentW = 0;
  let gap: Gap | null = null;
  const near: Box[] = [];
  for (const n of [el.previousElementSibling, el.nextElementSibling]) {
    const nb = n instanceof HTMLElement && n.offsetWidth + n.offsetHeight > 0 ? localBox(n, plane) : null;
    if (nb) near.push(nb);
  }
  if (parent) {
    const pcs = getComputedStyle(parent);
    contentW = parent.clientWidth - px(pcs.paddingLeft) - px(pcs.paddingRight);
    const sib = (el.nextElementSibling ?? el.previousElementSibling) as HTMLElement | null;
    const sbox = sib && sib.offsetWidth + sib.offsetHeight > 0 ? localBox(sib, plane) : null;
    if (sbox) {
      const flex = pcs.display.includes("flex") || pcs.display.includes("grid");
      const row = pcs.display.includes("flex") && !pcs.flexDirection.startsWith("column");
      const declared = flex ? px(row ? pcs.columnGap : pcs.rowGap) : undefined;
      gap = gapBetween(box, sbox, flex && declared !== undefined && declared > 0 ? declared : undefined);
    }
  }
  return { name, box, near, avoid: others.filter((o) => !contains(o, box)), card, bands, gap, guides: alignGuides(box, others), size: sizingLabel(box.w, contentW) };
}

type Tone = "accent" | "danger" | "ink";
interface Slot {
  key: string;
  /** Which side of the part it sits on (badgeSide): a change of side fades, a move on the same side glides. */
  side: string;
  box: Box;
  text: string;
  tone: Tone;
  className?: string;
}
/** Every badge the overlay can show, in a fixed order, so each keeps its element and glides. */
const SLOT_KEYS = ["tag", "size", "gap", "p-top", "p-bottom", "p-left", "p-right"] as const;

/**
 * Badges never cover a part (this one, its neighbours, or any other part) nor each other. The tag sits on the top
 * edge, then size, gap and padding find room: around the part, then outside the card's edge. The gap badge shrinks
 * to its number before it gives up. A badge with no free place is left out; the overlay still draws its band.
 */
export function badgeSlots(m: Measured, bounds?: Box): Slot[] {
  const card = m.card ?? m.box;
  const avoid = [m.box, ...m.near, ...m.avoid];
  const out: Slot[] = [];
  const taken: Box[] = [];
  const put = (key: string, at: Box | null, text: string, tone: Tone, className?: string) => {
    if (!at) return;
    taken.push(at);
    out.push({ key, side: badgeSide(at, m.box, card), box: at, text, tone, className });
  };
  const ts = badgeSize(m.name);
  const tagSize = { w: ts.w + 4, h: ts.h };
  put("tag", firstFree([{ x: m.box.x, y: m.box.y - 5 - tagSize.h, ...tagSize }, ...besideCard(tagSize, card, m.box.y + tagSize.h / 2), ...aroundTries(tagSize, m.box).slice(1)], taken, avoid, bounds), m.name, "ink", "text-[11px]");
  const ss = badgeSize(m.size);
  put("size", firstFree([...aroundTries(ss, m.box), ...besideCard(ss, card, m.box.y + m.box.h / 2)], taken, avoid, bounds), m.size, "accent");
  if (m.gap) {
    const g = m.gap;
    const cy = g.box.y + g.box.h / 2;
    const tone: Tone = g.px === 0 ? "danger" : "accent";
    const bandBoxes = m.bands.map((b) => b.box);
    const full = `Gap ${g.px}`;
    const fs = badgeSize(full);
    const at = firstFree([...besideCard(fs, card, cy), ...aroundTries(fs, g.box)], [...taken, ...bandBoxes], avoid, bounds);
    if (at) put("gap", at, full, tone);
    else {
      const short = String(g.px);
      const ns = badgeSize(short);
      put("gap", firstFree([...besideCard(ns, card, cy), ...aroundTries(ns, g.box)], [...taken, ...bandBoxes], avoid, bounds), short, tone);
    }
  }
  const others = avoid.filter((a) => a !== m.box);
  for (const b of m.bands) put(`p-${b.side}`, placeBandBadge(bandBadgeSize(String(b.px)), b, m.box, taken, 3, bounds, others), String(b.px), "accent", "overflow-hidden px-0 text-center text-[10px] leading-[13px]");
  return out;
}

/** Padding as hatched bands, the gap to the next sibling (red when 0) and the alignment guides of one part. */
function DetailLayers({ m }: { m: Measured }) {
  return (
    <>
      {m.bands.map((b) => (
        <div
          key={b.side}
          style={{ left: b.box.x, top: b.box.y, width: b.box.w, height: b.box.h }}
          className="absolute bg-[repeating-linear-gradient(135deg,color-mix(in_srgb,var(--knin-m)_45%,transparent)_0_1px,transparent_1px_5px)] bg-[color-mix(in_srgb,var(--knin-m)_10%,transparent)]"
        />
      ))}
      {m.gap && (
        <div
          style={{ left: m.gap.box.x, top: m.gap.box.y, width: Math.max(m.gap.box.w, 1), height: Math.max(m.gap.box.h, 1) }}
          className={cn("absolute", m.gap.px === 0 ? "bg-[rgb(248_113_113/0.5)]" : "bg-[repeating-linear-gradient(45deg,rgb(244_114_182/0.5)_0_1px,transparent_1px_4px)]")}
        />
      )}
      {m.guides.map((g, i) => (
        <div key={i} style={{ left: g.at - 0.5, top: g.from, height: g.to - g.from }} className="absolute w-0 border-l border-dashed border-[rgb(244_114_182/0.9)]" />
      ))}
    </>
  );
}

function Badge({ children, slot, tone = "accent", hidden, swap, leaving, style, className }: { children: ReactNode; slot: string; tone?: Tone; hidden?: boolean; swap?: boolean; leaving?: boolean; style?: CSSProperties; className?: string }) {
  return (
    <span
      data-inspect-badge={slot}
      data-hidden={hidden || leaving || undefined}
      data-inspect-swap={swap || undefined}
      data-inspect-leaving={leaving || undefined}
      style={style}
      className={cn(
        "absolute top-0 left-0 z-10 rounded-[4px] px-1 py-px text-[10.5px] leading-[14px] font-medium whitespace-nowrap tabular-nums",
        hidden && "opacity-0",
        tone === "accent" && "bg-[color-mix(in_srgb,var(--knin-m)_26%,#0b0b12)] text-[color-mix(in_srgb,var(--knin-m)_30%,white)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--knin-m)_45%,transparent)]",
        tone === "danger" && "bg-[#3b0d12] text-[#fecaca] shadow-[0_0_0_1px_rgb(248_113_113/0.6)]",
        tone === "ink" && "bg-[var(--knin-m)] text-white",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function InspectMeasure({ parts = [], children, label, hold = 0, autoplay = true, tilt = true, swapKey, controls, link, mirror, delay = 0, still, stack = true, before, after, narrowBelow = NARROW, className }: InspectMeasureProps) {
  const root = useRef<HTMLElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [els, setEls] = useState<{ el: Element; name: string }[]>([]);
  const [active, setActive] = useState(hold);
  const [m, setM] = useState<Measured | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [moved, setMoved] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const [touched, setTouched] = useState(false);
  const [glide, setGlide] = useState(600);
  // Until the first measurement has painted, nothing glides: the camera and frame start where they belong, not from the top.
  const [settled, setSettled] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [planeH, setPlaneH] = useState(0);
  /** The stage's visible area in the plane's coordinates, when flat (narrow): badges stay inside it. */
  const [bounds, setBounds] = useState<Box | undefined>(undefined);

  // Find the parts: the listed ones, then anything marked data-inspect inside the component.
  const collect = useCallback(() => {
    const r = root.current;
    if (!r) return;
    const listed = parts.map((p) => ({ el: find(r, p.target), name: p.name })).filter((x): x is { el: Element; name: string } => x.el !== null);
    const marked = [...r.querySelectorAll("[data-inspect-body] [data-inspect]")].filter((el) => !listed.some((l) => l.el === el)).map((el) => ({ el, name: el.getAttribute("data-inspect") || "Layer" }));
    const next = [...listed, ...marked];
    setEls((prev) => (prev.length === next.length && prev.every((p, i) => p.el === next[i]!.el && p.name === next[i]!.name) ? prev : next));
  }, [parts]);
  useLayoutEffect(() => {
    collect();
  });
  // A new state can drop parts: start again from the held one, in the same render, so nothing is measured on a stale part.
  const [seen, setSeen] = useState({ swapKey, hold });
  if (seen.swapKey !== swapKey || seen.hold !== hold) {
    if (seen.swapKey !== swapKey) {
      setMoved(true);
      setSwapped(true);
    }
    setSeen({ swapKey, hold });
    setActive(hold);
  }

  const measure = useCallback(() => {
    const r = root.current;
    const p = plane.current;
    if (!r || !p) return;
    const g = stageGeometry(r, p, narrowBelow);
    setNarrow(g.narrow);
    setPlaneH(g.planeH);
    setBounds((b) => (JSON.stringify(b) === JSON.stringify(g.bounds) ? b : g.bounds));
    const cur = els[Math.min(active, els.length - 1)];
    if (!cur) return setM(null);
    const others = els.filter((x) => x !== cur).map((x) => localBox(x.el, p)).filter((b): b is Box => b !== null);
    const one = measureOne(cur.el, cur.name, p, others, cardBox(p));
    const next = one && { ...one, swap: swapKey };
    setM((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [els, active, narrowBelow, swapKey]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    if (!m || settled) return;
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, [m, settled]);
  useEffect(() => {
    const r = root.current;
    if (!r || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(r);
    if (plane.current) ro.observe(plane.current);
    return () => ro.disconnect();
  }, [measure]);

  // The tour: the cursor moves on to the next part while on screen, until the visitor takes over.
  const { inView, started } = useStageView(root, delay);
  const touring = autoplay && !still && !reduced && !touched && inView && started && els.length > 1;
  useEffect(() => {
    if (!touring) return;
    const t = setTimeout(() => go((active + 1) % els.length, false), TOUR_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touring, active, els.length]);

  const go = (i: number, byVisitor: boolean) => {
    if (i < 0 || i >= els.length || i === active) return;
    const p = plane.current;
    // The visitor's own move answers at once (280ms); the tour travels at the cursor's pace, by distance.
    if (byVisitor) setGlide(MOTION.slow);
    else if (p && m) {
      const nb = localBox(els[i]!.el, p);
      if (nb) setGlide(glideMs(restPoint(m.box), restPoint(nb)));
    }
    setMoved(true);
    setActive(i);
    if (byVisitor) setAnnounce(els[i]!.name);
  };

  const pick = (clientX: number, clientY: number) => {
    const p = plane.current;
    if (!p) return;
    // Points inside the tilted plane: find the part whose on-screen box holds the pointer.
    const i = partAt(
      els.map((x) => {
        const r = x.el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      }),
      clientX,
      clientY,
    );
    if (i >= 0) go(i, true);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!els.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setTouched(true);
      go((active + 1) % els.length, true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setTouched(true);
      go((active - 1 + els.length) % els.length, true);
    }
  };

  const tilted = tilt && !narrow;
  const focus = m ? restPoint(m.box) : { x: 0, y: 0 };
  const showCursor = !touched && !narrow && !reduced && !still && m !== null;
  const summary = m ? `${m.name}: ${Math.round(m.box.w)} by ${Math.round(m.box.h)} pixels, ${m.size}${m.bands.length ? `, padding ${m.bands.map((b) => `${b.side} ${b.px}`).join(", ")}` : ""}${m.gap ? `, gap ${m.gap.px}` : ""}` : "";

  const slots = m ? badgeSlots(m, bounds) : [];
  // Where each badge was last seen in this state: a badge with nothing to say fades out there instead of vanishing.
  const lastSlots = useRef<{ swap?: string; map: Map<string, Slot> }>({ map: new Map() });
  useLayoutEffect(() => {
    if (!m) return;
    if (lastSlots.current.swap !== m.swap) lastSlots.current = { swap: m.swap, map: new Map() };
    for (const sl of slots) lastSlots.current.map.set(sl.key, sl);
  });
  // A badge that changes side fades out where it was and back in at its new place (after the fade out), so it never
  // glides across the card's text. One fading copy per badge at most.
  const sides = useRef<{ swap?: string; at: Map<string, string>; ghosts: Map<string, { slot: Slot; until: number }> }>({ at: new Map(), ghosts: new Map() });
  const [, setTick] = useState(0);
  if (m && sides.current.swap !== m.swap) sides.current = { swap: m.swap, at: new Map(), ghosts: new Map() };
  if (m && !reduced && lastSlots.current.swap === m.swap) {
    for (const cur of slots) {
      const prev = lastSlots.current.map.get(cur.key);
      if (!prev || prev.side === cur.side || sides.current.at.get(cur.key) === cur.side) continue;
      sides.current.at.set(cur.key, cur.side);
      sides.current.ghosts.set(cur.key, { slot: prev, until: Date.now() + MOTION.fast + 20 });
    }
  }
  useEffect(() => {
    const g = sides.current.ghosts;
    if (!g.size) return;
    const t = setTimeout(() => {
      const now = Date.now();
      for (const [k, v] of g) if (v.until <= now) g.delete(k);
      setTick((n) => n + 1);
    }, MOTION.fast + 30);
    return () => clearTimeout(t);
  });
  const now = Date.now();
  const ghosts = [...sides.current.ghosts].filter(([, v]) => v.until > now);

  const detailKey = m ? `${m.swap ?? ""}:${active}` : "";
  const detailLeaving = useLeaving(detailKey, m, reduced);
  const swapLeaving = useLeaving(m?.swap ?? "", m ? { m, slots } : null, reduced);

  const badge = (sl: Slot, shown = true, mode?: "swap" | "leaving") => (
    <Badge
      key={mode === "leaving" ? `ghost:${sl.key}` : `${sl.key}:${sl.side}`}
      slot={sl.key}
      tone={sl.tone}
      hidden={!shown}
      swap={mode === "swap"}
      leaving={mode === "leaving"}
      // A padding badge keeps the size it was placed with, so it never spills out of its band onto the part.
      style={sl.key.startsWith("p-") ? { translate: `${sl.box.x}px ${sl.box.y}px`, width: sl.box.w, height: sl.box.h } : { translate: `${Math.round(sl.box.x)}px ${Math.round(sl.box.y)}px` }}
      className={sl.className}
    >
      <SwapText value={sl.text}>{sl.text}</SwapText>
    </Badge>
  );
  // One overlay per state: the frame (a selection with handles and the guide on its left edge) rides the --knin-* lengths.
  const overlay = (mm: Measured, o: { key: string; leaving?: boolean; enter?: boolean; layers: ReactNode; badges: ReactNode }) => (
    <div
      key={o.key}
      data-inspect-overlay=""
      data-inspect-leaving={o.leaving || undefined}
      data-inspect-enter={o.enter || undefined}
      aria-hidden="true"
      style={{ ["--knin-x" as string]: `${mm.box.x}px`, ["--knin-y" as string]: `${mm.box.y}px`, ["--knin-w" as string]: `${mm.box.w}px`, ["--knin-h" as string]: `${mm.box.h}px` }}
      className="pointer-events-none absolute inset-0"
    >
      {o.layers}
      {/* The guide that walks down through the rows, on the selection's left edge. */}
      <div style={{ translate: "calc(var(--knin-x) - 0.5px) 0", height: planeH }} className="absolute top-0 left-0 w-0 border-l border-dashed border-[rgb(248_113_113/0.75)]" />
      {/* Selection with corner handles. */}
      <div style={{ translate: "var(--knin-x) var(--knin-y)", width: "var(--knin-w)", height: "var(--knin-h)" }} className="absolute top-0 left-0 shadow-[0_0_0_1.5px_var(--knin-m)]">
        {(["-left-[3.5px] -top-[3.5px]", "-right-[3.5px] -top-[3.5px]", "-left-[3.5px] -bottom-[3.5px]", "-right-[3.5px] -bottom-[3.5px]"] as const).map((c) => (
          <span key={c} className={cn("absolute size-[7px] rounded-[1px] bg-white shadow-[0_0_0_1.5px_var(--knin-m)]", c)} />
        ))}
      </div>
      {o.badges}
    </div>
  );
  const liveBadges = m
    ? SLOT_KEYS.map((k) => {
        const cur = slots.find((x) => x.key === k);
        if (cur) return badge(cur, true, sides.current.at.get(k) === cur.side ? "swap" : undefined);
        const last = lastSlots.current.swap === m.swap ? lastSlots.current.map.get(k) : undefined;
        return last ? badge(last, false) : null;
      }).concat(ghosts.map(([, g]) => badge(g.slot, true, "leaving")))
    : null;

  return (
    <StageFrame
      rootRef={root}
      planeRef={plane}
      label={label}
      tilted={tilted}
      narrow={narrow}
      mirror={mirror}
      stack={stack}
      before={before}
      after={after}
      focus={focus}
      glide={settled ? `${glide}ms` : "0ms"}
      masked={m !== null}
      onKeyDown={onKey}
      onPointerEnter={(e) => e.pointerType === "mouse" && setTouched(true)}
      onPointerMove={(e) => e.pointerType === "mouse" && pick(e.clientX, e.clientY)}
      onPointerDown={(e) => {
        setTouched(true);
        pick(e.clientX, e.clientY);
      }}
      controls={controls}
      link={link}
      className={className}
      overlay={
        <>
          <style href="kn-inspect-measure" precedence="default">
            {CSS}
          </style>
          <MotionStyle />
          {swapLeaving && swapLeaving.key !== (m?.swap ?? "") &&
            overlay(swapLeaving.value.m, { key: `ghost:${swapLeaving.key}`, leaving: true, layers: <DetailLayers m={swapLeaving.value.m} />, badges: swapLeaving.value.slots.map((sl) => badge(sl)) })}
          {m &&
            overlay(m, {
              key: `live:${m.swap ?? ""}`,
              enter: swapped,
              // Padding, gap and guides crossfade: the old part's fade out while the new part's fade in.
              layers: (
                <>
                  {detailLeaving && detailLeaving.key !== detailKey && detailLeaving.value.swap === m.swap && (
                    <div key={`out:${detailLeaving.key}`} data-inspect-leaving="" className="absolute inset-0">
                      <DetailLayers m={detailLeaving.value} />
                    </div>
                  )}
                  <div key={`in:${detailKey}`} data-inspect-enter={moved || undefined} className="absolute inset-0">
                    <DetailLayers m={m} />
                  </div>
                </>
              ),
              badges: liveBadges,
            })}

          {showCursor && (
            <span data-inspect-cursor="" aria-hidden="true" style={{ translate: `${Math.round(focus.x)}px ${Math.round(focus.y)}px` }} className="pointer-events-none absolute top-0 left-0 z-20">
              <Cursor />
            </span>
          )}
        </>
      }
      live={
        <>
          <p aria-live="polite" className="sr-only">
            {announce ? summary : ""}
          </p>
          <p className="sr-only">{summary}</p>
        </>
      }
    >
      {children}
    </StageFrame>
  );
}

/** The measurements of one part, as the overlay shows them (for tests, or to show them elsewhere). */
export { measureOne as measurePart, localBox };
export type { Measured, Slot };
