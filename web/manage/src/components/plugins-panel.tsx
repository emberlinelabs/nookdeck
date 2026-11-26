import { PluginProcessPanel } from "@/components/plugin-process";
import { placePluginTile } from "@/lib/palette";
import { PluginDetailsSheet } from "@/components/plugin-details";
import { TilePreview } from "@/components/tile-preview";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangle as Warn, IconDots as Dots, IconPlus as Plus, IconPuzzle as Puzzle, IconShieldCheck as ShieldCheck, IconTrash as Trash } from "@tabler/icons-react";
import { Alert } from "@/components/ui/knowns/alert";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { Card, CardContent } from "@/components/ui/knowns/card";
import { Dialog } from "@/components/ui/knowns/dialog";
import { Menu } from "@/components/ui/knowns/menu";
import { Empty } from "@/components/ui/knowns/empty";
import { Field, Input } from "@/components/ui/knowns/input";
import { Select } from "@/components/ui/knowns/select";
import { Spinner } from "@/components/ui/knowns/spinner";
import { Switch } from "@/components/ui/knowns/switch";
import { api } from "@/api";
import { t, useLanguage } from "@/lib/i18n";
import { addLayoutPack, pluginUsage, removePluginItems } from "@/lib/plugins";
import { networkLabel, osBadges, permChips, riskTone } from "@/lib/plugin-ui";
import { Row, type PluginView, RowList } from "@/components/plugin-view";
import type { Layout, PluginField, PluginInfo, PluginPermissions } from "@/types";

/** What a plugin asks for, one line each (the install dialog and the card use the same wording). */
export function permissionLines(p: PluginPermissions): string[] {
  const out = p.network.map((h) => t("Connect to {host}", { host: networkLabel(h) }));
  if (p.shell) out.push(t("Run shell commands on this computer"));
  if (p.keyboard) out.push(t("Press keys and type text"));
  if (p.storage) out.push(t("Store its own data"));
  if (p.onair) out.push(t("Turn On Air on"));
  if (p.notify) out.push(t("Show notifications on your phones"));
  return out;
}

const needsGrant = (p: PluginInfo) => p.needsApproval;

/** The access list a user agrees to before a plugin turns on. Shared by the installed list and the Store. */
export function PermissionDialog({ open, name, version, author, verified, unreviewed, permissions, source, confirmLabel, title, busy, onCancel, onConfirm }: {
  open: boolean; name: string; version: string; author?: string; verified?: boolean; unreviewed?: boolean; permissions: PluginPermissions; source?: string;
  confirmLabel?: string; title?: string; busy?: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  useLanguage();
  const chips = permChips(permissions);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      title={title ?? t("Turn on {name}?", { name })}
      description={t("This plugin asks for the access below. It cannot do more than you allow.")}
      size="md"
      footer={<><Button variant="secondary" onClick={onCancel}>{t("Cancel")}</Button><Button icon={<ShieldCheck />} loading={busy} onClick={onConfirm}>{confirmLabel ?? t("Allow and turn on")}</Button></>}
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{name}</span>
          <span className="text-xs text-muted-foreground">v{version}{author ? ` · ${author}` : ""}</span>
          {verified && <Badge size="sm" tone="success">{t("Verified")}</Badge>}
          {unreviewed && <Badge size="sm" tone="warning">{t("Unreviewed")}</Badge>}
        </div>
        {chips.length === 0 ? <p className="text-muted-foreground">{t("It asks for no special access.")}</p> : (
          <ul className="flex flex-col gap-2">
            {chips.map((c) => (
              <li key={c.key} className="flex items-start gap-2.5">
                <Badge size="sm" tone={riskTone(c.risk)} variant="outline" className="mt-px flex-none">{c.label}</Badge>
                <span className="text-muted-foreground">{c.plain}</span>
              </li>
            ))}
          </ul>
        )}
        {permissions.shell || permissions.keyboard ? <Alert tone="warning" icon={<Warn />}>{t("Plugins with code are trusted code. Nookdeck limits what they can reach but cannot fully sandbox them.")}</Alert> : null}
        {source && <div className="break-all text-xs text-muted-foreground">{t("Source")}: <code className="rounded bg-muted px-1.5 py-0.5">{source}</code></div>}
      </div>
    </Dialog>
  );
}

