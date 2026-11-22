"use client";
/** @registry name="inspect" type="ui" title="Inspect" description="Real components seen like a selection in a design tool: tilted on a dark stage between their neighbours, a cursor measuring one part at a time live from the DOM (padding, gap, size, layer tag, guide). Three subjects on a switch (the approval prompt, the chat composer, the agent card), each with its own states, plus the measure overlay for your own UI." */

import { useEffect, useState } from "react";
import { cn } from "@/lib/knowns/utils";
import { MOTION } from "@/lib/knowns/motion";
import { SegmentedControl } from "../../segmented-control";
import { useReducedMotion } from "../use-in-view";
import { InspectAgentCard } from "./inspect-agent-card";
import { InspectApproval } from "./inspect-approval";
import { InspectComposer } from "./inspect-composer";
import type { InspectMeasureProps } from "./inspect-measure";

export { InspectAgentCard, type InspectAgentCardProps } from "./inspect-agent-card";
export { InspectApproval, type InspectApprovalProps } from "./inspect-approval";
export { InspectComposer, type InspectComposerProps } from "./inspect-composer";
export { InspectMeasure, type InspectMeasureProps, type InspectTarget, type MeasurePart } from "./inspect-measure";
export type { InspectState } from "./inspect-states";

export type InspectSubject = "approval" | "composer" | "agent-card";

/** The subjects on the switch, in order. */
export const INSPECT_SUBJECTS: { id: InspectSubject; label: string }[] = [
  { id: "approval", label: "Approval" },
  { id: "composer", label: "Composer" },
  { id: "agent-card", label: "Agent card" },
];

export interface InspectProps extends Pick<InspectMeasureProps, "mirror" | "delay" | "still" | "narrowBelow"> {
  /** The subject shown, controlled. */
  subject?: InspectSubject;
  /** The subject shown first. Default "approval". */
  defaultSubject?: InspectSubject;
  onSubjectChange?: (subject: InspectSubject) => void;
  /** The subjects on the switch above the stage. Default all three; one hides the switch. */
  subjects?: InspectSubject[];
  /** Each subject moves through its own states every 3s while on screen, until the visitor interacts. */
  autoplay?: boolean;
  /** A link under the stage per subject, such as the component's own page. */
  links?: Partial<Record<InspectSubject, { href: string; label: string }>>;
  className?: string;
}

const CSS = `
@keyframes knin-show { from { opacity: 0 } to { opacity: 1 } }
[data-inspect-subject="enter"] { animation: knin-show var(--kn-dur-fast, 120ms) var(--kn-ease-out, cubic-bezier(0.22, 1, 0.36, 1)) both }
@media (prefers-reduced-motion: reduce) { [data-inspect-subject] { animation: none !important } }
`;

/**
 * One stage, three subjects. The switch above it crossfades from one subject to the next (120ms): the new one fades
 * in over the old, which stays solid underneath so the page never shows through two half-faded stages, then goes.
 * The new one starts fresh, its frame on its first part. Reduced motion swaps at once. Each subject keeps its own
 * state switch.
 */
export function Inspect({ subject, defaultSubject = "approval", onSubjectChange, subjects = INSPECT_SUBJECTS.map((s) => s.id), autoplay, links, still, mirror, delay, narrowBelow, className }: InspectProps) {
  const [own, setOwn] = useState<InspectSubject>(defaultSubject);
  const current = subject ?? own;
  const reduced = useReducedMotion();
  const [leaving, setLeaving] = useState<InspectSubject | null>(null);
  const [changed, setChanged] = useState(false);
  // The subject that was on screen fades out over the new one; decided in the same render, so the new one never shows a frame early.
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    setChanged(true);
    setLeaving(reduced ? null : seen);
  }
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setLeaving(null), MOTION.fast + 20);
    return () => clearTimeout(t);
  }, [leaving]);

  const pick = (id: InspectSubject) => {
    if (subject === undefined) setOwn(id);
    onSubjectChange?.(id);
  };
  const shared = { still, mirror, delay, narrowBelow, autoplay, className: "w-full" };
  const render = (id: InspectSubject) =>
    id === "approval" ? <InspectApproval {...shared} link={links?.approval} /> : id === "composer" ? <InspectComposer {...shared} link={links?.composer} /> : <InspectAgentCard {...shared} link={links?.["agent-card"]} />;
  const options = INSPECT_SUBJECTS.filter((s) => subjects.includes(s.id));
  const layers = [...(leaving && leaving !== current ? [leaving] : []), current];

  return (
    <div className={cn("w-full", className)}>
      <style href="kn-inspect" precedence="default">
        {CSS}
      </style>
      {options.length > 1 && (
        <div className="mb-3 flex justify-center">
          <SegmentedControl size="sm" aria-label="Subject" options={options.map((s) => ({ value: s.id, label: s.label }))} value={current} onValueChange={(v) => pick(v as InspectSubject)} />
        </div>
      )}
      <div className="grid">
        {layers.map((id) => {
          const out = id !== current;
          return (
            <div
              key={id}
              data-inspect-subject={out ? "leave" : changed ? "enter" : undefined}
              aria-hidden={out || undefined}
              inert={out || undefined}
              className={cn("min-w-0 [grid-area:1/1]", out && "pointer-events-none")}
            >
              {render(id)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
