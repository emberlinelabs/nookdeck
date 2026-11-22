"use client";
/**
 * The 3D stage shared by the Inspect and Showcase Stage illustrations: a real component on a dark stage in a
 * gentle tilt, its neighbours faded around it, and a camera (a fade mask) that follows the point in focus.
 * Everything that sits on top (Inspect's measure overlay, Showcase Stage's comments) is passed in as `overlay`
 * and drawn in the plane's own coordinates, so it tilts with the component.
 *
 * Motion: the camera and the cursor glide by `--knin-glide` (canvas travel, at most 600ms, ease in and out).
 * Reduced motion: no glide. Under `narrowBelow` of container the tilt and the neighbours are off.
 */
import { useEffect, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { cn, focusRing } from "@/lib/knowns/utils";
import { MOTION_GATE } from "../use-in-view";
import type { Box } from "./measure-utils";

/** What to point at, inside the stage: a CSS selector, a ref, or a function of the stage's root. */
export type InspectTarget = string | RefObject<Element | null> | ((root: HTMLElement) => Element | null);

/** Under this container width there is no tilt and no neighbours. */
export const NARROW = 640;

const EASE_INOUT = "var(--kn-ease-inout, cubic-bezier(0.65, 0, 0.35, 1))";
/* The camera (the focus fade) and the cursor glide together: canvas travel (kn-motion: up to 600ms, ease in and out). */
export const STAGE_CSS = `${MOTION_GATE}
@property --knin-fx { syntax: "<length>"; inherits: false; initial-value: 0px }
@property --knin-fy { syntax: "<length>"; inherits: false; initial-value: 0px }
[data-inspect-plane] { transition: --knin-fx var(--knin-glide, 600ms) ${EASE_INOUT}, --knin-fy var(--knin-glide, 600ms) ${EASE_INOUT} }
[data-inspect-cursor] { transition: translate var(--knin-glide, 600ms) ${EASE_INOUT} }
@media (prefers-reduced-motion: reduce) { [data-inspect-plane], [data-inspect-cursor] { transition: none !important } }
`;

/** The element `t` names inside the stage. A string is a selector inside the component. */
export function findTarget(root: HTMLElement, t: InspectTarget): Element | null {
  try {
    if (typeof t === "string") return root.querySelector(`[data-inspect-body] ${t}`);
    if (typeof t === "function") return t(root);
    return t.current;
  } catch {
    return null;
  }
}

/** The element's box in the plane's own coordinates (offsets ignore the tilt), so an overlay tilts with it. */
export function localBox(el: Element, plane: HTMLElement): Box | null {
  let node: HTMLElement | null = el instanceof HTMLElement ? el : el.parentElement;
  const w = node?.offsetWidth ?? 0;
  const h = node?.offsetHeight ?? 0;
  let x = 0;
  let y = 0;
  while (node && node !== plane) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (!parent || !plane.contains(parent) && parent !== plane) return null;
    node = parent;
  }
  return node === plane ? { x, y, w, h } : null;
}

/** The focal item (the card) inside the plane: the component's own outer element. */
export function cardBox(plane: HTMLElement): Box | null {
  const body = plane.querySelector("[data-inspect-body]");
  const el = body?.firstElementChild ?? body;
  return el ? localBox(el, plane) : null;
}

/**
 * The stage's shape now: narrow or not, the plane's height, and on a narrow (flat) stage its visible area in the
 * plane's coordinates (plane and screen share a scale there, so the stage's box maps straight across).
 */
export function stageGeometry(root: HTMLElement, plane: HTMLElement, narrowBelow: number): { narrow: boolean; planeH: number; bounds: Box | undefined } {
  const rr = root.getBoundingClientRect();
  const narrow = rr.width < narrowBelow;
  const pr = plane.getBoundingClientRect();
  const bounds = narrow && pr.width > 0 ? { x: Math.round(rr.left - pr.left + 4), y: Math.round(rr.top - pr.top + 4), w: Math.round(rr.width - 8), h: Math.round(rr.height - 8) } : undefined;
  return { narrow, planeH: plane.offsetHeight, bounds };
}

/** Whether the stage is on screen (40% of it), and whether `delay` has passed since it was first seen. */
export function useStageView(root: RefObject<HTMLElement | null>, delay = 0): { inView: boolean; started: boolean } {
  const [inView, setInView] = useState(false);
  const [started, setStarted] = useState(delay <= 0);
  useEffect(() => {
    const r = root.current;
    if (!r || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => setInView(e.some((x) => x.isIntersecting)), { threshold: 0.4 });
    io.observe(r);
    return () => io.disconnect();
  }, [root]);
  // `delay` holds the first move back once the stage is first seen, so two stages beside each other take turns.
  useEffect(() => {
    if (started || !inView) return;
    const t = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(t);
  }, [started, inView, delay]);
  return { inView, started };
}

