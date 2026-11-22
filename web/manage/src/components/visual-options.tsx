import { useState, type ReactNode } from "react";
import { IconX as X, IconSparkles as Sparkles } from "@tabler/icons-react";
import { StyleSwatch } from "@/components/style-select";
import { t, useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TileStyle } from "@/types";

/** A radio group of cards: a small drawing above a label, so people see what each option does. */
export function OptionCards<T extends string>({ label, value, onChange, options, cols = 3 }: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; art: ReactNode }[];
  cols?: number;
}) {
  useLanguage();
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("flex flex-col items-center gap-1.5 rounded-xl border p-2 text-[12px] transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", value === o.value && "border-primary bg-primary/10 font-medium ring-1 ring-primary")}
        >
          <span className="grid h-11 w-full place-items-center">{o.art}</span>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Screen = ({ w, h, bg, fg, children }: { w: number; h: number; bg: string; fg?: string; children?: ReactNode }) => (
  <span aria-hidden className="grid grid-cols-3 gap-[2px] rounded-[5px] border border-black/20 p-[3px]" style={{ width: w, height: h, background: bg, color: fg }}>{children}</span>
);
const Dots = ({ n, c, r = 1 }: { n: number; c: string; r?: number }) => (
  <>{Array.from({ length: n }, (_, i) => <span key={i} style={{ background: c, borderRadius: r, opacity: i % 3 === 0 ? 1 : 0.55 }} />)}</>
);

export function modeOptions(): { value: "dark" | "light" | "auto"; label: string; art: ReactNode }[] {
  return [
    { value: "dark", label: t("Dark"), art: <Screen w={52} h={34} bg="#0b0b0d"><Dots n={6} c="#2a2a30" /></Screen> },
    { value: "light", label: t("Light"), art: <Screen w={52} h={34} bg="#f4f4f5"><Dots n={6} c="#d4d4d8" /></Screen> },
    {
      value: "auto",
      label: t("Auto"),
      art: (
        <span aria-hidden className="flex overflow-hidden rounded-[5px] border border-black/20" style={{ width: 52, height: 34 }}>
          <span className="w-1/2" style={{ background: "#f4f4f5" }} />
          <span className="w-1/2" style={{ background: "#0b0b0d" }} />
        </span>
      ),
    },
  ];
}

export function orientationOptions(): { value: "landscape" | "portrait" | "auto"; label: string; art: ReactNode }[] {
  const body = (w: number, h: number) => <span aria-hidden className="grid grid-cols-3 gap-[2px] rounded-[5px] border-2 border-foreground/70 p-[3px]" style={{ width: w, height: h }}><Dots n={w > h ? 6 : 6} c="currentColor" /></span>;
  return [
    { value: "landscape", label: t("Landscape"), art: body(48, 28) },
    { value: "portrait", label: t("Portrait"), art: body(26, 40) },
    { value: "auto", label: t("Auto"), art: <span className="flex items-center gap-1 text-muted-foreground">{body(30, 20)}{body(18, 26)}</span> },
  ];
}

export function headerOptions(): { value: "full" | "minimal" | "hidden"; label: string; art: ReactNode } [] {
  const bar = (w: number) => <span className="h-1.5 rounded-full bg-foreground/60" style={{ width: w }} />;
  const frame = (children: ReactNode) => <span aria-hidden className="flex flex-col gap-1 rounded-[5px] border border-black/20 bg-black/70 p-[3px]" style={{ width: 52, height: 34 }}>{children}</span>;
  const grid = <span className="grid flex-1 grid-cols-3 gap-[2px]">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="rounded-[1px] bg-zinc-600" />)}</span>;
  return [
    { value: "full", label: t("Top bar: full"), art: frame(<><span className="flex items-center justify-between">{bar(14)}{bar(18)}</span>{grid}</>) },
    { value: "minimal", label: t("Top bar: minimal"), art: frame(<><span className="flex items-center justify-between">{bar(6)}{bar(10)}</span>{grid}</>) },
    { value: "hidden", label: t("Top bar: hidden"), art: frame(<>{grid}</>) },
  ];
}

export function radiusOptions(color: string): { value: string; label: string; art: ReactNode }[] {
  const tile = (r: number) => <span aria-hidden style={{ width: 34, height: 26, borderRadius: r, background: `${color}33`, boxShadow: `inset 0 0 0 1.5px ${color}` }} />;
  return [
    { value: "0", label: t("Square"), art: tile(0) },
    { value: "8", label: t("Soft"), art: tile(6) },
    { value: "14", label: t("Round"), art: tile(11) },
    { value: "24", label: t("Pill"), art: tile(18) },
  ];
}

