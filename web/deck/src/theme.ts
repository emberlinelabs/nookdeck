import { inDimWindow } from './screen-logic'
import type { Look, Theme } from './types'

/** Applies layout.theme to the deck root: mode -> data-pd-theme, the rest -> CSS custom properties. */

const num = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'number' ? v : NaN
  return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null
}

/** Only accept plain colour tokens so a theme cannot inject CSS. */
const color = (v: unknown): string | null =>
  typeof v === 'string' && /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i.test(v.trim()) ? v.trim() : null

export function resolveMode(t: Theme | undefined): 'dark' | 'light' {
  const m = t && t.mode
  if (m === 'light') return 'light'
  if (m === 'auto') {
    // a dim schedule decides when there is one (dark while dimmed, light otherwise); else the phone's colour scheme
    const d = t && t.screen && t.screen.dim
    if (d && d.from && d.to && d.from !== d.to) return inDimWindow(t && t.screen, new Date()) ? 'dark' : 'light'
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  }
  return 'dark'
}

/** System font stacks only (a theme cannot load a remote font); "pkg:<Family>" is a font the theme package ships and declares. */
const FONT_STACKS: { [k: string]: string } = {
  system: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', -apple-system, 'Helvetica Neue', Arial, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  serif: "'New York', Georgia, 'Times New Roman', serif",
  condensed: "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif",
}
export function fontStack(v: string | undefined, declared: { family: string }[] | undefined): string | null {
  if (!v) return null
  if (FONT_STACKS[v]) return FONT_STACKS[v]
  const m = /^pkg:([A-Za-z0-9 _-]{1,40})$/.exec(v)
  if (!m) return null
  let ok = false
  for (let i = 0; declared && i < declared.length; i++) if (declared[i].family === m[1]) ok = true
  return ok ? "'" + m[1] + "', " + FONT_STACKS.system : null
}

export interface ThemeCtx {
  /** iPhone 6/7 class devices: no blur, no animation from a theme */
  lite?: boolean
  /** ?theme=off: ignore the theme's look (safe mode) */
  off?: boolean
  /** the page on screen (its look overrides the layout theme) */
  page?: { theme?: Look }
  /** assets of the layout (uploaded img: backgrounds) */
  assets?: { [value: string]: { img?: string } }
}

/** The look in force: the layout theme, its auto pair resolved by the phone colour scheme, then the page's own look on top. */
export function effectiveTheme(t: Theme | undefined, page?: { theme?: Look }): Theme {
  let out: Theme = t ? ({} as Theme) : ({} as Theme)
  if (t) {
    const m = resolveMode(t)
    out = Object.assign({}, t) as Theme
    if (t.mode === 'auto' && t.auto) Object.assign(out, m === 'light' ? t.auto.light : t.auto.dark)
    out.mode = m
  }
  if (page && page.theme) {
    const pl = page.theme as Look
    const o = out as { [k: string]: unknown }
    for (const k in pl) if ((pl as { [k: string]: unknown })[k] !== undefined) o[k] = (pl as { [k: string]: unknown })[k]
    if (pl.mode === 'auto') out.mode = resolveMode({ mode: 'auto' } as Theme)
  }
  return out
}

const VARS = [
  '--pd-text', '--pd-text-2', '--pd-muted', '--pd-accent', '--pd-bg', '--pd-tile', '--pd-radius', '--pd-gap', '--pd-font',
  '--pd-ff', '--pd-ff-num', '--pd-tile-op', '--pd-tile-blur', '--pd-bw', '--pd-bc', '--pd-shadow', '--pd-ok', '--pd-warn', '--pd-error', '--pd-info',
  '--nd-standby-face', '--nd-standby-bg', '--pd-chart-1', '--pd-chart-2', '--pd-chart-3', '--pd-chart-4', '--pd-chart-5', '--pd-chart-6',
  '--nd-accent', '--nd-bg', '--nd-tile-bg', '--nd-tile-opacity', '--nd-text', '--nd-muted', '--nd-radius', '--nd-gap', '--nd-font', '--nd-number-font',
  '--nd-border-width', '--nd-border-color', '--nd-shadow', '--nd-tile-blur', '--nd-ok', '--nd-warn', '--nd-error', '--nd-info',
  '--nd-chart-1', '--nd-chart-2', '--nd-chart-3', '--nd-chart-4', '--nd-chart-5', '--nd-chart-6',
]
const SHADOWS: { [k: string]: string } = { none: 'none', soft: '0 2px 10px rgba(0,0,0,0.18)', strong: '0 6px 22px rgba(0,0,0,0.38)' }
const ATTRS = ['data-theme-pkg', 'data-theme-variant', 'data-pd-labels', 'data-pd-weight', 'data-pd-icons', 'data-pd-bg', 'data-pd-sh', 'data-pd-bd', 'data-pd-blur', 'data-pd-sbface', 'data-pd-sbbg']

