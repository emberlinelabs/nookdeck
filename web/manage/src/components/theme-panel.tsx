import { OptionCards, StyleChips, modeOptions, orientationOptions, radiusOptions, headerOptions } from "@/components/visual-options";
import { asLanguage, t, useLanguage } from "@/lib/i18n";
import { useState } from "react";
import { IconRotate as RotateLeft } from "@tabler/icons-react";
import { Button } from "@/components/ui/knowns/button";
import { Card } from "@/components/ui/knowns/card";
import { Field } from "@/components/ui/knowns/input";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { Switch } from "@/components/ui/knowns/switch";
import { ColorField } from "@/components/color-field";
import { PhonePreview, type Orientation } from "@/components/phone-preview";
import { LanguageMenu } from "@/components/language-menu";
import { ThemeLookGroups } from "@/components/theme-look";
import { ExportThemeButton, ThemeAdvanced, ThemeCards } from "@/components/theme-pack-bar";
import { THEME_DEFAULTS, type Layout, type Theme, type ThemeLook } from "@/types";

/** Fields a preset owns (it replaces them all). */
export const LOOK_FIELDS = new Set(["mode", "accent", "background", "tile", "text", "muted", "radius", "gap", "fontScale", "tileStyle", "iconScale", "iconStroke", "showLabels", "font", "numberFont", "backgroundImage", "backgroundFit", "backgroundDim", "backgroundBlur", "gradient", "tileOpacity", "tileBlur", "border", "shadow", "labelPosition", "labelWeight", "iconStyle", "palette", "chartColors", "source"]);
/** A small deck drawn from a preset's own tokens: background, tile colour, accent, radius and tile style. */
export function PresetThumb({ theme }: { theme: Theme }) {
  const d = THEME_DEFAULTS;
  const accent = theme.accent ?? d.accent;
  const bg = theme.background ?? d.background;
  const tile = theme.tile ?? d.tile;
  const style = theme.tileStyle ?? d.tileStyle;
  const radius = Math.max(2, Math.round((theme.radius ?? d.radius) / 3.5));
  const gap = Math.max(2, Math.round((theme.gap ?? d.gap) / 3));
  const text = theme.text ?? (theme.mode === "light" ? "#111113" : "#f4f4f5");
  const tileStyle = (i: number): React.CSSProperties => {
    const hot = i === 0 || i === 4;
    if (style === "solid") return { background: hot ? accent : tile, borderRadius: radius };
    if (style === "outline") return { background: "transparent", borderRadius: radius, boxShadow: `inset 0 0 0 1px ${hot ? accent : "rgb(128 128 128 / 0.45)"}` };
    return { background: tile, borderRadius: radius, boxShadow: hot ? `inset 0 0 0 1px ${accent}` : "none" };
  };
  if (style === "ios") {
    // Shortcuts look: coloured squircles with a vertical gradient, white glyph, label under the tile
    const hues = [accent, "#38bdf8", "#34d399", "#f59e0b", "#f87171", "#a1a1aa"];
    return (
      <span className="grid aspect-[16/9] w-full grid-cols-3 content-center overflow-hidden rounded-lg border border-black/10 px-2.5 py-2" style={{ background: bg, gap: Math.max(3, gap) }} aria-hidden="true">
        {hues.map((c, i) => (
          <span key={i} className="flex flex-col items-center gap-0.5">
            <span className="grid w-full place-items-center" style={{ aspectRatio: "1.7", borderRadius: Math.max(radius, 6), background: `linear-gradient(180deg, color-mix(in srgb, ${c} 72%, white), ${c})` }}>
              <span className="block size-1.5 rounded-full bg-white" />
            </span>
            <span className="block h-0.5 w-3/5 rounded-full" style={{ background: text, opacity: 0.5 }} />
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="grid aspect-[16/9] w-full grid-cols-3 content-center overflow-hidden rounded-lg border border-black/10 p-2" style={{ background: bg, gap }} aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span key={i} className="relative grid place-items-center" style={{ ...tileStyle(i), aspectRatio: "1.5" }}>
          <span className="block size-1.5 rounded-full" style={{ background: i === 0 || i === 4 ? (style === "solid" ? bg : accent) : text, opacity: i === 0 || i === 4 ? 1 : 0.55 }} />
        </span>
      ))}
    </span>
  );
}

export function ThemePanel({ beforeApply, onOpenPacks, layout, pageId, onChange, onPageTheme, onLayoutChanged, orientation, onOrientation }: {
  layout: Layout;
  pageId: string;
  onChange: (theme: Theme | undefined) => void;
  /** Writes (or clears, with undefined) the selected screen's own look override, page.theme. */
  onPageTheme: (pageId: string, look: Partial<ThemeLook> | undefined) => void;
  /** The agent changed the saved layout (a theme pack was applied): load it again. */
  onLayoutChanged: () => void;
  beforeApply?: () => Promise<void>;
  /** Go to the Packs tab. */
  onOpenPacks: () => void;
  orientation: Orientation;
  onOrientation: (o: Orientation) => void;
}) {
  useLanguage();
  const th = layout.theme ?? {};
  const page = layout.pages.find((p) => p.id === pageId);
  const [thisScreen, setThisScreen] = useState(false);
  const scoped = thisScreen && !!page;
  const pageLook = (page?.theme ?? {}) as Partial<ThemeLook>;
  const lookValue = scoped ? ({ ...th, ...pageLook } as Partial<ThemeLook>) : (th as Partial<ThemeLook>);
  const setLook = (patch: Partial<ThemeLook>) => {
    if (!scoped) return set(patch as Partial<Theme>);
    const next: Record<string, unknown> = { ...pageLook, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onPageTheme(pageId, Object.keys(next).length ? (next as Partial<ThemeLook>) : undefined);
  };
  // one onChange call = one undo step
  const set = (patch: Partial<Theme>) => {
    const next: Record<string, unknown> = { ...th, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    onChange(next as Theme);
  };
  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
      <Card className="min-h-0 overflow-y-auto p-4 kn-scroll-auto">
        <div className="flex flex-col gap-6">
          <div className="flex items-start justify-between gap-3 rounded-lg border p-2.5">
            <div className="min-w-0">
              <label htmlFor="t-scope" className="text-[13px] font-medium">{t("This screen only")}</label>
              <p className="text-xs text-muted-foreground">{scoped ? t("Changes below apply to \"{name}\" only. Other screens keep the main look.", { name: page?.name ?? "" }) : t("Off: changes apply to every screen.")}</p>
            </div>
            <Switch id="t-scope" checked={scoped} onCheckedChange={setThisScreen} aria-label={t("This screen only")} />
          </div>
          {scoped && Object.keys(pageLook).length > 0 && (
            <Button size="sm" variant="secondary" icon={<RotateLeft />} onClick={() => onPageTheme(pageId, undefined)} className="self-start">{t("Use the main look on this screen")}</Button>
          )}
          {!scoped && <>
          <ThemeCards theme={th} source={th.source} beforeApply={beforeApply} onChanged={onLayoutChanged} onBrowse={onOpenPacks} />

          <section aria-labelledby="t-basic" className="flex flex-col gap-4">
            <h2 id="t-basic" className="text-sm font-semibold">{t("Basics")}</h2>
            <Field label={t("Mode")} id="t-mode">
              <OptionCards label={t("Light or dark mode")} value={th.mode ?? THEME_DEFAULTS.mode} onChange={(v) => set({ mode: v })} options={modeOptions()} />
            </Field>
            <Field label={t("Accent color")} id="t-accent">
              <ColorField id="t-accent" value={th.accent} onChange={(v) => set({ accent: v })} fallback={THEME_DEFAULTS.accent} />
            </Field>
            <Field label={t("Corner style")} id="t-radius" hint={t("How round the tiles are. Fine-tune in More options.")}>
              <OptionCards label={t("Corner style")} cols={4} value={String([0, 8, 14, 24].reduce((p, c) => (Math.abs(c - (th.radius ?? THEME_DEFAULTS.radius)) < Math.abs(p - (th.radius ?? THEME_DEFAULTS.radius)) ? c : p)))} onChange={(v) => set({ radius: Number(v) })} options={radiusOptions(th.accent ?? THEME_DEFAULTS.accent)} />
            </Field>
            <Field label={t("Tile style")} id="t-tilestyle" hint={t("iOS: rounded colored tiles like Shortcuts, white icon, label below the tile.")}>
              <StyleChips label={t("Tile style")} follow={false} value={th.tileStyle ?? THEME_DEFAULTS.tileStyle} onChange={(v) => v && set({ tileStyle: v })} color={th.accent ?? THEME_DEFAULTS.accent} />
            </Field>
            <Field label={t("Phone orientation")} id="t-orient" hint={t("Landscape: a grid made for a phone held sideways, it rotates when held upright.")}>
              <OptionCards label={t("Phone orientation")} value={th.orientation ?? THEME_DEFAULTS.orientation} onChange={(v) => set({ orientation: v })} options={orientationOptions()} />
            </Field>
            <Field label={t("Top bar")} id="t-header" hint={t("Minimal hides the computer name and CPU/RAM. Hidden gives the whole height to the tiles; a small button keeps the menu and shows problems.")}>
              <OptionCards label={t("Top bar")} value={th.header ?? "full"} onChange={(v) => set({ header: v === "full" ? undefined : v })} options={headerOptions()} />
            </Field>
            <Field label={t("Temperature unit")} id="t-temp" hint={t("Every temperature on the phone follows this, whatever unit the source reports.")}>
              <SegmentedControl
                size="sm"
                aria-label={t("Temperature unit")}
                value={th.temperatureUnit ?? "c"}
                onValueChange={(v) => set({ temperatureUnit: v === "f" ? "f" : undefined })}
                options={[{ value: "c", label: "°C" }, { value: "f", label: "°F" }]}
              />
            </Field>
            <Field label={t("Updates")} id="t-update" hint={t("Looks for a newer Nookdeck release on GitHub. Nothing is installed automatically.")}>
              <div className="flex items-center gap-3">
                <Switch id="t-update" checked={th.updateCheck !== false} onCheckedChange={(v) => set({ updateCheck: v ? undefined : false })} aria-label={t("Check for updates daily")} />
                <label htmlFor="t-update" className="text-[13px]">{t("Check for updates daily")}</label>
              </div>
            </Field>
            <Field label={t("Language")} id="t-lang" hint={t("Language of this page and of the phone overlay.")}>
              <LanguageMenu id="t-lang" value={asLanguage(th.language)} onChange={(l) => set({ language: l })} />
            </Field>
          </section>

          </>}
          <section aria-labelledby="t-custom" className="flex flex-col gap-3">
            <h2 id="t-custom" className="text-sm font-semibold">{t("Customize the look")}</h2>
            <ThemeLookGroups value={lookValue} onChange={setLook} />
            {!scoped && <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" icon={<RotateLeft />} onClick={() => onChange(undefined)}>{t("Reset to defaults")}</Button><ExportThemeButton /></div>}
            {!scoped && <section aria-labelledby="t-adv" className="flex flex-col gap-3 border-t pt-3"><h3 id="t-adv" className="text-sm font-semibold">{t("Advanced")}</h3><ThemeAdvanced source={th.source} onChanged={onLayoutChanged} /></section>}
          </section>
        </div>
      </Card>
      <div className="min-h-0 min-w-0">
        <PhonePreview layout={layout} pageId={pageId} selectedId={null} orientation={orientation} onOrientation={onOrientation} />
      </div>
    </div>
  );
}
