import { render } from 'preact'
import { Tile, tileThemeOf } from './Deck'
import type { Placed } from './Deck'
import { setIconStroke } from './icon'
import { setLang } from './i18n'
import { setTempUnit } from './temp'
import { DEMO, applyTheme, effectiveTheme, kindsCss, setPalette } from './theme'
import { installNetGuard } from './demo-lib'
import { asTileMessage, tileEntry, tileLook } from './tile-lib'
import type { TileMessage } from './tile-lib'
import type { PluginSlot } from './plugin-logic'

/**
 * tile.html: exactly one plugin tile, filling the frame, on a transparent page. The embedding page sends
 * { type: 'nookdeck-tile', ... } (tile-lib.ts); docs/plugins.md, "Show a tile on a web page". No agent, no network, buttons do nothing.
 */
;(window as unknown as { __ndNet: string[] }).__ndNet = installNetGuard(window as unknown as { [k: string]: unknown }, location.origin)
DEMO.on = true

const mount = document.getElementById('root') as HTMLElement
let shown: { m: TileMessage; entry: PluginSlot } | null = null

const nothing = () => {}
const NO_HIST = { cpu: [], mem: [], rx: [], tx: [], load: [], gpu: [] }

function draw(m: TileMessage, entry: PluginSlot, look: ReturnType<typeof tileLook>) {
  const eff = effectiveTheme(look)
  setIconStroke(look.iconStroke)
  setPalette(eff)
  setLang(m.lang || look.language || 'en')
  setTempUnit(look.temperatureUnit)
  const item = { id: 'tile', kind: 'widget', widget: 'plugin', x: 0, y: 0, w: m.w, h: m.h, px: 0, py: 0, pw: m.w, ph: m.h, plugin: { id: 'preview.tile', widget: 'tile' } } as unknown as Placed
  const width = window.innerWidth
  const height = window.innerHeight
  render(
    <div class="pd-root pd-root--preview pd-onetile" data-pd-theme={eff.mode}>
      <div class="pd-onetile__back">
        <Tile
          page={{ id: 'tile', name: '', items: [] } as any}
          item={item}
          stats={null}
          fx=""
          selected={false}
          dragging={false}
          showHandle={false}
          tw={width}
          th={height}
          scale={Math.min(2, Math.max(0.5, look.fontScale || 1))}
          tt={tileThemeOf(look, eff)}
          preview={false}
          ai={null}
          waitingProjects={[]}
          onWidget={nothing}
          hist={NO_HIST}
          media={null}
          last={null}
          onMedia={nothing}
          onVolume={nothing}
          onPress={nothing}
          onDown={nothing}
          plug={entry}
        />
      </div>
    </div>,
    mount
  )
  const root = mount.firstChild as HTMLElement
  applyTheme(root, look)
  // the page stays clear around the tile; what the deck would have behind it goes behind the tile, so a translucent tile reads right
  const back = root.firstChild as HTMLElement
  back.style.backgroundImage = root.style.backgroundImage
  let css = document.getElementById('nd-tile-css')
  if (!css) {
    css = document.createElement('style')
    css.id = 'nd-tile-css'
    document.head.appendChild(css)
  }
  css.textContent = kindsCss(eff)
}

function show() {
  if (!shown || window.innerWidth < 1 || window.innerHeight < 1) return
  try {
    draw(shown.m, shown.entry, tileLook(shown.m.theme, shown.m.mode))
  } catch (e) {
    // a theme object with a field of the wrong kind: the default look, never a blank frame
    try { console.error('tile theme', e) } catch { /* ignore */ }
    render(null, mount) // the failed draw left half a tree behind
    draw(shown.m, shown.entry, tileLook(undefined, shown.m.mode))
  }
}

// any origin may embed the page; only the embedding window drives it, and only with the exact shape
window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window.parent) return
  const m = asTileMessage(ev.data)
  if (!m) return
  shown = { m, entry: tileEntry(m.render, m.data, m.style) }
  show()
})
window.addEventListener('resize', show)
if (window.parent !== window) window.parent.postMessage({ type: 'nookdeck-tile-ready' }, '*')
