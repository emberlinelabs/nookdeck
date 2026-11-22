"use client";
/** @registry name="showcase-stage" type="ui" title="Showcase Stage" description="Any real component on the Inspect stage (dark, a gentle 3D tilt, a camera that follows the part in focus) with your own comments placed beside the card, each with a hairline leader to a part. The camera tours comment to comment; point, tap or use the arrow keys to pick one. For heroes, feature sections, stills and video." */
/**
 * Showcase Stage: the Inspect stage (stage.tsx) with authored comments instead of the measure overlay. Each
 * comment names a part of the real component inside (a selector, a ref, a function of the root, or the name of an
 * element marked data-inspect="Name") and sits outside the card on the side nearer that part, never over a part or
 * another comment. A leader line runs from the comment to the part's edge.
 *
 * `sides` (default "auto") keeps comments on both sides while the card fits at full size, and moves them all to one
 * side (the side most of them prefer) before it would shrink the card. The stage's height follows the content.
 *
 * Motion: the camera glides from comment to comment (canvas travel, 240 to 600ms by distance on the tour, 280ms when
 * the visitor picks one); the active comment is full opacity and the others dimmed (120ms); the active leader draws
 * in (180ms). Nothing plays on mount. Reduced motion: no tour, everything snaps. Under 640px of container the tilt is
 * off and one comment shows at a time, above or below the card, its part marked with an accent outline (no leader, so
 * nothing crosses the card's text).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/knowns/utils";
import { MOTION } from "@/lib/knowns/motion";
import { useReducedMotion } from "../use-in-view";
import { glideMs, partAt, type Box } from "../inspect/measure-utils";
import { NARROW, StageFrame, cardBox, findTarget, localBox, stageGeometry, useStageView, type InspectTarget } from "../inspect/stage";
import { narrowRoom, nearerSide, placeComments, type CommentPlace, type CommentSide } from "./showcase-utils";

export type { InspectTarget } from "../inspect/stage";
export type { CommentSide } from "./showcase-utils";

export interface ShowcaseComment {
  /** The part it points at: a selector inside the component, a ref, `(root) => Element`, or the name of an element marked data-inspect="Name". */
  target: InspectTarget;
  /** The comment. Short: one idea, two lines at most reads best. */
  text: string;
  /** Beside the card on this side. Default: the side nearer the part. */
  side?: "left" | "right";
}

export interface ShowcaseStageProps {
  /** The real component. */
  children: ReactNode;
  comments: readonly ShowcaseComment[];
  /** The comment in focus, controlled. */
  active?: number;
  /** The comment in focus first. Default 0. */
  defaultActive?: number;
  onActiveChange?: (index: number) => void;
  /** The camera tours the comments while the stage is on screen, until the visitor points, taps or uses the keys. Default true; off under reduced motion. */
  autoplay?: boolean;
  /** A still frame: the active comment in focus, no tour. */
  still?: boolean;
  /** The 3D tilt. Default true; always off under `narrowBelow`. */
  tilt?: boolean;
  /** Which sides of the card hold comments. "auto" (default): both while the card fits at full size, else one side. */
  sides?: "auto" | "both" | "left" | "right";
  /** Tilt the other way. */
  mirror?: boolean;
  /** Wait this long (ms) after first view before the tour starts. */
  delay?: number;
  /** The items before and after this one, shown faded around it (inert, hidden from screen readers). */
  before?: ReactNode;
  after?: ReactNode;
  /** Under this container width: no tilt, no neighbours, one comment at a time. Default 640. */
  narrowBelow?: number;
  /** Names the figure for screen readers. */
  label?: string;
  /** Under the stage, on the left. */
  controls?: ReactNode;
  /** A link under the stage. */
  link?: { href: string; label: ReactNode };
  className?: string;
}

