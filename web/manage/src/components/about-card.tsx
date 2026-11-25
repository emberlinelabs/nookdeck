import { useEffect, useState } from "react";
import { IconCheck as Check, IconCoffee as Coffee, IconCopy as Copy, IconExternalLink as Link, IconStar as Star } from "@tabler/icons-react";
import { api } from "@/api";
import { Button } from "@/components/ui/knowns/button";
import { Card, CardContent } from "@/components/ui/knowns/card";
import { aboutLine, osName } from "@/lib/about";
import { getLanguage, t, useLanguage } from "@/lib/i18n";
import { GITHUB_URL, KOFI_URL } from "@/lib/support";
import type { About, UpdateInfo } from "@/types";

function fmtDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(getLanguage() === "vi" ? "vi-VN" : getLanguage() === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function AboutCard({ about }: { about: About | null }) {
  useLanguage();
  const [copied, setCopied] = useState(false);
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const check = async () => {
    setChecking(true); setFailed(false);
    try { setUpd(await api.getUpdate()); } catch { setFailed(true); } finally { setChecking(false); }
  };
  useEffect(() => { void check(); }, []);
  if (!about) return null;
  const rows: [string, string | undefined][] = [
    [t("Version"), about.version],
    [t("Commit"), about.commit],
    [t("Built"), fmtDate(about.buildDate)],
    [t("System"), osName(about)],
  ];
  const links: [string, string][] = [
    [t("Website"), "https://nookdeck.app"],
    [t("Source code on GitHub"), about.repo],
    [t("Releases"), `${about.repo}/releases`],
    [t("Report an issue"), `${about.repo}/issues`],
    [t("Privacy"), `${about.repo}/blob/main/PRIVACY.md`],
    [t("MIT License"), `${about.repo}/blob/main/LICENSE`],
  ];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(aboutLine(about));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };
  return (
    <Card id="about" className="max-w-3xl">
      <CardContent className="flex flex-col gap-3 p-4">
        <h3 className="text-[15px] font-semibold">{t("About Nookdeck")}</h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
          {rows.filter(([, v]) => v).map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="font-mono text-xs">{v}</dd></div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
          <span className="text-muted-foreground">{t("Updates")}</span>
          <span>{failed || upd?.error ? t("Could not check for updates.") : !upd ? t("Checking...") : upd.available && upd.latest ? t("Nookdeck {v} is available", { v: upd.latest.replace(/^v/, "") }) : t("You are up to date.")}</span>
          <Button size="xs" variant="secondary" loading={checking} onClick={() => void check()}>{t("Check for updates")}</Button>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {([[t("Star on GitHub"), GITHUB_URL, Star], [t("Support on Ko-fi"), KOFI_URL, Coffee]] as const).map(([label, href, Icon]) => (
            <a key={href} href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[13px] font-medium underline underline-offset-2 hover:text-foreground">
              <Icon className="size-3.5" />{label}
            </a>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {links.map(([label, href]) => (
            <a key={href} href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[13px] underline underline-offset-2 hover:text-foreground">
              <Link className="size-3.5" />{label}
            </a>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("Formerly PhoneDesk. Existing installs migrate automatically on update.")}</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 select-all truncate rounded-lg bg-muted px-2.5 py-1.5 text-xs">{aboutLine(about)}</code>
          <Button size="sm" variant="secondary" icon={copied ? <Check /> : <Copy />} onClick={() => void copy()}>{copied ? t("Copied") : t("Copy for bug report")}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
