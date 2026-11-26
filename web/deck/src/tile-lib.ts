/**
 * The demo's tile page (tile.html): one plugin tile drawn by the real deck, for a page that embeds it. This is the pure half: the
 * message it accepts, the checks the data goes through (the agent's, then the deck's) and the look a theme name or object stands for.
 */
import { cleanRender } from '../../../src/plugins/render'
import classic from '../../../themes/builtin/nookdeck-classic/nookdeck.json'
import nookdeck from '../../../themes/builtin/nookdeck/nookdeck.json'
import { PLUGIN_RENDERS, parsePluginItem } from './plugin-logic'
import type { PluginRender, PluginSlot } from './plugin-logic'
import type { Theme } from './types'

export const TILE_CELLS_MAX = 24

export interface TileMessage {
  type: 'nookdeck-tile'
  render: string
  data: unknown
  style?: string
  w: number
  h: number
  /** a built-in theme pack's id, or a Theme object */
  theme?: string | { [k: string]: unknown }
  mode?: 'light' | 'dark'
  lang?: 'en' | 'vi' | 'zh' | 'fr' | 'pt'
}

const KEYS = ['type', 'render', 'data', 'style', 'w', 'h', 'theme', 'mode', 'lang']
const isObj = (x: unknown): x is { [k: string]: unknown } => !!x && typeof x === 'object' && !Array.isArray(x)
const cells = (n: unknown): boolean => typeof n === 'number' && Math.floor(n) === n && n >= 1 && n <= TILE_CELLS_MAX

/** The message, or null for anything that is not exactly its shape (the page then keeps what it shows). `data` is checked later. */
export function asTileMessage(m: unknown): TileMessage | null {
  if (!isObj(m) || m.type !== 'nookdeck-tile') return null
  for (const k in m) if (KEYS.indexOf(k) < 0) return null
  if (typeof m.render !== 'string' || !('data' in m) || !cells(m.w) || !cells(m.h)) return null
  if (m.style !== undefined && typeof m.style !== 'string') return null
  if (m.theme !== undefined && typeof m.theme !== 'string' && !isObj(m.theme)) return null
  if (m.mode !== undefined && m.mode !== 'light' && m.mode !== 'dark') return null
  if (m.lang !== undefined && m.lang !== 'en' && m.lang !== 'vi' && m.lang !== 'zh' && m.lang !== 'fr' && m.lang !== 'pt') return null
  return m as unknown as TileMessage
}

/** What the tile shows: the agent's check and clean-up, then the deck's, as for live data. */
export function tileEntry(render: string, data: unknown, style?: string): PluginSlot {
  if (PLUGIN_RENDERS.indexOf(render as PluginRender) < 0) return { error: 'unknown renderer' }
  try {
    const clean = cleanRender(render as PluginRender, data)
    if ('error' in clean) return { error: clean.error.slice(0, 200) }
    // a live deck loads an https image; this page loads nothing
    if (render === 'image' && !/^data:/i.test((clean.data as { url: string }).url)) return { error: 'this preview loads no remote images' }
    return parsePluginItem({ render, data: clean.data, style })
  } catch {
    return { error: 'invalid data' }
  }
}

interface Pack {
  id: string
  version: string
  auto?: { light?: string; dark?: string }
  theme?: { [k: string]: unknown }
  variants: { id: string; mode?: string; theme: { [k: string]: unknown } }[]
}
const PACKS = [nookdeck, classic] as unknown as Pack[]
export const TILE_PACKS = PACKS.map((p) => p.id)

/**
 * The theme to apply. A pack id means that built-in pack's look for the mode (dark without one); an unknown id is the default look.
 * `mode` also settles an object whose mode is "auto".
 */
export function tileLook(theme: TileMessage['theme'], mode: TileMessage['mode']): Theme {
  if (typeof theme === 'string') {
    const p = PACKS.filter((x) => x.id === theme)[0]
    if (p) {
      const want = mode || 'dark'
      const id = p.auto && p.auto[want]
      const v = p.variants.filter((x) => x.id === id)[0] || p.variants.filter((x) => x.mode === want)[0] || p.variants[0]
      return Object.assign({}, p.theme, v.theme, { mode: v.mode || v.theme.mode || want, source: { pack: p.id + '@' + p.version, variant: v.id } }) as unknown as Theme
    }
  }
  const out = Object.assign({}, isObj(theme) ? theme : {}) as { [k: string]: unknown }
  if (mode) {
    const auto = out.auto as { [k: string]: object } | undefined
    if (out.mode === 'auto' && isObj(auto)) Object.assign(out, auto[mode])
    out.mode = mode
  } else if (!out.mode) out.mode = 'dark'
  return out as unknown as Theme
}