/** How long the camera rests on a comment during the tour (ms): long enough to read two lines. */
export const SHOWCASE_TOUR_MS = 2800;
/** A comment's width beside the card (px). */
export const COMMENT_W = 176;
/** Between the card and a comment (px). The tilted plane keeps 13rem (208px) each side: a comment, its gap and 4px. */
const GAP = 28;
const SIDE_ROOM = 208;
/** The plane's padding on the side without comments (pl-6 / pr-6). */
const ONE_SIDE_PAD = 24;
/** How much of each neighbour peeks in above and below the card (px). */
const PEEK = 64;

/** The side most comments would take (asked, or nearer their part); right on a tie. */
function majoritySide(comments: readonly ShowcaseComment[], parts: readonly (Box | null)[], card: Box): "left" | "right" {
  let left = 0;
  let right = 0;
  comments.forEach((c, i) => {
    const part = parts[i];
    const side = c.side ?? (part ? nearerSide(part, card) : "right");
    if (side === "left") left++;
    else right++;
  });
  return left > right ? "left" : "right";
}

const EASE_OUT = "var(--kn-ease-out, cubic-bezier(0.22, 1, 0.36, 1))";
const CSS = `
@keyframes knss-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
[data-showcase-comment], [data-showcase-leader], [data-showcase-mark] { transition: opacity var(--kn-dur-fast, 120ms) ${EASE_OUT} }
[data-showcase-leader][data-draw] path { animation: knss-draw var(--kn-dur, 180ms) ${EASE_OUT} both }
@media (prefers-reduced-motion: reduce) {
  [data-showcase-comment], [data-showcase-leader], [data-showcase-mark] { transition: none !important }
  [data-showcase-leader] path { animation: none !important }
}
`;

/** The element a comment names: a data-inspect name first, then a selector, ref or function. */
function resolve(root: HTMLElement, t: InspectTarget): Element | null {
  if (typeof t === "string") {
    const named = [...root.querySelectorAll("[data-inspect-body] [data-inspect]")].find((el) => el.getAttribute("data-inspect") === t);
    if (named) return named;
  }
  return findTarget(root, t);
}

interface Geo {
  narrow: boolean;
  card: Box | null;
  parts: (Box | null)[];
  sizes: { w: number; h: number }[];
  planeW: number;
  planeH: number;
  /** The tilted plane's zoom, so the card and its comments fit the stage. */
  fit: number;
  /** All comments on one side, or null for both. */
  one: "left" | "right" | null;
}

