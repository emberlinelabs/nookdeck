import { sameRepo, type PluginLink } from "@/lib/plugin-link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconBook as Book, IconLink as LinkIcon, IconSearch as Search, IconBuildingStore as Store, IconCloudOff as Offline } from "@tabler/icons-react";
import { Alert } from "@/components/ui/knowns/alert";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { Empty } from "@/components/ui/knowns/empty";
import { Input } from "@/components/ui/knowns/input";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { Spinner } from "@/components/ui/knowns/spinner";
import { api } from "@/api";
import { Icon } from "@/components/icon";
import { PluginDetailsSheet, type PluginDetails } from "@/components/plugin-details";
import { EntryButton, EntryCard, EntryRow } from "@/components/plugin-store";
import { RowList, ViewToggle, usePluginView } from "@/components/plugin-view";
import { PermissionDialog, PluginsPanel } from "@/components/plugins-panel";
import { BUILTIN_PLUGINS } from "@/lib/builtin-plugins";
import { t, useLanguage } from "@/lib/i18n";
import type { Layout, PluginInfo, PluginPermissions, RegistryEntry, RegistryManifest, RegistryResult } from "@/types";

const GUIDE = "https://github.com/howznguyen/nookdeck/blob/main/docs/plugins.md";
type Tab = "discover" | "installed" | "updates";
type Filter = "all" | "nocode" | "code" | "net" | "shell" | "keys" | "mac";
const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "nocode", label: "No code" }, { id: "code", label: "Runs code" }, { id: "net", label: "Uses the internet" }, { id: "shell", label: "Runs commands" }, { id: "keys", label: "Presses keys" }, { id: "mac", label: "macOS" }];
const matches = (e: { name: string; id: string; author?: string; description?: string }, q: string): boolean => !q || `${e.name} ${e.id} ${e.author ?? ""} ${e.description ?? ""}`.toLowerCase().includes(q.toLowerCase());

const fromEntry = (e: RegistryEntry): PluginDetails => ({ id: e.id, name: e.name, author: e.author, version: e.version, description: e.description, verified: e.verified, permissions: e.permissions, widgets: [], actions: [], source: e.repo, screenshot: e.screenshot, readme: true });
const fromInstalled = (p: PluginInfo, reg?: RegistryEntry): PluginDetails => reg ? { ...fromEntry(reg), version: p.version, builtin: p.builtin } : { id: p.id, name: p.name, author: p.author, version: p.version, description: p.description, builtin: p.builtin, permissions: p.permissions, widgets: p.widgets, actions: p.actions, source: p.source, readme: false };
const NO_PERMS: PluginPermissions = { network: [], shell: false, keyboard: false, storage: false, onair: false, notify: false };

