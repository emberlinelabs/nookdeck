import { useState, type ReactNode } from "react";
import { IconAlarm as Alarm, IconBolt as Bolt, IconBraces as Braces, IconDevices as Devices, IconInfoCircle as Info, IconLayoutGrid as Grid, IconPalette as Palette, IconPuzzle as Puzzle, IconShieldCheck as Shield, IconVolume as Volume } from "@tabler/icons-react";
import { Tooltip } from "@/components/ui/knowns/tooltip";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarItem, useSidebar } from "@/components/ui/knowns/blocks/sidebar/sidebar";
import { t, useLanguage, type Language } from "@/lib/i18n";
import { BUILTIN_PLUGINS } from "@/lib/builtin-plugins";
import { useEnabledPlugins } from "@/lib/plugins";
import { Icon } from "@/components/icon";
import type { About } from "@/types";

/** A page is a base section id or `plugin/<id>`; it is also the URL hash. */
export type Tab = string;
type Section = { value: Tab; label: string; icon: ReactNode };
const NAV_TOP: { label: string; items: Section[] }[] = [
  { label: "Layout", items: [
    { value: "screens", label: "Screens", icon: <Grid /> },
    { value: "theme", label: "Theme", icon: <Palette /> },
    { value: "screen", label: "Screen & alarms", icon: <Alarm /> },
  ] },
  { label: "Actions", items: [
    { value: "rules", label: "Automation", icon: <Bolt /> },
    { value: "sounds", label: "Sounds", icon: <Volume /> },
  ] },
];
const NAV_SYSTEM: Section[] = [
  { value: "permissions", label: "Permissions", icon: <Shield /> },
  { value: "devices", label: "Devices", icon: <Devices /> },
  { value: "json", label: "JSON", icon: <Braces /> },
  { value: "about", label: "About", icon: <Info /> },
];
const BASE: Section[] = [...NAV_TOP.flatMap((g) => g.items), { value: "plugins", label: "Plugins", icon: <Puzzle /> }, ...NAV_SYSTEM];
/** Hashes of older versions that now live somewhere else. */
const REDIRECT: Record<string, Tab> = { ai: "plugin/claude" };

