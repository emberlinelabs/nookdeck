import { useEffect, useState } from "react";
import { IconExternalLink as Link, IconPuzzle as Puzzle, IconRosetteDiscountCheck as Verified } from "@tabler/icons-react";
import { Badge } from "@/components/ui/knowns/badge";
import { Sheet } from "@/components/ui/knowns/sheet";
import { Spinner } from "@/components/ui/knowns/spinner";
import { api } from "@/api";
import { Markdown } from "@/components/markdown";
import { permChips, riskTone, rendererLabel } from "@/lib/plugin-ui";
import { t, useLanguage } from "@/lib/i18n";
import { TilePreview } from "@/components/tile-preview";
import type { PluginPermissions, RegistryManifest, TileDef, Theme } from "@/types";

/** What the drawer shows; built from a registry entry or from an installed plugin. */
export interface PluginDetails {
  id: string;
  name: string;
  author?: string;
  version: string;
  description?: string;
  verified?: boolean;
  builtin?: boolean;
  /** Missing for a registry plugin until its manifest is read. */
  permissions?: PluginPermissions;
  widgets: TileDef[];
  actions: { id: string; name: string }[];
  source?: string;
  screenshot?: string;
  /** A registry plugin: its README and manifest (tiles, access) come from the registry. */
  readme: boolean;
}


export function PluginDetailsSheet({ plugin: base, theme, onClose, footer }: { plugin: PluginDetails | null; theme?: Theme; onClose: () => void; footer?: React.ReactNode }) {
  useLanguage();
  const [man, setMan] = useState<RegistryManifest | null>(null);
  const plugin: PluginDetails | null = base && base.readme
    ? { ...base, permissions: man?.permissions ?? base.permissions, widgets: man ? man.widgets : base.widgets, actions: man ? man.actions : base.actions }
    : base;
  const [readme, setReadme] = useState<string | null>(null);
  const [readmeFailed, setReadmeFailed] = useState(false);
  const id = base?.id;
  const wants = base?.readme === true;
  useEffect(() => {
    setReadme(null); setReadmeFailed(false); setMan(null);
    if (!id || !wants) return;
    let live = true;
    api.getRegistryManifest(id).then((m) => live && setMan(m));
    api.getRegistryReadme(id).then((r) => live && setReadme(r), () => live && setReadmeFailed(true));
    return () => { live = false; };
  }, [id, wants]);

  const chips = plugin?.permissions ? permChips(plugin.permissions) : [];
  const loadingAccess = !!plugin && !plugin.permissions;
  return (
    <Sheet open={!!plugin} onOpenChange={(o) => !o && onClose()} side="right" size="lg" label={plugin?.name ?? t("Plugin details")}
      title={plugin ? <span className="flex flex-wrap items-center gap-2">{plugin.name}{plugin.verified && <Badge size="sm" tone="success" icon={<Verified />}>{t("Verified")}</Badge>}{plugin.builtin && <Badge size="sm" tone="neutral">{t("Built-in")}</Badge>}</span> : ""}
      description={plugin ? `v${plugin.version}${plugin.author ? ` · ${plugin.author}` : ""}` : ""} footer={footer}>
      {plugin && (
        <div className="flex flex-col gap-5 pb-2 text-[13px]">
          {plugin.description && <p className="text-[13.5px]">{plugin.description}</p>}

          <section aria-labelledby="pd-access" className="flex flex-col gap-2">
            <h3 id="pd-access" className="text-[13px] font-semibold">{t("What it can access")}</h3>
            {loadingAccess ? <Spinner label={t("Loading")} /> : chips.length === 0 ? <p className="text-muted-foreground">{t("It asks for no special access.")}</p> : (
              <ul className="flex flex-col gap-2">
                {chips.map((c) => (
                  <li key={c.key} className="flex items-start gap-2.5">
                    <Badge size="sm" tone={riskTone(c.risk)} variant="outline" className="mt-px flex-none">{c.label}</Badge>
                    <span className="text-muted-foreground">{c.plain}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(plugin.widgets.length > 0 || plugin.actions.length > 0) && (
            <section aria-labelledby="pd-adds" className="flex flex-col gap-2">
              <h3 id="pd-adds" className="text-[13px] font-semibold">{t("What it adds")}</h3>
              <ul className="flex flex-col gap-2">
                {plugin.widgets.map((w) => (
                  <li key={`w-${w.id}`} className="flex items-center gap-3">
                    <TilePreview pluginId={plugin.id} widget={w} theme={theme} screenshot={plugin.screenshot} className="w-44 flex-none" />
                    <span className="min-w-0"><span className="block font-medium">{w.name}</span><span className="block text-xs text-muted-foreground">{t("Tile")} · {rendererLabel(w.render, true)}</span></span>
                  </li>
                ))}
                {plugin.actions.map((a) => (
                  <li key={`a-${a.id}`} className="flex items-center gap-3">
                    <div className="grid h-12 w-20 flex-none place-items-center rounded-lg border bg-muted/40" aria-hidden><span className="grid size-7 place-items-center rounded-lg bg-foreground/15"><Puzzle className="size-4 text-muted-foreground" /></span></div>
                    <span className="min-w-0"><span className="block font-medium">{a.name}</span><span className="block text-xs text-muted-foreground">{t("Button")}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {plugin.readme && (
            <section aria-labelledby="pd-readme" className="flex flex-col gap-2">
              <h3 id="pd-readme" className="text-[13px] font-semibold">{t("About this plugin")}</h3>
              {readme === null && !readmeFailed && <Spinner label={t("Loading")} />}
              {readmeFailed && <p className="text-muted-foreground">{t("The description could not be loaded.")}</p>}
              {readme !== null && (readme.trim() ? <Markdown source={readme} /> : <p className="text-muted-foreground">{t("The author did not write a description.")}</p>)}
            </section>
          )}

          <div className="flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground">
            <div>{t("Version")}: <span className="font-mono">{plugin.version}</span></div>
            <div className="break-all">ID: <span className="font-mono">{plugin.id}</span></div>
            {plugin.source && /^https?:\/\//i.test(plugin.source) && <a href={plugin.source} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 underline underline-offset-2 hover:text-foreground"><Link className="size-3.5" />{t("Source code")}</a>}
          </div>
        </div>
      )}
    </Sheet>
  );
}
