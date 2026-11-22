import { useEffect, useState } from "react";
import { api } from "@/api";
import { isPluginTile, randomId, uniquePageId } from "@/lib/layout";
import type { Item, Layout, PluginInfo } from "@/types";

/** Plugins whose tiles and buttons can be placed: enabled and with every permission granted. Refetched each time a screen mounts it, so changes made in the Plugins tab show up. */
export function useEnabledPlugins(refreshKey?: string): PluginInfo[] {
  const [list, setList] = useState<PluginInfo[]>([]);
  useEffect(() => {
    let live = true;
    api.getPlugins().then((p) => live && setList(p.filter((x) => x.enabled))).catch(() => undefined);
    return () => { live = false; };
  }, [refreshKey]);
  return list;
}

/** "2x1" -> [2, 1]; anything else is dropped. */
export function parseSize(s: string): [number, number] | undefined {
  const m = /^(\d+)x(\d+)$/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export const pluginSizes = (sizes: string[]): [number, number][] => sizes.flatMap((s) => { const p = parseSize(s); return p ? [p] : []; });

/** Appends the pages of a plugin layout pack. Screen ids are made unique, and plugin tile ids are renewed when they clash (they must be unique across all screens). */
export function addLayoutPack(layout: Layout, pack: Layout): Layout {
  const pages = [...layout.pages];
  const used = new Set(pages.flatMap((p) => p.items.filter(isPluginTile).map((i) => i.id)));
  for (const p of pack.pages) {
    const items = p.items.map((it): Item => {
      if (!isPluginTile(it) || !used.has(it.id)) return it;
      return { ...it, id: randomId("w", used) };
    });
    for (const it of items) if (isPluginTile(it)) used.add(it.id);
    pages.push({ ...structuredClone(p), items: structuredClone(items), id: uniquePageId(p.name || p.id, pages) });
  }
  return { ...layout, pages };
}

/** The listed size nearest to a dragged size (a plugin tile is only valid in the sizes its manifest lists); other items pass through. */
export function snapSize(plugins: PluginInfo[], item: Item | undefined, w: number, h: number): [number, number] {
  if (!item || item.kind !== "widget" || item.widget !== "plugin") return [w, h];
  const sizes = pluginSizes(plugins.find((p) => p.id === item.plugin?.id)?.widgets.find((x) => x.id === item.plugin?.widget)?.sizes ?? []);
  let best: [number, number] = [w, h], d = Infinity;
  for (const s of sizes) { const k = Math.abs(s[0] - w) + Math.abs(s[1] - h); if (k < d) { d = k; best = s; } }
  return best;
}
