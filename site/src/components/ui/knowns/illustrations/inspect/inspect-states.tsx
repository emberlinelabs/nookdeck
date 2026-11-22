"use client";
/**
 * States for the Inspect illustrations: a small switch under the stage that drives the real component through
 * its own props, with the parts to measure per state. Controlled (`value` + `onValueChange`) or not (`defaultValue`).
 *
 * Autoplay (opt-in) moves to the next state every 3s, only while the figure is on screen, and stops for good
 * as soon as the visitor points at it, focuses inside it or picks a state. Reduced motion turns it off.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SegmentedControl } from "../../segmented-control";
import { useReducedMotion } from "../use-in-view";
import type { MeasurePart } from "./inspect-measure";

export interface InspectState<P> {
  id: string;
  /** On the switch: "Pending". */
  label: string;
  /** Props for the real component in this state, merged over the item's own props. */
  props: Partial<P>;
  /** Parts to measure in this state (Measure mode), in the order the cursor visits them. */
  parts?: MeasurePart[];
  /** The part measured at rest and in a still frame. Default 0. */
  measureHold?: number;
}

export interface InspectStateProps<P> {
  /** The states on the switch. Default: the item's own three. Pass [] to hide the switch. */
  states?: InspectState<P>[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  /** Move to the next state every 3s while on screen, until the visitor interacts. Off under reduced motion. */
  autoplay?: boolean;
}

/** Autoplay step (ms). */
export const AUTOPLAY_MS = 3000;

/** The next state after `id`, wrapping round. */
export function nextStateId(ids: readonly string[], id: string): string | undefined {
  if (!ids.length) return undefined;
  const i = ids.indexOf(id);
  return ids[(i + 1) % ids.length];
}

export function useInspectStates<P>({ states = [], value, defaultValue, onValueChange, autoplay }: InspectStateProps<P>) {
  const [own, setOwn] = useState(defaultValue ?? states[0]?.id ?? "");
  const current = value ?? own;
  const state = states.find((s) => s.id === current) ?? states[0];
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const [stopped, setStopped] = useState(false);
  const [inView, setInView] = useState(false);

  const select = (id: string) => {
    if (value === undefined) setOwn(id);
    onValueChange?.(id);
  };

  useEffect(() => {
    const el = wrap.current;
    if (!autoplay || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => setInView(e.some((x) => x.isIntersecting)), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [autoplay]);

  const playing = Boolean(autoplay) && !reduced && !stopped && inView && states.length > 1;
  const ids = states.map((s) => s.id);
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      const next = nextStateId(ids, current);
      if (next) select(next);
    }, AUTOPLAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, current, ids.join("|")]);

  const stop = () => setStopped(true);
  const switcher: ReactNode =
    states.length > 1 ? (
      <SegmentedControl
        size="sm"
        aria-label="State"
        options={states.map((s) => ({ value: s.id, label: s.label }))}
        value={state?.id}
        onValueChange={(id) => {
          stop();
          select(id);
        }}
      />
    ) : null;

  /** Spread on the wrapper: interacting with the figure stops autoplay. */
  const wrapProps = { ref: wrap, onPointerEnter: stop, onFocus: stop };
  return { state, switcher, wrapProps, playing };
}
