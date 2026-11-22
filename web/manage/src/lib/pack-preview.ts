import { LOOK_FIELDS } from "@/components/theme-panel";
import type { Layout, Theme, ThemeLook, ThemePack } from "@/types";

/** What to show a pack as: one variant, or an Auto pair, plus the chosen option values. */
export interface PackChoice { variant: string; auto?: { light: string; dark: string }; options?: Record<string, string> }

const merge = (a: Partial<ThemeLook>, b?: Partial<ThemeLook>): Partial<ThemeLook> => ({ ...a, ...(b ?? {}) });

/** The look of one variant with the option choices on top (the same order the agent uses: variant, then option patches). */
export function packLook(pack: ThemePack, variantId: string, options?: Record<string, string>): Partial<ThemeLook> {
  const v = pack.variants.find((x) => x.id === variantId) ?? pack.variants[0];
  let look: Partial<ThemeLook> = { ...(v?.look ?? {}) };
  if (v) look.mode = v.mode;
  for (const o of pack.options) {
    const val = o.values.find((x) => x.id === options?.[o.id]);
    if (val) look = merge(look, (v && val.variants?.[v.id]) || val.theme);
  }
  return look;
}

/** The layout theme with this pack's look on top. Behaviour settings (language, orientation, header, screen...) are kept, as Apply keeps them. */
export function themeWithPack(base: Theme | undefined, pack: ThemePack, c: PackChoice): Theme {
  const keep: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base ?? {})) if (!LOOK_FIELDS.has(k) && k !== "auto" && k !== "kinds" && k !== "fonts") keep[k] = v;
  const source: Record<string, unknown> = { pack: `${pack.id}@${pack.version}`, ...(c.auto ? { auto: c.auto } : { variant: c.variant }), ...(c.options && Object.keys(c.options).length ? { options: c.options } : {}) };
  if (c.auto) {
    const light = packLook(pack, c.auto.light, c.options), dark = packLook(pack, c.auto.dark, c.options);
    return { ...keep, ...dark, mode: "auto", auto: { light, dark }, source } as unknown as Theme;
  }
  return { ...keep, ...packLook(pack, c.variant, c.options), source } as unknown as Theme;
}

/** The user's own screen to preview themes on: the page asked for, else the first one that has tiles, else the first. */
export function previewPage(layout: Layout, pageId?: string): { page: Layout["pages"][number]; empty: boolean } | null {
  const pages = layout.pages ?? [];
  if (!pages.length) return null;
  const chosen = (pageId && pages.find((p) => p.id === pageId)) || pages[0]!;
  const items = (p: Layout["pages"][number]) => (p.items ?? []).length;
  const page = items(chosen) ? chosen : pages.find((p) => items(p)) ?? chosen;
  return { page, empty: !items(page) };
}
