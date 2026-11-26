import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconDeviceFloppy as Floppy, IconArrowForwardUp as Redo, IconRotate as RotateLeft, IconArrowBackUp as Undo } from "@tabler/icons-react";
import { Alert } from "@/components/ui/knowns/alert";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { Kbd } from "@/components/ui/knowns/kbd";
import { Spinner } from "@/components/ui/knowns/spinner";
import { api } from "@/api";
import { DevicesPanel } from "@/components/devices-panel";
import { IntegrationsPanel } from "@/components/integrations-panel";
import { JsonPanel } from "@/components/json-panel";
import { ScreensPanel } from "@/components/screens-panel";
import { usePreviewOrientation } from "@/components/phone-preview";
import { RulesPanel } from "@/components/rules-panel";
import { SoundsPanel } from "@/components/sounds-panel";
import { ThemePanel } from "@/components/theme-panel";
import { PermissionsPanel } from "@/components/permissions-panel";
import { AboutCard } from "@/components/about-card";
import { ReportCard } from "@/components/report-card";
import { SupportCard } from "@/components/support-card";
import { ScreenPanel } from "@/components/screen-panel";
import { CustomizeHint } from "@/components/visual-options";
import { UpdateBanner } from "@/components/update-banner";
import { useAbout } from "@/lib/about";
import { setPlatform, usePlatform } from "@/lib/platform";
import { needsAttention, useDoctor } from "@/lib/doctor";
import { mergeLayouts } from "@/lib/layout-merge";
import { PluginsPanel } from "@/components/plugins-panel";
import { placePluginTile } from "@/lib/palette";
import { PluginsOverview } from "@/components/plugins-overview";
import { parsePluginLink, parseThemeLink, type PluginLink } from "@/lib/plugin-link";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { ThemesStore } from "@/components/themes-store";
import { WeatherPage } from "@/components/weather-page";
import { HassCard } from "@/components/hass-card";
import { WebhookCard } from "@/components/webhook-card";
import { BUILTIN_PLUGINS, AI_TOOL_IDS } from "@/lib/builtin-plugins";
import { AppSidebar, pageFromHash, pageTitle, type Tab } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/knowns/blocks/sidebar/sidebar";
import { useEnabledPlugins } from "@/lib/plugins";
import { asLanguage, setLanguage, type Language, t, useLanguage } from "@/lib/i18n";
import type { AiProvider, Layout } from "@/types";

const REPO = "https://github.com/howznguyen/nookdeck";

type Status = { kind: "ok" | "error" | "info"; text: string } | null;