/** The Plugins page: find plugins in the Store, manage the installed ones, and see what is waiting for an update. */
export function PluginsOverview({ deeplink, onDeeplinkDone, update, layout, onSaveLayout, onAddTile }: { deeplink?: PluginLink | null; onDeeplinkDone?: () => void; update: (fn: (l: Layout) => Layout) => void; layout: Layout; onSaveLayout: () => void; onAddTile: (p: PluginInfo, widgetId: string, pageIdx: number) => string | null }) {
  useLanguage();
  const [tab, setTab] = useState<Tab>("installed");
  const [query, setQuery] = useState("");
  const [installed, setInstalled] = useState<PluginInfo[] | null>(null);
  const [registry, setRegistry] = useState<RegistryResult | null | undefined>(undefined); // undefined: loading, null: this agent has no Store
  const [registryError, setRegistryError] = useState(false);
  const [details, setDetails] = useState<PluginDetails | null>(null);
  const [ask, setAsk] = useState<{ entry: RegistryEntry; permissions: PluginPermissions } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkSource, setLinkSource] = useState("");
  const [view, setView] = usePluginView();
  const [filter, setFilter] = useState<Filter>("all");
  // "No code" and "Runs code" need each plugin's manifest; they are fetched when a filter is chosen (cached by the api).
  const [mans, setMans] = useState<Record<string, RegistryManifest | null>>({});
  useEffect(() => {
    if (filter === "all" || !registry) return;
    let live = true;
    for (const e of registry.plugins) api.getRegistryManifest(e.id).then((m) => live && setMans((x) => (e.id in x ? x : { ...x, [e.id]: m })));
    return () => { live = false; };
  }, [filter, registry]);

  const [rev, setRev] = useState(0);
  const loadInstalled = useCallback(() => { setRev((n) => n + 1); api.getPlugins().then(setInstalled, () => setInstalled([])); }, []);
  const loadRegistry = useCallback(() => {
    setRegistryError(false);
    api.getRegistry().then(setRegistry, () => { setRegistry(undefined); setRegistryError(true); });
  }, []);
  useEffect(() => { loadInstalled(); loadRegistry(); }, [loadInstalled, loadRegistry]);

  const count = (installed ?? []).filter((p) => !p.builtin).length;
  // A plugin installed from a link whose id is in the Store: the Store version is a switch (an update would be refused).
  const linked = new Set((installed ?? []).filter((p) => !p.builtin && !p.reviewed && !p.registryVersion).map((p) => p.id));
  const entries = useMemo(() => (registry?.plugins ?? []).map((e) => (e.installed && linked.has(e.id) ? { ...e, fromLink: true } : e)), [registry, installed]);
  const updates = entries.filter((e) => e.updateAvailable || e.fromLink);
  const theme = layout.theme;
  // If the Updates tab empties while it is open, go back to Installed.
  useEffect(() => { if (tab === "updates" && updates.length === 0 && registry) setTab("installed"); }, [tab, updates.length, registry]);

  // Add / Update: read the manifest first (it is the authority on what the plugin asks for), then ask.
  const askFor = async (e: RegistryEntry) => {
    setError(null);
    setBusy(e.id);
    const m = await api.getRegistryManifest(e.id);
    setBusy(null);
    const unavailable = m?.unavailable ?? e.unavailable;
    if (unavailable) return setError(unavailable);
    const permissions = m?.permissions ?? e.permissions;
    if (!permissions) return setError(t("Could not read what this plugin asks for, so it was not installed. Try again in a moment."));
    setAsk({ entry: e, permissions });
  };

  // A deeplink waits for the Store list, then opens the Add dialog (or the link dialog). It never installs by itself.
  useEffect(() => {
    if (!deeplink || (registry === undefined && !registryError) || installed === null) return;
    const entry = deeplink.kind === "add"
      ? entries.find((e) => e.id === deeplink.id)
      : entries.find((e) => e.repo && sameRepo(e.repo, deeplink.source));
    onDeeplinkDone?.();
    if (entry) {
      setTab("discover");
      if (entry.installed && !entry.updateAvailable && !entry.fromLink) setNotice(t("{name} is already installed.", { name: entry.name }));
      else void askFor(entry);
    } else if (deeplink.kind === "install") {
      setTab("installed");
      setLinkSource(deeplink.source);
      setLinkOpen(true);
    } else {
      setError(t("That plugin is not in the Store, so nothing was installed."));
    }
  }, [deeplink, registry, registryError, installed, entries]);

  const addEntry = async () => {
    const a = ask;
    if (!a) return;
    const e = a.entry;
    setAsk(null);
    setBusy(e.id);
    setError(null);
    try {
      if (e.fromLink) {
        const was = (installed ?? []).find((x) => x.id === e.id);
        const p = await api.installFromRegistry(e.id);
        if (p.needsApproval) await api.grantPlugin(p.id, a.permissions);
        if (was ? was.enabled : true) await api.setPluginEnabled(p.id, true);
        setNotice(t("{name} now uses the reviewed version.", { name: e.name }));
        setTab("installed");
      } else if (e.updateAvailable) {
        const p = await api.updatePlugin(e.id);
        if (p.needsApproval) {
          setNotice(t("{name} was updated and now asks for more access. Review it in Installed.", { name: e.name }));
          setTab("installed");
        } else setNotice(t("{name} is up to date.", { name: e.name }));
      } else {
        const p = await api.installFromRegistry(e.id);
        await api.grantPlugin(p.id, a.permissions);
        await api.setPluginEnabled(p.id, true);
        setNotice(t("{name} is on", { name: e.name }));
      }
      setDetails(null);
      loadInstalled();
      loadRegistry();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const passes = (e: RegistryEntry): boolean => {
    if (filter === "all") return true;
    const m = mans[e.id];
    const perms = m?.permissions ?? e.permissions;
    if (filter === "mac") return (m?.os ?? e.os)?.includes("darwin") === true; // the ones with a macOS badge
    if (filter === "nocode" || filter === "code") return m ? (filter === "nocode" ? m.main === null : m.main !== null) : false;
    if (!perms) return false;
    return filter === "net" ? perms.network.length > 0 : filter === "shell" ? perms.shell : perms.keyboard;
  };
  const shown = useMemo(() => entries.filter((e) => matches(e, query.trim()) && passes(e)), [entries, query, filter, mans]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownUpdates = shown.filter((e) => e.updateAvailable || e.fromLink);
  const suggestions = [...entries].filter((e) => !e.installed).sort((a, b) => Number(b.verified) - Number(a.verified)).slice(0, 3);
  const openDetails = (e: RegistryEntry) => setDetails(fromEntry(e));
  const openInstalled = (p: PluginInfo) => setDetails(fromInstalled(p, entries.find((e) => e.id === p.id)));
  const detailEntry = details ? entries.find((e) => e.id === details.id) : undefined;

  const grid = (list: RegistryEntry[]) => view === "list" ? (
    <RowList label={t("Plugins")}>
      {list.map((e) => <EntryRow key={e.id} entry={e} busy={busy === e.id} onAdd={() => void askFor(e)} onOpen={() => openDetails(e)} />)}
    </RowList>
  ) : (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {list.map((e) => <EntryCard key={e.id} entry={e} theme={theme} busy={busy === e.id} onAdd={() => void askFor(e)} onOpen={() => openDetails(e)} />)}
    </div>
  );

  const storeStatus = (
    <>
      {registryError && <Alert tone="warning" icon={<Offline className="size-5" />} action={{ label: t("Try again"), onClick: loadRegistry }}>{t("The plugin Store cannot be reached right now. Check your connection. Plugins you already installed keep working.")}</Alert>}
      {registry?.stale && <Alert tone="info">{t("Showing a saved copy of the Store. It could not be refreshed.")}</Alert>}
    </>
  );

  const discover = registry === undefined && !registryError ? <Spinner label={t("Loading")} /> : registry === null ? (
    <Empty icon={<Store />} title={t("The plugin Store is not available yet")} description={t("This version of Nookdeck cannot list community plugins. You can still install one from a link.")} actions={<Button icon={<LinkIcon />} onClick={() => setLinkOpen(true)}>{t("Install from a link")}</Button>} />
  ) : registry && shown.length === 0 ? (
    <Empty icon={<Store />} title={query ? t("Nothing matches that search") : t("No plugins in the Store yet")} description={query ? t("Try another word.") : t("Check back soon, or install one from a link.")} />
  ) : registry ? grid(shown) : null;

  const builtinGrid = (
    <section className="flex flex-col gap-2" aria-labelledby="po-builtin">
      <h3 id="po-builtin" className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("Built-in")}</h3>
      <div className={view === "list" ? "flex flex-col gap-1.5" : "grid gap-2 sm:grid-cols-2"} onKeyDown={view === "list" ? (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("a")); const at = rows.findIndex((r) => r === document.activeElement);
        e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      } : undefined}>
        {BUILTIN_PLUGINS.filter((p) => matches({ name: p.name, id: p.id, description: t(p.desc) }, query.trim())).map((p) => (
          <a key={p.id} href={`#plugin/${p.id}`} className={`flex items-center gap-3 rounded-xl border bg-card transition-colors hover:bg-muted/50 ${view === "list" ? "px-3 py-2" : "p-3"} focus-visible:outline-2 focus-visible:outline-ring`}>
            <span className="grid size-9 flex-none place-items-center rounded-lg border bg-muted/50"><Icon name={p.icon} size={20} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{p.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{t(p.desc)}</span>
            </span>
            <Badge size="sm" tone="neutral">{t("Built-in")}</Badge>
          </a>
        ))}
      </div>
    </section>
  );

  const firstRun = installed !== null && count === 0 && suggestions.length > 0 && !query.trim() ? (
    <section className="flex flex-col gap-2 rounded-2xl border border-dashed p-3.5" aria-labelledby="po-try">
      <div>
        <h3 id="po-try" className="text-[13.5px] font-semibold">{t("Start with one of these")}</h3>
        <p className="text-xs text-muted-foreground">{t("Each asks before it can do anything. You can remove it any time.")}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {suggestions.map((e) => (
          <div key={e.id} className="flex flex-col gap-1.5 rounded-xl border bg-card p-3">
            <button type="button" onClick={() => openDetails(e)} className="truncate rounded text-left text-[13.5px] font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{e.name}</button>
            <span className="line-clamp-2 text-xs text-muted-foreground">{e.description}</span>
            <div className="mt-auto pt-1"><EntryButton entry={e} busy={busy === e.id} onAdd={() => void askFor(e)} size="xs" /></div>
          </div>
        ))}
      </div>
    </section>
  ) : null;

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-col gap-3">
        <p className="text-[13.5px] text-muted-foreground">{t("Add tiles and buttons made by the community. Each plugin asks before it can do anything.")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-48 flex-1"><Input type="search" icon={<Search />} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search plugins")} aria-label={t("Search plugins")} autoComplete="off" /></div>
          <Button variant="secondary" icon={<LinkIcon />} onClick={() => setLinkOpen(true)}>{t("Install from a link")}</Button>
          <a href={GUIDE} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-[13px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"><Book className="size-4" />{t("Create your own")}</a>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl role="tablist" aria-label={t("Plugin sections")} value={tab} onValueChange={(v) => setTab(v as Tab)} className="w-fit max-w-full"
          options={[
            { value: "discover", id: "po-tab-discover", controls: "po-panel", label: t("Discover") },
            { value: "installed", id: "po-tab-installed", controls: "po-panel", label: `${t("Installed")}${installed ? ` (${count})` : ""}` },
            ...(updates.length > 0 ? [{ value: "updates", id: "po-tab-updates", controls: "po-panel", label: `${t("Updates")} (${updates.length})` }] : []),
          ]} />
          <ViewToggle view={view} onView={setView} />
        </div>
      </div>

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div id="po-panel" role="tabpanel" aria-labelledby={`po-tab-${tab}`} className="flex flex-col gap-4">
        {tab !== "installed" && storeStatus}
        {tab === "discover" && registry && registry.plugins.length > 0 && (
          <div role="group" aria-label={t("Filter plugins")} className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
                className={"rounded-full border px-3 py-1.5 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-ring " + (filter === f.id ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:border-foreground/50 hover:text-foreground")}>{t(f.label)}</button>
            ))}
          </div>
        )}
        {tab === "discover" && discover}
        {tab === "updates" && (shownUpdates.length > 0 ? grid(shownUpdates) : <Empty icon={<Store />} title={t("Everything is up to date")} />)}
        <PluginsPanel view={view} rev={rev} hideList={tab !== "installed"} installedView update={update} layout={layout} onSaveLayout={onSaveLayout} query={query} onChanged={() => { loadInstalled(); loadRegistry(); }}
          onDetails={openInstalled} onAddTile={onAddTile} linkOpen={linkOpen} linkSource={linkSource} onLinkClose={() => { setLinkOpen(false); setLinkSource(""); }} header={firstRun} builtinExtra={builtinGrid} />
      </div>

      <PermissionDialog open={!!ask} name={ask?.entry.name ?? ""} version={ask?.entry.version ?? ""} author={ask?.entry.author} verified={ask?.entry.verified}
        permissions={ask?.permissions ?? NO_PERMS} title={ask ? (ask.entry.fromLink ? t("Switch {name} to the reviewed version?", { name: ask.entry.name }) : ask.entry.updateAvailable ? t("Update {name}?", { name: ask.entry.name }) : t("Add {name}?", { name: ask.entry.name })) : undefined}
        confirmLabel={ask?.entry.fromLink ? t("Allow and switch") : ask?.entry.updateAvailable ? t("Allow and update") : t("Allow and add")} onCancel={() => setAsk(null)} onConfirm={() => void addEntry()} />

      <PluginDetailsSheet plugin={details} theme={theme} onClose={() => setDetails(null)}
        footer={detailEntry && !detailEntry.installed || detailEntry?.updateAvailable || detailEntry?.fromLink ? <EntryButton entry={detailEntry} busy={busy === detailEntry.id} onAdd={() => void askFor(detailEntry)} /> : undefined} />
    </div>
  );
}
