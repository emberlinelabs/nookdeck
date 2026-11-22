import { PAL } from './theme'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'

/**
 * Preact + Safari 12 ports of Knowns UI components. Each piece names its source file.
 * Safari 12 notes: no Web Animations (CSS keyframes instead), no ResizeObserver (sizes come from props), no color-mix
 * (rgba computed in JS), no SVG pathLength (dash lengths computed).
 */

export const reducedMotion = (): boolean => {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch {
    return false
  }
}

/* ---------- AnimatedNumber: registry/knowns/ui/knowns/animated-number.tsx ---------- */

interface Slot {
  key: string
  digit: number | null
  char: string
}
/** The characters of a formatted number: digits roll, everything else stays put. (animated-number.tsx: numberSlots) */
function numberSlots(text: string): Slot[] {
  const chars = text.split('')
  return chars.map((char, i) => {
    const fromRight = chars.length - 1 - i
    const digit = /^[0-9]$/.test(char) ? Number(char) : null
    return { key: (digit === null ? 'c' : 'd') + fromRight, digit, char }
  })
}

/** One digit; a change rolls it up when the value rose and down when it fell. (animated-number.tsx: Digit; CSS keyframes instead of WAAPI) */
function Digit(props: { digit: number; dir: 1 | -1 }) {
  const last = useRef(props.digit)
  const [roll, setRoll] = useState<{ from: number; to: number; dir: 1 | -1; id: number } | null>(null)
  const id = useRef(0)
  useLayoutEffect(() => {
    if (last.current === props.digit) return
    const from = last.current
    last.current = props.digit
    setRoll(reducedMotion() ? null : { from, to: props.digit, dir: props.dir, id: ++id.current })
  }, [props.digit])
  const done = () => setRoll((r) => (r && roll && r.id === roll.id ? null : r))
  return (
    <span class="pd-dg">
      <span style={roll ? { visibility: 'hidden' } : undefined}>{props.digit}</span>
      {roll ? (
        <span class={'pd-dg__col pd-dg__col--' + (roll.dir === 1 ? 'up' : 'down')} aria-hidden="true" onAnimationEnd={done}>
          {(roll.dir === 1 ? [roll.from, roll.to] : [roll.to, roll.from]).map((d, i) => (
            <span class="pd-dg__c" key={i}>
              {d}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  )
}

export function AnimatedNumber(props: { value: number; format?: (n: number) => string; prefix?: string; suffix?: string; class?: string; style?: { [k: string]: string | number } }) {
  const text = props.format ? props.format(props.value) : String(Math.round(props.value))
  const slots = numberSlots(text)
  const lastValue = useRef(props.value)
  const dir = useRef<1 | -1>(1)
  if (props.value !== lastValue.current) {
    dir.current = props.value > lastValue.current ? 1 : -1
    lastValue.current = props.value
  }
  return (
    <span class={'pd-an ' + (props.class || '')} style={props.style} aria-label={(props.prefix || '') + text + (props.suffix || '')}>
      {props.prefix}
      {slots.map((s) => (s.digit === null ? <span key={s.key}>{s.char}</span> : <Digit key={s.key} digit={s.digit} dir={dir.current} />))}
      {props.suffix}
    </span>
  )
}

/* ---------- DeltaPill: blocks/analytics/live-metrics.tsx ---------- */

/** The pill that says which way a number moved (live-metrics.tsx: DeltaPill). Muted unless the caller marks the change as large: tone "warn" (amber) or "bad" (red). */
export function DeltaPill(props: { value: number; unit?: string; decimals?: number; tone?: 'warn' | 'bad'; size?: number }) {
  const dec = props.decimals || 0
  const flat = Math.round(Math.abs(props.value) * Math.pow(10, dec)) === 0
  const up = props.value >= 0
  const cls = flat || !props.tone ? 'flat' : props.tone === 'bad' ? 'bad' : 'warn'
  return (
    <span class={'pd-delta pd-delta--' + cls} style={props.size ? { fontSize: props.size + 'px' } : undefined}>
      {!flat ? (
        <svg aria-hidden="true" viewBox="0 0 12 12" width="10" height="10" style={up ? undefined : { transform: 'rotate(180deg)' }}>
          <path d="M6 9.5V2.5M3 5.5l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      ) : null}
      <AnimatedNumber value={props.value} format={(n) => (n > 0 ? '+' : n < 0 ? '-' : '') + Math.abs(n).toFixed(dec)} suffix={props.unit} />
    </span>
  )
}

/* ---------- Gauge: blocks/analytics/agent-health.tsx + agent-health-utils.ts (arcPath, gaugeDash) ---------- */

const GAUGE_START = 150
const GAUGE_SWEEP = 240
const rad = (d: number) => (d * Math.PI) / 180
const r2 = (n: number) => Math.round(n * 100) / 100

/** An SVG arc from `start` to `start + sweep` degrees (clockwise, 0 = right). (agent-health-utils.ts: arcPath) */
function arcPath(cx: number, cy: number, r: number, start = GAUGE_START, sweep = GAUGE_SWEEP): string {
  const a = rad(start)
  const b = rad(start + sweep)
  return 'M' + r2(cx + r * Math.cos(a)) + ' ' + r2(cy + r * Math.sin(a)) + 'A' + r2(r) + ' ' + r2(r) + ' 0 ' + (sweep > 180 ? 1 : 0) + ' 1 ' + r2(cx + r * Math.cos(b)) + ' ' + r2(cy + r * Math.sin(b))
}

export type Band = 'good' | 'watch' | 'risk'
export const BAND_COLOR: { [k: string]: string } = { get good() { return PAL.ok }, get watch() { return PAL.warn }, get risk() { return PAL.error } }

/** The 0-100 arc gauge (240 degree arc opening at the bottom, 6px round stroke, faint track). Centre text is drawn by the caller. */
export function Gauge(props: { value: number; size: number; band: Band; color?: string }) {
  const r = 52
  const len = (r * rad(GAUGE_SWEEP)) // arc length for the dash (SVG pathLength is not reliable on Safari 12)
  const v = Math.min(100, Math.max(0, props.value))
  const d = arcPath(70, 70, r)
  return (
    <svg class="pd-gauge" width={props.size} height={Math.round(props.size * 0.7)} viewBox="0 8 140 98" aria-hidden="true">
      <path d={d} fill="none" stroke="var(--pd-border-strong)" stroke-width="6" stroke-linecap="round" />
      {v >= 0.5 ? <path d={d} fill="none" stroke={props.color || BAND_COLOR[props.band]} stroke-width="6" stroke-linecap="round" stroke-dasharray={r2((len * v) / 100) + ' ' + r2(len + 4)} /> : null}
    </svg>
  )
}
