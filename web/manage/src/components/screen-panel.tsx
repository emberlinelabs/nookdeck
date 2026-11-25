import { useEffect, useState, type ReactNode } from "react";
import { IconPlayerPlay as Play, IconPlus as Plus, IconTrash as Trash } from "@tabler/icons-react";
import { api } from "@/api";
import { Button } from "@/components/ui/knowns/button";
import { Card } from "@/components/ui/knowns/card";
import { Field, Input } from "@/components/ui/knowns/input";
import { Select } from "@/components/ui/knowns/select";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { Slider } from "@/components/ui/knowns/slider";
import { Switch } from "@/components/ui/knowns/switch";
import { OptionCards } from "@/components/visual-options";
import { PhonePreview, type Orientation } from "@/components/phone-preview";
import { previewAlarmSound } from "@/lib/alarm-preview";
import { getLanguage, t, useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ALARMS_MAX, type Alarm, type AlarmSoundId, type DeviceInfo, type Layout, type ScreenSettings } from "@/types";

const STANDBY_DEFAULT = { enabled: false, afterMin: 5, style: "digital" as const, showDate: true, showNext: true };
/** What the Night dim switch fills in when it is turned on. */
const NIGHT_DEFAULT = { from: "23:00", to: "07:00" };
const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v) || lo));
const newId = () => `al-${Math.random().toString(36).slice(2, 8)}`;
/** Monday first; the stored value is 0=Sun..6=Sat. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_VI = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const SOUNDS: { value: AlarmSoundId; label: string }[] = [
  { value: "chime", label: "Chime" }, { value: "birds", label: "Birds" }, { value: "soft", label: "Gentle" }, { value: "none", label: "Silent" },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function SwitchRow({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-[13px] font-medium">{label}</label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/** Little clock drawings for the three standby styles. */
const standbyArt = (): { value: "digital" | "analog" | "words"; label: string; art: ReactNode }[] => [
  { value: "digital", label: t("Digital"), art: <span aria-hidden className="grid h-9 w-14 place-items-center rounded-[5px] bg-black font-mono text-[11px] text-zinc-300">12:30</span> },
  {
    value: "analog", label: t("Analog"),
    art: (
      <span aria-hidden className="grid size-9 place-items-center rounded-full bg-black">
        <svg viewBox="0 0 24 24" width="28" height="28" stroke="#d4d4d8" strokeWidth="1.6" strokeLinecap="round"><circle cx="12" cy="12" r="10" fill="none" strokeWidth="1" /><path d="M12 12V6M12 12l4 2" /></svg>
      </span>
    ),
  },
  { value: "words", label: t("Words"), art: <span aria-hidden className="grid h-9 w-14 place-items-center rounded-[5px] bg-black px-1 text-center text-[8px] leading-[1.1] text-zinc-300">half past twelve</span> },
];

function useDevices(): DeviceInfo[] {
  const [list, setList] = useState<DeviceInfo[]>([]);
  useEffect(() => {
    let live = true;
    api.getDevices().then((d) => live && setList(Array.isArray(d) ? d : []), () => undefined);
    return () => { live = false; };
  }, []);
  return list;
}