const matches = (p: { name: string; id: string; author?: string; description?: string }, q: string): boolean => !q || `${p.name} ${p.id} ${p.author ?? ""} ${p.description ?? ""}`.toLowerCase().includes(q.toLowerCase());

export interface PluginsPanelProps {
  update: (fn: (l: Layout) => Layout) => void;
  /** The current draft: needed to show where a plugin is used and to place a tile. */
  layout?: Layout;
  /** Saves the draft layout (after "Also remove them from my screens"). */
  onSaveLayout?: () => void;
  /** Show only this plugin (its own page). */
  only?: string;
  /** With `only`: show nothing (not a "not installed" note) when the plugin is absent. */
  quietIfMissing?: boolean;
  /** The Installed tab: community plugins first, then the built-in ones. Without it the list is everything but core.weather. */
  installedView?: boolean;
  /** Mounted only for its dialogs and notices (another tab is showing). */
  hideList?: boolean;
  query?: string;
  /** Something was installed, removed or switched: the page refreshes its counts. */
  onChanged?: () => void;
  /** Bump to make the panel read the plugins again (the page installed one). */
  rev?: number;
  /** grid (cards) or list (compact rows) for the installed plugins. */
  view?: PluginView;
  onDetails?: (p: PluginInfo) => void;
  /** Places the plugin's tile and opens Screens; returns an error text, or null when it worked. */
  onAddTile?: (p: PluginInfo, widgetId: string, pageIdx: number) => string | null;
  /** The "Install from a link" dialog, opened by the page's header button. */
  linkOpen?: boolean;
  onLinkClose?: () => void;
  /** An address to fill into the link dialog when it opens (from a deeplink). */
  linkSource?: string;
  /** Shown above the list (first-run suggestions). */
  header?: React.ReactNode;
  /** Shown below the community plugins, above the built-in ones. */
  builtinExtra?: React.ReactNode;
}

interface Removed { plugin: PluginInfo; before: Layout | null; alsoItems: boolean }

