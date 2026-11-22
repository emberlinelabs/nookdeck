import { Component, render } from 'preact'
import type { ComponentChildren } from 'preact'
import { Deck } from './Deck'

export { Deck }
export type { DeckProps } from './Deck'

export interface MountOptions {
  /** Agent origin when embedded in another site, e.g. "http://nookdeck.local:7420". Default: same origin. */
  baseUrl?: string
  /** Always open, no close button (the Nookdeck page itself). Otherwise the deck starts closed. */
  standalone?: boolean
  /** Prefill for the pairing PIN. In standalone mode it is read from ?pin and stripped from the URL. */
  pin?: string
  /** Preview mode for the editor iframe: no pairing/WebSocket/actions; layout arrives via postMessage. Also on with ?preview=1. */
  preview?: boolean
  /** Called when the overlay closes itself (close button). */
  onClose?: () => void
}

export interface DeckHandle {
  open(): void
  close(): void
  toggle(): void
  isOpen(): boolean
  destroy(): void
}

/**
 * Error boundary: if the deck crashes while a theme is on, reload once in safe mode (?theme=off, the look is ignored); if it still
 * crashes, or this is an embedded overlay, show a short message instead of a blank screen.
 */
class Boundary extends Component<{ standalone?: boolean; children?: ComponentChildren }, { err: boolean }> {
  state = { err: false }
  componentDidCatch(e: unknown) {
    try { console.error('deck', e) } catch { /* ignore */ }
    try {
      if (this.props.standalone && !/[?&]theme=off(&|$)/.test(location.search)) {
        location.replace(location.pathname + (location.search ? location.search + '&' : '?') + 'theme=off' + location.hash)
        return
      }
    } catch { /* ignore */ }
    this.setState({ err: true })
  }
  render() {
    return this.state.err ? <div style={{ padding: '24px', font: '15px -apple-system, sans-serif', color: '#999' }}>Nookdeck hit a problem. Reload the page, or open it with ?theme=off.</div> : this.props.children
  }
}

/** Mounts the deck into `el`. Embedders call `handle.open()` from their own button. */
export function mountDeck(el: HTMLElement, opts: MountOptions = {}): DeckHandle {
  let open = !!opts.standalone
  let pin = opts.pin
  let preview = !!opts.preview
  if (opts.standalone && !pin) {
    try {
      const params = new URLSearchParams(location.search)
      if (params.get('preview') === '1') preview = true
      const p = params.get('pin')
      if (p) pin = p.replace(/\D/g, '').slice(0, 6)
      if (params.has('pin') && !preview) {
        params.delete('pin')
        const qs = params.toString()
        history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash)
      }
    } catch {
      /* ignore */
    }
  }
  const draw = () =>
    render(
      <Boundary standalone={opts.standalone}>
      <Deck
        open={open}
        standalone={opts.standalone}
        baseUrl={opts.baseUrl}
        pin={pin}
        preview={preview}
        onClose={() => {
          open = false
          draw()
          if (opts.onClose) opts.onClose()
        }}
      />
      </Boundary>,
      el
    )
  draw()
  return {
    open() {
      open = true
      draw()
    },
    close() {
      open = !!opts.standalone
      draw()
    },
    toggle() {
      open = !open
      draw()
    },
    isOpen: () => open,
    destroy() {
      render(null, el)
    },
  }
}
