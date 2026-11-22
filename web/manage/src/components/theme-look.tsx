import { useRef, useState } from "react";
import { IconArrowDown as ArrowDown, IconArrowRight as ArrowRight, IconPhotoPlus as PhotoPlus, IconRotate as RotateLeft, IconTrash as Trash, IconPlus as Plus } from "@tabler/icons-react";
import { api, uploadUrl } from "@/api";
import { Button } from "@/components/ui/knowns/button";
import { Field } from "@/components/ui/knowns/input";
import { Select } from "@/components/ui/knowns/select";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { Slider } from "@/components/ui/knowns/slider";
import { Switch } from "@/components/ui/knowns/switch";
import { ColorField } from "@/components/color-field";
import { StyleChips } from "@/components/visual-options";
import { t, useLanguage } from "@/lib/i18n";
import { THEME_DEFAULTS, type ThemeFont, type ThemeLook } from "@/types";

type Look = Partial<ThemeLook>;
const KEY = "nookdeck.manage.themeGroups";
function readOpen(): Record<string, boolean> { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>; } catch { return {}; } }

/** The fields each group owns: "Reset" removes exactly these. */
const GROUPS = {
  typography: ["font", "numberFont", "labelPosition", "labelWeight", "showLabels", "fontScale"],
  background: ["background", "gradient", "backgroundImage", "backgroundFit", "backgroundDim", "backgroundBlur"],
  tiles: ["tileStyle", "tile", "tileOpacity", "tileBlur", "border", "shadow", "radius", "gap"],
  colours: ["accent", "text", "palette", "chartColors"],
  icons: ["iconStyle", "iconScale", "iconStroke"],
} as const satisfies Record<string, readonly (keyof ThemeLook)[]>;
type GroupId = keyof typeof GROUPS;

const FONTS: ThemeFont[] = ["system", "rounded", "mono", "serif", "condensed"];
function fontLabel(f: ThemeFont): string {
  switch (f) {
    case "rounded": return t("Rounded");
    case "mono": return t("Monospace");
    case "serif": return t("Serif");
    case "condensed": return t("Condensed");
    default: return t("System");
  }
}
const FONT_CSS: Record<ThemeFont, string> = {
  system: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Nunito', system-ui, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  serif: "ui-serif, Georgia, 'Times New Roman', serif",
  condensed: "'Arial Narrow', 'Helvetica Neue Condensed', system-ui, sans-serif",
};
const PALETTE_KEYS = [["ok", "OK", "#34d399"], ["warn", "Warning", "#f59e0b"], ["error", "Error", "#f87171"], ["info", "Info", "#38bdf8"]] as const;

function Group({ id, title, hint, open, onToggle, onReset, dirty, children }: { id: GroupId; title: string; hint?: string; open: boolean; onToggle: () => void; onReset: () => void; dirty: boolean; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`tg-${id}`} className="flex flex-col gap-3 border-t pt-3">
      <div className="flex items-center justify-between gap-2">
        <button type="button" id={`tg-${id}`} aria-expanded={open} aria-controls={`tg-${id}-body`} onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">
          {open ? <ArrowDown className="size-4 shrink-0 text-muted-foreground" /> : <ArrowRight className="size-4 shrink-0 text-muted-foreground" />}
          <span className="truncate">{title}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label={t("Changed")} />}
        </button>
        <Button size="sm" variant="ghost" icon={<RotateLeft />} disabled={!dirty} onClick={onReset} aria-label={t("Reset {group}", { group: title })}>{t("Reset")}</Button>
      </div>
      {open && <div id={`tg-${id}-body`} className="flex flex-col gap-4">{hint && <p className="text-xs text-muted-foreground">{hint}</p>}{children}</div>}
    </section>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const px = (v: number) => `${Math.round(v)} px`;

/**
 * The look controls, in five groups: Typography, Background, Tiles, Colours, Icons. `value` is what the screen shows now (the theme, with this
 * screen's override on top when "This screen only" is on); `onChange` gets a patch (a key set to undefined removes it).
 */
