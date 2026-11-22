import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangle as Warn, IconPlus as Plus, IconPuzzle as Puzzle, IconRefresh as Refresh, IconShieldCheck as ShieldCheck } from "@tabler/icons-react";
import { Alert } from "@/components/ui/knowns/alert";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { Card, CardContent } from "@/components/ui/knowns/card";
import { Dialog } from "@/components/ui/knowns/dialog";
import { Empty } from "@/components/ui/knowns/empty";
import { Field, Input } from "@/components/ui/knowns/input";
import { Select } from "@/components/ui/knowns/select";
import { Spinner } from "@/components/ui/knowns/spinner";
import { Switch } from "@/components/ui/knowns/switch";
import { api } from "@/api";
import { t, useLanguage } from "@/lib/i18n";
import { addLayoutPack } from "@/lib/plugins";
import type { Layout, PluginField, PluginInfo, PluginPermissions } from "@/types";

/** What a plugin asks for, one line each (the install dialog and the card use the same wording). */
export function permissionLines(p: PluginPermissions): string[] {
  const out = p.network.map((h) => t("Connect to {host}", { host: h }));
  if (p.shell) out.push(t("Run shell commands on this computer"));
  if (p.keyboard) out.push(t("Press keys and type text"));
  if (p.storage) out.push(t("Store its own data"));
  return out;
}

const needsGrant = (p: PluginInfo) => p.needsApproval;

const hasAny = (p: PluginPermissions) => p.network.length > 0 || p.shell || p.keyboard || p.storage;

export function PluginsPanel({ update, only }: { update: (fn: (l: Layout) => Layout) => void; only?: string }) {
  useLanguage();
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [grant, setGrant] = useState<PluginInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setPlugins(await api.getPlugins());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    return () => clearTimeout(armTimer.current);
  }, [load]);

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
      await load();
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
      await load();
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
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: PluginInfo) => {
    if (armed !== p.id) {
      setArmed(p.id);
      clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(null), 3000);
      return;
    }
    setArmed(null);
    setBusy(p.id);
    try {
      await api.deletePlugin(p.id);
      setNotice(t("{name} removed. Tiles that use it show a neutral placeholder.", { name: p.name }));
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {!only && <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <div>
            <h2 className="text-sm font-semibold">{t("Install a plugin")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("Paste a GitHub address, an https link to a nookdeck.json, or the path of a plugin folder on this computer. You choose what it may do before it turns on.")}</p>
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void install(); }}>
            <div className="min-w-0 flex-1">
              <Input value={source} autoComplete="off" spellCheck={false} placeholder="https://github.com/…  or  ~/plugins/my-plugin" aria-label={t("Plugin link or folder")} onChange={(e) => setSource(e.target.value)} />
            </div>
            <Button type="submit" icon={<Plus />} loading={installing} disabled={!source.trim()}>{t("Install")}</Button>
          </form>
          <p className="text-[11.5px] text-muted-foreground">{t("Plugins from a link or a folder are not reviewed by Nookdeck. Only install ones you trust.")}</p>
        </CardContent>
      </Card>}

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {!plugins && !error && <Spinner label={t("Loading")} />}
      {plugins && only && !plugins.some((p) => p.id === only) && <Empty icon={<Puzzle />} title={t("This plugin is not installed")} description={t("It may have been removed. Go to Plugins to install it again.")} />}
      {plugins && !only && plugins.length === 0 && <Empty icon={<Puzzle />} title={t("No plugins yet")} description={t("Plugins add tiles and buttons. Install one above, or see the plugin guide to write your own.")} />}
      {plugins && plugins.length > 0 && (
        <>
          {!only && <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{t("Plugins: {count}", { count: plugins.length })}</span>
            <Button size="xs" variant="secondary" icon={<Refresh />} onClick={() => void load()}>{t("Refresh")}</Button>
          </div>}
          {plugins.filter((p) => !only || p.id === only).map((p) => (
            <PluginCard key={p.id} plugin={p} busy={busy === p.id} armed={armed === p.id} onToggle={(on) => void toggle(p, on)} onRemove={() => void remove(p)} onSaved={() => { setNotice(t("Settings saved")); void load(); }} onError={fail} onReview={() => setGrant(p)} onApply={(m) => { setNotice(m); }} update={update} />
          ))}
        </>
      )}

      <Dialog
        open={!!grant}
        onOpenChange={(o) => !o && setGrant(null)}
        title={grant ? t("Turn on {name}?", { name: grant.name }) : ""}
        description={t("This plugin asks for the access below. It cannot do more than you allow.")}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setGrant(null)}>{t("Cancel")}</Button>
            <Button icon={<ShieldCheck />} onClick={() => void confirmGrant()}>{t("Allow and turn on")}</Button>
          </>
        }
      >
        {grant && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{grant.name}</span>
              <span className="text-xs text-muted-foreground">v{grant.version}{grant.author ? ` · ${grant.author}` : ""}</span>
              {grant.unreviewed && <Badge size="sm" tone="warning">{t("Unreviewed")}</Badge>}
            </div>
            {hasAny(grant.permissions) ? (
              <ul className="flex list-disc flex-col gap-1.5 pl-5">
                {permissionLines(grant.permissions).map((l) => <li key={l}>{l}</li>)}
              </ul>
            ) : (
              <p className="text-muted-foreground">{t("It asks for no special access.")}</p>
            )}
            {grant.permissions.shell || grant.permissions.keyboard ? <Alert tone="warning" icon={<Warn />}>{t("Plugins with code are trusted code. Nookdeck limits what they can reach but cannot fully sandbox them.")}</Alert> : null}
            {grant.source && <div className="break-all text-xs text-muted-foreground">{t("Source")}: <code className="rounded bg-muted px-1.5 py-0.5">{grant.source}</code></div>}
          </div>
        )}
      </Dialog>
    </div>
  );
}

