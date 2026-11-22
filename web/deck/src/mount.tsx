import { render } from 'preact'
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
      />,
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