/** Fill styles as chips: a mini tile in the colour plus its name. `follow` adds "Follow theme". */
export function StyleChips({ label, value, onChange, color, follow = true }: { label: string; value: TileStyle | ""; onChange: (v: TileStyle | "") => void; color: string; follow?: boolean }) {
  useLanguage();
  const all: { v: TileStyle | ""; label: string }[] = [
    { v: "", label: t("Follow theme") }, { v: "tint", label: t("Soft") }, { v: "solid", label: t("Solid") }, { v: "outline", label: t("Outline") }, { v: "ios", label: "iOS" },
  ];
  return (
    <OptionCards
      label={label}
      cols={follow ? 5 : 4}
      value={value}
      onChange={onChange}
      options={all.filter((o) => follow || o.v !== "").map((o) => ({ value: o.v, label: o.label, art: <span className="scale-125"><StyleSwatch style={o.v} color={color} /></span> }))}
    />
  );
}

const SIZES: [number, number][] = [[1, 1], [2, 1], [1, 2], [2, 2], [3, 2], [4, 2], [3, 3], [4, 3]];

/** Tile size as a small grid: click a cell to make the tile that many cells wide and tall. Clipped to the page grid. */
export function SizeGrid({ w, h, maxW, maxH, onPick }: { w: number; h: number; maxW: number; maxH: number; onPick: (w: number, h: number) => void }) {
  useLanguage();
  const cols = Math.min(maxW, 6);
  const rows = Math.min(maxH, 4);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [hw, hh] = hover ?? [w, h];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("Common sizes")}>
        {SIZES.filter(([a, b]) => a <= maxW && b <= maxH).map(([a, b]) => (
          <button key={`${a}x${b}`} type="button" aria-pressed={a === w && b === h} onClick={() => onPick(a, b)} className={cn("rounded-md border px-2 py-0.5 text-[12px] tabular-nums transition-colors hover:bg-muted", a === w && b === h && "border-primary bg-primary/10 font-medium")}>{a}×{b}</button>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <div role="grid" aria-label={t("Tile size")} className="grid gap-1 rounded-lg border bg-muted/30 p-1.5" style={{ gridTemplateColumns: `repeat(${cols}, 22px)` }} onMouseLeave={() => setHover(null)}>
          {Array.from({ length: rows * cols }, (_, i) => {
            const cx = (i % cols) + 1;
            const cy = Math.floor(i / cols) + 1;
            const on = cx <= hw && cy <= hh;
            return (
              <button key={i} type="button" role="gridcell" aria-label={`${cx}×${cy}`} onMouseEnter={() => setHover([cx, cy])} onFocus={() => setHover([cx, cy])} onBlur={() => setHover(null)} onClick={() => onPick(cx, cy)}
                className={cn("h-[22px] rounded-[5px] border transition-colors", on ? "border-primary bg-primary/40" : "bg-card hover:bg-muted")} />
            );
          })}
        </div>
        <span className="text-[13px] tabular-nums text-muted-foreground">{hw} × {hh}</span>
      </div>
    </div>
  );
}

const HINT_KEY = "pd.manage.hintDismissed";
const readHint = (): boolean => { try { return localStorage.getItem(HINT_KEY) === "1"; } catch { return false; } };

/** Dismissible card listing what can be customised. */
export function CustomizeHint() {
  useLanguage();
  const [gone, setGone] = useState(readHint);
  if (gone) return null;
  const items = ["Theme presets", "Colours and accent", "Tile styles: soft, solid, outline, iOS", "Tile sizes", "Per-tile colour and fill", "Screen size preview"];
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-muted/30 px-3.5 py-2.5 text-[13px]">
      <Sparkles className="mt-0.5 size-4 flex-none text-primary" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("What can I customize?")}</p>
        <p className="mt-0.5 text-muted-foreground">{items.map((i) => t(i)).join(" · ")}</p>
      </div>
      <button type="button" aria-label={t("Dismiss")} title={t("Dismiss")} className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted" onClick={() => { try { localStorage.setItem(HINT_KEY, "1"); } catch { /* ignore */ } setGone(true); }}>
        <X className="size-4" />
      </button>
    </div>
  );
}
