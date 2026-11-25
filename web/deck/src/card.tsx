import { Component, createRef } from 'preact'
import { TileIcon } from './icon'
import type { IconAssets } from './types'
import { CARD_MIN_PX, CARD_SHRINK, cardBase } from './plugin-logic'
import type { CardArgs, CardData, CardNode, CardTone } from '../../../src/plugins/card'

/**
 * The `card` renderer (spec release 0.5, D2): the deck draws only these parts, with theme tokens. The data was checked by
 * validateCard (plugin-logic.ts) before it gets here. Sizes are in em from one base size per tile; when the parts do not fit,
 * the base steps down (never below CARD_MIN_PX), then the last parts of the overflowing column are left out, so a small tile
 * shows the top of the card rather than half-cut parts. Safari 12: no flex gap (margins), no ResizeObserver, no color-mix().
 */

export interface CardTileProps {
  data: CardData
  tw: number
  th: number
  /** the tile's own colour: the "accent" tone */
  color?: string
  textColor?: string
  assets?: IconAssets
  /** a button was tapped; resolves when the agent answered. Missing in previews: buttons do nothing. */
  onAction?: (action: string, args: CardArgs | undefined) => Promise<unknown>
}

const GAPS = ['0', '4px', '8px', '12px']

export class CardTile extends Component<CardTileProps, { busy: { [path: string]: boolean } }> {
  state = { busy: {} as { [path: string]: boolean } }
  private el = createRef<HTMLDivElement>()
  private alive = true
  private fontsAsked = false

  componentDidMount() {
    this.fit()
  }
  componentDidUpdate(prev: CardTileProps) {
    if (prev.data !== this.props.data || prev.tw !== this.props.tw || prev.th !== this.props.th) this.fit()
  }
  componentWillUnmount() {
    this.alive = false
  }

  /** Steps the base size down until no row or column of the card overflows; then drops trailing parts that still do not fit. */
  private fit() {
    const el = this.el.current
    if (!el) return
    const base = cardBase(this.props.tw, this.props.th)
    show(el)
    for (let s = 0; s < CARD_SHRINK.length; s++) {
      el.style.fontSize = Math.max(CARD_MIN_PX, Math.round(base * CARD_SHRINK[s] * 10) / 10) + 'px'
      if (!overflows(el)) break
    }
    trim(el)
    const fonts = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts
    if (!this.fontsAsked && fonts && fonts.ready) {
      this.fontsAsked = true
      fonts.ready.then(() => { if (this.alive) this.fit() }, () => {})
    }
  }

  private tap(path: string, action: string, args: CardArgs | undefined) {
    if (!this.props.onAction || this.state.busy[path]) return
    this.setState({ busy: assign(this.state.busy, path, true) })
    const since = Date.now()
    const done = () => window.setTimeout(() => { if (this.alive) this.setState({ busy: assign(this.state.busy, path, false) }) }, Math.max(0, 180 - (Date.now() - since)))
    this.props.onAction(action, args).then(done, done)
  }

  private tone(t: CardTone | undefined, fallback?: string): string | undefined {
    if (t === 'muted') return 'var(--pd-muted)'
    if (t === 'accent') return this.props.color || 'var(--pd-accent)'
    if (t === 'ok') return 'var(--pd-live)'
    if (t === 'warn') return 'var(--pd-warn)'
    if (t === 'bad') return 'var(--pd-bad)'
    return fallback
  }

