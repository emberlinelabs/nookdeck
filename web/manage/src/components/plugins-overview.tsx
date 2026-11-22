import { IconBuildingStore as Store } from "@tabler/icons-react";
import { Badge } from "@/components/ui/knowns/badge";
import { Card, CardContent } from "@/components/ui/knowns/card";
import { Icon } from "@/components/icon";
import { PluginsPanel } from "@/components/plugins-panel";
import { BUILTIN_PLUGINS } from "@/lib/builtin-plugins";
import { t, useLanguage } from "@/lib/i18n";
import type { Layout } from "@/types";

/** Plugins home: the built-in ones, the installed community plugins with the install box, and a place for the Store. */
export function PluginsOverview({ update }: { update: (fn: (l: Layout) => Layout) => void }) {
  useLanguage();
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("Built-in")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {BUILTIN_PLUGINS.map((p) => (
            <a key={p.id} href={`#plugin/${p.id}`} className="flex items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
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
      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("Community plugins")}</h2>
        <PluginsPanel update={update} />
      </section>
      <Card className="border-dashed">
        <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
          <Store className="size-5 flex-none" />
          <span>{t("A plugin Store is coming. Until then, install a plugin from a link or a folder above.")}</span>
        </CardContent>
      </Card>
    </div>
  );
}
