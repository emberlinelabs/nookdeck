import { render } from 'preact'
import { Deck } from './Deck'
import { DEMO } from './theme'
import { DEMO_LAYOUT, asDemoMessage, checkDemoCss, decodeDemoParam, demoFontCss, demoIcon, demoIsObj, installNetGuard } from './demo-lib'
import type { DemoMessage } from './demo-lib'

/**
 * Demo deck: the real deck in preview mode, no agent. The embedding page sends { type: 'nd-demo', ... } (or puts the same object,
 * base64url JSON, in `?d=` / `#d=`); see docs/themes.md, "Preview a theme without Nookdeck".
 */
const origin = location.origin
;(window as unknown as { __ndNet: string[] }).__ndNet = installNetGuard(window as unknown as { [k: string]: unknown }, origin)
DEMO.on = true

const style = (id: string): HTMLStyleElement => {
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  return el
}

let last: DemoMessage | null = null

function apply(m: DemoMessage) {
  last = m
  const o = demoIsObj
  const pkg = typeof m.pkg === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(m.pkg) ? m.pkg : ''
  const variant = typeof m.variant === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(m.variant) ? m.variant : ''
  // package files the look names (background image): { "theme:<pack>/<file>": url }
  DEMO.files = {}
  if (o(m.files)) for (const k in m.files) { const v = m.files[k]; if (/^theme:[a-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(k) && typeof v === 'string') DEMO.files[k] = v }
  const ok = (u: string) => checkDemoCss('a{b:url("' + u.replace(/"/g, '%22') + '")}', origin)
  for (const k in DEMO.files) if (!ok(DEMO.files[k])) delete DEMO.files[k]
  style('nd-demo-fonts').textContent = demoFontCss(m.fonts, origin)
  style('nd-demo-css').textContent = checkDemoCss(m.css, origin)
  const assets: { [k: string]: unknown } = {}
  if (o(m.icons)) {
    let n = 0
    for (const name in m.icons) {
      if (n++ >= 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(name)) continue
      const ic = demoIcon(m.icons[name])
      if (ic) assets['pack:' + name.toLowerCase()] = ic
    }
  }
  const base = o(m.layout) && Array.isArray((m.layout as { pages?: unknown }).pages) ? (m.layout as { [k: string]: unknown }) : (DEMO_LAYOUT as unknown as { [k: string]: unknown })
  const theme: { [k: string]: unknown } = Object.assign({}, o(base.theme) ? base.theme : {}, o(m.theme) ? m.theme : {})
  if (pkg) theme.source = { pack: pkg + '@0.0.0', variant: variant || undefined }
  else delete theme.source
  const pages = base.pages as { id?: string }[]
  const pg = typeof m.page === 'number' ? pages[Math.max(0, Math.min(pages.length - 1, m.page | 0))] : typeof m.page === 'string' ? pages.filter((p) => p.id === m.page)[0] : pages[0]
  const np = m.np === 'last' || m.np === 'empty' ? m.np : ''
  window.postMessage({ type: 'pd-preview', layout: Object.assign({}, base, { theme, assets }), pageId: pg && pg.id, np }, origin)
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source === window) return
  if (ev.source !== window.parent) return // only the page that embeds the demo may drive it
  const m = asDemoMessage(ev.data)
  if (m) apply(m)
})

render(<Deck open standalone preview />, document.getElementById('root') as HTMLElement)

// the deck's own preview handler is ready once it has mounted
window.setTimeout(() => {
  let first: DemoMessage | null = null
  try {
    const q = new URLSearchParams(location.search)
    const h = new URLSearchParams(location.hash.replace(/^#/, ''))
    first = asDemoMessage(decodeDemoParam(q.get('d') || h.get('d')))
  } catch { /* ignore */ }
  apply(first || last || { type: 'nd-demo' })
  if (window.parent !== window) window.parent.postMessage({ type: 'nd-demo-ready' }, '*')
}, 50)