export default function App() {
  const lang = useLanguage();
  const platform = usePlatform();
  const about = useAbout();
  const doctor = useDoctor();
  const attention = needsAttention(doctor.items, platform);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [saved, setSaved] = useState("");
  const [tab, setTabState] = useState<Tab>(() => pageFromHash(window.location.hash));
  // The section lives in the URL hash, so reload and the back button keep the place.
  useEffect(() => {
    const on = () => setTabState(pageFromHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // The Home Assistant sign-in ends on #plugins/core.hass?hass=ok (or hass=error&reason=...): say how it went, then keep the clean hash.
  const layoutReady = layout !== null;
  useEffect(() => {
    if (!layoutReady) return; // the first load clears the status line, so wait for it
    const m = /[?&]hass=(ok|error)(?:&reason=([^&]*))?/.exec(window.location.hash);
    if (!m) return;
    let reason = m[2] ?? "";
    try { reason = decodeURIComponent(reason); } catch { /* keep as is */ }
    const popup = !!window.opener;
    setStatus(m[1] === "ok"
      ? { kind: "ok", text: popup ? t("Signed in to Home Assistant. You can close this tab.") : t("Signed in to Home Assistant.") }
      : { kind: "error", text: reason ? t("Home Assistant sign-in failed: {reason}", { reason }) : t("Home Assistant sign-in failed.") });
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#plugin/hass`);
    setTabState("plugin/hass");
  }, [layoutReady]);
  // Plugin deeplinks (#plugins?add=<id> or #plugins?install=<https address>): open the right dialog, never install by itself. The hash is cleared at once.
  const [pluginLink, setPluginLink] = useState<PluginLink | null>(null);
  useEffect(() => {
    const read = () => {
      const r = parsePluginLink(window.location.hash);
      if (!r) return;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#plugins`);
      setTabState("plugins");
      if ("link" in r) setPluginLink(r.link);
      else setStatus({ kind: "error", text: t("That plugin link is not valid, so it was ignored.") });
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  // Theme deeplink (#themes?add=<id>): open the Themes page on that pack.
  const [themeLink, setThemeLink] = useState<string | null>(null);
  const [themeTab, setThemeTab] = useState<"customize" | "packs">("customize");
  useEffect(() => {
    const read = () => {
      const r = parseThemeLink(window.location.hash);
      if (!r) return;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#theme`);
      setTabState("theme");
      setThemeTab("packs");
      if ("open" in r && r.id) setThemeLink(r.id);
      else if ("rejected" in r) setStatus({ kind: "error", text: t("That theme link is not valid, so it was ignored.") });
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const setTab = useCallback((v: Tab) => {
    setTabState(v);
    if (window.location.hash !== `#${v}`) window.location.hash = v;
  }, []);
  const communityPlugins = useEnabledPlugins(tab);
  // The sidebar's own choice is remembered. On Screens, below 1400px wide, it folds to the icon rail so the phone preview keeps its width (opening it there is not remembered).
  const [userCollapsed, setUserCollapsed] = useState(() => { try { return localStorage.getItem("nookdeck.sidebar:collapsed") === "1"; } catch { return false; } });
  const [forceOpen, setForceOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1400);
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 1400);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const autoCollapse = tab === "screens" && narrow;
  useEffect(() => { if (!autoCollapse) setForceOpen(false); }, [autoCollapse]);
  const sidebarCollapsed = userCollapsed || (autoCollapse && !forceOpen);
  const onSidebarCollapse = (v: boolean) => {
    if (autoCollapse && !userCollapsed) return setForceOpen(!v);
    setUserCollapsed(v);
    setForceOpen(false);
    try { localStorage.setItem("nookdeck.sidebar:collapsed", v ? "1" : "0"); } catch { /* not remembered */ }
  };
  const [pageIdx, setPageIdx] = useState(0);
  const [itemId, setItemId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [jsonKey, setJsonKey] = useState(0);
  const [armedReload, setArmedReload] = useState(false);
  const [orientation, setOrientation] = usePreviewOrientation(layout?.theme?.orientation);
  const [history, setHistory] = useState<{ past: Layout[]; future: Layout[] }>({ past: [], future: [] });
  const lastEdit = useRef(0);

  const dirty = layout !== null && JSON.stringify(layout) !== saved;

  const load = useCallback(async () => {
    try {
      const l = await api.getLayout();
      setLayout(l);
      setSaved(JSON.stringify(l));
      setPageIdx((i) => Math.min(i, l.pages.length - 1));
      setItemId(null);
      setLoadError(null);
      setStatus(null);
      setJsonKey((k) => k + 1);
      setHistory({ past: [], future: [] });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    api.getPlatform().then((p) => p && setPlatform(p), () => undefined); // else the browser's own platform is used
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Back on this tab with nothing unsaved: pick up changes made elsewhere (another tab, MCP tools, a script).
  const focusDirty = useRef(false);
  focusDirty.current = dirty;
  useEffect(() => {
    const onFocus = () => {
      if (focusDirty.current) return;
      api.getLayout().then((l) => {
        if (!focusDirty.current && JSON.stringify(l) !== saved0.current) void load();
      }, () => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // The layout carries the language (theme.language); a missing value means English.
  const themeLang = layout?.theme?.language;
  useEffect(() => {
    if (layout) setLanguage(asLanguage(themeLang));
  }, [layout, themeLang]);

  // Every edit goes through here so it can be undone. Edits within 600 ms of each other (typing) share one undo step.
  const layoutRef = useRef<Layout | null>(null);
  layoutRef.current = layout;
  const update = useCallback((fn: (l: Layout) => Layout) => {
    const cur = layoutRef.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    const now = Date.now();
    const coalesce = now - lastEdit.current < 600;
    lastEdit.current = now;
    setHistory((h) => ({ past: coalesce ? h.past : [...h.past.slice(-99), cur], future: [] }));
    layoutRef.current = next;
    setLayout(next);
    setStatus(null);
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      const prev = h.past[h.past.length - 1];
      const cur = layoutRef.current;
      if (!prev || !cur) return h;
      layoutRef.current = prev;
      setLayout(prev);
      setJsonKey((k) => k + 1);
      lastEdit.current = 0;
      return { past: h.past.slice(0, -1), future: [cur, ...h.future] };
    });
  }, []);
  const redo = useCallback(() => {
    setHistory((h) => {
      const nxt = h.future[0];
      const cur = layoutRef.current;
      if (!nxt || !cur) return h;
      layoutRef.current = nxt;
      setLayout(nxt);
      setJsonKey((k) => k + 1);
      lastEdit.current = 0;
      return { past: [...h.past, cur], future: h.future.slice(1) };
    });
  }, []);

  /**
   * Saves `mine` on top of whatever the agent has now: fields changed elsewhere since this page loaded are kept
   * (three-way merge against the last loaded/saved layout). Returns the layout that was saved.
   */
  const saved0 = useRef("");
  saved0.current = saved;
  const saveMerged = useCallback(async (mine: Layout): Promise<Layout> => {
    let out = mine;
    try {
      const theirs = await api.getLayout();
      out = mergeLayouts(JSON.parse(saved0.current || JSON.stringify(theirs)) as Layout, mine, theirs);
    } catch {
      /* cannot read the agent's copy: save what we have */
    }
    await api.putLayout(out);
    if (JSON.stringify(out) !== JSON.stringify(mine)) {
      layoutRef.current = out;
      setLayout(out);
      setJsonKey((k) => k + 1);
    }
    setSaved(JSON.stringify(out));
    return out;
  }, []);

  // Header switch: the page changes at once (and remembers it); the layout carries theme.language so the phone follows.
  // With no other unsaved edits the new language is saved straight away, otherwise it goes out with the next Save.
  const switchLanguage = useCallback(async (l: Language) => {
    setLanguage(l);
    const cur = layoutRef.current;
    if (!cur) return;
    const wasDirty = JSON.stringify(cur) !== saved;
    const theme: Record<string, unknown> = { ...(cur.theme ?? {}) };
    theme.language = l;
    const next: Layout = { ...cur };
    delete next.theme;
    if (Object.keys(theme).length) next.theme = theme as Layout["theme"];
    update(() => next);
    if (wasDirty) {
      setStatus({ kind: "info", text: t("The phone follows the language when you save.") });
      return;
    }
    try {
      await saveMerged(next);
    } catch (e) {
      setStatus({ kind: "error", text: t("The agent rejected the layout: {error}", { error: e instanceof Error ? e.message : String(e) }) });
    }
  }, [saved, update]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!layout) return true;
    if (jsonError) {
      setStatus({ kind: "error", text: t("Invalid JSON: {error}", { error: jsonError }) });
      return false;
    }
    setSaving(true);
    try {
      await saveMerged(layout);
      setStatus({ kind: "ok", text: t("Saved. The phone gets the new layout right away.") });
      return true;
    } catch (e) {
      setStatus({ kind: "error", text: t("The agent rejected the layout: {error}", { error: e instanceof Error ? e.message : String(e) }) });
      return false;
    } finally {
      setSaving(false);
    }
  }, [layout, jsonError]);

  // Ctrl/Cmd+S and leave-page guard always see the latest state.
  const saveRef = useRef(save);
  saveRef.current = save;
  // Applying a theme writes on the agent at once: keep other unsaved edits by saving them first, so the reload that follows never drops them.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const flushDraft = useCallback(async () => { if (dirtyRef.current && !(await saveRef.current())) throw new Error(t("Your other changes could not be saved, so the theme was not applied.")); }, []);
  const undoRef = useRef({ undo, redo });
  undoRef.current = { undo, redo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        const t = e.target as HTMLElement | null;
        // Inside a text field the browser's own text undo wins.
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        if (e.shiftKey) undoRef.current.redo();
        else undoRef.current.undo();
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  const reload = () => {
    if (dirty && !armedReload) {
      setArmedReload(true);
      setTimeout(() => setArmedReload(false), 3000);
      return;
    }
    setArmedReload(false);
    void load();
  };

  const safePageIdx = useMemo(() => (layout ? Math.min(pageIdx, layout.pages.length - 1) : 0), [layout, pageIdx]);

  return (
    <SidebarProvider collapsed={sidebarCollapsed} onCollapsedChange={onSidebarCollapse} mobileBelow={900}>
      <AppSidebar tab={tab} onTab={setTab} attention={attention} about={about} repo={about?.repo ?? REPO} lang={lang} onLang={(l) => void switchLanguage(l)}
        onAbout={() => setTab("about")} />
      <SidebarInset className="h-screen overflow-hidden">
        <header className="flex flex-none items-center gap-2 border-b px-3 py-2">
          <SidebarTrigger label={t("Menu")} labels={{ collapse: t("Collapse sidebar"), expand: t("Expand sidebar") }} />
          <h1 className="mr-auto min-w-0 truncate text-[15px] font-semibold">{pageTitle(tab, communityPlugins.find((p) => `plugin/${p.id}` === tab)?.name)}</h1>
          {dirty && <Badge tone="warning" dot>{t("Unsaved")}</Badge>}
          <Button variant="secondary" icon={<Undo />} disabled={history.past.length === 0} onClick={undo} aria-label={t("Undo")} title={t("Undo (⌘Z)")} />
          <Button variant="secondary" icon={<Redo />} disabled={history.future.length === 0} onClick={redo} aria-label={t("Redo")} title={t("Redo (⌘⇧Z)")} />
          <Button variant="secondary" icon={<RotateLeft />} onClick={reload}>{armedReload ? t("Discard changes?") : t("Reload")}</Button>
          <Button icon={<Floppy />} loading={saving} disabled={!layout || (!dirty && !jsonError)} onClick={() => void save()}>
            {t("Save")} <Kbd size="sm" tone="inverse">⌘S</Kbd>
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
      <UpdateBanner repo={about?.repo ?? REPO} enabled={layout?.theme?.updateCheck !== false} />
      {layout && <SupportCard />}

      {status && (
        <Alert tone={status.kind === "error" ? "danger" : status.kind === "ok" ? "success" : "info"} onDismiss={() => setStatus(null)}>
          {status.text}
        </Alert>
      )}

      {loadError && (
        <Alert tone="danger" title={t("Could not load the layout")} action={{ label: t("Retry"), onClick: () => void load() }}>{loadError}</Alert>
      )}

      {!layout && !loadError && <div className="grid flex-1 place-items-center"><Spinner label={t("Loading layout")} /></div>}

      {layout && (
        <main key={lang} id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {(tab === "screens" || (tab === "theme" && themeTab === "customize")) && <div className="mb-3"><CustomizeHint /></div>}
          {tab === "screens" && (
            <ScreensPanel layout={layout} pageIdx={safePageIdx} itemId={itemId} setPageIdx={setPageIdx} setItemId={setItemId} update={update}
              orientation={orientation} onOrientation={setOrientation} onUndo={undo} />
          )}
          {tab === "theme" && (
            <div className="mb-3">
              <SegmentedControl size="sm" aria-label={t("Theme")} value={themeTab} onValueChange={(v) => setThemeTab(v as "customize" | "packs")}
                options={[{ value: "customize", label: t("Customize") }, { value: "packs", label: t("Packs") }]} />
            </div>
          )}
          {tab === "theme" && themeTab === "packs" && <ThemesStore layout={layout} beforeApply={flushDraft} deeplinkId={themeLink} onDeeplinkDone={() => setThemeLink(null)} onLayoutChanged={() => void load()} />}
          {tab === "theme" && themeTab === "customize" && (
            <ThemePanel beforeApply={flushDraft} onOpenPacks={() => setThemeTab("packs")} layout={layout} pageId={layout.pages[safePageIdx]!.id} orientation={orientation} onOrientation={setOrientation}
              onLayoutChanged={() => void load()} onPageTheme={(pid, look) => update((l) => ({ ...l, pages: l.pages.map((p) => { if (p.id !== pid) return p; const { theme: _t, ...rest } = p; return look ? { ...rest, theme: look } : rest; }) }))}
              onChange={(theme) => update((l) => {
                const rest = { ...l };
                delete rest.theme;
                return theme ? { ...rest, theme } : rest;
              })} />
          )}
          {tab === "screen" && <ScreenPanel layout={layout} pageId={layout.pages[safePageIdx]!.id} update={update} orientation={orientation} onOrientation={setOrientation} />}
          {tab === "rules" && <div className="flex flex-col gap-4"><RulesPanel layout={layout} update={update} /><WebhookCard /></div>}
          {tab === "sounds" && <SoundsPanel />}
          {tab === "plugins" && <PluginsOverview deeplink={pluginLink} onDeeplinkDone={() => setPluginLink(null)} update={update} layout={layout} onSaveLayout={() => { window.setTimeout(() => void saveRef.current(), 80); }}
            onAddTile={(p, widgetId, pi) => { const r = placePluginTile(layout, pi, p, widgetId); if ("error" in r) return r.error; update(() => r.layout); setPageIdx(pi); setItemId(r.itemId); setTab("screens"); return null; }} />}
          {(AI_TOOL_IDS as readonly string[]).includes(tab.replace("plugin/", "")) && tab.startsWith("plugin/") && <IntegrationsPanel key={tab} tool={tab.slice(7) as AiProvider} />}
          {tab === "plugin/hass" && <div className="max-w-3xl"><HassCard /></div>}
          {tab === "plugin/quota" && <div className="max-w-3xl"><PluginsPanel key={tab} update={update} layout={layout} only="core.quota" /></div>}
          {tab === "plugin/weather" && <WeatherPage layout={layout} update={update} onGoScreens={() => setTab("screens")} />}
          {tab.startsWith("plugin/") && !BUILTIN_PLUGINS.some((p) => `plugin/${p.id}` === tab) && <div className="max-w-3xl"><PluginsPanel key={tab} update={update} only={tab.slice(7)} /></div>}
          {tab === "permissions" && <PermissionsPanel {...doctor} />}
          {tab === "json" && <JsonPanel key={jsonKey} layout={layout} onChange={(l) => update(() => l)} onError={setJsonError} />}
          {tab === "devices" && <DevicesPanel />}
          {tab === "about" && <div className="flex flex-col gap-4"><AboutCard about={about} /><ReportCard /></div>}
        </main>
      )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