export function PluginsPanel({ update, layout, onSaveLayout, only, quietIfMissing, installedView, hideList, query = "", onChanged, rev, view = "grid", onDetails, onAddTile, linkOpen, linkSource, onLinkClose, header, builtinExtra }: PluginsPanelProps) {
  useLanguage();
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [undo, setUndo] = useState<Removed | null>(null);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [grant, setGrant] = useState<PluginInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PluginInfo | null>(null);
  const [alsoItems, setAlsoItems] = useState(true);
  const [addTo, setAddTo] = useState<PluginInfo | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const load = useCallback(async () => {
    try {
      setPlugins(await api.getPlugins());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load, rev]);
  useEffect(() => { if (linkOpen && linkSource) setSource(linkSource); }, [linkOpen, linkSource]);
  const changed = async () => { await load(); onChanged?.(); };

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const install = async () => {
    const s = source.trim();
    if (!s) return;
    setInstalling(true);
    setNotice(null);
    try {
      const p = await api.installPlugin(s);
      setSource("");
      setError(null);
      onLinkClose?.();
      await changed();
      setGrant(p);
    } catch (e) {
      fail(e);
    } finally {
      setInstalling(false);
    }
  };

  const confirmGrant = async () => {
    const p = grant;
    if (!p) return;
    setGrant(null);
    setBusy(p.id);
    try {
      await api.grantPlugin(p.id, p.permissions);
      await api.setPluginEnabled(p.id, true);
      setNotice(t("{name} is on", { name: p.name }));
      await changed();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (p: PluginInfo, on: boolean) => {
    if (on && needsGrant(p)) return setGrant(p);
    setBusy(p.id);
    try {
      await api.setPluginEnabled(p.id, on);
      await changed();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const startRemove = (p: PluginInfo) => { setAlsoItems(true); setRemoving(p); };
  const confirmRemove = async () => {
    const p = removing;
    if (!p) return;
    const before = layoutRef.current ?? null;
    const items = alsoItems && before && pluginUsage(before, p.id).length > 0;
    setRemoving(null);
    setBusy(p.id);
    try {
      await api.deletePlugin(p.id);
      if (items) { update((l) => removePluginItems(l, p.id)); onSaveLayout?.(); }
      setNotice(null);
      setUndo({ plugin: p, before, alsoItems: !!items });
      await changed();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  // The Undo toast goes away by itself.
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 15000);
    return () => clearTimeout(timer);
  }, [undo]);
  const doUndo = async () => {
    const u = undo;
    if (!u) return;
    setUndo(null);
    setBusy(u.plugin.id);
    let reinstalled = false;
    try {
      if (u.plugin.reviewed || u.plugin.registryVersion) {
        // from the registry: come back reviewed and pinned
        const p = await api.installFromRegistry(u.plugin.id);
        await api.grantPlugin(p.id, u.plugin.granted);
        await api.setPluginEnabled(p.id, u.plugin.enabled);
        reinstalled = true;
      } else if (u.plugin.source) {
        const p = await api.installPlugin(u.plugin.source);
        await api.grantPlugin(p.id, u.plugin.granted);
        await api.setPluginEnabled(p.id, u.plugin.enabled);
        reinstalled = true;
      }
    } catch { /* offline or the source is gone: the layout is still restored below */ }
    if (u.alsoItems && u.before) { const prev = u.before; update(() => prev); onSaveLayout?.(); }
    setNotice(reinstalled ? t("{name} is back.", { name: u.plugin.name }) : t("Your screens are back, but {name} could not be installed again. Install it from its link.", { name: u.plugin.name }));
    setBusy(null);
    await changed();
  };

  const q = query.trim();
  const visible = hideList ? [] : (plugins ?? []).filter((p) => (only ? p.id === only : p.id !== "core.weather") && (only || matches(p, q)));
  const community = visible.filter((p) => !p.builtin);
  const builtin = visible.filter((p) => !!p.builtin);
  const none = plugins !== null && !only && !(plugins ?? []).some((p) => !p.builtin) && !q;
  const [ownDetails, setOwnDetails] = useState<PluginInfo | null>(null);
  const row = (p: PluginInfo) => (
    <PluginRow key={p.id} plugin={p} busy={busy === p.id} onToggle={(on) => void toggle(p, on)} onRemove={() => startRemove(p)} onSaved={() => { setNotice(t("Settings saved")); void load(); }}
      onError={fail} onReview={() => setGrant(p)} onDetails={() => (onDetails ? onDetails(p) : setOwnDetails(p))} onAddTile={onAddTile && layout && p.enabled && p.widgets.length > 0 ? () => setAddTo(p) : undefined} />
  );
  const card = (p: PluginInfo) => (
    <PluginCard layout={layout} key={p.id} plugin={p} busy={busy === p.id} onToggle={(on) => void toggle(p, on)} onRemove={() => startRemove(p)}
      onSaved={() => { setNotice(t("Settings saved")); void load(); }} onError={fail} onReview={() => setGrant(p)}
      onApply={(msg) => setNotice(msg)} update={update} onDetails={() => (onDetails ? onDetails(p) : setOwnDetails(p))}
      onAddTile={onAddTile && layout && p.enabled && p.widgets.length > 0 ? () => setAddTo(p) : undefined} />
  );
  const usage = removing && layout ? pluginUsage(layout, removing.id) : [];

  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {undo && <Alert tone="info" action={{ label: t("Undo"), onClick: () => void doUndo() }} onDismiss={() => setUndo(null)}>{t("{name} removed.", { name: undo.plugin.name })}{undo.alsoItems ? ` ${t("Its tiles and buttons were removed from your screens too.")}` : ""}</Alert>}
      {!hideList && !plugins && !error && <Spinner label={t("Loading")} />}
      {!hideList && plugins && only && !quietIfMissing && !plugins.some((p) => p.id === only) && <Empty icon={<Puzzle />} title={t("This plugin is not installed")} description={t("It may have been removed. Go to Plugins to install it again.")} />}
      {installedView && !hideList && header}
      {!hideList && plugins && installedView && community.length === 0 && (none || q) && (
        <Empty icon={<Puzzle />} title={q ? t("No installed plugin matches") : t("No plugins yet")} description={q ? t("Try another word, or look in Discover.") : t("Plugins add tiles and buttons. Add one from Discover, or install one from a link.")} />
      )}
      {view === "list" && !only ? (community.length > 0 && <RowList label={t("Installed plugins")}>{community.map(row)}</RowList>) : community.map(card)}
      {installedView && !hideList && builtinExtra}
      {only && builtin.map(card)}

      <Dialog
        open={!!linkOpen}
        onOpenChange={(o) => !o && onLinkClose?.()}
        title={t("Install a plugin")}
        description={t("Paste a GitHub address, an https link to a nookdeck.json, or the path of a plugin folder on this computer. You choose what it may do before it turns on.")}
        size="md"
      >
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void install(); }}>
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Input value={source} autoComplete="off" spellCheck={false} placeholder="https://github.com/…  or  ~/plugins/my-plugin" aria-label={t("Plugin link or folder")} onChange={(e) => setSource(e.target.value)} data-autofocus />
            </div>
            <Button type="submit" icon={<Plus />} loading={installing} disabled={!source.trim()}>{t("Install")}</Button>
          </div>
          <Alert tone="warning" icon={<Warn />}>{t("Plugins from a link or a folder are not reviewed by Nookdeck. Only install ones you trust.")}</Alert>
        </form>
      </Dialog>

      <PermissionDialog open={!!grant} name={grant?.name ?? ""} version={grant?.version ?? ""} author={grant?.author} unreviewed={!!grant?.unreviewed && !grant?.builtin}
        permissions={grant?.permissions ?? { network: [], shell: false, keyboard: false, storage: false, onair: false, notify: false }} source={grant && !grant.builtin ? grant.source : undefined}
        onCancel={() => setGrant(null)} onConfirm={() => void confirmGrant()} />

      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? t("Remove {name}?", { name: removing.name }) : ""}
        size="md"
        footer={<><Button variant="secondary" onClick={() => setRemoving(null)}>{t("Cancel")}</Button><Button variant="destructive" onClick={() => void confirmRemove()}>{t("Remove")}</Button></>}
      >
        {removing && (
          <div className="flex flex-col gap-3 text-sm">
            {usage.length > 0 ? (
              <>
                <p>{t("It is used here:")} <strong>{usage.map((u) => [u.tiles ? (u.tiles === 1 ? t("1 tile") : t("{n} tiles", { n: u.tiles })) : "", u.buttons ? (u.buttons === 1 ? t("1 button") : t("{n} buttons", { n: u.buttons })) : ""].filter(Boolean).join(", ") + ` ${t("on {screen}", { screen: u.pageName })}`).join("; ")}</strong></p>
                <label className="flex items-start gap-2.5 text-[13px]">
                  <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={alsoItems} onChange={(e) => setAlsoItems(e.target.checked)} />
                  <span>{t("Also remove them from my screens")}<span className="block text-xs text-muted-foreground">{t("If you keep them, they show a \"Plugin missing\" tile until you reinstall it.")}</span></span>
                </label>
              </>
            ) : <p className="text-muted-foreground">{t("It is not used on any screen.")}</p>}
            <p className="text-xs text-muted-foreground">{t("You can undo this for a few seconds after.")}</p>
          </div>
        )}
      </Dialog>

      <AddTileDialog plugin={addTo} layout={layout} onClose={() => setAddTo(null)} onAdd={(wid, pi) => { const err = onAddTile?.(addTo!, wid, pi) ?? null; if (!err) setAddTo(null); return err; }} />
      <PluginDetailsSheet theme={layout ? layout.theme : undefined} onClose={() => setOwnDetails(null)}
        plugin={ownDetails ? { id: ownDetails.id, name: ownDetails.name, author: ownDetails.author, version: ownDetails.version, description: ownDetails.description, builtin: ownDetails.builtin, permissions: ownDetails.permissions, widgets: ownDetails.widgets, actions: ownDetails.actions, source: ownDetails.source, readme: false } : null} />
    </div>
  );
}

