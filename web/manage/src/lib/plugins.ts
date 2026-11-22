import { useEffect, useState } from "react";
import { api, PLUGINS_CHANGED } from "@/api";
import { isPluginTile, randomId, uniquePageId } from "@/lib/layout";
import type { Item, Layout, PluginInfo } from "@/types";

/** Plugins whose tiles and buttons can be placed: enabled and with every permission granted. Refetched each time a screen mounts it, so changes made in the Plugins tab show up. */
export function useEnabledPlugins(refreshKey?: string): PluginInfo[] {
  const [list, setList] = useState<PluginInfo[]>([]);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    const on = () => setRev((n) => n + 1);
    window.addEventListener(PLUGINS_CHANGED, on);
    return () => window.removeEventListener(PLUGINS_CHANGED, on);
  }, []);
  useEffect(() => {
    let live = true;
    api.getPlugins().then((p) => live && setList(p.filter((x) => x.enabled && !x.builtin))).catch(() => undefined);
    return () => { live = false; };
  }, [refreshKey, rev]);
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

/** Where a plugin is used: its tiles and its buttons, per screen. */
export interface PluginUse { pageId: string; pageName: string; tiles: number; buttons: number }
const isTileOf = (it: Item, id: string): boolean => it.kind === "widget" && it.widget === "plugin" && it.plugin?.id === id;
const isButtonOf = (it: Item, id: string): boolean => it.kind === "button" && it.action?.type === "plugin" && it.action.plugin === id;
export function pluginUsage(layout: Layout, id: string): PluginUse[] {
  return layout.pages.flatMap((p) => {
    const tiles = p.items.filter((it) => isTileOf(it, id)).length;
    const buttons = p.items.filter((it) => isButtonOf(it, id)).length;
    return tiles || buttons ? [{ pageId: p.id, pageName: p.name || p.id, tiles, buttons }] : [];
  });
}
/** The layout without the tiles and buttons of a plugin. */
export const removePluginItems = (layout: Layout, id: string): Layout => ({
  ...layout,
  pages: layout.pages.map((p) => (p.items.some((it) => isTileOf(it, id) || isButtonOf(it, id)) ? { ...p, items: p.items.filter((it) => !isTileOf(it, id) && !isButtonOf(it, id)) } : p)),
});