function PluginCard({ plugin: p, busy, armed, onToggle, onRemove, onSaved, onError, onReview, onApply, update }: { plugin: PluginInfo; busy: boolean; armed: boolean; onToggle: (on: boolean) => void; onRemove: () => void; onSaved: () => void; onError: (e: unknown) => void; onReview: () => void; onApply: (msg: string) => void; update: (fn: (l: Layout) => Layout) => void }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const pending = needsGrant(p);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground"><Puzzle className="size-5" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{p.name}</span>
              <span className="text-xs text-muted-foreground">v{p.version}{p.author ? ` · ${p.author}` : ""}</span>
              {p.unreviewed && <Badge size="sm" tone="warning">{t("Unreviewed")}</Badge>}
              {pending ? <Badge size="sm" tone="warning" dot>{t("Needs your OK")}</Badge> : <Badge size="sm" tone={p.enabled ? "success" : "neutral"} dot>{p.enabled ? t("On") : t("Off")}</Badge>}
            </div>
            {p.description && <p className="mt-0.5 text-[13px] text-muted-foreground">{p.description}</p>}
            <div className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground/80">{p.id}</div>
          </div>
          {pending
            ? <Button size="sm" icon={<ShieldCheck />} loading={busy} onClick={onReview}>{t("Review access")}</Button>
            : <Switch checked={p.enabled} disabled={busy} onCheckedChange={onToggle} aria-label={t("Turn {name} on or off", { name: p.name })} />}
        </div>

        {p.error && <Alert tone="danger">{p.error}</Alert>}

        {(p.widgets.length > 0 || p.actions.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {p.widgets.map((w) => <Badge key={`w-${w.id}`} size="sm" tone="info" variant="outline">{t("Tile")}: {w.name}</Badge>)}
            {p.actions.map((a) => <Badge key={`a-${a.id}`} size="sm" tone="accent" variant="outline">{t("Button")}: {a.name}</Badge>)}
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          {hasAny(p.permissions) ? <ul className="flex flex-col gap-0.5">{permissionLines(p.permissions).map((l) => <li key={l}>· {l}</li>)}</ul> : t("No special access")}
        </div>

        {open && p.fields.length > 0 && <SettingsForm plugin={p} onSaved={() => { setOpen(false); onSaved(); }} onError={onError} />}

        {p.enabled && (p.themes.length > 0 || p.layouts.length > 0) && (
          <div className="flex flex-col gap-1.5 rounded-xl border p-3">
            {p.themes.map((th) => (
              <div key={`t-${th.id}`} className="flex items-center justify-between gap-2 text-[13px]">
                <span>{t("Theme")}: {th.name}</span>
                <Button size="xs" variant="secondary" onClick={() => { update((l) => ({ ...l, theme: th.theme })); onApply(t("Theme \"{name}\" applied. Press Save to keep it.", { name: th.name })); }}>{t("Apply")}</Button>
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

        <div className="flex flex-wrap gap-2">
          {p.fields.length > 0 && <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}>{open ? t("Hide settings") : t("Settings")}</Button>}
          <Button size="sm" variant="destructive" loading={busy} onClick={onRemove}>{armed ? t("Confirm?") : t("Remove")}</Button>
        </div>
      </CardContent>
    </Card>
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
        <FieldInput key={f.key} id={`pl-${p.id}-${f.key}`} field={f} value={vals[f.key]} secret={secrets[f.key] ?? ""} onChange={(v) => setVals((s) => ({ ...s, [f.key]: v }))} onSecret={(v) => setSecrets((s) => ({ ...s, [f.key]: v }))} />
      ))}
      <div><Button type="submit" size="sm" loading={saving}>{t("Save settings")}</Button></div>
    </form>
  );
}

export function FieldInput({ id, field: f, value, secret, onChange, onSecret }: { id: string; field: PluginField; value: unknown; secret: string; onChange: (v: unknown) => void; onSecret: (v: string) => void }) {
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
      {f.type === "select" ? (
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
