"use client";
/** @registry name="prompt-keyboard" type="ui" title="Prompt keyboard" description="A chat prompt that types itself above a tilted glass keyboard: each key press lights its key and sends a soft wave across a Gradient Floor under the keyboard, then the prompt is sent and the next one starts. QWERTY, QWERTZ, AZERTY or your own rows, any prompts, theme accent. Pauses offscreen, still under reduced motion." */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/knowns/utils";
import { GradientFloor, type GradientFloorHandle } from "../blocks/backgrounds/gradient-floor";
import { MOTION_GATE, useLive } from "./use-in-view";

export type KeyboardLayout = "qwerty" | "qwertz" | "azerty";

export interface PromptKeyboardProps {
  /** Prompts to type, one after the other (and round again). Keep them under about 76 characters: the card shows two lines. */
  prompts?: string[];
  /** US QWERTY by default; "qwertz", "azerty", or your own letter rows, e.g. ["qwfpg", "arstd", "zxcvb"]. */
  layout?: KeyboardLayout | string[];
  /** Typing speed multiplier. Default 1 (about 12 characters a second). */
  speed?: number;
  /** Accent for the lit key, the send button and the floor: a theme token, a CSS variable or any CSS colour. Default indigo. */
  color?: string;
  /** Draw the Gradient Floor under the keyboard and send it a wave per key. Default true. */
  floor?: boolean;
  /** Called on every key press with the key and its centre as a fraction of the width, e.g. to pulse your own Gradient Floor. */
  onKey?: (key: string, x: number) => void;
  /** Type the first prompt once and stop (no send, no next prompt). Default false. */
  once?: boolean;
  paused?: boolean;
  /** Accessible description. Default names the current prompts. */
  label?: string;
  className?: string;
}

const DEFAULT_PROMPTS = ["Plan the migration and split it across three agents", "Summarize yesterday's failed runs and open an issue", "Draft a changelog from the PRs merged this week"];

const ROWS: Record<KeyboardLayout, string[]> = {
  qwerty: ["qwertyuiop", "asdfghjkl", "zxcvbnm,."],
  qwertz: ["qwertzuiop", "asdfghjkl", "yxcvbnm,."],
  azerty: ["azertyuiop", "qsdfghjklm", "wxcvbn,;."],
};

/** Key size and gap, in container-width units (1 = 1% of the card width). */
const KEY = 7.3;
const GAP = 1;
/** The space bar, in keys. */
const SPACE_KEYS = 5;

export interface KeyBox {
  /** The character (lower case); " " is the space bar. */
  key: string;
  row: number;
  /** Left edge and width, in container units. */
  left: number;
  width: number;
  /** Centre as a fraction of the card width (0 to 1): where this key sends its wave. */
  x: number;
}

/** Where every key sits: rows centred on the card, a space bar under them. Pure, so layouts are testable. */
export function keyboardGeometry(layout: KeyboardLayout | string[] = "qwerty"): KeyBox[] {
  const rows = (Array.isArray(layout) ? layout : (ROWS[layout] ?? ROWS.qwerty)).map((r) => [...r.toLowerCase()]);
  const out: KeyBox[] = [];
  rows.forEach((chars, row) => {
    const w = chars.length * KEY + (chars.length - 1) * GAP;
    const left0 = (100 - w) / 2;
    chars.forEach((key, i) => {
      const left = left0 + i * (KEY + GAP);
      out.push({ key, row, left, width: KEY, x: (left + KEY / 2) / 100 });
    });
  });
  const sw = SPACE_KEYS * KEY + (SPACE_KEYS - 1) * GAP;
  out.push({ key: " ", row: rows.length, left: (100 - sw) / 2, width: sw, x: 0.5 });
  return out;
}

/** The key a typed character presses: letters and punctuation on the layout, a space on the bar, else nothing. */
export function keyFor(boxes: KeyBox[], ch: string): KeyBox | undefined {
  const c = ch.toLowerCase();
  return boxes.find((b) => b.key === c);
}

/** Milliseconds before the next character: a steady beat, longer after spaces and punctuation, with a fixed wobble (no randomness). */
export function typingDelay(prev: string, i: number, speed = 1): number {
  const base = prev === " " ? 120 : /[.,;:!?]/.test(prev) ? 190 : 82;
  const wobble = ((i * 37) % 29) - 10;
  return Math.max(30, (base + wobble) / Math.max(0.25, speed));
}

