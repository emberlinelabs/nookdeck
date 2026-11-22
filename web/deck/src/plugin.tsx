import { t } from './i18n'
import { Icon, TileIcon } from './icon'
import { SlotSpark } from './charts'
import { Gauge, DeltaPill } from './knowns'
import type { Band } from './knowns'
import type { IconAssets } from './types'
import { friendlyError } from './plugin-logic'
import type { PluginSlot, PluginState } from './plugin-logic'

/** Plugin tiles: seven renderers fed by validated data (plugin-logic.ts). Reuses the value tile look and the shared charts. */

export const STATE_COLOR: { [k in PluginState]: string } = { ok: '#34d399', warn: '#f59e0b', error: '#f87171', off: '#8b8b94' }
const band = (v: number): Band => (v >= 85 ? 'risk' : v >= 65 ? 'watch' : 'good')
const fmtNum = (v: number) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : String(Math.round(v * 100) / 100))

export interface PluginTileProps {
  entry: PluginSlot | undefined
  tw: number
  th: number
  showLabel: boolean
  color?: string
  textColor?: string
  assets?: IconAssets
  /** the tile's own label, used when the data carries none */
  label?: string
}

export function PluginTile(props: PluginTileProps) {
  const e = props.entry
  const tw = props.tw
  const th = props.th
  const pad = tw >= 170 ? 14 : 10
  const col = props.textColor || undefined
  if (!e || 'error' in e) {
    const msg = e && 'error' in e ? e.error : ''
    const fr = friendlyError(msg)
    return (
      <div class="pd-vl pd-pl pd-pl--err" style={{ padding: pad + 'px' }}>
        <Icon name="plug-off" size={Math.max(16, Math.min(28, Math.floor(th * 0.3)))} />
        <span class="pd-pl__e">{fr ? t(fr) : t('Plugin unavailable')}</span>
        {msg && !fr && th >= 80 ? <span class="pd-pl__m">{msg}</span> : null}
      </div>
    )
  }
  if (e.render === 'stat') {
    const d = e.data
    const text = typeof d.value === 'number' ? fmtNum(d.value) : d.value
    const unit = d.unit || ''
    const vs = Math.max(16, Math.min(Math.floor(th * (d.delta !== undefined ? 0.34 : 0.42)), Math.floor((tw - pad * 2) / (Math.max(2, (text + unit).length) * 0.56)), 56))
    return (
      <div class="pd-vl pd-pl" style={{ padding: pad + 'px' }}>
        {props.showLabel && (d.label || props.label) ? <span class="pd-vl__lb" style={{ color: d.color || props.color || undefined }}>{d.label || props.label}</span> : null}
        <span class="pd-vl__v" style={{ fontSize: vs + 'px', color: d.color || col }}>
          {text}
          {unit ? <i style={{ fontSize: Math.max(10, Math.round(vs * 0.42)) + 'px' }}>{unit}</i> : null}
        </span>
        {d.delta !== undefined && th >= 80 ? <span class="pd-pl__d"><DeltaPill value={d.delta} unit="%" decimals={1} tone={d.delta < 0 ? 'bad' : undefined} /></span> : null}
      </div>
    )
  }
  if (e.render === 'gauge') {
    const d = e.data
    const size = Math.max(60, Math.min(tw - pad * 2, Math.floor((th - pad * 2 - (props.showLabel && d.label ? 16 : 0)) / 0.7), 150))
    return (
      <div class="pd-vl pd-pl pd-pl--c" style={{ padding: pad + 'px' }}>
        <div class="pd-pl__g" style={{ width: size + 'px' }}>
          <Gauge value={d.value} size={size} band={band(d.value)} color={d.color} />
          <span class="pd-pl__gv" style={{ fontSize: Math.round(size * 0.24) + 'px', color: d.color || col }}>{Math.round(d.value)}<i>%</i></span>
        </div>
        {props.showLabel && (d.label || props.label) ? <span class="pd-vl__lb">{d.label || props.label}</span> : null}
      </div>
    )
  }
  if (e.render === 'text') {
    const d = e.data
    return (
      <div class="pd-vl pd-pl" style={{ padding: pad + 'px', justifyContent: 'flex-start' }}>
        {d.title ? <span class="pd-vl__lb" style={{ color: props.color || undefined }}>{d.title}</span> : null}
        <span class="pd-pl__b" style={{ color: col, fontSize: th >= 110 ? '15px' : '13px', WebkitLineClamp: Math.max(1, Math.floor((th - pad * 2 - (d.title ? 18 : 0)) / (th >= 110 ? 20 : 17))) } as any}>{d.body}</span>
      </div>
    )
  }
  if (e.render === 'list') {
    const rows = e.data.items
    const rh = tw >= 170 ? 40 : 34
    const n = Math.max(1, Math.floor((th - pad * 2 + 4) / rh))
    return (
      <div class="pd-vl pd-pl" style={{ padding: pad + 'px', justifyContent: 'flex-start' }}>
        {rows.length === 0 ? <span class="pd-pl__e">{t('Nothing to show')}</span> : null}
        {rows.slice(0, n).map((r, i) => (
          <div class="pd-pl__r" key={i} style={{ height: rh - 4 + 'px' }}>
            {r.icon ? <span class="pd-pl__i"><TileIcon value={r.icon} size={18} assets={props.assets} /></span> : null}
            <span class="pd-pl__rb">
              <span class="pd-pl__rt" style={{ color: col }}>{r.title}</span>
              {r.subtitle && rh >= 40 ? <span class="pd-pl__rs">{r.subtitle}</span> : null}
            </span>
            {r.value ? <span class="pd-pl__rv" style={{ color: col }}>{r.value}</span> : null}
          </div>
        ))}
        {rows.length > n ? <span class="pd-pl__more">+{rows.length - n}</span> : null}
      </div>
    )
  }
  if (e.render === 'chart') {
    const d = e.data
    const pts = d.points
    const last = pts.length ? pts[pts.length - 1] : null
    const c = props.color || '#22d3ee'
    const hh = Math.max(24, th - pad * 2 - 22 - (props.showLabel && d.label ? 14 : 0))
    return (
      <div class="pd-vl pd-pl" style={{ padding: pad + 'px' }}>
        {props.showLabel && (d.label || props.label) ? <span class="pd-vl__lb" style={{ color: props.color || undefined }}>{d.label || props.label}</span> : null}
        {last !== null ? <span class="pd-pl__cv" style={{ color: col }}>{fmtNum(last)}{d.unit ? <i>{d.unit}</i> : null}</span> : <span class="pd-pl__e">{t('No data yet')}</span>}
        {pts.length >= 2 ? <SlotSpark values={pts} color={c} height={hh} slots={MAX} fill={0.14} /> : null}
      </div>
    )
  }
  if (e.render === 'image') {
    const d = e.data
    return (
      <div class="pd-pl pd-pl--img" style={{ backgroundImage: 'url("' + d.url.replace(/"/g, '%22') + '")', backgroundSize: d.fit === 'contain' ? 'contain' : 'cover' }} role="img" />
    )
  }
  const d = e.data
  const c = STATE_COLOR[d.state]
  return (
    <div class="pd-vl pd-pl pd-pl--c" style={{ padding: pad + 'px' }}>
      <i class="pd-pl__dot" style={{ background: c, boxShadow: '0 0 0 6px ' + c + '33' }} />
      <span class="pd-pl__sl" style={{ color: col }}>{d.label}</span>
      <span class="pd-vl__lb" style={{ color: c }}>{d.state === 'ok' ? t('OK') : d.state === 'warn' ? t('Warning') : d.state === 'error' ? t('Error') : t('Off')}</span>
    </div>
  )
}
const MAX = 120
