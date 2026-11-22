/** Pure validation for plugin tiles. No DOM, no deck imports: the agent sends {render, data} and the deck never trusts it. */

export type PluginRender = 'stat' | 'gauge' | 'text' | 'list' | 'chart' | 'image' | 'status'
export const PLUGIN_RENDERS: PluginRender[] = ['stat', 'gauge', 'text', 'list', 'chart', 'image', 'status']
export const MAX_LIST = 20
export const MAX_POINTS = 120
export type PluginState = 'ok' | 'warn' | 'error' | 'off'

export interface StatData { value: string | number; unit?: string; label?: string; delta?: number; color?: string }
export interface GaugeData { value: number; label?: string; color?: string }
export interface TextData { title?: string; body: string }
export interface ListRow { title: string; subtitle?: string; value?: string; icon?: string }
export interface ListData { items: ListRow[] }
export interface ChartData { points: number[]; label?: string; unit?: string }
export interface ImageData { url: string; fit?: 'cover' | 'contain' }
export interface StatusData { state: PluginState; label: string }

export type PluginEntry =
  | { render: 'stat'; data: StatData }
  | { render: 'gauge'; data: GaugeData }
  | { render: 'text'; data: TextData }
  | { render: 'list'; data: ListData }
  | { render: 'chart'; data: ChartData }
  | { render: 'image'; data: ImageData }
  | { render: 'status'; data: StatusData }

const isObj = (x: unknown): x is { [k: string]: unknown } => !!x && typeof x === 'object' && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && isFinite(x)
const optStr = (x: unknown): string | undefined | null => (x === undefined || x === null ? undefined : typeof x === 'string' ? x : null)
const COLOR = /^#[0-9a-fA-F]{3,8}$/

/** Only https and data:image URLs may load; never http, javascript: or file:. */
export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null
  const s = u.trim()
  if (s.length === 0 || s.length > 2000000) return null
  if (/^https:\/\/[^\s]+$/i.test(s)) return s
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);/i.test(s)) return s
  return null
}

/** The validated entry for one tile, or null when the render is unknown or the data is invalid. */
export function validatePlugin(render: unknown, data: unknown): PluginEntry | null {
  if (typeof render !== 'string' || !isObj(data)) return null
  const d = data
  if (render === 'stat') {
    const v = d.value
    if (!(typeof v === 'string' || isNum(v))) return null
    const unit = optStr(d.unit)
    const label = optStr(d.label)
    if (unit === null || label === null) return null
    if (d.delta !== undefined && d.delta !== null && !isNum(d.delta)) return null
    if (d.color !== undefined && d.color !== null && !(typeof d.color === 'string' && COLOR.test(d.color))) return null
    return { render, data: { value: v, unit, label, delta: isNum(d.delta) ? d.delta : undefined, color: typeof d.color === 'string' ? d.color : undefined } }
  }
  if (render === 'gauge') {
    if (!isNum(d.value) || d.value < 0 || d.value > 100) return null
    const label = optStr(d.label)
    if (label === null) return null
    if (d.color !== undefined && d.color !== null && !(typeof d.color === 'string' && COLOR.test(d.color))) return null
    return { render, data: { value: d.value, label, color: typeof d.color === 'string' ? d.color : undefined } }
  }
  if (render === 'text') {
    if (typeof d.body !== 'string') return null
    const title = optStr(d.title)
    if (title === null) return null
    return { render, data: { title, body: d.body } }
  }
  if (render === 'list') {
    if (!Array.isArray(d.items) || d.items.length > MAX_LIST) return null
    const items: ListRow[] = []
    for (let i = 0; i < d.items.length; i++) {
      const r = d.items[i]
      if (!isObj(r) || typeof r.title !== 'string') return null
      const sub = optStr(r.subtitle)
      const icon = optStr(r.icon)
      if (sub === null || icon === null) return null
      let val: string | undefined
      if (r.value !== undefined && r.value !== null) {
        if (typeof r.value === 'string') val = r.value
        else if (isNum(r.value)) val = String(r.value)
        else return null
      }
      items.push({ title: r.title, subtitle: sub, value: val, icon })
    }
    return { render, data: { items } }
  }
  if (render === 'chart') {
    if (!Array.isArray(d.points) || d.points.length > MAX_POINTS) return null
    for (let i = 0; i < d.points.length; i++) if (!isNum(d.points[i])) return null
    const label = optStr(d.label)
    const unit = optStr(d.unit)
    if (label === null || unit === null) return null
    return { render, data: { points: d.points as number[], label, unit } }
  }
  if (render === 'image') {
    const url = safeImageUrl(d.url)
    if (!url) return null
    if (d.fit !== undefined && d.fit !== null && d.fit !== 'cover' && d.fit !== 'contain') return null
    return { render, data: { url, fit: d.fit === 'contain' ? 'contain' : d.fit === 'cover' ? 'cover' : undefined } }
  }
  if (render === 'status') {
    const s = d.state
    if (s !== 'ok' && s !== 'warn' && s !== 'error' && s !== 'off') return null
    if (typeof d.label !== 'string') return null
    return { render, data: { state: s, label: d.label } }
  }
  return null
}

