import { useCallback, useEffect, useState } from "react";
import { IconPlayerStop as Stop, IconRefresh as Refresh } from "@tabler/icons-react";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { api } from "@/api";
import { t, useLanguage } from "@/lib/i18n";
import type { PluginInfo, PluginProcess } from "@/types";

const TONE = { running: "success", stopped: "neutral", crashed: "danger", failed: "danger" } as const;
const LABEL = (s: PluginProcess["state"]): string => s === "running" ? t("Running") : s === "stopped" ? t("Stopped") : s === "crashed" ? t("Crashed") : t("Failed");

function ago(since?: number): string {
  if (!since) return "";
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? t("{n} s", { n: s }) : s < 3600 ? t("{n} min", { n: Math.round(s / 60) }) : t("{n} h", { n: Math.round(s / 3600) });
}

/** The process of a code plugin: its state, the last 50 log lines, restart and stop. Renders nothing for a plugin without code or on an agent without these endpoints. */
export function PluginProcessPanel({ plugin: p, onError }: { plugin: PluginInfo; onError: (e: unknown) => void }) {
  useLanguage();
  const [proc, setProc] = useState<PluginProcess | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState<"restart" | "stop" | null>(null);

  const load = useCallback(async () => {
    try {
      setProc(await api.getPluginProcess(p.id));
      if (showLog) setLines(await api.getPluginLogs(p.id, 50));
    } catch { /* the next poll tries again */ }
  }, [p.id, showLog]);

  useEffect(() => {
    if (!p.code || !p.enabled) return;
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [p.code, p.enabled, load]);

  if (!p.code || !p.enabled || !proc) return null;
  const act = async (kind: "restart" | "stop") => {
    setBusy(kind);
    try { await (kind === "restart" ? api.restartPlugin(p.id) : api.stopPlugin(p.id)); await load(); } catch (e) { onError(e); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium">{t("Process")}</span>
        <Badge size="sm" tone={TONE[proc.state]} dot>{LABEL(proc.state)}</Badge>
        {proc.startedAt ? <span className="text-xs text-muted-foreground">{t("for {time}", { time: ago(proc.startedAt) })}</span> : null}
        {proc.state === "crashed" && proc.restarts ? <span className="text-xs text-muted-foreground">{t("{n} crashes in a row", { n: proc.restarts })}</span> : null}
        <div className="ml-auto flex gap-1.5">
          <Button size="xs" variant="secondary" icon={<Refresh />} loading={busy === "restart"} onClick={() => void act("restart")}>{t("Restart")}</Button>
          <Button size="xs" variant="secondary" icon={<Stop />} loading={busy === "stop"} disabled={proc.state === "stopped"} onClick={() => void act("stop")}>{t("Stop")}</Button>
        </div>
      </div>
      {proc.lastError && <p className="text-xs text-destructive">{proc.lastError}</p>}
      <button type="button" className="w-fit text-xs underline underline-offset-2 hover:text-foreground" aria-expanded={showLog} onClick={() => { setShowLog((o) => !o); if (!showLog) void api.getPluginLogs(p.id, 50).then(setLines, onError); }}>
        {showLog ? t("Hide log") : t("Show log (last 50 lines)")}
      </button>
      {showLog && (
        <pre tabIndex={0} aria-label={t("Plugin log")} className="max-h-56 overflow-auto rounded-lg bg-muted p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all">{lines === null ? t("Loading") : lines.length ? lines.join("\n") : t("No log lines yet.")}</pre>
      )}
    </div>
  );
}