/** "<pack id>@<version>" -> "<pack id>" */
const packId = (s: Theme['source']): string => (s && typeof s.pack === 'string' ? s.pack.split('@')[0] : '')

/** URL of a theme background: a package file or an uploaded image. Anything else is refused. */
export function backgroundUrl(v: string | undefined, assets?: { [value: string]: { img?: string } }): string | null {
  if (!v) return null
  const m = /^theme:([a-z0-9][a-z0-9._-]*)\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/.exec(v)
  if (m && v.indexOf('..') < 0) return '/api/themes/' + m[1] + '/files/' + m[2]
  if (/^img:[A-Za-z0-9_-]+$/.test(v) && assets && assets[v] && assets[v].img) return assets[v].img as string
  return null
}

const set = (root: HTMLElement, names: string[], val: string) => names.forEach((n) => root.style.setProperty(n, val))

/** Which kind a tile is, for data-kind. */
export function tileKind(item: { kind: string; widget?: string }): string {
  if (item.kind !== 'widget') return 'button'
  const w = item.widget || ''
  if (w === 'clock') return 'clock'
  if (w === 'nowplaying') return 'media'
  if (w === 'weather') return 'weather'
  if (w === 'quota') return 'quota'
  if (w === 'entity' || w === 'ha') return 'entity'
  if (w === 'plugin') return 'plugin'
  if (w === 'folder') return 'folder'
  return 'metric'
}

/** The status palette and chart colours of the look in force: read by status, gauge, chart and built-in metric tiles (getters, so module-level maps follow a theme change). */
export const PAL = { ok: '#34d399', warn: '#f59e0b', error: '#f87171', info: '#60a5fa' }
const PAL_DEFAULT = { ok: '#34d399', warn: '#f59e0b', error: '#f87171', info: '#60a5fa' }
let CHARTS: string[] = []
export function setPalette(t: Theme | undefined) {
  const p = (t && t.palette) || {}
  PAL.ok = color(p.ok) || PAL_DEFAULT.ok
  PAL.warn = color(p.warn) || PAL_DEFAULT.warn
  PAL.error = color(p.error) || PAL_DEFAULT.error
  PAL.info = color(p.info) || PAL_DEFAULT.info
  CHARTS = []
  const cc = (t && t.chartColors) || []
  for (let i = 0; i < cc.length && i < 6; i++) { const c = color(cc[i]); if (c) CHARTS.push(c) }
}
/** The i-th chart colour of the look (0-based), or `fallback`. */
export function chartColor(i: number, fallback: string): string {
  return i >= 0 && i < CHARTS.length ? CHARTS[i] : fallback
}

