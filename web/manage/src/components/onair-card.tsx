/** Plugins > On Air: which sources turn it on, and whether Nookdeck's own use counts. Works without OBS. */
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/knowns/alert";
import { Badge } from "@/components/ui/knowns/badge";
import { Card, CardContent } from "@/components/ui/knowns/card";
import { Spinner } from "@/components/ui/knowns/spinner";
import { Switch } from "@/components/ui/knowns/switch";
import { ApiError } from "@/api";
import { Icon } from "@/components/icon";
import { t, useLanguage } from "@/lib/i18n";
import { liveApi, type OnAirStatus } from "@/lib/live";
import type { OnAirSettings } from "@shared/onair";

type SourceKey = keyof OnAirSettings["sources"];
const SOURCES: { key: SourceKey; label: string; hint: string }[] = [
  { key: "obs", label: "OBS plugin: streaming or recording", hint: "Needs the OBS plugin from the Store." },
  { key: "mic", label: "Microphone in use", hint: "Any app using the computer's mic: Zoom, Meet, Teams, Discord..." },
  { key: "camera", label: "Camera in use", hint: "Any app using a camera." },
  { key: "manual", label: "On Air button", hint: "A button on the phone turns it on and off." },
  { key: "api", label: "Webhook and API", hint: "POST /api/onair with the webhook key, from a script, Streamlabs, vMix or Home Assistant." },
];
const SOURCE_TEXT: Record<string, string> = { "obs-stream": "Live", "obs-record": "Recording", mic: "Mic", camera: "Camera", manual: "Manual", api: "API" };

export function OnAirCard() {
  useLanguage();
  const [st, setSt] = useState<OnAirStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await liveApi.getOnAir());
      setMissing(false);
    } catch (e) {
      setMissing(e instanceof ApiError && e.status === 404);
      if (!(e instanceof ApiError && e.status === 404)) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const iv = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(iv);
  }, [load]);

  const save = async (next: OnAirSettings) => {
    if (!st) return;
    const prev = st;
    setSt({ ...st, settings: next }); // the switch moves at once; rolled back when the agent refuses
    setSaving(true);
    setError(null);
    try {
      const r = await liveApi.putOnAirSettings(next);
      if (r) setSt(r);
    } catch (e) {
      setSt(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const s = st?.settings;
  const on = st?.state.on;
  const why = st?.state.sources.map((x) => (x === "api" && st.state.label ? st.state.label : t(SOURCE_TEXT[x] ?? x))).join(", ");

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl border bg-muted/50"><Icon name="radio" size={22} /></span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold leading-tight">On Air</h3>
            <p className="text-xs text-muted-foreground">{t("A red light on the phone while you are live, recording or in a call")}</p>
          </div>
          {missing ? <Badge tone="neutral" dot>{t("Agent not supported")}</Badge>
            : !st ? <Spinner label={t("Loading")} />
            : on ? <Badge tone="danger" dot>{t("On Air")}{why ? ` · ${why}` : ""}</Badge>
            : <Badge tone="neutral" dot>{t("Off air")}</Badge>}
        </div>

        {missing && <Alert tone="info">{t("This agent does not have /api/onair yet (404). Update the agent and reload the page.")}</Alert>}
        {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}

        {s && (
          <>
            <h4 className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("Turns on from")}</h4>
            <div className="flex flex-col divide-y rounded-xl border">
              {SOURCES.map((src) => (
                <div key={src.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <label htmlFor={`oa-${src.key}`} className="min-w-0 text-[13px] font-medium">
                    {t(src.label)}
                    <span className="block text-xs font-normal text-muted-foreground">{t(src.hint)}</span>
                  </label>
                  <Switch id={`oa-${src.key}`} checked={s.sources[src.key]} disabled={saving} aria-label={t(src.label)}
                    onCheckedChange={(v) => void save({ ...s, sources: { ...s.sources, [src.key]: v } })} />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
              <label htmlFor="oa-self" className="min-w-0 text-[13px] font-medium">
                {t("Ignore Nookdeck's own use")}
                <span className="block text-xs font-normal text-muted-foreground">{t("Mic or camera use by Nookdeck itself does not turn On Air on.")}</span>
              </label>
              <Switch id="oa-self" checked={s.ignoreSelf} disabled={saving} aria-label={t("Ignore Nookdeck's own use")} onCheckedChange={(v) => void save({ ...s, ignoreSelf: v })} />
            </div>
            <p className="text-xs text-muted-foreground">
              {t("Add an On Air tile from the palette (On Air). To turn a spare phone into a sign by the door, open Screen & alarms on that phone and switch on Full-screen ON AIR.")}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