/** Parses the URL hash into a page, following old links. */
export function pageFromHash(hash: string): Tab {
  let raw = hash.replace(/^#/, "").replace(/\?.*$/, "");
  try { raw = decodeURIComponent(raw); } catch { /* keep the raw text */ }
  // The agent's own links: #plugins/core.<id> is the page of the built-in plugin <id>.
  const core = /^plugins\/core\.(.+)$/.exec(raw);
  if (core) raw = `plugin/${core[1]}`;
  const h = REDIRECT[raw] ?? raw;
  if (BASE.some((x) => x.value === h) || (h.startsWith("plugin/") && h.length > 7)) return h;
  return "screens";
}

/** Title of a page for the top bar. */
export function pageTitle(page: Tab, communityName?: string): string {
  const b = BASE.find((x) => x.value === page);
  if (b) return t(b.label);
  const id = page.replace(/^plugin\//, "");
  return BUILTIN_PLUGINS.find((p) => p.id === id)?.name ?? communityName ?? id;
}

/** Fold state of a group, remembered per group. */
function useFold(name: string): [boolean, (o: boolean) => void] {
  const key = `nookdeck.sidebar.${name}Open`;
  const [open, setOpen] = useState(() => { try { return window.localStorage.getItem(key) !== "0"; } catch { return true; } });
  return [open, (o) => { setOpen(o); try { window.localStorage.setItem(key, o ? "1" : "0"); } catch { /* not remembered */ } }];
}

const LANGS: { value: Language; label: string }[] = [{ value: "en", label: "EN" }, { value: "vi", label: "VI" }, { value: "zh", label: "中文" }];

function VersionChip({ about, onAbout }: { about: About; onAbout: () => void }) {
  const text = `v${about.version}${about.commit ? ` · ${about.commit}` : ""}${about.dirty ? "*" : ""}`;
  const cls = "w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
  return about.commit && !about.dirty
    ? <a href={`${about.repo}/commit/${about.commit}`} target="_blank" rel="noopener noreferrer" title={t("Open this commit on GitHub")} className={cls}>{text}</a>
    : <button type="button" title={t("Open About")} className={cls} onClick={onAbout}>{text}</button>;
}

const GITHUB = (
  <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" /></svg>
);

/** The left navigation: logo and version on top, the sections in groups, language and GitHub at the bottom. A rail of icons when collapsed, a drawer on narrow screens. */
export function AppSidebar({ tab, onTab, attention, about, repo, lang, onLang, onAbout }: { tab: Tab; onTab: (t: Tab) => void; attention: number; about: About | null; repo: string; lang: Language; onLang: (l: Language) => void; onAbout: () => void }) {
  useLanguage();
  const { collapsed, isMobile } = useSidebar();
  const rail = collapsed && !isMobile;
  const community = useEnabledPlugins(tab);
  const [layoutOpen, setLayoutOpen] = useFold("layout");
  const [actionsOpen, setActionsOpen] = useFold("actions");
  const [pluginsOpen, setPluginsOpen] = useFold("plugins");
  const [systemOpen, setSystemOpen] = useFold("system");
  const folds: Record<string, [boolean, (o: boolean) => void]> = { Layout: [layoutOpen, setLayoutOpen], Actions: [actionsOpen, setActionsOpen] };
  const row = (x: Section, raw = false) => (
    <div key={x.value} id={`tab-${x.value}`}>
      <SidebarItem
        label={raw ? x.label : t(x.label)}
        icon={x.icon}
        href={`#${x.value}`}
        active={tab === x.value}
        count={x.value === "permissions" && attention > 0 ? attention : undefined}
        onClick={() => onTab(x.value)}
      />
    </div>
  );
  const brand = (
    <div className="flex min-w-0 items-center gap-2.5">
      <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={32} height={32} className="size-8 flex-none" />
      {!rail && <span className="truncate text-[15px] font-semibold tracking-tight">Nookdeck</span>}
    </div>
  );
  return (
    <Sidebar label={t("Main menu")} collapsible sheetHeader={brand}>
      <SidebarHeader>
        {!isMobile && <div className={rail ? "flex justify-center py-1" : "px-1 py-1"}>{brand}</div>}
        {!rail && about && <div className="flex px-1"><VersionChip about={about} onAbout={onAbout} /></div>}
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t("Sections")} className="flex flex-col gap-3">
          {NAV_TOP.map((g) => (
            <SidebarGroup key={g.label} label={t(g.label)} collapsible open={folds[g.label]![0]} onOpenChange={folds[g.label]![1]} active={g.items.some((x) => x.value === tab)}>
              {g.items.map((x) => row(x))}
            </SidebarGroup>
          ))}
          <SidebarGroup label={t("Plugins")} collapsible open={pluginsOpen} onOpenChange={setPluginsOpen} active={tab === "plugins" || tab.startsWith("plugin/")} count={pluginsOpen ? undefined : BUILTIN_PLUGINS.length + community.length}>
            {row({ value: "plugins", label: "All plugins", icon: <Puzzle /> })}
            {!rail && (
              <div className="ml-4 flex flex-col gap-0.5 border-l pl-1.5">
                <div className="px-2 pt-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">{t("Built-in")}</div>
                {BUILTIN_PLUGINS.map((p) => row({ value: `plugin/${p.id}`, label: p.name, icon: <Icon name={p.icon} size={16} /> }, true))}
                {community.length > 0 && <div className="px-2 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/80">{t("Community plugins")}</div>}
                {community.map((p) => row({ value: `plugin/${p.id}`, label: p.name, icon: <Puzzle /> }, true))}
              </div>
            )}
          </SidebarGroup>
          <SidebarGroup label={t("System")} collapsible open={systemOpen} onOpenChange={setSystemOpen} active={NAV_SYSTEM.some((x) => x.value === tab)}>
            {NAV_SYSTEM.map((x) => row(x))}
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        {rail ? (
          <Tooltip content={t("Language")} side="right">
            <button type="button" aria-label={t("Language")} className="mx-auto grid h-8 min-w-8 place-items-center rounded-lg px-1 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onLang(LANGS[(LANGS.findIndex((l) => l.value === lang) + 1) % LANGS.length]!.value)}>
              {LANGS.find((l) => l.value === lang)?.label}
            </button>
          </Tooltip>
        ) : (
          <SegmentedControl size="sm" aria-label={t("Language")} value={lang} onValueChange={(v) => onLang(v === "vi" ? "vi" : v === "zh" ? "zh" : "en")} options={LANGS} className="w-full" />
        )}
        <a href={repo} target="_blank" rel="noopener noreferrer" title={t("Source code on GitHub")} aria-label={t("Source code on GitHub")} className="flex h-8 items-center gap-2.5 rounded-[9px] px-3 text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <span className={rail ? "mx-auto" : ""}>{GITHUB}</span>
          {!rail && <span>GitHub</span>}
        </a>
      </SidebarFooter>
    </Sidebar>
  );
}