function AddTileDialog({ plugin, layout, onClose, onAdd }: { plugin: PluginInfo | null; layout?: Layout; onClose: () => void; onAdd: (widgetId: string, pageIdx: number) => string | null }) {
  useLanguage();
  const [page, setPage] = useState("0");
  const [widget, setWidget] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Start on the first screen with room for the tile; "New screen" is always there.
  useEffect(() => {
    setWidget(plugin?.widgets[0]?.id ?? "");
    setErr(null);
    if (!plugin || !layout) return;
    const w = plugin.widgets[0];
    const fits = w ? layout.pages.findIndex((_, i) => !("error" in placePluginTile(layout, i, plugin, w.id))) : -1;
    setPage(String(fits >= 0 ? fits : layout.pages.length));
  }, [plugin]);
  if (!plugin || !layout) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t("Add a tile of {name}", { name: plugin.name })} description={t("It goes to the first free spot, and Screens opens with it selected.")} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button><Button icon={<Plus />} disabled={!widget} onClick={() => setErr(onAdd(widget, Number(page)))}>{t("Add tile")}</Button></>}>
      <div className="flex flex-col gap-3">
        {plugin.widgets.length > 1 && <Field label={t("Tile")} id="at-widget"><Select id="at-widget" value={widget} onChange={(e) => setWidget(e.target.value)} options={plugin.widgets.map((w) => ({ value: w.id, label: w.name }))} /></Field>}
        <Field label={t("Screen")} id="at-page"><Select id="at-page" value={page} onChange={(e) => { setPage(e.target.value); setErr(null); }} options={[...layout.pages.map((p, i) => ({ value: String(i), label: p.name || p.id })), { value: String(layout.pages.length), label: t("New screen") }]} /></Field>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Dialog>
  );
}