  private node(n: CardNode, path: string): preact.JSX.Element | null {
    const text = this.props.textColor || undefined
    if (n.t === 'row' || n.t === 'col') {
      return (
        <div
          key={path}
          class={'pd-card__box pd-card__' + n.t + ' pd-card__al-' + (n.align || 'start') + (n.grow ? ' pd-card__grow' : '')}
          data-gap={GAPS[n.gap === undefined ? 1 : n.gap]}
        >
          {n.children.map((c, i) => this.node(c, path + '.' + i))}
        </div>
      )
    }
    if (n.t === 'text') {
      return <span key={path} class={'pd-card__text pd-card__text--' + (n.size || 'm') + (n.bold ? ' pd-card__b' : '')} data-part={n.tone === 'muted' ? 'tile-sub' : undefined} style={{ color: this.tone(n.tone, text) }}>{n.text}</span>
    }
    if (n.t === 'number') {
      return (
        <span key={path} class={'pd-card__num pd-card__num--' + (n.size || 'l')}>
          <span class="pd-card__nv" data-part="tile-value" style={{ color: this.tone(n.tone, text) }}>
            {typeof n.value === 'number' ? fmt(n.value) : n.value}
            {n.unit ? <i>{n.unit}</i> : null}
          </span>
        </span>
      )
    }
    if (n.t === 'pill') {
      return (
        <span key={path} class="pd-card__pill" style={{ color: this.tone(n.tone, text) }}>{n.text}</span>
      )
    }
    if (n.t === 'progress') {
      return (
        <span key={path} class="pd-card__prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(n.value * 100)}>
          <i style={{ width: n.value * 100 + '%', background: this.tone(n.tone, this.props.color || 'var(--pd-accent)') }} />
        </span>
      )
    }
    if (n.t === 'sparkline') return <Spark key={path} points={n.points} color={this.tone(n.tone, this.props.color || 'var(--pd-accent)') as string} />
    if (n.t === 'icon') {
      return <span key={path} class="pd-card__icon" style={{ color: this.tone(n.tone, text) }}><TileIcon value={n.name} size={24} assets={this.props.assets} /></span>
    }
    if (n.t === 'image') {
      return <span key={path} class="pd-card__img" role="img" style={{ backgroundImage: 'url("' + n.src + '")', backgroundSize: n.fit === 'contain' ? 'contain' : 'cover' }} />
    }
    if (n.t === 'button') {
      const c = this.tone(n.tone, n.active ? this.props.color || 'var(--pd-accent)' : text)
      const busy = !!this.state.busy[path]
      return (
        <button
          key={path}
          type="button"
          class={'pd-card__btn' + (n.active ? ' pd-card__btn--active' : '') + (busy ? ' pd-card__btn--busy' : '') + (n.label ? '' : ' pd-card__btn--icon')}
          style={n.active ? { background: c || 'var(--pd-accent)', borderColor: c || 'var(--pd-accent)' } : { color: c }}
          aria-label={n.label || n.icon}
          aria-pressed={n.active === undefined ? undefined : n.active}
          onClick={(e: Event) => { e.stopPropagation(); this.tap(path, n.action, n.args) }}
        >
          {n.icon ? <span class="pd-card__bi"><TileIcon value={n.icon} size={16} assets={this.props.assets} /></span> : null}
          {n.label ? <span class="pd-card__bl">{n.label}</span> : null}
        </button>
      )
    }
    return <span key={path} class="pd-card__spacer" />
  }

  render() {
    const pad = this.props.th < 100 ? 6 : this.props.tw >= 170 ? 12 : 8
    return (
      <div ref={this.el} class="pd-card" style={{ padding: pad + 'px', fontSize: cardBase(this.props.tw, this.props.th) + 'px' }}>
        {this.node(this.props.data.root, 'r')}
      </div>
    )
  }
}

function assign(o: { [k: string]: boolean }, k: string, v: boolean): { [k: string]: boolean } {
  return Object.assign({}, o, { [k]: v })
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100))

/** Brings back the parts an earlier fit left out. */
function show(card: HTMLElement) {
  const hidden = card.querySelectorAll('.pd-card__cut')
  for (let i = 0; i < hidden.length; i++) (hidden[i] as HTMLElement).classList.remove('pd-card__cut')
}

/** Deepest columns first: hides a column's last parts while it is taller than its room (at least one part stays). */
function trim(card: HTMLElement) {
  const cols = card.querySelectorAll('.pd-card__col')
  for (let i = cols.length - 1; i >= 0; i--) {
    const col = cols[i] as HTMLElement
    for (let j = col.children.length - 1; j > 0 && col.scrollHeight > col.clientHeight + 1; j--) col.children[j].classList.add('pd-card__cut')
  }
}

function overflows(card: HTMLElement): boolean {
  const boxes = card.querySelectorAll('.pd-card__box')
  for (let i = -1; i < boxes.length; i++) {
    const b = (i < 0 ? card : boxes[i]) as HTMLElement
    if (b.scrollHeight > b.clientHeight + 1 || b.scrollWidth > b.clientWidth + 1) return true
  }
  return false
}

function Spark(props: { points: number[]; color: string }) {
  const p = props.points
  if (p.length < 2) return <span class="pd-card__spark" />
  let lo = Math.min.apply(null, p)
  let hi = Math.max.apply(null, p)
  if (hi === lo) { lo -= 1; hi += 1 }
  const pts = p.map((v, i) => ((i / (p.length - 1)) * 100).toFixed(2) + ',' + (27 - ((v - lo) / (hi - lo)) * 24).toFixed(2)).join(' ')
  return (
    <span class="pd-card__spark" aria-hidden="true">
      <svg width="100%" height="100%" viewBox="0 0 100 30" preserveAspectRatio="none">
        <polygon points={'0,30 ' + pts + ' 100,30'} style={{ fill: props.color, opacity: 0.14 }} />
        <polyline points={pts} fill="none" vector-effect="non-scaling-stroke" style={{ stroke: props.color, strokeWidth: 2 }} stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
  )
}
