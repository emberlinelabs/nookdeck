import { useEffect, useId, useState } from "react";
import { api } from "@/api";
import { Field } from "@/components/ui/knowns/input";
import { Select } from "@/components/ui/knowns/select";
import { Switch } from "@/components/ui/knowns/switch";
import { QuotaAccountPicker } from "@/components/ai-accounts";
import { cn } from "@/lib/utils";
import { t, useLanguage } from "@/lib/i18n";
import { QUOTA_CHARTS, type AiProvider, type QuotaChart, type QuotaOptions } from "@/types";

const NAME: Record<QuotaChart, string> = {
  auto: "Auto", bars: "Bars", rings: "Rings", gauge: "Gauge", meter: "Detail card", number: "Number", history: "History",
};

const LINE = "M2 20 L9 14 L15 17 L22 8 L29 12 L36 5 L44 9";

function Thumb({ chart }: { chart: QuotaChart }) {
  const svg = (children: React.ReactNode) => (
    <svg viewBox="0 0 46 26" className="h-7 w-full" aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
  );
  switch (chart) {
    case "auto":
      return <span className="grid h-7 place-items-center text-[11px] text-muted-foreground">{t("auto")}</span>;
    case "bars":
      return svg(<>{[8, 15, 21].map((w, i) => <g key={i}><rect x="3" y={4 + i * 7} width="40" height="4" rx="2" fill="currentColor" fillOpacity=".22" stroke="none" /><rect x="3" y={4 + i * 7} width={w + 8} height="4" rx="2" fill="currentColor" stroke="none" /></g>)}</>);
    case "rings":
      return svg(<><circle cx="23" cy="13" r="11" strokeWidth="2.4" opacity=".25" /><path d="M23 2 A11 11 0 1 1 12.5 16" strokeWidth="2.4" /><circle cx="23" cy="13" r="6" strokeWidth="2.4" opacity=".25" /><path d="M23 7 A6 6 0 0 1 29 13" strokeWidth="2.4" /></>);
    case "gauge":
      return svg(<><path d="M9 22 A14 14 0 0 1 37 22" strokeWidth="3" opacity=".25" /><path d="M9 22 A14 14 0 0 1 28 9" strokeWidth="3" /></>);
    case "meter":
      return svg(<><rect x="3" y="3" width="40" height="20" rx="3" strokeWidth="1.2" opacity=".5" /><rect x="7" y="8" width="32" height="3" rx="1.5" fill="currentColor" fillOpacity=".22" stroke="none" /><rect x="7" y="8" width="20" height="3" rx="1.5" fill="currentColor" stroke="none" /><path d="M7 16 H24 M7 19 H18" strokeWidth="1.2" opacity=".5" /></>);
    case "number":
      return <span className="grid h-7 place-items-center font-mono text-[14px] font-semibold leading-none">42%</span>;
    case "history":
      return svg(<><path d={`${LINE} L44 24 L2 24 Z`} fill="currentColor" fillOpacity=".25" stroke="none" /><path d={LINE} strokeWidth="1.6" /></>);
  }
}

/** Window ids the agent is known to send, with English labels (translated where shown). */
const KNOWN_WINDOWS: Partial<Record<AiProvider, { id: string; label: string }[]>> = {
  claude: [{ id: "five_hour", label: "5 hours" }, { id: "seven_day", label: "7 days" }],
  codex: [{ id: "primary", label: "30 days" }],
  antigravity: [
    { id: "gemini-5h", label: "Gemini 5 hours" }, { id: "gemini-weekly", label: "Gemini weekly" },
    { id: "3p-5h", label: "3rd party 5 hours" }, { id: "3p-weekly", label: "3rd party weekly" }, { id: "gemini-argon-wtu-weekly", label: "Gemini Argon weekly" },
  ],
};

/** Live quota windows of one provider, from GET /api/integrations. Empty while loading or without data. */
function useLiveWindows(provider: AiProvider): { id: string; label: string }[] {
  const [list, setList] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let live = true;
    api.getIntegrations().then(
      (r) => live && setList((r.integrations.find((i) => i.id === provider)?.windows ?? []).map((w) => ({ id: w.id, label: w.label }))),
      () => live && setList([]),
    );
    return () => { live = false; };
  }, [provider]);
  return list;
}

