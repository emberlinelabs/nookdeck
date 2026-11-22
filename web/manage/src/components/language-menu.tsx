import { IconChevronDown as Chevron, IconWorld as Globe } from "@tabler/icons-react";
import { Menu } from "@/components/ui/knowns/menu";
import { Tooltip } from "@/components/ui/knowns/tooltip";
import { LANGUAGES, t, useLanguage, type Language } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The language picker: a menu of languages, each by its own name, so a new language is one more row. `compact` shows only the globe. */
export function LanguageMenu({ value, onChange, compact, className, side = "auto", id }: { value: Language; onChange: (l: Language) => void; compact?: boolean; className?: string; side?: "top" | "bottom" | "auto"; id?: string }) {
  useLanguage();
  const current = LANGUAGES.find((l) => l.id === value) ?? LANGUAGES[0]!;
  const trigger = (
    <button type="button" id={id} aria-label={`${t("Language")}: ${current.label}`}
      className={cn("flex h-8 items-center gap-2 rounded-lg border border-transparent px-2.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring", compact ? "mx-auto w-8 justify-center px-0" : "w-full border-border", className)}>
      <Globe className="size-4 shrink-0" aria-hidden />
      {!compact && <><span className="min-w-0 flex-1 truncate text-left text-foreground">{current.label}</span><Chevron className="size-3.5 shrink-0" aria-hidden /></>}
    </button>
  );
  const menu = (
    <Menu aria-label={t("Language")} role="listbox" side={side} align="start" width={compact ? 180 : "trigger"} trigger={trigger}
      items={LANGUAGES.map((l) => ({ id: l.id, label: l.label, kind: "radio" as const, checked: l.id === value }))}
      onSelect={(item) => onChange(item.id as Language)} />
  );
  return compact ? <Tooltip content={`${t("Language")}: ${current.label}`} side="right">{menu}</Tooltip> : menu;
}
