import { useRef } from 'preact/hooks'
import { tint } from './theme'

/**
 * Preact + Safari 12 port of the Knowns UI chart geometry (registry/knowns/ui/knowns/chart):
 *  - monotone(), linePath(), areaPath()  <- chart-utils.ts (monotone cubic: smooth, never overshoots a peak)
 *  - SlotSpark                           <- sparkline.tsx + the `slots`, `fadeArea` and `endDot` options of chart.tsx
 *                                           (fixed number of x slots, points fill from the left, the line extends right;
 *                                           fadeArea = vertical gradient from ~14% of the line colour to nothing)
 *  - ringProgress(), Rings               <- chart-radial.tsx (RingsChart: rounded ends, faint 20% track, rings at most
 *                                           14px wide, arcs lap past 100% up to three laps)
 * Differences: no motion tween (rAF path morphing), no tooltip/legend; colours are rgba computed in JS because
 * Safari 12 has no color-mix(); the lap "soft shadow" (CSS drop-shadow on SVG) is a dark under-arc instead.
 */

const f = (n: number) => Number(n.toFixed(2))

export interface Point {
  x: number
  y: number | null
}

/** Monotone cubic through the points: smooth, and never overshoots a peak. (chart-utils.ts: monotone) */
function monotone(p: { x: number; y: number }[]): string {
  const n = p.length
  const px = (i: number) => (p[i] ? p[i].x : 0)
  const py = (i: number) => (p[i] ? p[i].y : 0)
  const dx: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const w = px(i + 1) - px(i)
    dx.push(w)
    m.push((py(i + 1) - py(i)) / (w || 1))
  }
  const slope = (i: number) => m[i] || 0
  const t = [slope(0)]
  for (let i = 1; i < n - 1; i++) t.push(slope(i - 1) * slope(i) <= 0 ? 0 : (slope(i - 1) + slope(i)) / 2)
  t.push(slope(n - 2))
  const tan = (i: number) => t[i] || 0
  for (let i = 0; i < n - 1; i++) {
    const mi = slope(i)
    if (mi === 0) {
      t[i] = 0
      t[i + 1] = 0
    } else {
      const a = tan(i) / mi
      const b = tan(i + 1) / mi
      const s = a * a + b * b
      if (s > 9) {
        const k = 3 / Math.sqrt(s)
        t[i] = k * a * mi
        t[i + 1] = k * b * mi
      }
    }
  }
  let d = 'M' + f(px(0)) + ',' + f(py(0))
  for (let i = 0; i < n - 1; i++) {
    const h = (dx[i] || 0) / 3
    d += 'C' + f(px(i) + h) + ',' + f(py(i) + tan(i) * h) + ',' + f(px(i + 1) - h) + ',' + f(py(i + 1) - tan(i + 1) * h) + ',' + f(px(i + 1)) + ',' + f(py(i + 1))
  }
  return d
}

/** (chart-utils.ts: linePath) */
export function linePath(points: Point[], smooth = false): string {
  const run = points.filter((p) => p.y !== null) as { x: number; y: number }[]
  if (run.length === 0) return ''
  if (run.length === 1) return 'M' + f(run[0].x) + ',' + f(run[0].y) + 'h0'
  return smooth ? monotone(run) : 'M' + run.map((p) => f(p.x) + ',' + f(p.y)).join('L')
}

/** The area under a line down to `base`. (chart-utils.ts: areaPath) */
export function areaPath(points: Point[], base: number, smooth = false): string {
  const run = points.filter((p) => p.y !== null) as { x: number; y: number }[]
  if (run.length < 2) return ''
  const first = run[0]
  const last = run[run.length - 1]
  const edge = smooth ? monotone(run) : 'M' + run.map((p) => f(p.x) + ',' + f(p.y)).join('L')
  return edge + 'L' + f(last.x) + ',' + f(base) + 'L' + f(first.x) + ',' + f(base) + 'Z'
}

let uid = 0

/**
 * Sparkline for stat tiles: fluid width, `slots` fixed x slots (points fill from the left, the line extends to the
 * right as samples arrive), smooth monotone curve, fadeArea gradient and an end dot. The dot is an HTML element so the
 * non-uniform SVG stretch does not squash it.
 */
