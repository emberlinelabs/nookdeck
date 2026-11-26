/**
 * What a tile shows for On Air, mic and camera, from the `onair` contract message (web/shared/onair.ts). Pure: no DOM, no deck imports,
 * ES5-safe for Safari 12. Texts are English keys; the caller passes them through t().
 */
import type { OnAirMsg, OnAirSource } from '../../shared/onair'

/**
 * data-state of an On Air / Mic / Camera button:
 * - on: lit (a camera is in use)
 * - live: red with a timer (On Air is on)
 * - muted: red (the computer mic is muted)
 * - off: known and not active
 */
export type LiveState = 'on' | 'live' | 'muted' | 'off'

export interface LiveView {
  state: LiveState
  /** epoch ms (agent clock) the timer counts from */
  since?: number
  /** short English line under the label, passed through t() */
  sub?: string
}

const isLive = (a: unknown): a is { type: string; [k: string]: unknown } =>
  !!a && typeof a === 'object' && ['onair', 'mic', 'camera'].indexOf((a as { type: string }).type) >= 0

/** The live view of a button action from the `onair` message, or null when the action has no live state. */
export function liveView(action: unknown, onair: OnAirMsg | null | undefined): LiveView | null {
  if (!isLive(action)) return null
  if (action.type === 'onair') {
    if (!onair) return { state: 'off' }
    return onair.on ? { state: 'live', since: onair.since } : { state: 'off' }
  }
  if (action.type === 'mic') {
    if (!onair || onair.mic.muted === null) return { state: 'off', sub: onair ? 'No microphone' : undefined }
    return onair.mic.muted ? { state: 'muted', sub: 'Mic off' } : { state: 'off', sub: onair.mic.inUse ? 'Mic in use' : undefined }
  }
  if (!onair) return { state: 'off' }
  return onair.camera.inUse ? { state: 'on', sub: 'Camera in use' } : { state: 'off', sub: 'Camera off' }
}

/** Elapsed time as m:ss, or h:mm:ss from one hour. Negative (clock skew) shows 0:00. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const p2 = (n: number) => (n < 10 ? '0' : '') + n
  return h > 0 ? h + ':' + p2(m) + ':' + p2(ss) : m + ':' + p2(ss)
}

const SOURCE_TEXT: { [s: string]: string } = {
  'obs-stream': 'Live',
  'obs-record': 'Recording',
  mic: 'Mic',
  camera: 'Camera',
  manual: 'Manual',
  api: 'API',
}

export interface OnAirView {
  on: boolean
  /** English: 'ON AIR' or 'Off air' */
  title: string
  /** why it is on, in order (English keys, except the API label which is shown as is) */
  reasons: { text: string; raw?: boolean }[]
  /** on because of the mic, and the mic is muted */
  micOff: boolean
  since?: number
}

/** The On Air tile and the full-screen sign. */
export function onAirView(m: OnAirMsg | null | undefined): OnAirView {
  if (!m || !m.on) return { on: false, title: 'Off air', reasons: [], micOff: false }
  const micOff = m.sources.indexOf('mic') >= 0 && m.mic.muted === true
  const reasons: { text: string; raw?: boolean }[] = []
  m.sources.forEach((s: OnAirSource) => {
    if (s === 'api' && m.label) reasons.push({ text: m.label, raw: true })
    else if (s === 'mic' && micOff) reasons.push({ text: 'Mic off' })
    else reasons.push({ text: SOURCE_TEXT[s] || s })
  })
  return { on: true, title: 'ON AIR', reasons, micOff, since: m.since }
}

/** The full-screen sign shows while On Air is on, the option is on for this phone, and no tap asked for the deck in the last 30 s. */
export const PEEK_MS = 30000
export function signVisible(fullOn: boolean, m: OnAirMsg | null | undefined, peekUntil: number, now: number): boolean {
  return !!fullOn && !!m && m.on && !(peekUntil > now)
}