export function Cursor() {
  return (
    <svg viewBox="0 0 20 20" className="size-5 drop-shadow-[0_2px_3px_rgb(0_0_0/0.5)]" aria-hidden="true">
      <path d="M3 2.5v13.2l3.6-3.4 2.3 5.2 2.3-1-2.3-5.1 5-.3Z" fill="white" stroke="#0b0b12" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export interface StageFrameProps {
  rootRef: RefObject<HTMLElement | null>;
  planeRef: RefObject<HTMLDivElement | null>;
  /** Names the figure for screen readers. */
  label?: string;
  /** The tilt is on (the caller turns it off under narrowBelow). */
  tilted: boolean;
  narrow: boolean;
  mirror?: boolean;
  stack?: boolean;
  before?: ReactNode;
  after?: ReactNode;
  /** The real component. */
  children: ReactNode;
  /** Drawn inside the plane after the component, in plane coordinates. */
  overlay?: ReactNode;
  /** The point in focus, in plane coordinates: the camera follows it. */
  focus: { x: number; y: number };
  /** The glide for the camera and cursor, as a CSS time. */
  glide: string;
  /** Fade everything away from the focus (only once there is something in focus). */
  masked: boolean;
  /** The plane's zoom when tilted. Default 1.32. */
  scale?: number;
  /** Side room inside the tilted plane (a class): the mask clips to the plane's box. Default "px-24". */
  room?: string;
  /** When tilted, the stage's height in px (it follows the content); default 30rem. */
  height?: number;
  /** When tilted, the plane keeps its own width even past the stage's (scale it down to fit); off: it shrinks to fit. */
  bleed?: boolean;
  /** Extra style on the plane, such as room reserved above the card on a narrow stage. */
  planeStyle?: CSSProperties;
  onKeyDown?: (e: KeyboardEvent) => void;
  onPointerEnter?: (e: PointerEvent) => void;
  onPointerMove?: (e: PointerEvent) => void;
  onPointerDown?: (e: PointerEvent) => void;
  /** Screen reader text inside the figure, after the stage. */
  live?: ReactNode;
  controls?: ReactNode;
  link?: { href: string; label: ReactNode };
  className?: string;
}

/** The stage itself: figure, backdrop, perspective, the tilted plane with the camera mask, the focal item and its neighbours. */
export function StageFrame({ rootRef, planeRef, label, tilted, narrow, mirror, stack = true, before, after, children, overlay, focus, glide, masked, scale = 1.32, room = "px-24", bleed, height, planeStyle, onKeyDown, onPointerEnter, onPointerMove, onPointerDown, live, controls, link, className }: StageFrameProps) {
  // Whole neighbouring items, the way a list shows them; inert and hidden, the fade mask is their only clip.
  const neighbour = (node: ReactNode) =>
    stack && !narrow && node ? (
      <div aria-hidden="true" inert className="pointer-events-none select-none opacity-55">
        {node}
      </div>
    ) : null;
  const tilt = mirror ? `rotateX(20deg) rotateY(8deg) rotateZ(3.5deg) scale(${scale})` : `rotateX(20deg) rotateY(-8deg) rotateZ(-3.5deg) scale(${scale})`;
  return (
    <div className={cn("w-full", className)}>
      <figure
        ref={rootRef as RefObject<HTMLElement>}
        aria-label={label}
        data-kn-ill=""
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerEnter={onPointerEnter}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        style={{ ["--knin-m" as string]: "var(--kn-accent, #a78bfa)", ...(tilted && height ? { height } : null) }}
        className={cn(
          "@container relative isolate m-0 flex w-full items-center justify-center overflow-hidden rounded-3xl bg-[#0c0c11] px-4 shadow-[0_0_0_1px_rgb(255_255_255/0.06)]",
          tilted ? (height ? "sm:px-10" : "h-[30rem] sm:px-10") : "py-10",
          focusRing,
        )}
      >
        <style href="kn-inspect-stage" precedence="default">
          {STAGE_CSS}
        </style>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
          {/* A lighter centre lifts the component off the dark stage; the dots fade out toward the edges. */}
          <div className="absolute inset-0 bg-[radial-gradient(55%_60%_at_50%_50%,rgb(255_255_255/0.07),transparent_75%)]" />
          <div className="absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.07)_1px,transparent_1.4px)] bg-[size:18px_18px] [mask-image:radial-gradient(75%_75%_at_50%_50%,black,transparent)]" />
          <div className="absolute inset-0 bg-[radial-gradient(38%_45%_at_50%_50%,color-mix(in_srgb,var(--knin-m)_20%,transparent),transparent_75%)]" />
        </div>
        <div className="flex w-full min-w-0 justify-center [perspective:1400px]">
          <div
            ref={planeRef}
            data-inspect-plane=""
            style={{
              ...planeStyle,
              ["--knin-glide" as string]: glide,
              ["--knin-fx" as string]: `${Math.round(focus.x)}px`,
              ["--knin-fy" as string]: `${Math.round(focus.y)}px`,
              transform: tilted ? tilt : undefined,
            }}
            className={cn(
              // Side room inside the plane: the mask clips to the plane's box, and anything beside the card needs space.
              "relative flex min-w-0 flex-col gap-4 transform-3d",
              tilted && bleed ? "max-w-none shrink-0" : "max-w-full",
              tilted && room,
              // Everything away from the point in focus fades out, following the camera; this is also the neighbours' only clip.
              tilted && masked && "[mask-image:linear-gradient(to_bottom,transparent_calc(var(--knin-fy)-240px),black_calc(var(--knin-fy)-80px),black_calc(var(--knin-fy)+80px),transparent_calc(var(--knin-fy)+240px))]",
            )}
          >
            {neighbour(before)}
            <div
              data-inspect-body=""
              // The focal item: a hairline and a soft accent glow, so it lifts off the stage in either theme.
              className="relative [filter:drop-shadow(0_0_1px_rgb(255_255_255/0.35))_drop-shadow(0_18px_40px_color-mix(in_srgb,var(--knin-m)_22%,transparent))]"
            >
              {children}
            </div>
            {neighbour(after)}
            {overlay}
          </div>
        </div>
        {live}
      </figure>
      {(controls || link) && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">{controls}</div>
          {link && (
            <a href={link.href} className={cn("inline-flex items-center rounded-[5px] text-[13px] font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground", focusRing)}>
              {link.label}
              <span aria-hidden="true">{" ↗"}</span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
