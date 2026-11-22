import { useEffect, useState } from "react";
import { IconArrowRight as ArrowRight, IconCopy as Copy, IconDownload as Download, IconShieldHalf as Safe } from "@tabler/icons-react";
import { api } from "@/api";
import { Alert } from "@/components/ui/knowns/alert";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { Dialog } from "@/components/ui/knowns/dialog";
import { Field, Input, } from "@/components/ui/knowns/input";
import { VariantMini } from "@/components/variant-mini";
import { packLook } from "@/lib/pack-preview";
import { Switch } from "@/components/ui/knowns/switch";
import { Textarea } from "@/components/ui/knowns/textarea";
import { t, useLanguage } from "@/lib/i18n";
import { THEME_DEFAULTS, type Theme, type ThemeLook, type ThemePack, type ThemeSource } from "@/types";

const CLASSIC_ID = "dev.nookdeck.nookdeck-classic";
const MATCH_KEYS = ["mode", "accent", "background", "tile", "text", "radius", "gap", "fontScale", "tileStyle", "iconScale", "iconStroke", "showLabels"] as const;
/** True when the saved look has the same values as a variant (a missing value counts as the default). */
function lookEquals(current: Theme, look: Record<string, unknown>): boolean {
  const d = THEME_DEFAULTS as Record<string, unknown>;
  return MATCH_KEYS.every((k) => {
    const a = (current as Record<string, unknown>)[k] ?? d[k], b = look[k] ?? d[k];
    return typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
  });
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Advanced: the active theme's CSS (read only) and the safe-mode hint. */
export function ThemeAdvanced({ source, onChanged }: { source: ThemeSource | undefined; onChanged: () => void }) {
  useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = source?.pack?.split("@")[0];
  const [css, setCss] = useState("");
  const variant = source?.variant ?? source?.auto?.dark;
  useEffect(() => { setCss(""); if (id) api.getThemeCss(id, variant).then(setCss, () => setCss("")); }, [id, variant]);
  return (
    <div className="flex flex-col gap-3">
      {id && css ? (
        <Field label={t("Theme CSS (read only)")} id="ta-css" hint={t("Set by the active theme pack. Themes cannot run code.")}>
          <pre id="ta-css" tabIndex={0} className="max-h-56 overflow-auto rounded-lg border bg-muted/40 p-2 text-[11.5px] leading-snug">{css}</pre>
        </Field>
      ) : <p className="text-xs text-muted-foreground">{t("The active theme has no custom CSS.")}</p>}
      {id && (
        <div className="flex flex-col gap-1.5">
          <Button size="sm" variant="secondary" icon={<Copy />} loading={busy} className="self-start" onClick={async () => {
            setBusy(true); setError(null);
            try {
              const fork = await api.forkTheme(id, { variant: source?.variant, options: source?.options });
              if (fork) await api.applyTheme(fork.id, { variant: fork.variants[0]?.id });
              onChanged();
            } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
          }}>{t("Edit as a copy")}</Button>
          <p className="text-xs text-muted-foreground">{t("Makes your own local theme from this one, so you can change colors and more without touching the original. Custom CSS is not copied.")}</p>
          {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
        </div>
      )}
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Safe className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t("If a theme makes the phone hard to read, open the deck with safe mode to ignore the theme:")} <a href="/?theme=off" target="_blank" rel="noreferrer" className="underline">/?theme=off</a></span>
      </div>
    </div>
  );
}

/** Export: name, author and description, then the browser downloads the theme package (a zip). */
export function ExportThemeButton() {
  useLanguage();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true); setError(null);
    try {
      const blob = await api.exportTheme({ id: `local.${slug(n) || "theme"}`, name: n, version: "1.0.0", ...(author.trim() ? { author: author.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}) });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${slug(n) || "theme"}.zip`; document.body.appendChild(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <Button size="sm" variant="secondary" icon={<Download />} onClick={() => setOpen(true)} className="self-start">{t("Export this look")}</Button>
      <Dialog open={open} onOpenChange={setOpen} title={t("Export as a theme package")} description={t("Saves the current look as a zip you can share or edit. Install it from the Themes page.")} size="md">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void go(); }}>
          <Field label={t("Name")} id="te-name"><Input id="te-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-autofocus /></Field>
          <Field label={t("Author")} id="te-author"><Input id="te-author" value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={60} /></Field>
          <Field label={t("Description")} id="te-desc"><Textarea id="te-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} rows={3} /></Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" loading={busy} disabled={!name.trim()} icon={<Download />}>{t("Download")}</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

type ApplyBody = { variant?: string; auto?: { light: string; dark: string }; options?: Record<string, string> };

/** Theme cards at the top of Customize: the pack in use first (with its options and Auto), then the other installed packs. Pressing a card applies it at once (saved, with Undo). */
export function ThemeCards({ theme, source: saved, beforeApply, onChanged, onBrowse }: { theme: Theme; source: ThemeSource | undefined; beforeApply?: () => Promise<void>; onChanged: () => void; onBrowse: () => void }) {
  useLanguage();
  const [packs, setPacks] = useState<ThemePack[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState(false);
  useEffect(() => { api.getThemes().then((r) => setPacks((r?.packs ?? []).filter((p) => p.installed)), () => setPacks([])); }, [saved?.pack, saved?.variant]);
  useEffect(() => { if (!undo) return; const id = window.setTimeout(() => setUndo(false), 15000); return () => window.clearTimeout(id); }, [undo]);
  const classic = packs.find((p) => p.id === CLASSIC_ID);
  const guess = !saved && classic ? classic.variants.find((v) => lookEquals(theme, v.look)) : undefined;
  const cur: ThemeSource | undefined = saved ?? (classic && guess ? { pack: classic.id, variant: guess.id } : undefined);
  const curId = cur?.pack.split("@")[0];
  const active = packs.find((p) => p.id === curId);
  const others = packs.filter((p) => p.id !== curId).sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  const apply = async (p: ThemePack, body: ApplyBody) => {
    setBusy(true); setError(null);
    try { await beforeApply?.(); await api.applyTheme(p.id, body); setUndo(true); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (!packs.length) return null;
  const grid = (p: ThemePack, isActive: boolean) => (
    <div role="radiogroup" aria-label={p.name} className="grid grid-cols-3 gap-2">
      {p.variants.map((v) => (
        <VariantMini key={v.id} small look={packLook(p, v.id, isActive ? cur?.options : undefined)} name={v.name} mode={v.mode}
          picked={isActive && (cur?.variant === v.id || cur?.auto?.light === v.id || cur?.auto?.dark === v.id)} current={isActive && cur?.variant === v.id}
          disabled={busy} onPick={() => void apply(p, { variant: v.id, ...(isActive && cur?.options ? { options: cur.options } : {}) })} />
      ))}
    </div>
  );
  let activeBlock: React.ReactNode = null;
  if (active && cur) {
    const vName = (id?: string) => active.variants.find((v) => v.id === id)?.name ?? id ?? "";
    const optNames = Object.entries(cur.options ?? {}).map(([o, v]) => active.options.find((x) => x.id === o)?.values.find((x) => x.id === v)?.name ?? v);
    const label = [active.name, cur.auto ? `${t("Auto")} (${vName(cur.auto.light)}/${vName(cur.auto.dark)})` : vName(cur.variant), ...optNames].filter((x, i, a) => x && a.indexOf(x) === i).join(" · ");
    const light = active.variants.filter((v) => v.mode === "light"), dark = active.variants.filter((v) => v.mode === "dark");
    const canAuto = light.length > 0 && dark.length > 0;
    const pair = cur.auto ?? { light: active.auto?.light ?? light[0]?.id ?? "", dark: active.auto?.dark ?? dark[0]?.id ?? "" };
    const refVariant = cur.variant ?? cur.auto?.dark;
    activeBlock = (
      <div className="flex flex-col gap-2 rounded-xl border p-2.5">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px]"><span className="text-muted-foreground">{t("In use")}:</span><span className="font-medium">{label}</span>{active.hasCss && <Badge size="sm" tone="warning">{t("Custom CSS")}</Badge>}</div>
        {!cur.auto && grid(active, true)}
        {canAuto && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="tc-auto" className="text-[13px] font-medium">{t("Auto (light/dark)")}</label>
              <Switch id="tc-auto" checked={!!cur.auto} disabled={busy} aria-label={t("Auto (light/dark)")}
                onCheckedChange={(on) => void apply(active, on ? { auto: pair, ...(cur.options ? { options: cur.options } : {}) } : { variant: cur.variant ?? pair.dark, ...(cur.options ? { options: cur.options } : {}) })} />
            </div>
            {cur.auto && (["light", "dark"] as const).map((m) => (
              <div key={m} role="radiogroup" aria-label={m === "light" ? t("Light") : t("Dark")} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{m === "light" ? t("Light") : t("Dark")}</span>
                <div className="grid grid-cols-3 gap-2">
                  {(m === "light" ? light : dark).map((v) => (
                    <VariantMini key={v.id} small look={packLook(active, v.id, cur.options)} name={v.name} mode={v.mode} picked={cur.auto![m] === v.id} disabled={busy}
                      onPick={() => void apply(active, { auto: { ...cur.auto!, [m]: v.id }, ...(cur.options ? { options: cur.options } : {}) })} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {active.options.map((o) => (
          <div key={o.id} role="radiogroup" aria-label={o.name} className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{o.name}</span>
            <div className="flex flex-wrap gap-1.5">
              {[{ id: "", name: t("Default") } as { id: string; name: string; theme?: Partial<ThemeLook>; variants?: Record<string, Partial<ThemeLook>> }, ...o.values].map((val) => {
                const on = (cur.options?.[o.id] ?? "") === val.id;
                const color = (refVariant && val.variants?.[refVariant]?.accent) || val.theme?.accent;
                return (
                  <button key={val.id || "default"} type="button" role="radio" aria-checked={on} disabled={busy} title={val.name}
                    onClick={() => { const opts = { ...(cur.options ?? {}) }; if (val.id) opts[o.id] = val.id; else delete opts[o.id]; void apply(active, { ...(cur.auto ? { auto: cur.auto } : { variant: cur.variant }), ...(Object.keys(opts).length ? { options: opts } : {}) }); }}
                    className={"flex items-center gap-1.5 rounded-full border px-2 py-1 text-[12px] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring " + (on ? "border-primary bg-primary/10 font-medium" : "")}>
                    {color && <span className="size-3.5 rounded-full border border-black/20" style={{ background: color }} />}{val.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <section aria-labelledby="tc-h" className="flex flex-col gap-3">
      <h2 id="tc-h" className="text-sm font-semibold">{t("Themes")}</h2>
      {activeBlock}
      {others.map((p) => (
        <div key={p.id} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="font-medium text-foreground">{p.name}</span>{p.builtin && <Badge size="sm" tone="neutral">{t("Built-in")}</Badge>}{p.hasCss && <Badge size="sm" tone="warning">{t("Custom CSS")}</Badge>}</div>
          {grid(p, false)}
        </div>
      ))}
      <Button size="sm" variant="secondary" icon={<ArrowRight />} onClick={onBrowse} className="self-start">{t("Browse more themes")}</Button>
      {undo && <Alert tone="success" action={{ label: t("Undo"), onClick: () => { setUndo(false); api.undoLayout().then(onChanged, (e) => setError(e instanceof Error ? e.message : String(e))); } }} onDismiss={() => setUndo(false)}>{t("Theme applied.")}</Alert>}
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
    </section>
  );
}
