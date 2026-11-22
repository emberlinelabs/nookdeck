import { Card, CardContent } from "@/components/ui/knowns/card";
import { Button } from "@/components/ui/knowns/button";
import { Field } from "@/components/ui/knowns/input";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { Icon } from "@/components/icon";
import { PluginsPanel } from "@/components/plugins-panel";
import { t, useLanguage } from "@/lib/i18n";
import type { Layout } from "@/types";

/** The weather plugin: the temperature unit (a theme setting) and where the location is set. */
export function WeatherPage({ layout, update, onGoScreens }: { layout: Layout; update: (fn: (l: Layout) => Layout) => void; onGoScreens: () => void }) {
  useLanguage();
  const unit = layout.theme?.temperatureUnit === "f" ? "f" : "c";
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border bg-muted/50"><Icon name="sun" size={22} /></span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[15px] font-semibold leading-tight">{t("Weather")}</h3>
              <p className="text-xs text-muted-foreground">{t("Now, hourly, 7 days")}</p>
            </div>
          </div>
          <Field label={t("Temperature unit")} id="w-unit" hint={t("Every temperature on the phone follows this, whatever unit the source reports.")}>
            <SegmentedControl size="sm" aria-label={t("Temperature unit")} value={unit} options={[{ value: "c", label: "°C" }, { value: "f", label: "°F" }]}
              onValueChange={(v) => update((l) => { const th = { ...(l.theme ?? {}) }; if (v === "f") th.temperatureUnit = "f"; else delete th.temperatureUnit; return { ...l, theme: th }; })} />
          </Field>
          <div className="flex flex-col gap-2 rounded-xl border p-3 text-[13px]">
            <p className="text-muted-foreground">{t("The location is set on each Weather tile: pick the tile on the phone, then choose Automatic or search for a city.")}</p>
            <div><Button size="sm" variant="secondary" onClick={onGoScreens}>{t("Open Screens")}</Button></div>
          </div>
        </CardContent>
      </Card>
      {/* The agent's core.weather plugin: its on/off switch and settings, when this agent lists it. */}
      <PluginsPanel update={update} only="core.weather" quietIfMissing />
    </div>
  );
}
