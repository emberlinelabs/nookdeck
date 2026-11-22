import { useCallback, useEffect, useMemo, useState } from "react";
import { IconCheck as Check, IconLink as LinkIcon, IconPalette as Palette, IconSearch as Search, IconTrash as Trash } from "@tabler/icons-react";
import { api, ApiError } from "@/api";
import { Alert } from "@/components/ui/knowns/alert";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { Dialog } from "@/components/ui/knowns/dialog";
import { Empty } from "@/components/ui/knowns/empty";
import { Field, Input } from "@/components/ui/knowns/input";
import { Select } from "@/components/ui/knowns/select";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { Sheet } from "@/components/ui/knowns/sheet";
import { Spinner } from "@/components/ui/knowns/spinner";
import { Switch } from "@/components/ui/knowns/switch";
import { PresetThumb } from "@/components/theme-panel";
import { VariantMini } from "@/components/variant-mini";
import { ScreenThumb } from "@/components/screen-thumb";
import { packLook, previewPage, themeWithPack, type PackChoice } from "@/lib/pack-preview";
import { t, useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Layout, ThemeOptionValue, ThemePack, ThemeSource, Theme } from "@/types";

type Tab = "discover" | "installed";

/** Where a package file is served from (the agent serves installed packs' files). */
const fileUrl = (id: string, path: string) => (/^https?:\/\//.test(path) ? path : `/api/themes/${encodeURIComponent(id)}/files/${path.split("/").map(encodeURIComponent).join("/")}`);

/** The variants as little colour chips: background, tile and accent of each. */
/** The user's own screen in this pack (their first screen with tiles), or the pack's preview picture, or a small sample, when there is nothing to draw. */
function PackShot({ layout, pack, choice, pageId, fallback }: { layout: Layout; pack: ThemePack; choice: PackChoice; pageId?: string; fallback?: string }) {
  const pp = useMemo(() => previewPage(layout, pageId), [layout, pageId]);
  const themed = useMemo(() => (pack.installed && pp && !pp.empty ? { ...layout, theme: themeWithPack(layout.theme, pack, choice) } : null), [layout, pack, choice, pp]);
  if (themed && pp) return <ScreenThumb layout={themed} pageId={pp.page.id} label={t("{name} on your screen", { name: pack.name })} />;
  const v = pack.variants.find((x) => x.id === choice.variant) ?? pack.variants[0];
  if (fallback && pack.installed) return <img src={fileUrl(pack.id, fallback)} alt="" loading="lazy" className="aspect-[844/390] w-full rounded-[10px] border object-cover" />;
  return v ? <PresetThumb theme={{ ...(packLook(pack, v.id, choice.options) as Theme) }} /> : <span className="aspect-[844/390] w-full rounded-lg border bg-muted" />;
}

function PackCard({ pack, layout, applied, onOpen, busy, onPrimary }: { pack: ThemePack; layout: Layout; applied: ThemeSource | null; onOpen: () => void; busy: boolean; onPrimary: () => void }) {
  const first = pack.variants[0];
  const previewPath = pack.preview ?? first?.preview;
  const choice = useMemo<PackChoice>(() => { const c = initialChoice(pack, applied); return { variant: c.variant, ...(c.auto ? { auto: { light: c.light, dark: c.dark } } : {}), options: c.options }; }, [pack, applied]);
  return (
    <article className={cn("flex flex-col gap-2 rounded-xl border p-3 transition-colors hover:bg-muted/50", pack.applied && "border-primary ring-1 ring-primary")}>
      <button type="button" onClick={onOpen} className="flex flex-col gap-2 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("Details of {name}", { name: pack.name })}>
        <PackShot layout={layout} pack={pack} choice={choice} fallback={previewPath} />
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13.5px] font-medium">{pack.name}</span>
          {pack.builtin && <Badge size="sm" tone="neutral">{t("Built-in")}</Badge>}
          {pack.hasCss && <Badge size="sm" tone="warning">{t("Custom CSS")}</Badge>}
          {pack.applied && <Badge size="sm" tone="success" icon={<Check />}>{t("In use")}</Badge>}
          {pack.updateAvailable && <Badge size="sm" tone="info">{t("Update")}</Badge>}
        </span>
        <span className="text-[11.5px] text-muted-foreground">{pack.author ? `${pack.author} · ` : ""}v{pack.version}{pack.variants.length > 1 ? ` · ${t("{n} variants", { n: pack.variants.length })}` : ""}</span>
        {pack.description && <span className="line-clamp-2 text-[12.5px]">{pack.description}</span>}
      </button>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-[11.5px] text-muted-foreground">{pack.installed ? t("Installed") : ""}</span>
        {!pack.installed ? <Button size="sm" variant="primary" loading={busy} onClick={onPrimary}>{t("Install")}</Button> : <Button size="sm" variant="secondary" onClick={onOpen}>{t("Details")}</Button>}
      </div>
    </article>
  );
}