/** An error tile: `error` is the agent's text (may be empty when the data was just invalid). */
export interface PluginError { error: string }
export type PluginSlot = PluginEntry | PluginError | null

/** One wire item: {render, data} is validated; {error} keeps its text; anything else (missing, junk) is the empty error. */
export function parsePluginItem(x: unknown): PluginSlot {
  if (isObj(x) && x.error !== undefined) return { error: typeof x.error === 'string' ? x.error.slice(0, 200) : '' }
  const v = isObj(x) ? validatePlugin(x.render, x.data) : null
  return v || { error: '' }
}

const FRIENDLY: { [msg: string]: string } = {
  'plugin missing': 'Plugin missing',
  'plugin disabled': 'Plugin off',
  'plugin not granted': 'Needs approval',
  'plugin widget missing': 'Tile removed',
}
/** The label for a known agent error (an English key for t()), or null for free text / empty. */
export function friendlyError(msg: string): string | null {
  return FRIENDLY[msg.trim().toLowerCase()] || null
}

/**
 * Merge a {type:'plugin', items} message into the current map by tile id: the latest value per tile wins.
 * The first message after connecting is the full map and later ones are partial, so tiles missing from a message keep their value.
 */
export function mergePlugins(cur: { [tileId: string]: PluginSlot } | undefined, items: unknown): { [tileId: string]: PluginSlot } {
  const out: { [tileId: string]: PluginSlot } = {}
  const c = cur || {}
  Object.keys(c).forEach((k) => (out[k] = c[k]))
  if (!isObj(items)) return out
  Object.keys(items).forEach((k) => (out[k] = parsePluginItem(items[k])))
  return out
}

/** Data used for the manage preview, so plugin tiles are not all error tiles there. Cycles the renderers by widget name. */
export function samplePlugin(widget: string): PluginEntry {
  let h = 0
  for (let i = 0; i < widget.length; i++) h = (h * 31 + widget.charCodeAt(i)) % 7
  const r = PLUGIN_RENDERS[h]
  if (r === 'stat') return { render: 'stat', data: { value: 64231, unit: 'USD', label: 'BTC', delta: 1.8 } }
  if (r === 'gauge') return { render: 'gauge', data: { value: 62, label: 'Battery' } }
  if (r === 'text') return { render: 'text', data: { title: 'Note', body: 'Sample text from a plugin.' } }
  if (r === 'list') return { render: 'list', data: { items: [{ title: 'Build', subtitle: 'main', value: 'ok' }, { title: 'Deploy', subtitle: 'prod', value: '2m' }, { title: 'Tests', value: '412' }] } }
  if (r === 'chart') return { render: 'chart', data: { points: [3, 5, 4, 7, 6, 9, 8, 11, 10, 13], label: 'Requests', unit: '/s' } }
  if (r === 'image') return { render: 'text', data: { title: 'Image', body: 'Shown in the live deck.' } }
  return { render: 'status', data: { state: 'ok', label: 'All good' } }
}
