import { IconCheck as Check } from "@tabler/icons-react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ThemeLook } from "@/types";

const FONTS: Record<string, string> = { serif: "Georgia, serif", mono: "ui-monospace, Menlo, monospace", rounded: "ui-rounded, system-ui, sans-serif", condensed: "'Arial Narrow', system-ui, sans-serif" };

const alpha = (hex: string, a: number): string => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || a >= 1) return hex;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
};

/** The variant's own surface: its gradient or background colour. */
export function lookSurface(look: Partial<ThemeLook>, mode?: "light" | "dark"): string {
  const g = look.gradient;
  if (g) return `linear-gradient(${g.angle ?? 180}deg, ${g.from}, ${g.to})`;
  return look.background ?? ((mode ?? look.mode) !== "light" ? "#0b0b0d" : "#f4f4f6");
}

/** A tiny mock of a screen drawn with plain CSS from a resolved look: no deck iframe, so many of them are cheap. */
export function MiniScreen({ look, mode, bare }: { look: Partial<ThemeLook>; mode?: "light" | "dark"; bare?: boolean }) {
  const dark = (mode ?? look.mode) !== "light";
  const tile = look.tile ?? (dark ? "#141417" : "#ffffff");
  const accent = look.accent ?? "#22d3ee";
  const text = look.text ?? (dark ? "#f4f4f5" : "#111113");
  const muted = look.muted ?? alpha(text, 0.55);
  const radius = Math.min(look.radius ?? 14, 40) * 0.33;
  const gap = Math.max(1, Math.min(look.gap ?? 10, 20) * 0.3);
  const style = look.tileStyle ?? "tint";
  const bd = look.border && look.border.width > 0 ? `${Math.max(0.5, look.border.width * 0.6)}px solid ${look.border.color ?? alpha(text, 0.25)}` : style === "outline" ? `1px solid ${alpha(accent, 0.8)}` : "0";
  const op = look.tileOpacity ?? 1;
  const fill = style === "outline" ? "transparent" : alpha(tile, op);
  const serif = FONTS[look.font ?? ""] ?? undefined;
  const chart = look.chartColors?.[0] ?? accent;
  const cell = (i: number): React.CSSProperties => {
    const on = i === 0 || i === 4;
    const solid = on && (style === "solid" || style === "ios");
    return { background: solid ? accent : style === "tint" && on ? alpha(accent, 0.22) : fill, border: bd, borderRadius: radius, boxShadow: look.shadow === "strong" ? "0 1px 3px rgba(0,0,0,.5)" : look.shadow === "soft" ? "0 1px 2px rgba(0,0,0,.3)" : undefined, backdropFilter: look.tileBlur ? `blur(${Math.min(look.tileBlur, 6)}px)` : undefined, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 18%", gap: 2, minHeight: 0 };
  };
  return (
    <div aria-hidden="true" style={{ background: bare ? "transparent" : lookSurface(look, mode), padding: bare ? 0 : gap + 1, borderRadius: 8, fontFamily: serif }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gridTemplateRows: "repeat(2, 1fr)", gap, height: 54 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const solid = (i === 0 || i === 4) && (style === "solid" || style === "ios");
          const ink = solid ? (dark ? "#0b0b0d" : "#ffffff") : text;
          return (
            <div key={i} style={cell(i)}>
              {i === 2 ? (
                <svg viewBox="0 0 30 12" width="100%" height="12" preserveAspectRatio="none"><polyline points="0,10 6,7 11,9 17,4 23,6 30,1" fill="none" stroke={chart} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" /></svg>
              ) : (
                <>
                  <span style={{ height: 3, width: "70%", borderRadius: 2, background: i === 0 || i === 4 ? ink : alpha(text, 0.85) }} />
                  <span style={{ height: 2, width: "45%", borderRadius: 2, background: solid ? alpha(ink, 0.6) : muted }} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One variant as a small card: the mini screen, its name, light or dark, and a check with an accent ring when it is the one in use. */
export function VariantMini({ look, name, mode, current, picked, disabled, onPick, onHover, small }: {
  look: Partial<ThemeLook>; name: string; mode: "light" | "dark"; current?: boolean; picked: boolean; disabled?: boolean; onPick: () => void; onHover?: (on: boolean) => void; small?: boolean;
}) {
  return (
    <button type="button" role="radio" aria-checked={picked} disabled={disabled} onClick={onPick}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} onFocus={() => onHover?.(true)} onBlur={() => onHover?.(false)}
      style={{ background: lookSurface(look, mode), color: look.text ?? (mode === "light" ? "#111113" : "#f4f4f5"), borderColor: picked ? look.accent ?? undefined : alpha(look.text ?? "#888888", 0.22), boxShadow: picked ? `0 0 0 2px ${look.accent ?? "#22d3ee"}` : undefined }}
      className="flex min-w-0 flex-col gap-1.5 rounded-xl border p-1.5 text-left text-[12px] transition-transform hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
      <MiniScreen look={look} mode={mode} bare />
      <span className="flex items-center justify-between gap-1 px-0.5">
        <span className={cn("min-w-0 truncate font-medium", small && "text-[11.5px]")}>{name}</span>
        <span className="flex flex-none items-center gap-1 text-[10.5px] opacity-70">
          {current && <Check className="size-3.5" style={{ color: look.accent }} aria-label={t("In use")} />}
          {!small && (mode === "light" ? t("Light") : t("Dark"))}
        </span>
      </span>
    </button>
  );
}

/** The smallest version: just the screen, for a strip of variants on a pack card. */
export function MiniStrip({ look, mode }: { look: Partial<ThemeLook>; mode: "light" | "dark" }) {
  return <MiniScreen look={look} mode={mode} />;
}
