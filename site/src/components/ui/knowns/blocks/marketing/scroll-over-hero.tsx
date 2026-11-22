"use client";
/** @registry name="scroll-over-hero" type="block" title="Scroll-over hero" description="A title stack pinned while the page scrolls, and a product window that peeks under it, then rises and scales to full size as the title fades, lifts and shrinks away. Stacks plainly under reduced motion, on short screens and before JavaScript." */

/**
 * ScrollOverHero: a pinned title (eyebrow, heading, lead, actions) and a product window under it. As the page scrolls the
 * title stack fades, lifts and shrinks to 92% over the first third of the scroll, while the window rises from a peek under
 * the title and grows from 95% to full size by the halfway mark; the rest of the pinned span holds still. The stage is
 * `position: sticky` inside a track that is (1 + scrollLength) viewports tall. One number, the progress through the
 * pinned span, is written to a CSS variable on the track; every transform is `calc()` on that variable, so scrolling
 * costs one style write per frame and no React render. Scroll is read from the section's own window, so it works in an
 * iframe too. `ScaledScreen` is the matching piece for the window: a whole app page laid out at a desktop size and
 * scaled to the window's width.
 *
 * The title's height is measured, and the panel starts peeking just below it, so the buttons are never under the
 * panel. When the title nearly fills the viewport, under reduced motion, and until JavaScript has run, the section
 * is a plain stack: title, then panel. The pinned layout is switched on only in an effect, so the server HTML and
 * the first client render are the same.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/knowns/utils";
import { ActionButton } from "./section-heading";
import type { MarketingAction } from "./marketing-utils";
import { PANEL_END, PANEL_FROM_SCALE, PANEL_TOP, TITLE_END, TITLE_LIFT, TITLE_TO_SCALE, panelFrom, pinProgress, shouldStack } from "./scroll-over-hero-math";

export interface ScrollOverHeroProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons under the lead. The first is primary. */
  actions?: MarketingAction[];
  /** What rises over the title: a screenshot, a video (MediaFrame) or live content. It fills the panel. */
  media: ReactNode;
  /** Breadcrumb in the window bar, e.g. ["Relaybox", "Runs"]. The window always shows its three dots. */
  windowTitle?: string[];
  /** Anything extra under the buttons, e.g. an install command. (Local patch.) */
  extra?: ReactNode;
  /** Extra scroll, in viewport heights, while the stage is pinned. 1 by default; the motion finishes before it ends. */
  scrollLength?: number;
  className?: string;
}

/** Transforms as calc() on --knsh-p, the same ramps as scroll-over-hero-math. Only transform and opacity change. */
const CSS = `
.kn-scrollhero[data-live]{height:calc(100svh*(1 + var(--knsh-len,1)))}
.kn-scrollhero[data-live] .kn-scrollhero-stage{position:sticky;top:0;height:100svh;overflow:hidden}
.kn-scrollhero-glow{pointer-events:none;position:absolute;inset:auto -10% -25% -10%;height:70%;
  background:radial-gradient(60% 60% at 50% 60%,color-mix(in srgb,var(--kn-accent,#6366f1) 20%,transparent),transparent 70%)}
.dark .kn-scrollhero-glow{background:radial-gradient(60% 60% at 50% 60%,color-mix(in srgb,var(--kn-accent,#6366f1) 16%,transparent),transparent 70%)}
.kn-scrollhero[data-live] .kn-scrollhero-title{position:absolute;inset:0 0 auto 0;will-change:transform,opacity;transform-origin:50% 0;
  --t:clamp(0, var(--knsh-p,0) / ${TITLE_END}, 1);opacity:calc(1 - var(--t));
  transform:translateY(calc(${-TITLE_LIFT}px * var(--t))) scale(calc(1 - ${+(1 - TITLE_TO_SCALE).toFixed(3)} * var(--t)))}
.kn-scrollhero[data-live] .kn-scrollhero-panel{position:absolute;inset:${PANEL_TOP}px 0 0 0;will-change:transform;transform-origin:50% 0;
  --t:clamp(0, var(--knsh-p,0) / ${PANEL_END}, 1);
  transform:translateY(calc(var(--knsh-from,0px) * (1 - var(--t)))) scale(calc(${PANEL_FROM_SCALE} + ${+(1 - PANEL_FROM_SCALE).toFixed(3)} * var(--t)))}
.kn-scrollhero[data-live] .kn-scrollhero-media{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 3rem),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 3rem),transparent)}
`;