function PluginCard({ plugin: p, busy, onToggle, onRemove, onSaved, onError, onReview, onApply, update, onDetails, onAddTile, layout }: { plugin: PluginInfo; busy: boolean; onToggle: (on: boolean) => void; onRemove: () => void; onSaved: () => void; onError: (e: unknown) => void; onReview: () => void; onApply: (msg: string) => void; update: (fn: (l: Layout) => Layout) => void; onDetails?: () => void; onAddTile?: () => void; layout?: Layout }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const pending = needsGrant(p);
  const status = p.error ? <Badge size="sm" tone="danger" dot>{t("Error")}</Badge> : pending ? <Badge size="sm" tone="warning" dot>{t("Needs approval")}</Badge> : <Badge size="sm" tone={p.enabled ? "success" : "neutral"} dot>{p.enabled ? t("On") : t("Off")}</Badge>;
  const chips = permChips(p.permissions);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><Puzzle className="size-5" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {onDetails ? <button type="button" onClick={onDetails} className="rounded font-semibold underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{p.name}</button> : <span className="font-semibold">{p.name}</span>}
              <span className="text-xs text-muted-foreground">v{p.version}{p.author ? ` · ${p.author}` : ""}</span>
              {status}
              {osBadges(p.os).map((n) => <Badge key={n} size="sm" tone="neutral">{n}</Badge>)}
              {p.builtin ? <Badge size="sm" tone="neutral">{t("Built-in")}</Badge> : p.unreviewed && <Badge size="sm" tone="warning">{t("Unreviewed")}</Badge>}
              {(p.permissions.shell || p.permissions.keyboard) && <Badge size="sm" tone="danger" variant="outline" title={t("It can run commands or press keys on this computer. Only allow plugins you trust.")}>{t("Runs trusted code")}</Badge>}
            </div>
            {p.description && <p className="mt-0.5 text-[13px] text-muted-foreground">{p.description}</p>}
          </div>
          {pending
            ? <Button size="sm" icon={<ShieldCheck />} loading={busy} onClick={onReview}>{t("Review access")}</Button>
            : <Switch checked={p.enabled} disabled={busy} onCheckedChange={onToggle} aria-label={t("Turn {name} on or off", { name: p.name })} />}
        </div>

        {p.error && <Alert tone="danger">{p.error}</Alert>}

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {chips.length === 0 ? <span className="text-muted-foreground">{t("No special access")}</span> : chips.map((c) => <Badge key={c.key} size="sm" tone={riskTone(c.risk)} variant="outline">{c.label}</Badge>)}
          {p.widgets.length + p.actions.length > 0 && <span className="text-muted-foreground">· {[p.widgets.length ? (p.widgets.length === 1 ? t("1 tile") : t("{n} tiles", { n: p.widgets.length })) : "", p.actions.length ? (p.actions.length === 1 ? t("1 button") : t("{n} buttons", { n: p.actions.length })) : ""].filter(Boolean).join(", ")}</span>}
        </div>

        <PluginProcessPanel plugin={p} onError={onError} />

        {open && p.fields.length > 0 && p.id !== "core.weather" && <SettingsForm plugin={p} onSaved={() => { setOpen(false); onSaved(); }} onError={onError} />}

        {p.enabled && (p.themes.length > 0 || p.layouts.length > 0) && (
          <div className="flex flex-col gap-1.5 rounded-xl border p-3">
            {p.themes.map((th) => (
              <div key={`t-${th.id}`} className="flex items-center justify-between gap-2 text-[13px]">
                <span>{t("Theme")}: {th.name}</span>
                <Button size="xs" variant="secondary" onClick={() => { update((l) => ({ ...l, theme: th.theme })); onApply(t("Theme \"{name}\" applied. Press Save to keep it.", { name: th.name })); }}>{t("Apply theme")}</Button>
              </div>
            ))}
            {p.layouts.map((ly) => (
              <div key={`l-${ly.id}`} className="flex items-center justify-between gap-2 text-[13px]">
                <span>{t("Screens")}: {ly.name} <span className="text-xs text-muted-foreground">({t("{count} screens", { count: ly.layout.pages.length })})</span></span>
                <Button size="xs" variant="secondary" onClick={() => { update((l) => addLayoutPack(l, ly.layout)); onApply(t("Screens from \"{name}\" added. Press Save to keep them.", { name: ly.name })); }}>{t("Add screens")}</Button>
              </div>
            ))}
          </div>
        )}

        {p.widgets[0] && p.widgets[0].preview != null && <TilePreview pluginId={p.id} widget={p.widgets[0]} theme={layout ? layout.theme : undefined} className="max-w-44" />}

        <div className="flex flex-wrap items-center gap-2">
          {onAddTile && <Button size="sm" icon={<Plus />} onClick={onAddTile}>{t("Add tile to a screen")}</Button>}
          {p.fields.length > 0 && p.id !== "core.weather" && <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? t("Hide settings") : t("Settings")}</Button>}
          {onDetails && <Button size="sm" variant="ghost" onClick={onDetails}>{t("Details")}</Button>}
          {!p.builtin && (
            <div className="ml-auto">
              <Menu aria-label={t("More actions for {name}", { name: p.name })} align="end" trigger={<Button size="sm" variant="ghost" aria-label={t("More actions for {name}", { name: p.name })} icon={<Dots />} />}
                items={[{ id: "remove", label: t("Remove…"), danger: true, icon: <Trash /> }]} onSelect={(it) => { if (it.id === "remove") onRemove(); }} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** One installed plugin as a compact row: name, one line, access chips, status, and the toggle with a menu. */
function PluginRow({ plugin: p, busy, onToggle, onRemove, onSaved, onError, onReview, onDetails, onAddTile }: { plugin: PluginInfo; busy: boolean; onToggle: (on: boolean) => void; onRemove: () => void; onSaved: () => void; onError: (e: unknown) => void; onReview: () => void; onDetails: () => void; onAddTile?: () => void }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const pending = needsGrant(p);
  const chips = permChips(p.permissions);
  const status = p.error ? <Badge size="sm" tone="danger" dot>{t("Error")}</Badge> : pending ? <Badge size="sm" tone="warning" dot>{t("Needs approval")}</Badge> : <Badge size="sm" tone={p.enabled ? "success" : "neutral"} dot>{p.enabled ? t("On") : t("Off")}</Badge>;
  const items = [
    ...(onAddTile ? [{ id: "tile", label: t("Add tile to a screen"), icon: <Plus /> }] : []),
    ...(p.fields.length > 0 && p.id !== "core.weather" ? [{ id: "settings", label: open ? t("Hide settings") : t("Settings") }] : []),
    { id: "details", label: t("Details") },
    ...(!p.builtin ? [{ id: "remove", label: t("Remove…"), danger: true, icon: <Trash /> }] : []),
  ];
  return (
    <>
      <Row label={p.name} onOpen={onDetails}>
        <span className="grid size-8 flex-none place-items-center rounded-lg bg-muted text-muted-foreground"><Puzzle className="size-4" /></span>
        <div className="min-w-0 basis-40 flex-1">
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={onDetails} className="truncate rounded text-left text-[13.5px] font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{p.name}</button>
            {p.unreviewed && <Badge size="sm" tone="warning">{t("Unreviewed")}</Badge>}
            {osBadges(p.os).map((n) => <Badge key={n} size="sm" tone="neutral">{n}</Badge>)}
          </div>
          <div className="truncate text-xs text-muted-foreground">{p.author ? `${p.author} · ` : ""}v{p.version}</div>
        </div>
        <p className="min-w-0 basis-56 flex-[2] truncate text-[13px] text-muted-foreground">{p.description}</p>
        <div className="flex flex-wrap items-center gap-1">
          {chips.length === 0 ? <span className="text-xs text-muted-foreground">{t("No special access")}</span> : chips.map((c) => <Badge key={c.key} size="sm" tone={riskTone(c.risk)} variant="outline">{c.label}</Badge>)}
        </div>
        {status}
        <div className="ml-auto flex flex-none items-center gap-1">
          {pending
            ? <Button size="xs" icon={<ShieldCheck />} loading={busy} onClick={onReview}>{t("Review access")}</Button>
            : <Switch checked={p.enabled} disabled={busy} onCheckedChange={onToggle} aria-label={t("Turn {name} on or off", { name: p.name })} />}
          <Menu aria-label={t("More actions for {name}", { name: p.name })} align="end" trigger={<Button size="sm" variant="ghost" aria-label={t("More actions for {name}", { name: p.name })} icon={<Dots />} />}
            items={items} onSelect={(it) => { if (it.id === "remove") onRemove(); else if (it.id === "tile") onAddTile?.(); else if (it.id === "settings") setOpen((o) => !o); else if (it.id === "details") onDetails(); }} />
        </div>
      </Row>
      {p.error && <li className="list-none"><Alert tone="danger">{p.error}</Alert></li>}
      {open && p.fields.length > 0 && p.id !== "core.weather" && <li className="list-none rounded-xl border bg-card p-3"><SettingsForm plugin={p} onSaved={() => { setOpen(false); onSaved(); }} onError={onError} /></li>}
    </>
  );
}

/** Secrets are write-only: the field starts empty, "Saved" shows when a value exists, and an empty field leaves it unchanged. */
function SettingsForm({ plugin: p, onSaved, onError }: { plugin: PluginInfo; onSaved: () => void; onError: (e: unknown) => void }) {
  const [vals, setVals] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of p.fields) if (f.type !== "secret") v[f.key] = p.settings[f.key] ?? f.default ?? (f.type === "boolean" ? false : "");
    return v;
  });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { ...vals };
      for (const [k, s] of Object.entries(secrets)) if (s) body[k] = s;
      await api.putPluginSettings(p.id, body);
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="flex flex-col gap-3 rounded-xl border p-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {p.fields.map((f) => (
        <FieldInput key={f.key} id={`pl-${p.id}-${f.key}`} field={f} value={vals[f.key]} secret={secrets[f.key] ?? ""} pluginId={p.id} settings={vals} onChange={(v) => setVals((s) => ({ ...s, [f.key]: v }))} onSecret={(v) => setSecrets((s) => ({ ...s, [f.key]: v }))} />
      ))}
      <div><Button type="submit" size="sm" loading={saving}>{t("Save settings")}</Button></div>
    </form>
  );
}