/** Installed packs as a compact management list: version, update, details and remove. Applying happens on the Customize tab. */
function InstalledRow({ pack, busy, onOpen, onUpdate, onRemove }: { pack: ThemePack; busy: boolean; onOpen: () => void; onUpdate: () => void; onRemove: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3 py-2.5">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("Details of {name}", { name: pack.name })}>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13.5px] font-medium">{pack.name}</span>
          {pack.builtin && <Badge size="sm" tone="neutral">{t("Built-in")}</Badge>}
          {pack.hasCss && <Badge size="sm" tone="warning">{t("Custom CSS")}</Badge>}
          {pack.applied && <Badge size="sm" tone="success" icon={<Check />}>{t("In use")}</Badge>}
          {pack.updateAvailable && <Badge size="sm" tone="info">{t("Update")}</Badge>}
        </span>
        <span className="text-[11.5px] text-muted-foreground">{pack.author ? `${pack.author} · ` : ""}v{pack.installedVersion ?? pack.version}{pack.variants.length > 1 ? ` · ${t("{n} variants", { n: pack.variants.length })}` : ""}</span>
      </button>
      <div className="flex items-center gap-1.5">
        {pack.updateAvailable && <Button size="sm" variant="primary" loading={busy} onClick={onUpdate}>{t("Update")}</Button>}
        <Button size="sm" variant="secondary" onClick={onOpen}>{t("Details")}</Button>
        {!pack.builtin && <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>{t("Remove")}</Button>}
      </div>
    </li>
  );
}

/** What to apply: one variant or Auto (a light and a dark one), and the pack's choices (such as the accent). */
interface Choice { variant: string; auto: boolean; light: string; dark: string; options: Record<string, string> }

function initialChoice(p: ThemePack, applied: ThemeSource | null): Choice {
  const mine = applied && applied.pack.split("@")[0] === p.id ? applied : null;
  const light = mine?.auto?.light ?? p.auto?.light ?? p.variants.find((v) => v.mode === "light")?.id ?? p.variants[0]?.id ?? "";
  const dark = mine?.auto?.dark ?? p.auto?.dark ?? p.variants.find((v) => v.mode === "dark")?.id ?? p.variants[0]?.id ?? "";
  return { variant: mine?.variant ?? p.variants[0]?.id ?? "", auto: !!mine?.auto, light, dark, options: { ...(mine?.options ?? {}) } };
}

/** The accent of an option value for one variant, when the pack says (so the swatch is the real colour). */
function valueColor(v: ThemeOptionValue, variantId: string | undefined): string | undefined {
  const l = (variantId && v.variants?.[variantId]) || v.theme;
  return l?.accent;
}

/** True when this variant of this pack is what is applied now. */
export function isCurrent(applied: ThemeSource | null, pack: ThemePack, variantId: string): boolean {
  return !!applied && applied.pack.split("@")[0] === pack.id && (applied.variant === variantId || applied.auto?.light === variantId || applied.auto?.dark === variantId);
}