export function applyTheme(root: HTMLElement, t0: Theme | undefined, ctx: ThemeCtx = {}) {
  const t = ctx.off ? undefined : effectiveTheme(t0, ctx.page)
  const mode = resolveMode(t0 && ctx.off ? ({ mode: t0.mode } as Theme) : t)
  root.setAttribute('data-pd-theme', t && t.mode ? t.mode : mode)
  VARS.forEach((v) => root.style.removeProperty(v))
  ATTRS.forEach((a) => root.removeAttribute(a))
  root.style.removeProperty('background-image')
  const bgEl = root.querySelector('.pd-bgimg') as HTMLElement | null
  if (bgEl) {
    bgEl.style.backgroundImage = ''
    bgEl.style.display = 'none'
  }
  if (!t) return
  const text = color(t.text)
  if (text) set(root, ['--pd-text', '--pd-text-2', '--nd-text'], text)
  const muted = color(t.muted)
  if (muted) set(root, ['--pd-text-2', '--pd-muted', '--nd-muted'], muted)
  const accent = color(t.accent)
  if (accent) set(root, ['--pd-accent', '--nd-accent'], accent)
  const bg = color(t.background)
  if (bg) set(root, ['--pd-bg', '--nd-bg'], bg)
  const tile = color(t.tile)
  if (tile) set(root, ['--pd-tile', '--nd-tile-bg'], tile)
  const radius = num(t.radius, 0, 40)
  if (radius !== null) set(root, ['--pd-radius', '--nd-radius'], radius + 'px')
  const gap = num(t.gap, 0, 40)
  if (gap !== null) set(root, ['--pd-gap', '--nd-gap'], gap + 'px')
  const fs = num(t.fontScale, 0.5, 2)
  if (fs !== null) root.style.setProperty('--pd-font', String(fs))
  const ff = fontStack(t.font, t.fonts)
  if (ff) set(root, ['--pd-ff', '--nd-font'], ff)
  const nf = fontStack(t.numberFont, t.fonts)
  if (nf) set(root, ['--pd-ff-num', '--nd-number-font'], nf)
  const op = num(t.tileOpacity, 0.05, 1)
  if (op !== null) {
    set(root, ['--nd-tile-opacity'], String(op))
    // the tile colour gets the alpha (text stays opaque); a named / non-hex tile colour keeps full opacity
    const base = tile && hexToRgb(tile) ? tile : t.tile ? '' : mode === 'light' ? '#ffffff' : '#16161a'
    const rgba = tint(base, op)
    if (rgba) set(root, ['--pd-tile', '--nd-tile-bg'], rgba)
  }
  const blur = num(t.tileBlur, 0, 40)
  // blur costs a lot on old phones: skipped in lite mode (the tile keeps its colour, so it is still readable)
  if (blur !== null && blur > 0 && !ctx.lite) { set(root, ['--pd-tile-blur', '--nd-tile-blur'], blur + 'px'); root.setAttribute('data-pd-blur', '1') }
  if (t.border) {
    const w = num(t.border.width, 0, 3)
    if (w !== null) { set(root, ['--pd-bw', '--nd-border-width'], w + 'px'); root.setAttribute('data-pd-bd', '1') }
    const bc = color(t.border.color)
    if (bc) set(root, ['--pd-bc', '--nd-border-color'], bc)
  }
  if (t.shadow && SHADOWS[t.shadow]) { set(root, ['--pd-shadow', '--nd-shadow'], SHADOWS[t.shadow]); root.setAttribute('data-pd-sh', '1') }
  const pal = t.palette
  if (pal) (['ok', 'warn', 'error', 'info'] as const).forEach((k) => { const c = color(pal[k]); if (c) set(root, ['--pd-' + k, '--nd-' + k], c) })
  const cc = t.chartColors
  if (cc) for (let i = 0; i < cc.length && i < 6; i++) { const c = color(cc[i]); if (c) set(root, ['--pd-chart-' + (i + 1), '--nd-chart-' + (i + 1)], c) }
  if (t.labelPosition) root.setAttribute('data-pd-labels', t.labelPosition === 'top' || t.labelPosition === 'hidden' ? t.labelPosition : 'bottom')
  if (t.labelWeight) root.setAttribute('data-pd-weight', t.labelWeight)
  if (t.iconStyle) root.setAttribute('data-pd-icons', t.iconStyle)
  const pk = packId(t0 && t0.source)
  if (pk && /^[a-z0-9][a-z0-9._-]*$/.test(pk)) {
    root.setAttribute('data-theme-pkg', pk)
    const src = t0 && t0.source
    let variant = src && src.variant
    if (src && src.auto) variant = mode === 'light' ? src.auto.light : src.auto.dark
    if (variant && /^[a-z0-9][a-z0-9_-]*$/.test(variant)) root.setAttribute('data-theme-variant', variant)
  }
  // background: an image (cover / contain / tile, dimmed, blurred) or a gradient; the image sits in .pd-bgimg behind the content
  // standby clock face / background from the theme package (served by the agent, never an outside address)
  const sbAsset = (k: string): string => {
    const a = ctx.assets && ctx.assets['pack:standby-' + k]
    return a && a.img && /^\/api\/themes\/[a-z0-9._-]+\/files\/standby\/[A-Za-z0-9._-]+$/.test(a.img) ? 'url("' + a.img + '")' : ''
  }
  const sbFace = sbAsset('face'), sbBg = sbAsset('background')
  if (sbFace) { root.style.setProperty('--nd-standby-face', sbFace); root.setAttribute('data-pd-sbface', '1') }
  if (sbBg) { root.style.setProperty('--nd-standby-bg', sbBg); root.setAttribute('data-pd-sbbg', '1') }
  const url = backgroundUrl(t.backgroundImage, ctx.assets)
  if (url && bgEl) {
    const dim = num(t.backgroundDim, 0, 0.9)
    const fit = t.backgroundFit === 'contain' || t.backgroundFit === 'tile' ? t.backgroundFit : 'cover'
    const img = 'url("' + url.replace(/"/g, '%22') + '")'
    bgEl.style.display = 'block'
    bgEl.style.backgroundImage = (dim ? 'linear-gradient(rgba(0,0,0,' + dim + '),rgba(0,0,0,' + dim + ')),' : '') + img
    bgEl.style.backgroundSize = (dim ? 'auto,' : '') + (fit === 'tile' ? 'auto' : fit)
    bgEl.style.backgroundRepeat = (dim ? 'no-repeat,' : '') + (fit === 'tile' ? 'repeat' : 'no-repeat')
    bgEl.style.backgroundPosition = (dim ? '0 0,' : '') + 'center'
    const bb = num(t.backgroundBlur, 0, 30)
    const f = bb && !ctx.lite ? 'blur(' + bb + 'px)' : ''
    bgEl.style.setProperty('-webkit-filter', f)
    bgEl.style.filter = f
    root.setAttribute('data-pd-bg', 'image')
    // (standby assets are set below)
  } else if (t.gradient) {
    const a = color(t.gradient.from), b = color(t.gradient.to), ang = num(t.gradient.angle, 0, 360)
    if (a && b) {
      root.style.backgroundImage = 'linear-gradient(' + (ang === null ? 135 : ang) + 'deg,' + a + ',' + b + ')'
      root.setAttribute('data-pd-bg', 'gradient')
    }
  }
}

