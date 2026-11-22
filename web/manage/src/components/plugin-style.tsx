import type { ReactNode } from "react";
import { PLUGIN_STYLES } from "@shared/plugin-styles";
import { OptionCards } from "@/components/visual-options";
import { Field } from "@/components/ui/knowns/input";
import { t, useLanguage } from "@/lib/i18n";

export { PLUGIN_STYLES };

function label(render: string, s: string): string {
  switch (`${render}:${s}`) {
    case "stat:plain": return t("Plain");
    case "stat:spark": return t("With trend");
    case "stat:big": return t("Big number");
    case "gauge:arc": return t("Arc");
    case "gauge:ring": return t("Ring");
    case "gauge:half": return t("Half circle");
    case "gauge:bar": return t("Bar");
    case "text:plain": return t("Plain");
    case "text:minimal": return t("Minimal");
    case "list:rows": return t("Rows");
    case "list:compact": return t("Compact");
    case "chart:line": return t("Line");
    case "chart:area": return t("Area");
    case "chart:bars": return t("Bars");
    case "chart:dots": return t("Dots");
    case "image:cover": return t("Fill");
    case "image:contain": return t("Fit");
    case "status:card": return t("Card");
    case "status:pill": return t("Pill");
    case "status:dot": return t("Dot");
    default: return s;
  }
}

const C = "currentColor";
const Svg = ({ children }: { children: ReactNode }) => <svg aria-hidden viewBox="0 0 52 34" width="52" height="34" className="text-foreground">{children}</svg>;
const PTS = "4,26 12,18 20,22 28,10 36,15 48,6";

