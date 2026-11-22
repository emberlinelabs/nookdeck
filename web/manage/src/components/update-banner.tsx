import { useEffect, useState } from "react";
import { IconCheck as Check, IconCopy as Copy, IconExternalLink as Link, IconX as X } from "@tabler/icons-react";
import { api } from "@/api";
import { t, useLanguage } from "@/lib/i18n";
import type { UpdateInfo } from "@/types";

const COMMAND = "nookdeck update";
const KEY = "pd.manage.updateDismissed";

const read = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };

/** Shown above the tabs when the agent knows of a newer release. Hidden on an old agent (no /api/update), when off, or after dismissing that version. */
export function UpdateBanner({ repo, enabled }: { repo: string; enabled: boolean }) {
  useLanguage();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [gone, setGone] = useState<string | null>(read);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!enabled) { setInfo(null); return; }
    let live = true;
    api.getUpdate().then((u) => live && setInfo(u), () => undefined);
    return () => { live = false; };
  }, [enabled]);
  if (!enabled || !info?.available || !info.latest || gone === info.latest) return null;
  const latest = info.latest.replace(/^v/, "");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the command is shown, copy it by hand */ }
  };
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-primary/40 bg-primary/10 px-3.5 py-2.5 text-[13px]">
      <span className="font-medium">{t("Nookdeck {v} is available", { v: latest })}</span>
      <span className="text-muted-foreground">{t("You have {v}.", { v: info.current })}</span>
      <button type="button" onClick={() => void copy()} title={t("Copy the update command")} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 font-mono text-[12px] transition-colors hover:bg-muted">
        {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
        {COMMAND}
      </button>
      <a href={`${repo}/releases/tag/v${latest}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
        {t("Release notes")} <Link className="size-3.5" />
      </a>
      <button type="button" aria-label={t("Dismiss")} title={t("Dismiss")} className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted" onClick={() => { try { localStorage.setItem(KEY, info.latest!); } catch { /* ignore */ } setGone(info.latest); }}>
        <X className="size-4" />
      </button>
    </div>
  );
}