const KIND_PROPS: { [k: string]: string } = { tile: '--pd-tile', text: '--pd-text', muted: '--pd-text-2', accent: '--pd-accent' }

/** Per-kind and state tokens as a stylesheet scoped to the root (selectors use only the stable data-* hooks). */
export function kindsCss(t: Theme | undefined, lite?: boolean): string {
  if (!t || !t.kinds) return ''
  let out = ''
  for (const kind in t.kinds) {
    if (!/^[a-z]+$/.test(kind)) continue
    const k = t.kinds[kind]
    const decl = (o: { [k: string]: unknown }, withExtra: boolean): string => {
      let d = ''
      for (const f in KIND_PROPS) { const c = color(o[f]); if (c) d += KIND_PROPS[f] + ':' + c + ';' }
      if (o.border && typeof (o.border as { width: number }).width === 'number') {
        const b = o.border as { width: number; color?: string }
        d += '--pd-bw:' + Math.min(3, Math.max(0, b.width)) + 'px;'
        const bc = color(b.color); if (bc) d += '--pd-bc:' + bc + ';'
      }
      if (typeof o.shadow === 'string' && SHADOWS[o.shadow]) d += '--pd-shadow:' + SHADOWS[o.shadow] + ';'
      if (withExtra) {
        const r = num(o.radius, 0, 40); if (r !== null) d += '--pd-radius:' + r + 'px;'
        const op = num(o.tileOpacity, 0.05, 1)
        const tc = color(o.tile)
        if (op !== null && tc) { const rg = tint(tc, op); if (rg) d += '--pd-tile:' + rg + ';' }
        const bl = num(o.tileBlur, 0, 40); if (bl !== null && bl > 0 && !lite) d += '--pd-tile-blur:' + bl + 'px;'
      }
      return d
    }
    const base = '.pd-root [data-part="tile"][data-kind="' + kind + '"]'
    const d0 = decl(k as { [k: string]: unknown }, true)
    if (d0) out += base + '{' + d0 + '}'
    const st = k.states
    if (st) {
      const m: { [k: string]: string } = { pressed: ':active', active: '[data-state="on"],' + base + '[data-state="playing"]', alert: '[data-state="warn"],' + base + '[data-state="error"]' }
      for (const s of ['pressed', 'active', 'alert'] as const) {
        const d = st[s] ? decl(st[s] as { [k: string]: unknown }, false) : ''
        if (d) out += base + m[s] + '{' + d + '}'
      }
    }
  }
  return out
}