export function QuotaOptionsForm({ provider, value, onChange }: { provider: AiProvider; value: QuotaOptions | undefined; onChange: (next: QuotaOptions | undefined) => void }) {
  useLanguage();
  const o = value ?? {};
  const uid = useId();
  const set = (patch: Partial<QuotaOptions>) => {
    const next: QuotaOptions = { ...o, ...patch };
    for (const k of Object.keys(next) as (keyof QuotaOptions)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const chart = o.chart ?? "auto";
  const mode: "all" | "main" | "choose" = Array.isArray(o.windows) ? "choose" : o.windows === "main" ? "main" : "all";
  const picked = Array.isArray(o.windows) ? o.windows : [];
  // The provider's live windows (id + label); known ids stand in when it has no data yet. Chosen ids that are not live stay visible.
  const live = useLiveWindows(provider);
  const known = KNOWN_WINDOWS[provider] ?? [];
  const base = live.length ? live : known.map((k) => ({ id: k.id, label: t(k.label) }));
  const choices = [...base, ...picked.filter((id) => !base.some((w) => w.id === id)).map((id) => ({ id, label: known.find((k) => k.id === id)?.label ? t(known.find((k) => k.id === id)!.label) : id }))];

  return (
    <div className="flex flex-col gap-3">
      {(provider === "claude" || provider === "codex") && <QuotaAccountPicker tool={provider} id={`${uid}-account`} value={o.account} onChange={(account) => set({ account })} />}
      <Field label={t("Quota display style")} id={`${uid}-chart`}>
        <div role="radiogroup" aria-label={t("Quota display style")} className="grid grid-cols-3 gap-2">
          {QUOTA_CHARTS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={chart === c}
              onClick={() => set({ chart: c === "auto" ? undefined : c })}
              className={cn("flex flex-col items-center gap-1 rounded-lg border p-1.5 text-[12px] transition-colors hover:bg-muted", chart === c && "border-primary bg-primary/10 font-medium")}
            >
              <span className="w-full rounded-md bg-muted/60 px-1 py-0.5 text-foreground"><Thumb chart={c} /></span>
              {t(NAME[c])}
            </button>
          ))}
        </div>
      </Field>

      <Field label={t("Show")} id={`${uid}-windows`} hint={mode === "choose" ? t("The first chosen window is the main one. Tap a chip to add or remove it.") : undefined}>
        <Select
          id={`${uid}-windows`}
          value={mode}
          onChange={(e) => {
            const m = e.target.value;
            if (m === "choose") set({ windows: Array.isArray(o.windows) ? o.windows : [choices[0]?.id ?? ""].filter(Boolean) });
            else set({ windows: m === "main" ? "main" : undefined });
          }}
          options={[{ value: "all", label: t("All windows") }, { value: "main", label: t("Main window only") }, { value: "choose", label: t("Choose…") }]}
        />
      </Field>
      {mode === "choose" && (
        <div role="group" aria-label={t("Windows to show")} className="-mt-1 flex flex-wrap gap-1.5">
          {choices.map((w) => {
            const at = picked.indexOf(w.id);
            const on = at >= 0;
            return (
              <button
                key={w.id}
                type="button"
                aria-pressed={on}
                disabled={!on && picked.length >= 6}
                onClick={() => {
                  if (on && picked.length === 1) return; // at least one window stays
                  set({ windows: on ? picked.filter((x) => x !== w.id) : [...picked, w.id] });
                }}
                className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] transition-colors hover:bg-muted disabled:opacity-40", on && "border-primary bg-primary/10 font-medium")}
              >
                {on && <span className="grid size-4 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">{at + 1}</span>}
                {w.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`${uid}-reset`} className="text-[13px]">{t("Show reset time")}</label>
        <Switch id={`${uid}-reset`} checked={o.showReset ?? true} onCheckedChange={(v) => set({ showReset: v ? undefined : false })} aria-label={t("Show reset time")} />
      </div>
    </div>
  );
}
