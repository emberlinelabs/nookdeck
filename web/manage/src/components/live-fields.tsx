/** Item form fields for the On Air, Mic and Camera actions. */
import { Field } from "@/components/ui/knowns/input";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { t, useLanguage } from "@/lib/i18n";
import { MODE_LABEL } from "@/lib/layout";
import { formProblem, modesFor, withMode } from "@/lib/live-form";
import type { CameraAction, MicAction, OnAirAction } from "@shared/onair";
import type { Action } from "@/types";

type Props = { action: OnAirAction | MicAction | CameraAction; onChange: (a: Action) => void };

const HINT: Record<string, string> = {
  onair: "Turns the manual On Air source on or off. Add an On Air tile to see it, and choose its sources in Plugins > On Air.",
  mic: "Mutes the computer's default microphone for every app. The button turns red while it is muted, also when you mute it somewhere else.",
  camera: "Turns the camera off or on in the meeting app that is using it (Zoom, Google Meet, Microsoft Teams) with that app's own shortcut. The button shows whether a camera is in use. With no known meeting app it says so and sends nothing.",
};

export function LiveFields({ action, onChange }: Props) {
  useLanguage();
  const modes = modesFor(action.type);
  if (!modes.length) return <p className="text-xs text-muted-foreground">{t(HINT[action.type] ?? "")}</p>;
  const label = action.type === "onair" ? t("On Air") : t("Computer microphone");
  const problem = formProblem(action);
  const mode = "mode" in action ? action.mode : undefined;
  return (
    <Field label={label} id={`f-${action.type}`} hint={t(HINT[action.type] ?? "")} error={problem ? t(problem) : undefined}>
      <SegmentedControl aria-label={label} value={mode ?? "toggle"} onValueChange={(m) => onChange(withMode(action as { mode?: string }, m) as Action)}
        options={modes.map((m) => ({ value: m, label: t(MODE_LABEL[m] ?? m) }))} />
    </Field>
  );
}
