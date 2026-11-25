import { useEffect, useRef, useState } from "react";
import { IconDownload as Download, IconPuzzle as Puzzle, IconRefresh as Refresh, IconRosetteDiscountCheck as Verified } from "@tabler/icons-react";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { TilePreview } from "@/components/tile-preview";
import { api } from "@/api";
import { osBadges, permChips, riskTone } from "@/lib/plugin-ui";
import { Row } from "@/components/plugin-view";
import { t, useLanguage } from "@/lib/i18n";
import type { RegistryEntry, RegistryManifest, Theme } from "@/types";

/** The button of a Store card: Add, Update, or a quiet "Installed". */
export function EntryButton({ entry, busy, onAdd, size = "sm" }: { entry: RegistryEntry; busy: boolean; onAdd: () => void; size?: "sm" | "xs" }) {
  useLanguage();
  if (entry.unavailable && (!entry.installed || entry.updateAvailable || entry.fromLink)) return <Button size={size} variant="secondary" disabled title={entry.unavailable} aria-label={`${entry.name}: ${entry.unavailable}`}>{entry.updateAvailable ? t("Update") : t("Add")}</Button>;
  if (entry.fromLink) return <Button size={size} loading={busy} icon={<Refresh />} onClick={onAdd} aria-label={t("Switch {name} to the reviewed version", { name: entry.name })}>{t("Switch to the reviewed version")}</Button>;
  if (entry.updateAvailable) return <Button size={size} loading={busy} icon={<Refresh />} onClick={onAdd} aria-label={t("Update {name}", { name: entry.name })}>{t("Update")}</Button>;
  if (entry.installed) return <Button size={size} variant="secondary" disabled aria-label={t("{name} is installed", { name: entry.name })}>{t("Installed")}</Button>;
  return <Button size={size} loading={busy} icon={<Download />} onClick={onAdd} aria-label={t("Add {name}", { name: entry.name })}>{t("Add")}</Button>;
}

/** One plugin of the Store: icon, name, author, a line about it, what it asks for, and its first tile as it looks on the phone. */
/** The manifest of a registry plugin, fetched once the card scrolls into view (the list itself carries no tiles). */
export function useLazyManifest(id: string): [React.RefObject<HTMLElement | null>, RegistryManifest | null] {
  const ref = useRef<HTMLElement | null>(null);
  const [man, setMan] = useState<RegistryManifest | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); api.getRegistryManifest(id).then((m) => live && setMan(m)); } });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [id]);
  return [ref, man];
}

const hueOf = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; };