const TOKENS = new Set(["foreground", "primary", "ring", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5"]);
const accentOf = (c: string | undefined) => {
  const v = (c ?? "var(--kn-accent, #6366f1)").trim();
  return v.startsWith("--") ? `var(${v})` : TOKENS.has(v) ? `var(--${v})` : v;
};

const CSS = `
[data-kn-ill="prompt-keyboard"] { container-type: inline-size; }
@keyframes knpk-caret { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
[data-kn-ill="prompt-keyboard"] .kn-caret { animation: knpk-caret 1.05s steps(1) infinite; }
@media (prefers-reduced-motion: reduce) { [data-kn-ill="prompt-keyboard"] * { transition: none !important; } }
`;

/**
 * A prompt that types itself on a glass keyboard. Sizes are in container units (cqw), so the drawing scales
 * with its box (it is 16:11). One timer step per character, no frame loop: a key press is a state change, a
 * CSS transition and one short wave on the floor. Decorative: one image to assistive tech.
 */
export function PromptKeyboard({ prompts = DEFAULT_PROMPTS, layout = "qwerty", speed = 1, color, floor = true, onKey, once, paused, label, className }: PromptKeyboardProps) {
  const root = useRef<HTMLDivElement>(null);
  const floorRef = useRef<GradientFloorHandle>(null);
  const { live, reduced } = useLive(root, paused);
  const list = prompts.length ? prompts : DEFAULT_PROMPTS;
  const boxes = useMemo(() => keyboardGeometry(layout), [layout]);
  const accent = accentOf(color);

  const [typed, setTyped] = useState("");
  const [lit, setLit] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Where the show is, kept in refs so pausing (offscreen, hidden tab) resumes in place.
  const at = useRef({ prompt: 0, pos: 0 });
  const latest = useRef({ list, boxes, speed, onKey, once });
  latest.current = { list, boxes, speed, onKey, once };
  const litTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!live || reduced) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let dead = false;
    const later = (ms: number, fn: () => void) => {
      t = setTimeout(() => !dead && fn(), ms);
    };

    const press = (ch: string, i: number) => {
      const { boxes: bx, onKey: cb } = latest.current;
      const k = keyFor(bx, ch);
      setLit(k ? k.key : null);
      clearTimeout(litTimer.current);
      litTimer.current = setTimeout(() => setLit(null), 150);
      const x = k ? k.x : 0.5;
      // A wave on every other key: one per key piles up into fog at this typing speed. Spaces always send one.
      if (k?.key === " " || i % 2 === 0) floorRef.current?.pulse(x, 0.4 + ((i * 7) % 4) * 0.1);
      cb?.(k ? k.key : ch, x);
    };

    const step = () => {
      const { list: ps, speed: sp, once: one } = latest.current;
      const text = ps[at.current.prompt % ps.length] ?? "";
      if (at.current.pos < text.length) {
        const ch = text[at.current.pos] ?? "";
        at.current.pos++;
        setTyped(text.slice(0, at.current.pos));
        press(ch, at.current.pos);
        later(typingDelay(ch, at.current.pos, sp), step);
        return;
      }
      if (one) return;
      // Done: hold, send, clear, next prompt.
      later(1500, () => {
        setSending(true);
        later(560, () => {
          setSending(false);
          setTyped("");
          at.current = { prompt: at.current.prompt + 1, pos: 0 };
          later(520, step);
        });
      });
    };

    later(at.current.pos ? 0 : 500, step);
    return () => {
      dead = true;
      clearTimeout(t);
      clearTimeout(litTimer.current);
    };
  }, [live, reduced]);

  // Still frame (reduced motion): the first prompt, fully typed, nothing lit.
  const shown = reduced ? list[0] : typed;
  const c = accent;

  return (
    <div
      ref={root}
      data-kn-ill="prompt-keyboard"
      data-live={live}
      role="img"
      aria-label={label ?? `A prompt typed on a keyboard: ${list.join("; ")}`}
      className={cn("relative isolate aspect-[16/11] w-full overflow-hidden rounded-[2.4cqw] select-none", className)}
      style={{ ["--kn-ill" as string]: c } as CSSProperties}
    >
      <style href="kn-ill-prompt-keyboard" precedence="default">
        {`${MOTION_GATE}\n${CSS}`}
      </style>

      {floor && (
        // Fills the card so a wave is never clipped by the floor's own box; the floor itself rises 70%.
        <div className="absolute inset-0">
          <GradientFloor ref={floorRef} className="size-full" color={[c, c]} height={0.78} intensity={1} />
        </div>
      )}

      {/* The chat prompt. */}
      <div className="absolute inset-x-[7cqw] top-[5cqw] flex min-h-[13.5cqw] items-center gap-[2.4cqw] rounded-[3cqw] border bg-card/90 px-[3.2cqw] py-[2cqw] shadow-[0_1.2cqw_4cqw_-2cqw_rgb(0_0_0/0.25)] backdrop-blur-sm">
        <span aria-hidden="true" className="grid size-[5.4cqw] flex-none place-items-center rounded-full border text-[3.4cqw] leading-none text-muted-foreground">
          +
        </span>
        <p className={cn("min-w-0 flex-1 text-[3.1cqw] leading-[1.38] text-foreground transition-[opacity,transform] ease-(--kn-ease-out) duration-(--kn-dur-slow)", sending && "-translate-y-[1.2cqw] opacity-0")} style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {shown || <span className="text-muted-foreground">Ask anything</span>}
          {!reduced && shown && <span aria-hidden="true" className="kn-caret ml-[0.4cqw] inline-block h-[3.2cqw] w-[0.45cqw] translate-y-[0.5cqw] rounded-full" style={{ background: "var(--kn-ill)" }} />}
        </p>
        <span
          aria-hidden="true"
          className="grid size-[6cqw] flex-none place-items-center rounded-full text-[3.4cqw] leading-none font-semibold text-background transition-[background-color,transform] ease-(--kn-ease-out) duration-(--kn-dur-slow)"
          style={{ background: sending || shown ? "var(--kn-ill)" : "color-mix(in srgb, var(--foreground) 18%, transparent)", transform: sending ? "scale(0.9)" : undefined }}
        >
          ↑
        </span>
      </div>

      {/* The glass keyboard, tilted back. */}
      <div className="absolute inset-x-[2.5cqw] top-[24cqw] bottom-[2cqw] [perspective:120cqw]" aria-hidden="true">
        <div
          className="relative size-full origin-bottom rounded-[3cqw] border bg-background/35 shadow-[inset_0_0.5cqw_0_rgb(255_255_255/0.12),0_2cqw_6cqw_-2cqw_rgb(0_0_0/0.3)] backdrop-blur-md"
          style={{ transform: "rotateX(14deg)" }}
        >
          {boxes.map((b) => {
            const on = lit === b.key;
            const rowTop = 3.6 + b.row * (KEY + GAP + 0.5);
            return (
              <span
                key={`${b.row}-${b.key}`}
                className={cn(
                  "absolute grid place-items-center rounded-[1.5cqw] border text-[3.1cqw] leading-none font-semibold uppercase transition-[transform,background-color,box-shadow,color,border-color] ease-(--kn-ease-out) duration-(--kn-dur-fast)",
                  on ? "text-background" : "bg-foreground/[0.06] text-muted-foreground",
                )}
                style={{
                  // Keys are placed against the card width; the panel is inset 2.5cqw each side, hence the shift.
                  left: `${b.left - 2.5}cqw`,
                  top: `${rowTop}cqw`,
                  width: `${b.width}cqw`,
                  height: `${KEY}cqw`,
                  background: on ? "var(--kn-ill)" : undefined,
                  borderColor: on ? "color-mix(in srgb, var(--kn-ill) 70%, white)" : "color-mix(in srgb, var(--foreground) 10%, transparent)",
                  boxShadow: on ? "0 0 4cqw color-mix(in srgb, var(--kn-ill) 70%, transparent)" : "0 0.5cqw 0 color-mix(in srgb, var(--foreground) 10%, transparent)",
                  transform: on ? "translateY(0.6cqw) scale(0.95)" : undefined,
                }}
              >
                {b.key === " " ? "" : b.key}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