/**
 * A select whose choices come from the plugin's code (optionsFrom): asked once when the form opens. While they load, and when the plugin
 * cannot give them (OBS not running ...), the field is a text box with the saved value, so nothing is lost and a name can still be typed.
 */
function DynamicSelect({ id, pluginId, provider, settings, value, onChange }: { id: string; pluginId: string; provider: string; settings: Record<string, unknown>; value: string; onChange: (v: string) => void }) {
  useLanguage();
  const [state, setState] = useState<{ options: string[] } | { error: string } | null>(null);
  // the settings at the moment the form opened: a provider is not asked again on every key press
  const [asked] = useState(() => settings);
  useEffect(() => {
    let live = true;
    api.pluginOptions(pluginId, provider, asked).then((options) => { if (live) setState({ options }); }, (e) => { if (live) setState({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [pluginId, provider, asked]);
  if (state && "options" in state && state.options.length) {
    const opts = state.options.map((o) => ({ value: o, label: o }));
    // a saved value the plugin no longer lists stays selectable, marked
    if (value && !state.options.includes(value)) opts.unshift({ value, label: t("{value} (not found now)", { value }) });
    if (!value) opts.unshift({ value: "", label: t("Choose…") });
    return <Select id={id} value={value} options={opts} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="flex flex-col gap-1">
      <Input id={id} value={value} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <span className="text-xs text-muted-foreground">
        {!state ? t("Loading the choices…") : "error" in state ? t("Could not get the choices ({error}). You can type the name.", { error: state.error }) : t("No choices yet. You can type the name.")}
      </span>
    </div>
  );
}

export function FieldInput({ id, field: f, value, secret, pluginId, settings, onChange, onSecret }: { id: string; field: PluginField; value: unknown; secret: string; pluginId?: string; settings?: Record<string, unknown>; onChange: (v: unknown) => void; onSecret: (v: string) => void }) {
  if (f.type === "boolean") {
    return (
      <label className="flex items-center justify-between gap-2 text-[13px]">
        <span>{f.label}</span>
        <Switch checked={value === true} onCheckedChange={onChange} aria-label={f.label} />
      </label>
    );
  }
  return (
    <Field label={f.label} id={id} hint={f.type === "secret" ? t("Stored on this computer. It is never shown again.") : f.type === "entity" ? t("A Home Assistant entity id, for example light.desk") : undefined}>
      {f.type === "select" && f.optionsFrom && pluginId ? (
        <DynamicSelect id={id} pluginId={pluginId} provider={f.optionsFrom} settings={settings ?? {}} value={String(value ?? "")} onChange={onChange} />
      ) : f.type === "select" ? (
        <Select id={id} value={String(value ?? "")} options={f.options ?? []} onChange={(e) => onChange(e.target.value)} />
      ) : f.type === "secret" ? (
        <Input id={id} type="password" value={secret} autoComplete="new-password" spellCheck={false} placeholder={f.isSet ? t("•••••••• (Saved)") : ""} onChange={(e) => onSecret(e.target.value)} />
      ) : f.type === "number" ? (
        <Input id={id} type="number" value={String(value ?? "")} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
      ) : (
        <Input id={id} value={String(value ?? "")} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}
