import { useEffect, useRef, useState } from "react";
import { IconDownload as Download, IconPuzzle as Puzzle, IconRefresh as Refresh, IconRosetteDiscountCheck as Verified } from "@tabler/icons-react";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { TilePreview } from "@/components/tile-preview";
import { api } from "@/api";
import { permChips, riskTone } from "@/lib/plugin-ui";
import { Row } from "@/components/plugin-view";
import { t, useLanguage } from "@/lib/i18n";
import type { RegistryEntry, RegistryManifest, Theme } from "@/types";

/** The button of a Store card: Add, Update, or a quiet "Installed". */
export function EntryButton({ entry, busy, onAdd, size = "sm" }: { entry: RegistryEntry; busy: boolean; onAdd: () => void; size?: "sm" | "xs" }) {
  useLanguage();
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

export function EntryCard({ entry, theme, busy, onAdd, onOpen }: { entry: RegistryEntry; theme?: Theme; busy: boolean; onAdd: () => void; onOpen: () => void }) {
  useLanguage();
  const [ref, man] = useLazyManifest(entry.id);
  const perms = man?.permissions ?? entry.permissions;
  const chips = perms ? permChips(perms) : [];
  const first = man?.widgets[0];
  return (
    <article ref={ref} className="flex flex-col gap-3 rounded-2xl border bg-card p-3.5 text-card-foreground" aria-label={entry.name}>
      <div className="flex items-start gap-3">
        <div className="grid size-10 flex-none place-items-center overflow-hidden rounded-xl bg-muted text-muted-foreground">
          {entry.icon && /^https:\/\//i.test(entry.icon) ? <img src={entry.icon} alt="" className="size-full object-cover" loading="lazy" /> : <Puzzle className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onOpen} className="flex max-w-full items-center gap-1.5 rounded text-left font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            <span className="truncate">{entry.name}</span>
            {entry.verified && <Verified className="size-4 flex-none text-primary" aria-label={t("Verified")} />}
          </button>
          <div className="truncate text-xs text-muted-foreground">{entry.author ?? ""}{entry.author ? " · " : ""}v{entry.version}</div>
        </div>
      </div>
      {entry.description && <p className="line-clamp-2 text-[13px] text-muted-foreground">{entry.description}</p>}
      {first && <TilePreview pluginId={entry.id} widget={first} theme={theme} screenshot={entry.screenshot} className="max-w-48" />}
      {man && !first && man.actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={t("Buttons it adds")}>
          {man.actions.slice(0, 4).map((a) => <span key={a.id} className="rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs">{a.name}</span>)}
        </div>
      )}
      {!man && !entry.screenshot ? null : !first && !man?.actions.length && entry.screenshot ? <img src={entry.screenshot} alt="" loading="lazy" className="max-w-48 rounded-xl border" /> : null}
      <div className="flex flex-wrap gap-1.5">
        {!perms ? <span className="text-xs text-muted-foreground">…</span> : chips.length === 0 ? <span className="text-xs text-muted-foreground">{t("No special access")}</span> : chips.map((c) => <Badge key={c.key} size="sm" tone={riskTone(c.risk)} variant="outline">{c.label}</Badge>)}
      </div>
      {entry.fromLink && <p className="text-xs text-muted-foreground">{t("You installed this from a link. The Store has a version Nookdeck checked. Your settings and tiles stay.")}</p>}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onOpen}>{t("Details")}</Button>
        <EntryButton entry={entry} busy={busy} onAdd={onAdd} />
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
        {perms && chips.length === 0 ? <span className="text-xs text-muted-foreground">{t("No special access")}</span> : chips.map((c) => <Badge key={c.key} size="sm" tone={riskTone(c.risk)} variant="outline">{c.label}</Badge>)}
      </div>
      <div className="ml-auto flex-none"><EntryButton entry={entry} busy={busy} onAdd={onAdd} size="xs" /></div>
    </Row>
  );
}