export function ShowcaseStage({ children, comments, active: activeProp, defaultActive = 0, onActiveChange, autoplay = true, still, tilt = true, sides = "auto", mirror, delay = 0, before, after, narrowBelow = NARROW, label, controls, link, className }: ShowcaseStageProps) {
  const root = useRef<HTMLElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const boxes = useRef<(HTMLDivElement | null)[]>([]);
  const reduced = useReducedMotion();
  const [own, setOwn] = useState(defaultActive);
  const active = Math.min(Math.max(activeProp ?? own, 0), Math.max(0, comments.length - 1));
  const [geo, setGeo] = useState<Geo>({ narrow: false, card: null, parts: [], sizes: [], planeW: 0, planeH: 0, fit: 1, one: null });
  const [touched, setTouched] = useState(false);
  const [moved, setMoved] = useState(false);
  const [glide, setGlide] = useState(600);
  const [settled, setSettled] = useState(false);
  const [announce, setAnnounce] = useState("");

  const measure = useCallback(() => {
    const r = root.current;
    const p = plane.current;
    if (!r || !p) return;
    const g = stageGeometry(r, p, narrowBelow);
    const parts = comments.map((c) => {
      const el = resolve(r, c.target);
      return el ? localBox(el, p) : null;
    });
    const sizes = comments.map((_, i) => {
      const el = boxes.current[i];
      return { w: el?.offsetWidth || COMMENT_W, h: el?.offsetHeight || 44 };
    });
    // The plane keeps its width (the card plus room for comments); zoom it so the tilted plane fits the stage. Both
    // sides while the card still fits at full size, otherwise one side before the card shrinks.
    const card = cardBox(p);
    const inner = r.clientWidth - 80;
    const zoom = (w: number) => Math.round(Math.min(1.12, Math.max(0.6, (inner / w) * 0.98)) * 100) / 100;
    let one: Geo["one"] = sides === "left" || sides === "right" ? sides : null;
    if (sides === "auto" && card && !g.narrow && zoom(card.w + 2 * SIDE_ROOM) < 1) one = majoritySide(comments, parts, card);
    const fit = g.narrow || !card ? 1 : zoom(card.w + (one ? SIDE_ROOM + ONE_SIDE_PAD : 2 * SIDE_ROOM));
    const next: Geo = { narrow: g.narrow, card, parts, sizes, planeW: p.offsetWidth, planeH: g.planeH, fit, one };
    setGeo((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [comments, narrowBelow, sides]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const r = root.current;
    if (!r || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(r);
    if (plane.current) ro.observe(plane.current);
    return () => ro.disconnect();
  }, [measure]);

  const places: (CommentPlace | null)[] = geo.card
    ? placeComments({ card: geo.card, parts: geo.parts, sizes: geo.sizes, sides: comments.map((c) => (geo.one ?? c.side) as CommentSide | undefined), narrow: geo.narrow, gap: GAP, bounds: geo.narrow ? undefined : { x: 0, y: 0, w: geo.planeW, h: geo.planeH } })
    : [];
  const ready = places.some(Boolean);
  useEffect(() => {
    if (!ready || settled) return;
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, [ready, settled]);

  const { inView, started } = useStageView(root, delay);
  const touring = autoplay && !still && !reduced && !touched && inView && started && comments.length > 1;
  const focusOf = (i: number) => {
    const part = geo.parts[i];
    return part ? { x: part.x + part.w / 2, y: part.y + part.h / 2 } : null;
  };

  const go = (i: number, byVisitor: boolean) => {
    if (i < 0 || i >= comments.length || i === active) return;
    const from = focusOf(active);
    const to = focusOf(i);
    // The visitor's own pick answers at once (280ms); the tour travels by distance.
    if (byVisitor) setGlide(MOTION.slow);
    else if (from && to) setGlide(glideMs(from, to));
    setMoved(true);
    if (activeProp === undefined) setOwn(i);
    onActiveChange?.(i);
    if (byVisitor) setAnnounce(`${i + 1} of ${comments.length}: ${comments[i]!.text}`);
  };
  useEffect(() => {
    if (!touring) return;
    const t = setTimeout(() => go((active + 1) % comments.length, false), SHOWCASE_TOUR_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touring, active, comments.length]);
  // A controlled change from outside glides too.
  const [seen, setSeen] = useState(active);
  if (seen !== active) {
    setSeen(active);
    setMoved(true);
  }

  const pick = (x: number, y: number) => {
    const r = root.current;
    if (!r) return;
    // A comment under the pointer first, then a part.
    const onComment = boxes.current.findIndex((el) => {
      if (!el) return false;
      const b = el.getBoundingClientRect();
      return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    });
    if (onComment >= 0 && places[onComment]) return go(onComment, true);
    const i = partAt(
      comments.map((c) => {
        const el = resolve(r, c.target);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
      }),
      x,
      y,
    );
    if (i >= 0) go(i, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!comments.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setTouched(true);
      go((active + 1) % comments.length, true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setTouched(true);
      go((active - 1 + comments.length) % comments.length, true);
    }
  };

  const tilted = tilt && !geo.narrow;
  const focus = focusOf(active) ?? { x: 0, y: 0 };
  const room = geo.narrow ? narrowRoom(places, GAP) : { top: 0, bottom: 0 };
  // The stage is as tall as what it shows: the card and its comments, a peek of the neighbours, at least 22rem.
  let stageH: number | undefined;
  if (geo.card && !geo.narrow) {
    const tops = [geo.card.y, ...places.flatMap((p) => (p ? [p.box.y] : []))];
    const bottoms = [geo.card.y + geo.card.h, ...places.flatMap((p) => (p ? [p.box.y + p.box.h] : []))];
    stageH = Math.max(352, Math.ceil((Math.max(...bottoms) - Math.min(...tops) + 2 * PEEK) * geo.fit + 48));
  }

  return (
    <StageFrame
      rootRef={root}
      planeRef={plane}
      label={label}
      tilted={tilted}
      narrow={geo.narrow}
      mirror={mirror}
      before={before}
      after={after}
      focus={focus}
      glide={settled ? `${glide}ms` : "0ms"}
      masked={ready}
      scale={geo.fit}
      height={stageH}
      // Room for comments beside the card, and above and below it so one nudged past the card's edge is not clipped by the mask.
      room={geo.one === "right" ? "pl-6 pr-[13rem] py-16" : geo.one === "left" ? "pl-[13rem] pr-6 py-16" : "px-[13rem] py-16"}
      bleed
      planeStyle={geo.narrow ? { paddingTop: room.top, paddingBottom: room.bottom } : undefined}
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
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <style href="kn-showcase-stage" precedence="default">
            {CSS}
          </style>
          <svg className="absolute inset-0 size-full overflow-visible" fill="none">
            {places.map((pl, i) =>
              pl && !geo.narrow ? (
                <g key={`${i}:${i === active && moved ? "draw" : "rest"}`} data-showcase-leader="" data-draw={i === active && moved ? "" : undefined} className={i === active ? "opacity-100" : "opacity-35"}>
                  <path d={pl.leader} pathLength={1} strokeDasharray={1} stroke="color-mix(in srgb, var(--knin-m) 55%, white)" strokeWidth={1} strokeLinejoin="round" />
                  <circle cx={pl.end.x} cy={pl.end.y} r={2.5} fill="color-mix(in srgb, var(--knin-m) 55%, white)" />
                </g>
              ) : null,
            )}
          </svg>
          {/* Narrow: no leader (it would cross the card's text); the part in focus gets an accent outline instead. */}
          {geo.narrow &&
            geo.parts.map((part, i) =>
              part ? (
                <div
                  key={`m${i}`}
                  data-showcase-mark=""
                  style={{ translate: `${part.x - 3}px ${part.y - 3}px`, width: part.w + 6, height: part.h + 6 }}
                  className={cn("absolute top-0 left-0 rounded-[7px] shadow-[0_0_0_1.5px_var(--knin-m)]", i === active ? "opacity-100" : "opacity-0")}
                />
              ) : null,
            )}
          {comments.map((c, i) => {
            const pl = places[i];
            const on = i === active;
            return (
              <div
                key={i}
                ref={(el) => {
                  boxes.current[i] = el;
                }}
                data-showcase-comment=""
                data-active={on || undefined}
                style={{ translate: pl ? `${Math.round(pl.box.x)}px ${Math.round(pl.box.y)}px` : "-9999px 0", width: geo.narrow && pl ? pl.box.w : COMMENT_W }}
                className={cn(
                  "absolute top-0 left-0 flex gap-2 rounded-xl bg-[#17171f] px-3 py-2 text-[12.5px] leading-[18px] font-medium text-white/90 shadow-[0_0_0_1px_rgb(255_255_255/0.1),0_8px_24px_rgb(0_0_0/0.35)]",
                  on && "shadow-[0_0_0_1px_color-mix(in_srgb,var(--knin-m)_55%,transparent),0_8px_24px_rgb(0_0_0/0.35)]",
                  !pl ? "opacity-0" : geo.narrow ? (on ? "opacity-100" : "opacity-0") : on ? "opacity-100" : "opacity-45",
                )}
              >
                <span className="mt-[6px] size-1.5 shrink-0 rounded-full bg-[color-mix(in_srgb,var(--knin-m)_70%,white)]" />
                <span className="min-w-0">{c.text}</span>
              </div>
            );
          })}
        </div>
      }
      live={
        <>
          <ol className="sr-only">
            {comments.map((c, i) => (
              <li key={i}>{c.text}</li>
            ))}
          </ol>
          <p aria-live="polite" className="sr-only">
            {announce}
          </p>
        </>
      }
    >
      {children}
    </StageFrame>
  );
}
