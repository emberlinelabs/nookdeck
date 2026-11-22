"use client";
/** Inspect subject: the real Chat Composer, tilted between other turns, with Empty, Typing and Sending. Part of the inspect item. */

import { ChatComposer, type ChatComposerProps } from "../../chat-composer/chat-composer";
import { InspectMeasure, type InspectMeasureProps, type MeasurePart } from "./inspect-measure";
import { useInspectStates, type InspectState, type InspectStateProps } from "./inspect-states";

export type { InspectTarget, MeasurePart } from "./inspect-measure";
export type { InspectState } from "./inspect-states";

/** The row that holds the composer's buttons: the nearest box around both the first and the last of them. */
const toolbar = (root: HTMLElement): Element | null => {
  const first = root.querySelector("[data-inspect-body] button[aria-label='Add files and more']");
  const last = root.querySelector("[data-inspect-body] button[aria-label='Send'], [data-inspect-body] button[aria-label='Stop']");
  let el = first?.parentElement ?? null;
  while (el && last && !el.contains(last)) el = el.parentElement;
  return el;
};

/** What Measure visits while someone types: the input row, the toolbar row, then one small part. */
export const COMPOSER_PARTS: MeasurePart[] = [
  { target: "textarea[aria-label='Message']", name: "Input" },
  { target: toolbar, name: "Toolbar" },
  { target: "button[aria-label='Send']", name: "Send" },
];

const TEXT = "Summarise last night's failed runs and suggest one fix each";

/** Another turn in the same thread, shown faded around the one in focus. */
function Turn({ text }: { text: string }) {
  return (
    <div className="mx-auto w-[26rem] max-w-full">
      <ChatComposer defaultValue={text} footer={false} onSubmit={() => {}} />
    </div>
  );
}

/** Empty, Typing, Sending: the same composer before, during and after the person writes. */
export const COMPOSER_STATES: InspectState<ChatComposerProps>[] = [
  { id: "empty", label: "Empty", props: { defaultValue: "", placeholder: "Ask the release agent anything" }, parts: COMPOSER_PARTS, measureHold: 1 },
  { id: "typing", label: "Typing", props: { defaultValue: TEXT }, parts: COMPOSER_PARTS, measureHold: 1 },
  {
    id: "sending",
    label: "Sending",
    props: { defaultValue: TEXT, busy: true },
    parts: [
      { target: "textarea[aria-label='Message']", name: "Input" },
      { target: toolbar, name: "Toolbar" },
      { target: "button[aria-label='Stop']", name: "Stop" },
    ],
    measureHold: 1,
  },
];

/**
 * The composer's own props pass through (models, mode, onModeChange, onSubmit...), except its text: the state sets
 * the text, and `value` / `onValueChange` pick the state.
 */
export interface InspectComposerProps
  extends Partial<Omit<ChatComposerProps, "className" | "value" | "defaultValue" | "onValueChange">>,
    InspectStateProps<ChatComposerProps>,
    Pick<InspectMeasureProps, "mirror" | "delay" | "still" | "narrowBelow" | "link"> {
  /** Replace the parts the cursor visits in every state. */
  parts?: MeasurePart[];
  /** Names the figure for screen readers. */
  label?: string;
  className?: string;
}

export function InspectComposer({ parts, label = "Chat composer, inspected", still, mirror, delay, narrowBelow, link, className, states = COMPOSER_STATES, value, defaultValue = "typing", onValueChange, autoplay, onSubmit, ...composer }: InspectComposerProps) {
  const { state, switcher, wrapProps } = useInspectStates({ states, value, defaultValue, onValueChange, autoplay });
  return (
    <div {...wrapProps} className={className}>
      <InspectMeasure
        parts={parts ?? state?.parts ?? COMPOSER_PARTS}
        hold={state?.measureHold ?? 0}
        before={<Turn text="Draft the release notes for 2.4 from the merged pull requests" />}
        after={<Turn text="Which tests failed on main last night?" />}
        label={label}
        still={still}
        mirror={mirror}
        delay={delay}
        narrowBelow={narrowBelow}
        swapKey={state?.id}
        controls={switcher}
        link={link}
      >
        <div className="mx-auto w-[26rem] max-w-full">
          {/* A new state starts the composer fresh, so its own default text applies. */}
          <ChatComposer key={state?.id} footer={false} defaultValue={state ? undefined : TEXT} onSubmit={onSubmit ?? (() => {})} {...composer} {...state?.props} />
        </div>
      </InspectMeasure>
    </div>
  );
}