export function SlotSpark(props: { values: number[]; color: string; height: number; slots?: number; minRange?: number; domain?: [number, number]; fill?: number; extra?: { values: number[]; color: string } }) {
  const idRef = useRef(0)
  if (!idRef.current) idRef.current = ++uid
  const slots = props.slots || 60
  const vals = props.values.slice(-slots)
  const H = 30
  const W = 600
  const padY = 3
  const padX = 1
  if (vals.length < 2) return <div class="pd-spark" data-part="chart" style={{ height: props.height + 'px' }} />
  let lo = props.domain ? props.domain[0] : Math.min.apply(null, vals)
  let hi = props.domain ? props.domain[1] : Math.max.apply(null, vals)
  const minR = props.minRange || 0
  if (!props.domain && hi - lo < minR) {
    const mid = (hi + lo) / 2
    lo = mid - minR / 2
    hi = mid + minR / 2
  }
  if (lo === hi) {
    lo -= 1
    hi += 1
  }
  const span = Math.max(1, slots - 1)
  const pts: Point[] = vals.map((v, i) => ({
    x: padX + (i / span) * (W - padX * 2),
    y: H - padY - ((v - lo) / (hi - lo)) * (H - padY * 2),
  }))
  const last = pts[pts.length - 1]
  const gid = 'pd-sg' + idRef.current
  // a second thin line on the same scale and slots (network tx); no area, no dot
  const ex = props.extra ? props.extra.values.slice(-slots) : []
  const exPts: Point[] = ex.map((v, i) => ({ x: padX + (i / span) * (W - padX * 2), y: H - padY - ((v - lo) / (hi - lo)) * (H - padY * 2) }))
  return (
    <div class="pd-spark" data-part="chart" style={{ height: props.height + 'px' }} aria-hidden="true">
      <svg viewBox={'0 0 ' + W + ' ' + H} width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color={props.color} stop-opacity={props.fill || 0.14} />
            <stop offset="1" stop-color={props.color} stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath(pts, H, true)} fill={'url(#' + gid + ')'} />
        {exPts.length > 1 && props.extra ? <path d={linePath(exPts, true)} fill="none" stroke={props.extra.color} stroke-width="1" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" /> : null}
        <path d={linePath(pts, true)} fill="none" stroke={props.color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      </svg>
      <span class="pd-spark__dot" style={{ left: (last.x / W) * 100 + '%', top: ((last.y as number) / H) * 100 + '%', background: props.color }} />
    </div>
  )
}

const LAPS = 3

/** How far a ring is drawn: `base` is the first lap (0..1), `lap` the arc that keeps going past the start. (chart-radial.tsx) */
export function ringProgress(value: number, goal: number): { p: number; base: number; lap: number } {
  const p = goal > 0 ? Math.min(LAPS, Math.max(0, value / goal)) : 0
  return { p, base: Math.min(1, p), lap: p > 1 ? ((p - 1) % 1) || 1 : 0 }
}

export interface RingSpec {
  value: number
  goal: number
  color: string
}

/** Concentric progress rings, the first outermost (chart-radial.tsx: RingsChart; thickness 0.62, at most 14px, gap 3). */
export function Rings(props: { size: number; rings: RingSpec[]; gap?: number; center?: string; centerSize?: number }) {
  const n = Math.max(1, props.rings.length)
  const gap = props.gap === undefined ? 3 : props.gap
  const R = props.size / 2
  const stroke = Math.max(3, Math.min(14, Math.floor((R * 0.62 - gap * (n - 1)) / n), Math.floor(R * 0.28)))
  const cx = R
  return (
    <div class="pd-ring" data-part="gauge" style={{ width: props.size + 'px', height: props.size + 'px' }}>
      <svg width={props.size} height={props.size} viewBox={'0 0 ' + props.size + ' ' + props.size} aria-hidden="true">
        {props.rings.map((r, k) => {
          const rad = R - stroke / 2 - 1 - k * (stroke + gap)
          if (rad <= 0) return null
          const len = 2 * Math.PI * rad
          const { base, lap } = ringProgress(r.value, r.goal)
          const dash = (x: number) => f(len * x) + ' ' + f(len)
          const rot = 'rotate(-90 ' + cx + ' ' + cx + ')'
          return (
            <g key={k}>
              <circle cx={cx} cy={cx} r={rad} fill="none" stroke={r.color} stroke-opacity="0.2" stroke-width={stroke} />
              {base > 0 ? <circle cx={cx} cy={cx} r={rad} fill="none" stroke={r.color} stroke-width={stroke} stroke-linecap="round" stroke-dasharray={base >= 1 ? undefined : dash(base)} transform={rot} /> : null}
              {lap > 0 ? <circle cx={cx} cy={cx} r={rad} fill="none" stroke={tint('#000000', 0.45) || '#000'} stroke-width={stroke + 2} stroke-linecap="round" stroke-dasharray={dash(lap)} transform={rot} /> : null}
              {lap > 0 ? <circle cx={cx} cy={cx} r={rad} fill="none" stroke={r.color} stroke-width={stroke} stroke-linecap="round" stroke-dasharray={dash(lap)} transform={rot} /> : null}
            </g>
          )
        })}
      </svg>
      {props.center ? (
        <span class="pd-ring__t" data-part="num" style={{ fontSize: (props.centerSize || Math.max(10, Math.round(props.size * 0.24))) + 'px' }}>
          {props.center}
        </span>
      ) : null}
    </div>
  )
}