export function ScrollOverHero({ eyebrow, title, description, actions, extra, media, windowTitle, scrollLength = 1, className }: ScrollOverHeroProps) {
  const track = useRef<HTMLElement>(null);
  const head = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = track.current;
    const titleEl = head.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !titleEl || !win) return;
    const reduce = win.matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;

    const paint = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--knsh-p", pinProgress(r.top, r.height, win.innerHeight).toFixed(4));
    };
    const queue = () => {
      if (!raf) raf = win.requestAnimationFrame(paint);
    };
    // Measures the title and decides between pinned and stacked. Runs on mount and when the size changes, never per scroll.
    const layout = () => {
      el.removeAttribute("data-live");
      const stacked = reduce.matches;
      if (stacked) return;
      const bottom = titleEl.offsetHeight;
      if (shouldStack(win.innerHeight, bottom)) return;
      el.style.setProperty("--knsh-from", `${panelFrom(bottom)}px`);
      el.setAttribute("data-live", "");
      paint();
    };

    layout();
    const ro = new win.ResizeObserver(layout);
    ro.observe(titleEl);
    win.addEventListener("scroll", queue, { passive: true });
    win.addEventListener("resize", layout);
    reduce.addEventListener("change", layout);
    return () => {
      ro.disconnect();
      win.removeEventListener("scroll", queue);
      win.removeEventListener("resize", layout);
      reduce.removeEventListener("change", layout);
      if (raf) win.cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section ref={track} className={cn("kn-scrollhero relative overflow-x-clip", className)} style={{ "--knsh-len": Math.max(0, scrollLength) } as CSSProperties}>
      <style>{CSS}</style>
      <div className="kn-scrollhero-stage">
        <div aria-hidden="true" className="kn-scrollhero-glow" />
        <div ref={head} className="kn-scrollhero-title px-6 pt-20 pb-6 sm:pt-24">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 text-center">
            {eyebrow && <div className="text-[14px] font-semibold text-[color:var(--kn-accent,var(--primary))]">{eyebrow}</div>}
            <h1 className="text-balance text-[36px] leading-[1.1] font-semibold tracking-tight sm:text-[56px]">{title}</h1>
            {description && <p className="max-w-xl text-pretty text-[16px] leading-7 text-muted-foreground">{description}</p>}
            {actions && actions.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
                {actions.map((a, i) => (
                  <ActionButton key={a.label} action={a} variant={i === 0 ? "primary" : "secondary"} />
                ))}
              </div>
            )}
            {extra}
          </div>
        </div>
        <div className="kn-scrollhero-panel mx-auto w-full max-w-6xl px-4 pb-10 sm:px-6">
          <div className="kn-scrollhero-media flex max-h-full flex-col overflow-hidden rounded-2xl border bg-card shadow-[0_40px_90px_-30px_rgb(0_0_0/0.35),0_8px_24px_-12px_rgb(0_0_0/0.2)]">
            <div className="flex h-9 flex-none items-center gap-3 border-b bg-muted/50 px-4">
              <span aria-hidden="true" className="flex gap-1.5">
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
              </span>
              {windowTitle && <span className="truncate text-[12px] text-muted-foreground">{windowTitle.join("  /  ")}</span>}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{media}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A whole app page laid out at a real desktop size (1280 x 800 by default) and scaled down to the width it is given, so it
 * reads like a screenshot of a real app. Below `compactBelow` px of width (a phone) it shows `compact` instead, at 1x and
 * in a tall box: a page made for that width, never the desktop page shrunk until its text is unreadable. The choice is made
 * in an effect, so the server HTML and the first client render are the same; the box keeps its aspect ratio meanwhile. The
 * page is shown, not used: it takes no pointer input.
 */
export function ScaledScreen({ children, width = 1280, height = 800, compact, compactBelow = 640, compactAspect = "9 / 19", className }: { children: ReactNode; width?: number; height?: number; compact?: ReactNode; compactBelow?: number; compactAspect?: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const el = box.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return;
    const fit = () => {
      const w = el.clientWidth;
      if (!w) return;
      setNarrow(!!compact && w < compactBelow);
      if (page.current) page.current.style.transform = `scale(${w / width})`;
    };
    fit();
    const ro = new win.ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, compact, compactBelow]);

  return (
    <div ref={box} className={cn("relative w-full overflow-hidden", className)} style={{ aspectRatio: narrow ? compactAspect : `${width} / ${height}` }}>
      {narrow ? (
        <div className="pointer-events-none absolute inset-0">{compact}</div>
      ) : (
        <div ref={page} className="pointer-events-none absolute top-0 left-0 origin-top-left" style={{ width, height, transform: "scale(.8)" }}>
          {children}
        </div>
      )}
    </div>
  );
}
