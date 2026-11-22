import { PAL } from './theme'
const f = (n: number) => Math.round(n * 100) / 100

/**
 * Extra metric charts in the Knowns UI chart style (chart.tsx bars with rounded tops, chart-radial.tsx rounded ends / donut look,
 * usage-meter.tsx limit tick). Window downsampling for the client side history (one sample every ~2 s, up to 450).
 */

export const SAMPLE_SEC = 2

/** The last `windowSec` seconds of a history, averaged down to at most `slots` points. */
export function windowSeries(a: number[], windowSec: number, slots: number): number[] {
  const n = Math.max(2, Math.min(a.length, Math.round(windowSec / SAMPLE_SEC)))
  const w = a.slice(-n)
  if (w.length <= slots) return w
  const out: number[] = []
  for (let i = 0; i < slots; i++) {
    const from = Math.floor((i * w.length) / slots)
    const to = Math.max(from + 1, Math.floor(((i + 1) * w.length) / slots))
    let sum = 0
    for (let j = from; j < to; j++) sum += w[j]
    out.push(sum / (to - from))
  }
  return out
}

/** Column history: rounded tops, a small gap, newest on the right. Missing slots stay empty on the left so bars keep their width. */
export function BarSpark(props: { values: number[]; color: string; height: number; slots: number; domain: [number, number]; inset?: number }) {
  const lo = props.domain[0]
  const hi = props.domain[1] > lo ? props.domain[1] : lo + 1
  const vals = props.values.slice(-props.slots)
  const empty = props.slots - vals.length
  const cols = []
  for (let i = 0; i < props.slots; i++) {
    const v = i < empty ? null : vals[i - empty]
    const last = i === props.slots - 1
    const h = v === null ? 0 : Math.max(4, Math.min(100, ((v - lo) / (hi - lo)) * 100))
    cols.push(
      <div class="pd-bars__c" key={i}>
        {v === null ? null : <i style={{ height: h + '%', background: props.color, opacity: last ? 1 : 0.55 }} />}
      </div>
    )
  }
  const ins = props.inset || 0
  return (
    <div class="pd-bars" style={{ height: props.height + 'px', padding: '0 ' + ins + 'px' }} aria-hidden="true">
      {cols}
    </div>
  )
}

/** Donut: used share with rounded ends and a small gap to the free share (faint). */
export function Donut(props: { size: number; used: number; color: string; center?: string; centerSize?: number }) {
  const R = props.size / 2
  const stroke = Math.max(5, Math.min(18, Math.round(props.size * 0.15)))
  const rad = R - stroke / 2 - 1
  const len = 2 * Math.PI * rad
  const p = Math.min(1, Math.max(0, props.used / 100))
  const gap = 3
  const arcs: any[] = []
  const rot = (frac: number) => 'rotate(' + f(-90 + frac * 360) + ' ' + R + ' ' + R + ')'
  const seg = (k: string, from: number, span: number, color: string, op: number) => {
    const dash = len * span - gap - stroke
    if (dash < 0.5) return
    const off = (gap + stroke) / 2 / len
    arcs.push(<circle key={k} cx={R} cy={R} r={rad} fill="none" stroke={color} stroke-opacity={op} stroke-width={stroke} stroke-linecap="round" stroke-dasharray={f(dash) + ' ' + f(len)} transform={rot(from + off)} />)
  }
  if (p <= 0.005) arcs.push(<circle key="f" cx={R} cy={R} r={rad} fill="none" stroke={props.color} stroke-opacity="0.22" stroke-width={stroke} />)
  else if (p >= 0.995) arcs.push(<circle key="u" cx={R} cy={R} r={rad} fill="none" stroke={props.color} stroke-width={stroke} />)
  else {
    seg('f', p, 1 - p, props.color, 0.22)
    seg('u', 0, p, props.color, 1)
  }
  return (
    <div class="pd-ring" data-part="gauge" style={{ width: props.size + 'px', height: props.size + 'px' }}>
      <svg width={props.size} height={props.size} viewBox={'0 0 ' + props.size + ' ' + props.size} aria-hidden="true">
        {arcs}
      </svg>
      {props.center ? (
        <span class="pd-ring__t" style={{ fontSize: (props.centerSize || Math.max(10, Math.round(props.size * 0.22))) + 'px' }}>
          {props.center}
        </span>
      ) : null}
    </div>
  )
}

/** One horizontal meter with a limit tick (usage-meter.tsx look: round track, fill, hairline at the limit). */
export function MeterBar(props: { value: number; limit: number; color: string; thick: number }) {
  const v = Math.min(100, Math.max(0, props.value))
  const over = v >= props.limit
  return (
    <div class="pd-mt" data-part="gauge" style={{ height: props.thick + 'px', borderRadius: props.thick + 'px' }} aria-hidden="true">
      <div class="pd-mt__fill" style={{ width: v + '%', background: over ? PAL.error : props.color, borderRadius: props.thick + 'px' }} />
      <i class="pd-mt__tick" style={{ left: props.limit + '%', top: '-2px', bottom: '-2px' }} />
    </div>
  )
}