function PackSheet({ pack, layout, applied, onClose, busy, onInstall, onApply, onRemove }: {
  pack: ThemePack | null; layout: Layout; applied: ThemeSource | null; onClose: () => void; busy: boolean;
  onInstall: (p: ThemePack) => void; onApply: (p: ThemePack, c: Choice) => void; onRemove: (p: ThemePack) => void;
}) {
  useLanguage();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [screenId, setScreenId] = useState<string | undefined>(undefined);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => { setChoice(pack ? initialChoice(pack, applied) : null); setScreenId(undefined); }, [pack?.id, pack?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pack || !choice) return <Sheet open={false} onOpenChange={() => onClose()} side="right" size="lg" label={t("Theme details")}>{null}</Sheet>;
  const modeVariants = (m: "light" | "dark") => pack.variants.filter((v) => v.mode === m);
  const canAuto = modeVariants("light").length > 0 && modeVariants("dark").length > 0;
  const activeVariant = choice.auto ? undefined : choice.variant;
  const set = (patch: Partial<Choice>) => setChoice({ ...choice, ...patch });
  const shown: PackChoice = { variant: hover && !choice.auto ? hover : choice.variant, ...(choice.auto ? { auto: { light: choice.light, dark: choice.dark } } : {}), options: choice.options };
  const footer = !pack.installed ? (
    <Button loading={busy} onClick={() => onInstall(pack)}>{t("Install")}</Button>
  ) : (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      {pack.builtin ? <span /> : <Button variant="ghost" icon={<Trash />} onClick={() => onRemove(pack)}>{t("Remove")}</Button>}
      <Button loading={busy} onClick={() => onApply(pack, choice)}>{pack.appliedOlder ? t("Re-apply") : t("Apply")}</Button>
    </div>
  );
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} side="right" size="lg" label={pack.name} footer={footer}
      title={<span className="flex flex-wrap items-center gap-2">{pack.name}{pack.builtin && <Badge size="sm" tone="neutral">{t("Built-in")}</Badge>}{pack.hasCss && <Badge size="sm" tone="warning">{t("Custom CSS")}</Badge>}{pack.applied && <Badge size="sm" tone="success">{t("In use")}</Badge>}</span>}
      description={`v${pack.version}${pack.author ? ` · ${pack.author}` : ""}`}>
      <div className="flex flex-col gap-5 pb-2 text-[13px]">
        {pack.description && <p className="text-[13.5px]">{pack.description}</p>}
        {pack.hasCss && <Alert tone="warning">{t("This theme adds its own styling (CSS). It cannot run code. You can always switch it off with safe mode or remove it.")}</Alert>}

        {pack.installed && (
          <section aria-label={t("Preview")} className="flex flex-col gap-2">
            <PackShot layout={layout} pack={pack} pageId={screenId} choice={shown} fallback={pack.preview} />
            {layout.pages.length > 1 && (
              <Field label={t("Preview on screen")} id="ts-screen">
                <Select id="ts-screen" value={previewPage(layout, screenId)?.page.id ?? ""} onChange={(e) => setScreenId(e.target.value)} options={layout.pages.map((p) => ({ value: p.id, label: p.name || p.id }))} />
              </Field>
            )}
          </section>
        )}
        <section aria-labelledby="ts-variants" className="flex flex-col gap-2">
          <h3 id="ts-variants" className="text-[13px] font-semibold">{pack.variants.length > 1 ? t("Variants") : t("Look")}</h3>
          <div role="radiogroup" aria-label={t("Variants")} className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {pack.variants.map((v) => (
              <VariantMini key={v.id} look={packLook(pack, v.id, choice.options)} name={v.name} mode={v.mode} picked={!choice.auto && choice.variant === v.id}
                current={isCurrent(applied, pack, v.id)} disabled={choice.auto} onPick={() => set({ variant: v.id })} onHover={(on) => setHover(on ? v.id : null)} />
            ))}
          </div>
          {canAuto && (
            <div className="flex flex-col gap-2 rounded-lg border p-2.5">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="ts-auto" className="text-[13px] font-medium">{t("Auto (light/dark)")}</label>
                <Switch id="ts-auto" checked={choice.auto} onCheckedChange={(v) => set({ auto: v })} aria-label={t("Auto (light/dark)")} />
              </div>
              <p className="text-xs text-muted-foreground">{t("Follows the phone's light or dark setting.")}</p>
              {choice.auto && (
                <div className="flex flex-col gap-2">
                  {(["light", "dark"] as const).map((m) => (
                    <div key={m} role="radiogroup" aria-label={m === "light" ? t("Light") : t("Dark")} className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">{m === "light" ? t("Light") : t("Dark")}</span>
                      <div className="grid grid-cols-3 gap-2">
                        {modeVariants(m).map((v) => (
                          <VariantMini key={v.id} small look={packLook(pack, v.id, choice.options)} name={v.name} mode={v.mode} picked={(m === "light" ? choice.light : choice.dark) === v.id}
                            onPick={() => set(m === "light" ? { light: v.id } : { dark: v.id })} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {pack.options.map((o) => {
          const cur = choice.options[o.id];
          const ref = activeVariant ?? choice.dark;
          return (
            <section key={o.id} aria-labelledby={`ts-opt-${o.id}`} className="flex flex-col gap-2">
              <h3 id={`ts-opt-${o.id}`} className="text-[13px] font-semibold">{o.name}</h3>
              <div role="radiogroup" aria-label={o.name} className="flex flex-wrap gap-1.5">
                <button type="button" role="radio" aria-checked={!cur} onClick={() => { const n = { ...choice.options }; delete n[o.id]; set({ options: n }); }}
                  className={cn("flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", !cur && "border-primary bg-primary/10 font-medium")}>{t("Default")}</button>
                {o.values.map((val) => {
                  const c = valueColor(val, ref);
                  const on = cur === val.id;
                  return (
                    <button key={val.id} type="button" role="radio" aria-checked={on} title={val.name} onClick={() => set({ options: { ...choice.options, [o.id]: val.id } })}
                      className={cn("flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", on && "border-primary bg-primary/10 font-medium")}>
                      {c && <span className="size-3.5 rounded-full border border-black/20" style={{ background: c }} />}
                      {val.name}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}

        {(pack.fonts.length > 0 || pack.icons.length > 0 || pack.hasCss) && (
          <section aria-labelledby="ts-has" className="flex flex-col gap-1.5">
            <h3 id="ts-has" className="text-[13px] font-semibold">{t("What it includes")}</h3>
            <ul className="flex flex-col gap-0.5 text-muted-foreground">
              {pack.fonts.length > 0 && <li>{t("Fonts")}: {pack.fonts.join(", ")}</li>}
              {pack.icons.length > 0 && <li>{t("Icons")}: {pack.icons.length > 6 ? `${pack.icons.slice(0, 6).join(", ")} +${pack.icons.length - 6}` : pack.icons.join(", ")}</li>}
              {pack.hasCss && <li>{t("Custom CSS")}</li>}
            </ul>
          </section>
        )}
        <p className="text-xs text-muted-foreground">{t("Applying changes the look only. Your language, orientation, top bar and screen settings stay as they are, and so do per-tile colors. You can undo it right after.")}</p>
      </div>
    </Sheet>
  );
}

/** The Themes page: find theme packs, install them, apply one (with undo) and remove them. */
export function ThemesStore({ layout, beforeApply, deeplinkId, onDeeplinkDone, onLayoutChanged }: { layout: Layout; beforeApply?: () => Promise<void>; deeplinkId?: string | null; onDeeplinkDone?: () => void; onLayoutChanged: () => void }) {
  useLanguage();
  const [tab, setTab] = useState<Tab>("discover");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ packs: ThemePack[]; applied: ThemeSource | null } | null | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; undo?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const load = useCallback(() => { api.getThemes().then(setData, (e) => { setData(null); setError(e instanceof Error ? e.message : String(e)); }); }, []);
  useEffect(load, [load]);
  useEffect(() => { if (!notice?.undo) return; const timer = setTimeout(() => setNotice(null), 15000); return () => clearTimeout(timer); }, [notice]);
  // A deeplink opens that pack's details; the user presses Install or Apply.
  useEffect(() => {
    if (!deeplinkId || !data) return;
    const p = data.packs.find((x) => x.id === deeplinkId);
    onDeeplinkDone?.();
    if (p) { setTab(p.installed ? "installed" : "discover"); setOpenId(p.id); } else setError(t("That theme is not in the Store, so nothing was installed."));
  }, [deeplinkId, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLowerCase();
  const packs = data?.packs ?? [];
  const list = useMemo(() => packs.filter((p) => (tab === "installed" ? p.installed : true) && (!q || `${p.name} ${p.author ?? ""} ${p.description ?? ""}`.toLowerCase().includes(q))), [packs, tab, q]);
  const installedCount = packs.filter((p) => p.installed).length;
  const open = packs.find((p) => p.id === openId) ?? null;
  const fail = (e: unknown) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));

  const apply = async (p: ThemePack, c: Choice) => {
    setBusy(p.id); setError(null);
    try {
      await beforeApply?.();
      const body = c.auto ? { auto: { light: c.light, dark: c.dark } } : { variant: c.variant };
      await api.applyTheme(p.id, { ...body, ...(Object.keys(c.options).length ? { options: c.options } : {}) });
      setNotice({ text: t("{name} is applied.", { name: p.name }), undo: true });
      setOpenId(null); load(); onLayoutChanged();
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const install = async (p: ThemePack, thenApply = false) => {
    setBusy(p.id); setError(null);
    try {
      const got = await api.installTheme({ id: p.id });
      load();
      if (thenApply && got) await apply(got, initialChoice(got, data?.applied ?? null));
      else setNotice({ text: t("{name} is installed.", { name: p.name }) });
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const primary = (p: ThemePack) => (!p.installed ? void install(p, true) : p.applied && !p.appliedOlder ? setOpenId(p.id) : void apply(p, initialChoice(p, data?.applied ?? null)));
  const remove = async (p: ThemePack) => {
    setBusy(p.id); setError(null);
    try { await api.removeTheme(p.id); setNotice({ text: t("{name} was removed.", { name: p.name }) }); setOpenId(null); load(); onLayoutChanged(); } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const undo = async () => {
    setNotice(null);
    try { await api.undoLayout(); setNotice({ text: t("Undone.") }); load(); onLayoutChanged(); } catch (e) { fail(e); }
  };

  if (data === undefined) return <div className="grid place-items-center py-16"><Spinner /></div>;
  if (data === null) return <Empty icon={<Palette />} title={t("Themes are not available yet")} description={error ?? t("This version of Nookdeck cannot list theme packs. Update Nookdeck to use them.")} />;
  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("A theme pack changes how every tile looks. Apply one, or pick a variant, and undo it if you do not like it.")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1"><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search themes")} aria-label={t("Search themes")} icon={<Search />} /></div>
        <Button size="sm" variant="secondary" icon={<LinkIcon />} onClick={() => setLinkOpen(true)}>{t("Install from a link")}</Button>
        <SegmentedControl size="sm" aria-label={t("Themes")} value={tab} onValueChange={(v) => setTab(v as Tab)}
          options={[{ value: "discover", label: t("Discover") }, { value: "installed", label: `${t("Installed")} (${installedCount})` }]} />
      </div>
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)} action={notice.undo ? { label: t("Undo"), onClick: () => void undo() } : undefined}>{notice.text}</Alert>}
      {list.length === 0 ? (
        <Empty icon={<Palette />} title={q ? t("No theme matches") : tab === "installed" ? t("No themes installed yet") : t("No themes to show")} description={q ? t("Try another word.") : t("Themes you install show up here.")} />
      ) : tab === "installed" ? (
        <ul className="flex flex-col gap-2">
          {[...list].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)).map((p) => <InstalledRow key={p.id} pack={p} busy={busy === p.id} onOpen={() => setOpenId(p.id)} onUpdate={() => void install(p, false)} onRemove={() => void remove(p)} />)}
        </ul>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => <PackCard key={p.id} pack={p} layout={layout} applied={data.applied} busy={busy === p.id} onOpen={() => setOpenId(p.id)} onPrimary={() => primary(p)} />)}
        </div>
      )}
      <Dialog open={linkOpen} onOpenChange={setLinkOpen} title={t("Install a theme from a link")} description={t("Paste the address of a theme on GitHub, or a folder on this computer. Themes cannot run code, but check where it comes from.")} size="md">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void (async () => {
          const src = linkText.trim(); if (!src) return;
          setLinkBusy(true); setError(null);
          try { const got = await api.installTheme({ source: src }); setLinkOpen(false); setLinkText(""); load(); setNotice({ text: t("{name} is installed.", { name: got?.name ?? src }) }); if (got) { setTab("installed"); setOpenId(got.id); } } catch (er) { fail(er); setLinkOpen(false); } finally { setLinkBusy(false); }
        })(); }}>
          <Field label={t("Address or folder")} id="ts-link"><Input id="ts-link" value={linkText} onChange={(e) => setLinkText(e.target.value)} placeholder="https://github.com/you/your-theme" data-autofocus /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setLinkOpen(false)}>{t("Cancel")}</Button><Button type="submit" loading={linkBusy} disabled={!linkText.trim()}>{t("Install")}</Button></div>
        </form>
      </Dialog>
      <PackSheet pack={open} layout={layout} applied={data.applied} busy={!!open && busy === open.id} onClose={() => setOpenId(null)} onInstall={(p) => void install(p)} onApply={(p, c) => void apply(p, c)} onRemove={(p) => void remove(p)} />
    </div>
  );
}