export function ThemeLookGroups({ value, onChange }: { value: Look; onChange: (patch: Look) => void }) {
  useLanguage();
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const toggle = (g: GroupId) => setOpen((o) => { const n = { ...o, [g]: !o[g] }; try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* private mode */ } return n; });
  const dirty = (g: GroupId) => GROUPS[g].some((k) => value[k] !== undefined);
  const reset = (g: GroupId) => onChange(Object.fromEntries(GROUPS[g].map((k) => [k, undefined])) as Look);
  const v = value;
  const D = THEME_DEFAULTS;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setUploadError(null);
    setUploading(true);
    try { onChange({ backgroundImage: await api.uploadIcon(f) }); } catch (e) { setUploadError(e instanceof Error ? e.message : String(e)); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const fontOptions = FONTS.map((f) => ({ value: f, label: fontLabel(f) }));
  const grad = v.gradient;
  const cc = v.chartColors ?? [];
  const row = (g: GroupId, title: string, hint: string | undefined, body: React.ReactNode) => (
    <Group id={g} title={title} hint={hint} open={!!open[g]} onToggle={() => toggle(g)} onReset={() => reset(g)} dirty={dirty(g)}>{body}</Group>
  );
  return (
    <div className="flex flex-col gap-3">
      {row("typography", t("Typography"), undefined, <>
        <Field label={t("Font")} id="tl-font">
          <Select id="tl-font" value={v.font ?? "system"} onChange={(e) => onChange({ font: e.target.value === "system" ? undefined : (e.target.value as ThemeFont) })} options={fontOptions} />
          <span className="mt-1 block truncate text-[13px] text-muted-foreground" style={{ fontFamily: FONT_CSS[v.font ?? "system"] }}>{t("Aa Bb Cc 0123 The quick brown fox")}</span>
        </Field>
        <Field label={t("Number font")} id="tl-numfont" hint={t("Big numbers and the clock.")}>
          <Select id="tl-numfont" value={v.numberFont ?? v.font ?? "system"} onChange={(e) => onChange({ numberFont: e.target.value === (v.font ?? "system") ? undefined : (e.target.value as ThemeFont) })} options={fontOptions} />
        </Field>
        <Field label={t("Label position")} id="tl-labelpos">
          <SegmentedControl size="sm" aria-label={t("Label position")} value={v.labelPosition ?? "bottom"}
            onValueChange={(x) => onChange({ labelPosition: x === "bottom" ? undefined : (x as "top" | "hidden") })}
            options={[{ value: "bottom", label: t("Bottom") }, { value: "top", label: t("Top") }, { value: "hidden", label: t("Hidden") }]} />
        </Field>
        <Field label={t("Label weight")} id="tl-labelw">
          <SegmentedControl size="sm" aria-label={t("Label weight")} value={v.labelWeight ?? "medium"}
            onValueChange={(x) => onChange({ labelWeight: x === "medium" ? undefined : (x as "regular" | "bold") })}
            options={[{ value: "regular", label: t("Regular") }, { value: "medium", label: t("Medium") }, { value: "bold", label: t("Bold") }]} />
        </Field>
        <Slider label={t("Text size")} min={0.5} max={2} step={0.05} value={v.fontScale ?? D.fontScale} formatValue={pct} onValueChange={(x) => onChange({ fontScale: Math.round(x * 100) / 100 })} />
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="tl-labels" className="text-[13px] font-medium">{t("Show label under the icon")}</label>
          <Switch id="tl-labels" checked={v.showLabels ?? D.showLabels} onCheckedChange={(x) => onChange({ showLabels: x })} aria-label={t("Show label")} />
        </div>
      </>)}

      {row("background", t("Background"), undefined, <>
        <Field label={t("Background color")} id="tl-bg">
          <ColorField id="tl-bg" value={v.background} onChange={(x) => onChange({ background: x })} fallback={D.background} withText />
        </Field>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="tl-grad" className="text-[13px] font-medium">{t("Gradient")}</label>
            <Switch id="tl-grad" checked={!!grad} onCheckedChange={(x) => onChange({ gradient: x ? { from: v.background ?? D.background, to: v.accent ?? D.accent, angle: 160 } : undefined })} aria-label={t("Gradient")} />
          </div>
          {grad && (
            <div className="flex flex-col gap-3 rounded-lg border p-2.5">
              <Field label={t("From")} id="tl-gfrom"><ColorField id="tl-gfrom" value={grad.from} onChange={(x) => onChange({ gradient: { ...grad, from: x ?? grad.from } })} fallback={grad.from} withText /></Field>
              <Field label={t("To")} id="tl-gto"><ColorField id="tl-gto" value={grad.to} onChange={(x) => onChange({ gradient: { ...grad, to: x ?? grad.to } })} fallback={grad.to} withText /></Field>
              <Slider label={t("Angle")} min={0} max={360} step={5} value={grad.angle} formatValue={(a) => `${Math.round(a)}°`} onValueChange={(a) => onChange({ gradient: { ...grad, angle: Math.round(a) } })} />
              <span aria-hidden className="h-6 rounded-md border" style={{ background: `linear-gradient(${grad.angle}deg, ${grad.from}, ${grad.to})` }} />
            </div>
          )}
        </div>
        <Field label={t("Background image")} id="tl-img" hint={t("A PNG or JPEG. It is drawn behind the tiles.")}>
          <div className="flex items-center gap-2">
            {v.backgroundImage && /^[0-9a-f]{8,}$/i.test(v.backgroundImage) && <img src={uploadUrl(v.backgroundImage)} alt="" className="h-12 w-20 rounded-md border object-cover" />}
            <input ref={fileRef} id="tl-img" type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
            <Button size="sm" variant="secondary" icon={<PhotoPlus />} loading={uploading} onClick={() => fileRef.current?.click()}>{v.backgroundImage ? t("Change image") : t("Upload image")}</Button>
            {v.backgroundImage && <Button size="sm" variant="ghost" icon={<Trash />} onClick={() => onChange({ backgroundImage: undefined, backgroundFit: undefined, backgroundDim: undefined, backgroundBlur: undefined })}>{t("Remove")}</Button>}
          </div>
          {uploadError && <p role="alert" className="mt-1 text-xs text-destructive">{uploadError}</p>}
        </Field>
        {v.backgroundImage && <>
          <Field label={t("Fit")} id="tl-fit">
            <SegmentedControl size="sm" aria-label={t("Fit")} value={v.backgroundFit ?? "cover"} onValueChange={(x) => onChange({ backgroundFit: x === "cover" ? undefined : (x as "contain" | "tile") })}
              options={[{ value: "cover", label: t("Fill") }, { value: "contain", label: t("Fit") }, { value: "tile", label: t("Tile") }]} />
          </Field>
          <Slider label={t("Dim")} min={0} max={0.9} step={0.05} value={v.backgroundDim ?? 0} formatValue={pct} onValueChange={(x) => onChange({ backgroundDim: x === 0 ? undefined : Math.round(x * 100) / 100 })} />
          <Slider label={t("Blur")} min={0} max={30} step={1} value={v.backgroundBlur ?? 0} formatValue={px} onValueChange={(x) => onChange({ backgroundBlur: x === 0 ? undefined : Math.round(x) })} />
        </>}
      </>)}

      {row("tiles", t("Tiles"), undefined, <>
        <Field label={t("Tile style")} id="tl-style">
          <StyleChips label={t("Tile style")} follow={false} value={v.tileStyle ?? D.tileStyle} onChange={(x) => x && onChange({ tileStyle: x })} color={v.accent ?? D.accent} />
        </Field>
        <Field label={t("Tile color")} id="tl-tile"><ColorField id="tl-tile" value={v.tile} onChange={(x) => onChange({ tile: x })} fallback={D.tile} withText /></Field>
        <Slider label={t("Opacity")} min={0.05} max={1} step={0.05} value={v.tileOpacity ?? 1} formatValue={pct} onValueChange={(x) => onChange({ tileOpacity: x >= 1 ? undefined : Math.round(x * 100) / 100 })} />
        <Slider label={t("Frosted blur")} min={0} max={30} step={1} value={v.tileBlur ?? 0} formatValue={px} onValueChange={(x) => onChange({ tileBlur: x === 0 ? undefined : Math.round(x) })} />
        <Slider label={t("Border width")} min={0} max={3} step={0.5} value={v.border?.width ?? 0} formatValue={(x) => `${x} px`}
          onValueChange={(x) => onChange({ border: x === 0 ? undefined : { ...v.border, width: x } })} />
        {(v.border?.width ?? 0) > 0 && <Field label={t("Border color")} id="tl-bcolor"><ColorField id="tl-bcolor" value={v.border?.color} onChange={(x) => onChange({ border: { width: v.border?.width ?? 1, ...(x ? { color: x } : {}) } })} noneLabel={t("Auto")} withText /></Field>}
        <Field label={t("Shadow")} id="tl-shadow">
          <SegmentedControl size="sm" aria-label={t("Shadow")} value={v.shadow ?? "none"} onValueChange={(x) => onChange({ shadow: x === "none" ? undefined : (x as "soft" | "strong") })}
            options={[{ value: "none", label: t("None") }, { value: "soft", label: t("Soft") }, { value: "strong", label: t("Strong") }]} />
        </Field>
        <Slider label={t("Corner radius (px)")} min={0} max={40} step={1} value={v.radius ?? D.radius} onValueChange={(x) => onChange({ radius: x })} />
        <Slider label={t("Tile gap (px)")} min={0} max={40} step={1} value={v.gap ?? D.gap} onValueChange={(x) => onChange({ gap: x })} />
      </>)}

      {row("colours", t("Colours"), undefined, <>
        <Field label={t("Accent color")} id="tl-accent"><ColorField id="tl-accent" value={v.accent} onChange={(x) => onChange({ accent: x })} fallback={D.accent} /></Field>
        <Field label={t("Text color")} id="tl-text"><ColorField id="tl-text" value={v.text} onChange={(x) => onChange({ text: x })} fallback="#f4f4f5" noneLabel={t("Auto")} withText /></Field>
        <Field label={t("State colors")} id="tl-palette" hint={t("Used by status tiles, gauges and charts.")}>
          <div className="flex flex-col gap-3">
            {PALETTE_KEYS.map(([k, label, def]) => (
              <div key={k} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{t(label)}</span>
                <ColorField value={v.palette?.[k]} onChange={(x) => { const p = { ...v.palette, [k]: x }; if (!x) delete p[k]; onChange({ palette: Object.keys(p).length ? p : undefined }); }} fallback={def} withText />
              </div>
            ))}
          </div>
        </Field>
        <Field label={t("Chart colors")} id="tl-chart" hint={t("Up to 6, used in order for chart series.")}>
          <div className="flex flex-col gap-2">
            {cc.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1"><ColorField value={c} onChange={(x) => { const n = cc.slice(); if (x) n[i] = x; else n.splice(i, 1); onChange({ chartColors: n.length ? n : undefined }); }} fallback={c} withText /></div>
                <Button size="sm" variant="ghost" icon={<Trash />} aria-label={t("Remove")} onClick={() => { const n = cc.filter((_, j) => j !== i); onChange({ chartColors: n.length ? n : undefined }); }} />
              </div>
            ))}
            {cc.length < 6 && <Button size="sm" variant="secondary" icon={<Plus />} className="self-start" onClick={() => onChange({ chartColors: [...cc, ["#22d3ee", "#a78bfa", "#34d399", "#f59e0b", "#f87171", "#38bdf8"][cc.length]!] })}>{t("Add color")}</Button>}
          </div>
        </Field>
      </>)}

      {row("icons", t("Icons"), undefined, <>
        <Field label={t("Icon style")} id="tl-iconstyle" hint={t("Filled applies where the icon has a filled form.")}>
          <SegmentedControl size="sm" aria-label={t("Icon style")} value={v.iconStyle ?? "line"} onValueChange={(x) => onChange({ iconStyle: x === "line" ? undefined : "filled" })}
            options={[{ value: "line", label: t("Line") }, { value: "filled", label: t("Filled") }]} />
        </Field>
        <Slider label={t("Icon size")} min={0.5} max={2} step={0.05} value={v.iconScale ?? D.iconScale} formatValue={pct} onValueChange={(x) => onChange({ iconScale: Math.round(x * 100) / 100 })} />
        <Slider label={t("Icon stroke weight")} min={1} max={3} step={0.25} value={v.iconStroke ?? D.iconStroke} formatValue={(x) => x.toFixed(2).replace(/\.?0+$/, "")} onValueChange={(x) => onChange({ iconStroke: Math.round(x * 100) / 100 })} />
      </>)}
    </div>
  );
}
