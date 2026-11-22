"use client";
/** Inspect subject: the real Agent Graph detail card, tilted between other agents' cards, with Working, Waiting on you and Done. Part of the inspect item. */

import { useRef } from "react";
import type { Actor, ActorState, Span } from "@/lib/knowns/types";
import { actorIcon } from "@/lib/knowns/icons/actor-icon";
import { AGENT_PALETTE, formatUsd } from "@/lib/knowns/status";
import { DetailCard } from "../../agent-graph/detail-card";
import { InspectMeasure, type InspectMeasureProps, type MeasurePart } from "./inspect-measure";
import { useInspectStates, type InspectState, type InspectStateProps } from "./inspect-states";

export type { InspectTarget, MeasurePart } from "./inspect-measure";
export type { InspectState } from "./inspect-states";

const card = (root: HTMLElement) => root.querySelector("[data-inspect-body] > div");
/** What Measure visits on the card: whole rows first, then one small part. */
export const AGENT_CARD_PARTS: MeasurePart[] = [
  { target: (root) => card(root)?.firstElementChild ?? null, name: "Header" },
  { target: (root) => root.querySelector("[data-inspect-body] p"), name: "Status" },
  { target: "li:first-child", name: "Call" },
  { target: "ul + div", name: "Rate" },
  { target: "li:first-child span.tabular-nums", name: "Duration" },
];

/** What the card shows. */
export interface AgentCardFacts {
  actor: Actor;
  state: ActorState;
  /** Newest first. */
  recent: Span[];
  peers: Actor[];
  spansPerMinute: number;
}

const AGENT: Actor = { id: "researcher", type: "agent", label: "Researcher", activity: "reading 4 sources", spend: 0.42 };
const PEERS: Actor[] = [
  { id: "search", type: "tool", label: "search" },
  { id: "fetch", type: "tool", label: "fetch_page" },
  { id: "writer", type: "agent", label: "Writer" },
];
const DONE_CALLS: Span[] = [
  { id: "s3", from: "researcher", to: "fetch", startedAt: 0, endedAt: 412, outcome: "success", summary: "pricing page" },
  { id: "s2", from: "researcher", to: "search", startedAt: 0, endedAt: 286, outcome: "success", summary: "3 results" },
  { id: "s1", from: "writer", to: "researcher", startedAt: 0, endedAt: 1840, outcome: "success", summary: "brief" },
];

/** Working, Waiting on you, Done: one agent through a run. */
export const AGENT_CARD_STATES: InspectState<AgentCardFacts>[] = [
  { id: "working", label: "Working", props: { state: "busy", actor: AGENT, recent: DONE_CALLS, spansPerMinute: 6 }, parts: AGENT_CARD_PARTS, measureHold: 2 },
  {
    id: "waiting",
    label: "Waiting on you",
    props: {
      state: "blocked",
      actor: { ...AGENT, activity: "asks to read a paid report" },
      recent: [{ id: "s4", from: "researcher", to: "fetch", startedAt: 0, summary: "paid report" }, ...DONE_CALLS.slice(0, 2)],
      spansPerMinute: 4,
    },
    parts: AGENT_CARD_PARTS,
    measureHold: 1,
  },
  {
    id: "done",
    label: "Done",
    props: { state: "finished", actor: { ...AGENT, activity: "brief sent to Writer", spend: 0.61 }, recent: DONE_CALLS, spansPerMinute: 0 },
    parts: AGENT_CARD_PARTS,
    measureHold: 3,
  },
];

export interface InspectAgentCardProps extends Partial<AgentCardFacts>, InspectStateProps<AgentCardFacts>, Pick<InspectMeasureProps, "mirror" | "delay" | "still" | "narrowBelow" | "link"> {
  /** Replace the parts the cursor visits in every state. */
  parts?: MeasurePart[];
  /** Names the figure for screen readers. */
  label?: string;
  onClose?: () => void;
  className?: string;
}

export function InspectAgentCard({ parts, label = "Agent detail card, inspected", still, mirror, delay, narrowBelow, link, onClose, className, states = AGENT_CARD_STATES, value, defaultValue, onValueChange, autoplay, ...own }: InspectAgentCardProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const { state: st, switcher, wrapProps } = useInspectStates({ states, value, defaultValue, onValueChange, autoplay });
  const f: AgentCardFacts = { actor: AGENT, state: "busy", recent: DONE_CALLS, peers: PEERS, spansPerMinute: 6, ...own, ...st?.props };
  const all = [f.actor, ...f.peers];
  const hueOf = (id: string) => AGENT_PALETTE[Math.max(0, all.findIndex((a) => a.id === id)) % AGENT_PALETTE.length]!;
  // The agents next to this one, as their own cards, shown faded around it.
  const other = (a: Actor, state: ActorState, calls: Span[]) => (
    <div className="mx-auto w-[20rem] max-w-full rounded-2xl border bg-popover p-4 pb-3 text-popover-foreground shadow-lg">
      <DetailCard actor={a} state={state} recent={calls} peers={f.peers} spansPerMinute={2} iconFor={(x) => actorIcon(x, x.id === a.id)} hueOf={hueOf} formatSpend={formatUsd} closeRef={closeRef} onClose={() => {}} />
    </div>
  );
  const writer: Actor = { id: "writer", type: "agent", label: "Writer", activity: "drafting the brief", spend: 0.18 };
  const checker: Actor = { id: "checker", type: "agent", label: "Fact checker", activity: "queued", spend: 0 };
  return (
    <div {...wrapProps} className={className}>
      <InspectMeasure
        before={other(writer, "busy", [{ id: "w1", from: "writer", to: "researcher", startedAt: 0, endedAt: 940, outcome: "success", summary: "ask for sources" }])}
        after={other(checker, "idle", [])}
        parts={parts ?? st?.parts ?? AGENT_CARD_PARTS}
        hold={st?.measureHold ?? 0}
        label={label}
        still={still}
        mirror={mirror}
        delay={delay}
        narrowBelow={narrowBelow}
        swapKey={st?.id}
        controls={switcher}
        link={link}
      >
        <div className="mx-auto w-[20rem] max-w-full rounded-2xl border bg-popover p-4 pb-3 text-popover-foreground shadow-lg">
          <DetailCard actor={f.actor} state={f.state} recent={f.recent} peers={f.peers} spansPerMinute={f.spansPerMinute} iconFor={(a) => actorIcon(a, a.id === f.actor.id)} hueOf={hueOf} formatSpend={formatUsd} closeRef={closeRef} onClose={onClose ?? (() => {})} />
        </div>
      </InspectMeasure>
    </div>
  );
}