function art(render: string, s: string): ReactNode {
  const k = `${render}:${s}`;
  switch (k) {
    case "stat:plain": return <Svg><rect x="6" y="6" width="18" height="3" rx="1.5" opacity=".45" fill={C} /><rect x="6" y="15" width="30" height="12" rx="3" fill={C} /></Svg>;
    case "stat:spark": return <Svg><rect x="6" y="5" width="16" height="3" rx="1.5" opacity=".45" fill={C} /><rect x="6" y="11" width="20" height="9" rx="2.5" fill={C} /><polyline points="6,30 16,26 24,28 34,22 46,24" fill="none" stroke={C} strokeWidth="2" strokeLinecap="round" opacity=".6" /></Svg>;
    case "stat:big": return <Svg><rect x="5" y="6" width="42" height="22" rx="4" fill={C} /></Svg>;
    case "gauge:arc": return <Svg><path d="M10 28 A16 16 0 1 1 42 28" fill="none" stroke={C} strokeWidth="4" strokeLinecap="round" opacity=".3" /><path d="M10 28 A16 16 0 0 1 30 12" fill="none" stroke={C} strokeWidth="4" strokeLinecap="round" /></Svg>;
    case "gauge:ring": return <Svg><circle cx="26" cy="17" r="12" fill="none" stroke={C} strokeWidth="4" opacity=".3" /><path d="M26 5 A12 12 0 0 1 38 17" fill="none" stroke={C} strokeWidth="4" strokeLinecap="round" /></Svg>;
    case "gauge:half": return <Svg><path d="M8 27 A18 18 0 0 1 44 27" fill="none" stroke={C} strokeWidth="4" strokeLinecap="round" opacity=".3" /><path d="M8 27 A18 18 0 0 1 26 9" fill="none" stroke={C} strokeWidth="4" strokeLinecap="round" /></Svg>;
    case "gauge:bar": return <Svg><rect x="6" y="14" width="40" height="6" rx="3" opacity=".3" fill={C} /><rect x="6" y="14" width="24" height="6" rx="3" fill={C} /></Svg>;
    case "text:plain": return <Svg><rect x="6" y="7" width="28" height="4" rx="2" fill={C} /><rect x="6" y="15" width="40" height="3" rx="1.5" opacity=".5" fill={C} /><rect x="6" y="21" width="34" height="3" rx="1.5" opacity=".5" fill={C} /></Svg>;
    case "text:minimal": return <Svg><rect x="10" y="15" width="32" height="4" rx="2" fill={C} /></Svg>;
    case "list:rows": return <Svg>{[5, 14, 23].map((y) => <g key={y}><circle cx="9" cy={y + 2} r="2.5" fill={C} /><rect x="16" y={y} width="30" height="4" rx="2" opacity=".6" fill={C} /></g>)}</Svg>;
    case "list:compact": return <Svg>{[4, 10, 16, 22, 28].map((y) => <rect key={y} x="6" y={y} width={y % 12 === 4 ? 36 : 28} height="3" rx="1.5" opacity=".6" fill={C} />)}</Svg>;
    case "chart:line": return <Svg><polyline points={PTS} fill="none" stroke={C} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></Svg>;
    case "chart:area": return <Svg><polygon points={`${PTS} 48,30 4,30`} fill={C} opacity=".3" /><polyline points={PTS} fill="none" stroke={C} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></Svg>;
    case "chart:bars": return <Svg>{[8, 15, 11, 22, 17, 26].map((h, i) => <rect key={i} x={5 + i * 7.5} y={30 - h} width="5" height={h} rx="1.5" fill={C} />)}</Svg>;
    case "chart:dots": return <Svg>{[26, 18, 22, 10, 15, 6].map((y, i) => <circle key={i} cx={7 + i * 7.5} cy={y + 2} r="2.4" fill={C} />)}</Svg>;
    case "image:cover": return <Svg><rect x="3" y="3" width="46" height="28" rx="3" fill={C} opacity=".55" /><circle cx="16" cy="13" r="3" fill="var(--background, #000)" /></Svg>;
    case "image:contain": return <Svg><rect x="3" y="3" width="46" height="28" rx="3" fill="none" stroke={C} strokeWidth="1.5" opacity=".35" /><rect x="12" y="8" width="28" height="18" rx="2" fill={C} opacity=".55" /></Svg>;
    case "status:card": return <Svg><rect x="4" y="4" width="44" height="26" rx="5" fill={C} opacity=".18" /><circle cx="13" cy="12" r="3.5" fill={C} /><rect x="20" y="10" width="22" height="4" rx="2" fill={C} /><rect x="9" y="21" width="30" height="3" rx="1.5" opacity=".5" fill={C} /></Svg>;
    case "status:pill": return <Svg><rect x="5" y="10" width="42" height="14" rx="7" fill={C} opacity=".25" /><circle cx="14" cy="17" r="3.5" fill={C} /><rect x="22" y="15" width="20" height="4" rx="2" fill={C} /></Svg>;
    case "status:dot": return <Svg><circle cx="26" cy="17" r="8" fill={C} /></Svg>;
    default: return <Svg><rect x="8" y="10" width="36" height="14" rx="4" fill={C} opacity=".4" /></Svg>;
  }
}

/** Picks how a plugin tile is drawn (plugin.view.style). The manifest's suggestion is marked "Suggested"; with no choice the suggestion, then the first style, is used. */
export function PluginStylePicker({ render, value, suggested, onChange }: { render: string; value: string | undefined; suggested?: string; onChange: (v: string | undefined) => void }) {
  useLanguage();
  const all = PLUGIN_STYLES[render];
  if (!all || all.length < 2) return null;
  const sug = suggested && all.includes(suggested) ? suggested : undefined;
  const effective = value && all.includes(value) ? value : sug ?? all[0]!;
  return (
    <Field label={t("Style")} id="f-pl-style" hint={t("How this tile looks on the phone.")}>
      <OptionCards
        label={t("Style")}
        cols={all.length === 2 ? 2 : all.length === 3 ? 3 : 4}
        value={effective}
        onChange={(v) => onChange(v === (sug ?? all[0]) ? undefined : v)}
        options={all.map((s) => ({ value: s, label: s === sug ? `${label(render, s)} · ${t("Suggested")}` : label(render, s), art: art(render, s) }))}
      />
    </Field>
  );
}