/** One plugin of the Store as a cover card, like the website: its live tile on a coloured cover, then name, author, a line about it, what it asks for, and the primary button. */
export function EntryCard({ entry, theme, busy, onAdd, onOpen }: { entry: RegistryEntry; theme?: Theme; busy: boolean; onAdd: () => void; onOpen: () => void }) {
  useLanguage();
  const [ref, man] = useLazyManifest(entry.id);
  const perms = man?.permissions ?? entry.permissions;
  const chips = perms ? permChips(perms) : [];
  const first = man?.widgets[0];
  const os = osBadges(man?.os ?? entry.os);
  const unavailable = man?.unavailable ?? entry.unavailable;
  const h = hueOf(entry.id);
  return (
    <article ref={ref} className="group flex flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground transition-colors hover:border-foreground/30" aria-label={entry.name}>
      <button type="button" onClick={onOpen} tabIndex={-1} aria-hidden="true"
        className="relative grid min-h-32 place-items-center overflow-hidden p-4"
        style={{ background: `radial-gradient(120% 140% at 20% 0%, hsl(${h} 60% 30%), hsl(${(h + 40) % 360} 45% 11%) 70%)` }}>
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: "repeating-linear-gradient(90deg, rgb(255 255 255 / .05) 0 1px, transparent 1px 28px), repeating-linear-gradient(0deg, rgb(255 255 255 / .05) 0 1px, transparent 1px 28px)", WebkitMaskImage: "radial-gradient(circle at 50% 50%, #000, transparent 75%)", maskImage: "radial-gradient(circle at 50% 50%, #000, transparent 75%)" }} />
        {first ? <TilePreview pluginId={entry.id} widget={first} theme={theme} screenshot={entry.screenshot} className="relative w-full max-w-44" />
          : entry.screenshot ? <img src={entry.screenshot} alt="" loading="lazy" className="relative max-h-28 max-w-44 rounded-xl border" />
          : entry.icon && /^https:\/\//i.test(entry.icon) ? <img src={entry.icon} alt="" className="relative size-14 rounded-2xl object-cover" loading="lazy" />
          : <span className="relative grid size-14 place-items-center rounded-2xl text-2xl font-bold text-[#0b0d10]" style={{ background: `linear-gradient(145deg, hsl(${h} 85% 68%), hsl(${(h + 40) % 360} 80% 55%))` }}>{entry.name.slice(0, 1).toUpperCase()}</span>}
        <span className="absolute right-2.5 top-2.5 rounded-full border border-primary/70 bg-black/40 px-2 py-0.5 text-[11px] font-semibold text-primary">v{entry.version}</span>
      </button>
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="min-w-0">
          <button type="button" onClick={onOpen} className="flex max-w-full items-center gap-1.5 rounded text-left text-[15px] font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            <span className="truncate">{entry.name}</span>
            {entry.verified && <Verified className="size-4 flex-none text-primary" aria-label={t("Verified")} />}
          </button>
          <div className="truncate text-xs text-muted-foreground">{entry.author ?? ""}</div>
        </div>
        {entry.description && <p className="line-clamp-2 text-[13px] text-muted-foreground">{entry.description}</p>}
        <div className="flex flex-wrap gap-1.5">
          {os.map((n) => <Badge key={n} size="sm" tone="neutral">{n}</Badge>)}
          {!perms ? <span className="text-xs text-muted-foreground">…</span> : chips.length === 0 ? <Badge size="sm" tone="success" variant="outline">{t("No special access")}</Badge> : chips.map((c) => <Badge key={c.key} size="sm" tone={riskTone(c.risk)} variant="outline">{c.label}</Badge>)}
        </div>
        {entry.fromLink && <p className="text-xs text-muted-foreground">{t("You installed this from a link. The Store has a version Nookdeck checked. Your settings and tiles stay.")}</p>}
        {unavailable && <p className="text-xs text-muted-foreground">{unavailable}</p>}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
          <Button size="sm" variant="ghost" onClick={onOpen}>{t("Details")}</Button>
          <EntryButton entry={{ ...entry, unavailable }} busy={busy} onAdd={onAdd} />
        </div>
      </div>
    </article>
  );
}

/** One Store plugin as a compact row (no preview): icon, name and author, one line about it, access chips, and the action. */
export function EntryRow({ entry, busy, onAdd, onOpen }: { entry: RegistryEntry; busy: boolean; onAdd: () => void; onOpen: () => void }) {
  useLanguage();
  const [ref, man] = useLazyManifest(entry.id);
  const perms = man?.permissions ?? entry.permissions;
  const chips = perms ? permChips(perms) : [];
  const os = osBadges(man?.os ?? entry.os);
  const unavailable = man?.unavailable ?? entry.unavailable;
  return (
    <Row label={entry.name} onOpen={onOpen}>
      <span ref={ref as React.RefObject<HTMLSpanElement>} className="grid size-8 flex-none place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
        {entry.icon && /^https:\/\//i.test(entry.icon) ? <img src={entry.icon} alt="" className="size-full object-cover" loading="lazy" /> : <Puzzle className="size-4" />}
      </span>
      <div className="min-w-0 basis-40 flex-1">
        <button type="button" onClick={onOpen} className="flex max-w-full items-center gap-1.5 rounded text-left text-[13.5px] font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          <span className="truncate">{entry.name}</span>
          {entry.verified && <Verified className="size-3.5 flex-none text-primary" aria-label={t("Verified")} />}
        </button>
        <div className="truncate text-xs text-muted-foreground">{entry.author ? `${entry.author} · ` : ""}v{entry.version}</div>
      </div>
      <p className="min-w-0 basis-56 flex-[2] truncate text-[13px] text-muted-foreground">{entry.description}</p>
      <div className="flex flex-wrap items-center gap-1">
        {os.map((n) => <Badge key={n} size="sm" tone="neutral" title={unavailable}>{n}</Badge>)}
        {perms && chips.length === 0 ? <span className="text-xs text-muted-foreground">{t("No special access")}</span> : chips.map((c) => <Badge key={c.key} size="sm" tone={riskTone(c.risk)} variant="outline">{c.label}</Badge>)}
      </div>
      <div className="ml-auto flex-none"><EntryButton entry={{ ...entry, unavailable }} busy={busy} onAdd={onAdd} size="xs" /></div>
    </Row>
  );
}