/** @font-face for the fonts a theme declares; urls are package files only. */
export function fontFaceCss(t: Theme | undefined): string {
  if (!t || !t.fonts || !t.source) return ''
  const id = packId(t.source)
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) return ''
  let out = ''
  for (let i = 0; i < t.fonts.length && i < 4; i++) {
    const f = t.fonts[i]
    if (!/^[A-Za-z0-9 _-]{1,40}$/.test(f.family) || !/^fonts\/[A-Za-z0-9._-]+\.woff2?$/i.test(f.file)) continue
    const fmt = /\.woff2$/i.test(f.file) ? 'woff2' : 'woff'
    out += "@font-face{font-family:'" + f.family + "';src:url('/api/themes/" + id + '/files/' + f.file + "') format('" + fmt + "');font-weight:" + (f.weight || 400) + ';font-display:swap;}'
  }
  return out
}

/** `fg` at `alpha` laid over `bg` (both hex), as hex: the colour a translucent tile really shows. Null for non-hex input. */
export function over(fg: string | undefined, alpha: number, bg: string | undefined): string | null {
  const a = hexToRgb(fg), b = hexToRgb(bg)
  if (!a || !b) return null
  const h = (i: number) => {
    const x = Math.round(a[i] * alpha + b[i] * (1 - alpha))
    return (x < 16 ? '0' : '') + x.toString(16)
  }
  return '#' + h(0) + h(1) + h(2)
}

/** The colour behind the tiles, for ink decisions: the theme background, else its gradient start, else the mode default. */
export function backdropOf(t: Theme | undefined, mode: 'dark' | 'light'): string {
  const bg = t && color(t.background)
  if (bg && hexToRgb(bg)) return bg as string
  const g = t && t.gradient && color(t.gradient.from)
  if (g && hexToRgb(g)) return g as string
  return mode === 'light' ? '#f4f4f6' : '#0b0b0d'
}

/** "#rgb" / "#rrggbb" -> [r,g,b], or null for anything else (named colours, rgb(), ...). */
export function hexToRgb(c: string | undefined): [number, number, number] | null {
  if (!c) return null
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** Tint of an item colour: rgba computed here because Safari 12 has no color-mix(). */
export function tint(c: string | undefined, alpha: number): string | null {
  const rgb = hexToRgb(c)
  return rgb ? 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')' : null
}

/** Dark or light text, whichever reads better on a hex background; null for non-hex colours. */
export function readableOn(bg: string | undefined): string | null {
  const rgb = hexToRgb(bg)
  if (!rgb) return null
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 150 ? '#111114' : '#ffffff'
}

/** Mixes a hex colour toward white (amt > 0) or black (amt < 0), amt -1..1. Returns a hex string; falls back to the input. */
export function shade(c: string | undefined, amt: number): string {
  const rgb = hexToRgb(c)
  if (!rgb) return c || '#22d3ee'
  const to = amt >= 0 ? 255 : 0
  const k = Math.abs(amt)
  const h = (v: number) => {
    const x = Math.round(v + (to - v) * k)
    return (x < 16 ? '0' : '') + x.toString(16)
  }
  return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2])
}
