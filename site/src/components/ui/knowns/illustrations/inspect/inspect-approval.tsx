"use client";
/** Inspect subject: the real Approval Prompt, tilted between its neighbours in the queue, with Pending, Approved and Denied. Part of the inspect item. */

import { useMemo } from "react";
import type { Actor, Approval } from "@/lib/knowns/types";
import { ApprovalPrompt, type ApprovalPromptProps } from "../../approval-prompt/approval-prompt";
import { InspectMeasure, type InspectMeasureProps, type MeasurePart } from "./inspect-measure";
import { useInspectStates, type InspectState, type InspectStateProps } from "./inspect-states";

export type { InspectTarget, MeasurePart } from "./inspect-measure";
export type { InspectState } from "./inspect-states";

/** What Measure visits on a waiting request: whole rows first, then one small part. */
export const APPROVAL_PARTS: MeasurePart[] = [
  { target: "article > div:first-child", name: "Header" },
  { target: (root) => root.querySelector("[data-inspect-body] article")?.children[1] ?? null, name: "Payload" },
  { target: "article > div:last-child", name: "Actions" },
  { target: "article > div:last-child > button:last-child", name: "Approve" },
];

const RESOLVED_PARTS: MeasurePart[] = [
  { target: "ul > li:first-child", name: "Row" },
  { target: "ul > li:nth-child(2)", name: "Row" },
  { target: "ul > li:first-child > span:nth-last-child(2)", name: "Decision" },
];

const ACTORS: Actor[] = [
  { id: "deploy", type: "agent", label: "Deploy agent" },
  { id: "billing", type: "agent", label: "Billing agent" },
  { id: "keys", type: "agent", label: "Security agent" },
];

/** The requests before and after this one in the queue, shown faded around it. */
function Neighbour({ now, which }: { now: number; which: "before" | "after" }) {
  const a: Approval =
    which === "before"
      ? { id: "n0", actor: "keys", title: "Rotate the staging API key", detail: "2 services restart", requestedAt: now - 300_000 }
      : { id: "n2", actor: "billing", title: "Send 18 invoice reminders", detail: "Total due: EUR 4,210", requestedAt: now - 60_000 };
  return (
    <div className="mx-auto w-[24rem] max-w-full">
      <ApprovalPrompt approvals={[a]} actors={ACTORS} live={false} history={0} />
    </div>
  );
}

/** Pending, Approved, Denied: the same request, before and after a person decides. `now` is when the figure renders. */
export function approvalStates(now: number): InspectState<ApprovalPromptProps>[] {
  const base: Approval = { id: "r1", actor: "deploy", title: "Deploy to production", detail: "3 services, 14 files changed\nRollback: previous build", requestedAt: now - 120_000 };
  const earlier: Approval = { id: "r0", actor: "deploy", title: "Deploy to staging", detail: "3 services", requestedAt: now - 3_600_000, decision: "approved", decidedAt: now - 3_480_000 };
  return [
    { id: "pending", label: "Pending", props: { approvals: [base] }, parts: APPROVAL_PARTS, measureHold: 2 },
    { id: "approved", label: "Approved", props: { approvals: [{ ...base, decision: "approved", decidedAt: now - 20_000 }, earlier] }, parts: RESOLVED_PARTS },
    { id: "denied", label: "Denied", props: { approvals: [{ ...base, decision: "denied", decidedAt: now - 20_000 }, earlier] }, parts: RESOLVED_PARTS },
  ];
}

export interface InspectApprovalProps
  extends Omit<ApprovalPromptProps, "className">,
    InspectStateProps<ApprovalPromptProps>,
    Pick<InspectMeasureProps, "mirror" | "delay" | "still" | "narrowBelow" | "link"> {
  /** Replace the parts the cursor visits in every state. */
  parts?: MeasurePart[];
  /** Names the figure for screen readers. */
  label?: string;
  className?: string;
}

export function InspectApproval({ parts, label = "Approval prompt, inspected", still, mirror, delay, narrowBelow, link, className, states, value, defaultValue, onValueChange, autoplay, actors, ...prompt }: InspectApprovalProps) {
  const now = useMemo(() => Date.now(), []);
  const list = useMemo(() => states ?? approvalStates(now), [states, now]);
  const { state, switcher, wrapProps } = useInspectStates({ states: list, value, defaultValue, onValueChange, autoplay });
  return (
    <div {...wrapProps} className={className}>
      <InspectMeasure
        parts={parts ?? state?.parts ?? APPROVAL_PARTS}
        hold={state?.measureHold ?? 0}
        before={<Neighbour now={now} which="before" />}
        after={<Neighbour now={now} which="after" />}
        label={label}
        still={still}
        mirror={mirror}
        delay={delay}
        narrowBelow={narrowBelow}
        swapKey={state?.id}
        controls={switcher}
        link={link}
      >
        {/* As tall as the waiting request, so the stage keeps its height when a state resolves it. */}
        <div className="mx-auto flex min-h-[10.75rem] w-[24rem] max-w-full flex-col justify-center">
          <ApprovalPrompt actors={actors ?? ACTORS} live={false} history={3} {...(state || prompt.approvals ? {} : approvalStates(now)[0]!.props)} {...prompt} {...state?.props} />
        </div>
      </InspectMeasure>
    </div>
  );
}