function AlarmCard({ alarm, devices, onChange, onDelete }: { alarm: Alarm; devices: DeviceInfo[]; onChange: (a: Alarm) => void; onDelete: () => void }) {
  useLanguage();
  const set = (patch: Partial<Alarm>) => {
    const next: Record<string, unknown> = { ...alarm, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(next as unknown as Alarm);
  };
  const names = getLanguage() === "vi" ? DAYS_VI : DAYS_EN;
  const days = alarm.days ?? [];
  const chosen = alarm.devices ?? [];
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const chip = (on: boolean) => cn("rounded-full border px-2.5 py-1 text-[12.5px] transition-colors hover:bg-muted", on && "border-primary bg-primary/10 font-medium");
  const [noAudio, setNoAudio] = useState(false);
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border p-3", !alarm.enabled && "opacity-70")}>
      <div className="flex items-center gap-3">
        <Input type="time" aria-label={t("Alarm time")} className="w-[112px] text-base" value={alarm.time} onChange={(e) => e.target.value && set({ time: e.target.value })} />
        <Input aria-label={t("Label")} placeholder={t("Label (optional)")} maxLength={60} className="min-w-0 flex-1" value={alarm.label ?? ""} onChange={(e) => set({ label: e.target.value || undefined })} />
        <Switch checked={alarm.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label={t("Alarm on")} />
        <button type="button" aria-label={t("Delete alarm")} title={t("Delete alarm")} onClick={onDelete} className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"><Trash className="size-4" /></button>
      </div>
      <div role="group" aria-label={t("Repeat on")} className="flex flex-wrap items-center gap-1.5">
        {DAY_ORDER.map((d) => (
          <button key={d} type="button" aria-pressed={days.includes(d)} onClick={() => set({ days: toggle(days, d).sort((a, b) => a - b) })} className={chip(days.includes(d))}>{names[d]}</button>
        ))}
        <span className="ml-1 text-xs text-muted-foreground">{days.length ? "" : t("Once: the next time it is that hour")}</span>
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field label={t("Sound")} id={`al-${alarm.id}-sound`}>
          <Select id={`al-${alarm.id}-sound`} value={alarm.sound} onChange={(e) => set({ sound: e.target.value as AlarmSoundId })} options={SOUNDS.map((s) => ({ value: s.value, label: t(s.label) }))} />
        </Field>
        <Button variant="secondary" icon={<Play />} disabled={alarm.sound === "none"} onClick={() => setNoAudio(!previewAlarmSound(alarm.sound))}>{t("Listen")}</Button>
      </div>
      {noAudio && alarm.sound !== "none" && <p className="-mt-1 text-xs text-muted-foreground">{t("This browser cannot play the preview.")}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Slider label={t("Sunrise before the alarm")} min={0} max={30} step={1} value={alarm.sunriseMin} formatValue={(v) => (v ? t("{n} min", { n: v }) : t("Off"))} onValueChange={(v) => set({ sunriseMin: v })} />
        <Field label={t("Snooze (minutes)")} id={`al-${alarm.id}-snooze`}>
          <Input id={`al-${alarm.id}-snooze`} type="number" min={1} max={30} value={alarm.snoozeMin} onChange={(e) => set({ snoozeMin: clampInt(Number(e.target.value), 1, 30) })} />
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] font-medium">{t("Phones")}</p>
        <div role="group" aria-label={t("Phones")} className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={chosen.length === 0} onClick={() => set({ devices: undefined })} className={chip(chosen.length === 0)}>{t("All phones")}</button>
          {devices.map((d) => (
            <button key={d.id} type="button" aria-pressed={chosen.includes(d.id)} onClick={() => { const next = toggle(chosen, d.id); set({ devices: next.length ? next : undefined }); }} className={chip(chosen.includes(d.id))}>{d.name}</button>
          ))}
          {chosen.filter((id) => !devices.some((d) => d.id === id)).map((id) => (
            <button key={id} type="button" aria-pressed onClick={() => { const next = chosen.filter((x) => x !== id); set({ devices: next.length ? next : undefined }); }} className={chip(true)} title={t("This phone is no longer paired")}>{id.slice(0, 8)}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ScreenPanel({ layout, pageId, update, orientation, onOrientation }: {
  layout: Layout;
  pageId: string;
  update: (fn: (l: Layout) => Layout) => void;
  orientation: Orientation;
  onOrientation: (o: Orientation) => void;
}) {
  useLanguage();
  const devices = useDevices();
  const screen: ScreenSettings = layout.theme?.screen ?? {};
  const standby = { ...STANDBY_DEFAULT, ...screen.standby };
  const dim = screen.dim ?? { level: 0.6 };
  const night = !!(dim.from || dim.to);
  const alarms = layout.alarms ?? [];
  const setScreen = (patch: Partial<ScreenSettings>) =>
    update((l) => {
      const next: ScreenSettings = { ...(l.theme?.screen ?? {}), ...patch };
      return { ...l, theme: { ...(l.theme ?? {}), screen: next } };
    });
  const setAlarms = (list: Alarm[]) =>
    update((l) => {
      const { alarms: _drop, ...rest } = l;
      return list.length ? { ...rest, alarms: list } : (rest as Layout);
    });
  const setDim = (patch: Partial<NonNullable<ScreenSettings["dim"]>>) => {
    const next: Record<string, unknown> = { ...dim, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === "") delete next[k];
    setScreen({ dim: next as NonNullable<ScreenSettings["dim"]> });
  };
  const [dimPreview, setDimPreview] = useState(false);

  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[480px_minmax(0,1fr)]">
      <Card className="kn-scroll-auto min-h-0 overflow-y-auto p-4">
        <div className="flex flex-col gap-7">
          <Section title={t("Performance and power")}>
            <Field label={t("Lite mode")} id="s-lite" hint={t("Turns off blur, shadows and animations so old or slow phones stay smooth. Auto decides by itself.")}>
              <SegmentedControl size="sm" aria-label={t("Lite mode")} value={screen.lite ?? "auto"} onValueChange={(v) => setScreen({ lite: v === "auto" ? undefined : (v as "on" | "off") })}
                options={[{ value: "auto", label: t("Auto") }, { value: "on", label: t("On") }, { value: "off", label: t("Off") }]} />
            </Field>
            <SwitchRow id="s-awake" label={t("Keep the phone screen on")} checked={screen.keepAwake !== false} onChange={(v) => setScreen({ keepAwake: v ? undefined : false })} />
          </Section>

          <Section title={t("Standby clock")} hint={t("After a while without touch, the phone shows a quiet full-screen clock. Tap to go back.")}>
            <SwitchRow id="s-standby" label={t("Show a clock when idle")} checked={standby.enabled} onChange={(v) => setScreen({ standby: { ...standby, enabled: v } })} />
            {standby.enabled && (
              <>
                <Field label={t("Start after (minutes)")} id="s-after">
                  <Input id="s-after" type="number" min={1} max={120} className="w-28" value={standby.afterMin} onChange={(e) => setScreen({ standby: { ...standby, afterMin: clampInt(Number(e.target.value), 1, 120) } })} />
                </Field>
                <OptionCards label={t("Clock style")} value={standby.style} onChange={(v) => setScreen({ standby: { ...standby, style: v } })} options={standbyArt()} />
                <SwitchRow id="s-date" label={t("Show the date")} checked={standby.showDate !== false} onChange={(v) => setScreen({ standby: { ...standby, showDate: v } })} />
                <SwitchRow id="s-next" label={t("Show the next alarm")} checked={standby.showNext !== false} onChange={(v) => setScreen({ standby: { ...standby, showNext: v } })} />
              </>
            )}
          </Section>

          <Section title={t("Screen care")} hint={t("For a phone that stays on all day.")}>
            <SwitchRow id="s-shift" label={t("Burn-in shift")} checked={screen.burnInShift === true} onChange={(v) => setScreen({ burnInShift: v ? true : undefined })} />
            <p className="-mt-2 text-xs text-muted-foreground">{t("Every 3 minutes the tiles move by up to 2 px.")}</p>
            <SwitchRow id="s-night" label={t("Night dim")} checked={night} onChange={(v) => setDim(v ? NIGHT_DEFAULT : { from: undefined, to: undefined })} />
            <p className="-mt-2 text-xs text-muted-foreground">{t("During these hours a black layer covers the screen. The first tap only lifts it for 30 seconds and presses nothing.")}</p>
            {night && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t("Dim from")} id="s-from"><Input id="s-from" type="time" value={dim.from ?? ""} onChange={(e) => setDim({ from: e.target.value || undefined })} /></Field>
                <Field label={t("Dim until")} id="s-to"><Input id="s-to" type="time" value={dim.to ?? ""} onChange={(e) => setDim({ to: e.target.value || undefined })} /></Field>
              </div>
            )}
            <Slider label={t("Dim level")} min={0} max={0.9} step={0.05} value={dim.level} formatValue={(v) => `${Math.round(v * 100)}%`} onValueChange={(v) => { setDimPreview(true); setDim({ level: Math.round(v * 100) / 100 }); }} />
            <p className="-mt-2 text-xs text-muted-foreground">{dim.from && dim.to ? t("Dims every day from {from} to {to}.", { from: dim.from, to: dim.to }) : t("No schedule: the screen only dims in standby.")}</p>
            <Button size="sm" variant="secondary" className="self-start" onClick={() => setDimPreview((v) => !v)}>{dimPreview ? t("Hide dim preview") : t("Preview dim")}</Button>
          </Section>

          <Section title={t("Alarms")} hint={t("Alarms ring on the phone itself, even when the computer is off. Tap the phone once after opening Nookdeck so the sound can play.")}>
            {alarms.length === 0 && <p className="rounded-xl border border-dashed p-4 text-center text-[13px] text-muted-foreground">{t("No alarms yet.")}</p>}
            {alarms.map((a, i) => (
              <AlarmCard key={a.id} alarm={a} devices={devices} onChange={(n) => setAlarms(alarms.map((x, j) => (j === i ? n : x)))} onDelete={() => setAlarms(alarms.filter((_, j) => j !== i))} />
            ))}
            <Button variant="secondary" icon={<Plus />} className="self-start" disabled={alarms.length >= ALARMS_MAX}
              onClick={() => setAlarms([...alarms, { id: newId(), time: "07:00", days: [1, 2, 3, 4, 5], enabled: true, sound: "chime", sunriseMin: 10, snoozeMin: 9 }])}>{t("Add alarm")}</Button>
          </Section>
        </div>
      </Card>
      <div className="min-h-0 min-w-0">
        <PhonePreview layout={layout} pageId={pageId} selectedId={null} orientation={orientation} onOrientation={onOrientation} dimLevel={dimPreview ? dim.level : 0} />
      </div>
    </div>
  );
}
