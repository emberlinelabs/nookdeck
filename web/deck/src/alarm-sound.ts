/**
 * Alarm sounds synthesized with WebAudio, no audio files. No imports: the manage UI copies or imports this file for its
 * "Nghe thử" button. Safari 12 safe (webkitAudioContext, no optional chaining).
 *
 *   unlockAudio()            call from a touchend/click handler; iOS only lets audio start after one gesture
 *   audioState()             'ready' | 'locked' | 'unsupported'
 *   playAlarm(kind, rise)    start a looping sound, volume rising over `rise` seconds (0 = full at once); returns stop()
 *   previewSound(kind)       a short audible sample (about 4 s) at moderate volume; returns stop()
 */

export type AlarmSoundKind = 'chime' | 'birds' | 'soft' | 'none'

let ctx: any = null

const Ctor = (): any => (typeof window === 'undefined' ? null : (window as any).AudioContext || (window as any).webkitAudioContext || null)

function getCtx(): any {
  if (ctx) return ctx
  const C = Ctor()
  if (!C) return null
  try {
    ctx = new C()
  } catch (e) {
    ctx = null
  }
  return ctx
}

/** Create / resume the AudioContext and play one silent sample (the iOS unlock). Safe to call on every touch. */
export function unlockAudio(): void {
  const c = getCtx()
  if (!c) return
  try {
    if (c.state === 'suspended' && c.resume) c.resume()
    const b = c.createBuffer(1, 1, 22050)
    const s = c.createBufferSource()
    s.buffer = b
    s.connect(c.destination)
    if (s.start) s.start(0)
    else s.noteOn(0)
  } catch (e) {
    /* ignore */
  }
}

export function audioState(): 'ready' | 'locked' | 'unsupported' {
  if (!Ctor()) return 'unsupported'
  if (ctx && ctx.state === 'running') return 'ready'
  return 'locked'
}

function tone(c: any, out: any, type: string, freq: number, t0: number, dur: number, peak: number, attack: number) {
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t0)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.linearRampToValueAtTime(peak, t0 + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  o.connect(g)
  g.connect(out)
  o.start(t0)
  o.stop(t0 + dur + 0.05)
}

/** Schedule one pattern of `kind` starting at t0; returns its length in seconds. */
function pattern(c: any, out: any, kind: AlarmSoundKind, t0: number): number {
  if (kind === 'chime') {
    // a bell arpeggio (C major pentatonic), each note a sine plus a quiet octave partial
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25]
    for (let i = 0; i < notes.length; i++) {
      tone(c, out, 'sine', notes[i], t0 + i * 0.45, 1.6, 0.35, 0.02)
      tone(c, out, 'sine', notes[i] * 2, t0 + i * 0.45, 0.8, 0.08, 0.01)
    }
    return 4.2
  }
  if (kind === 'birds') {
    // chirps: short sine sweeps up and down, in little groups
    const chirp = (at: number, f: number, up: boolean) => {
      const o = c.createOscillator()
      const g = c.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(f, at)
      o.frequency.exponentialRampToValueAtTime(up ? f * 1.5 : f * 0.7, at + 0.09)
      g.gain.setValueAtTime(0.0001, at)
      g.gain.linearRampToValueAtTime(0.28, at + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.11)
      o.connect(g)
      g.connect(out)
      o.start(at)
      o.stop(at + 0.15)
    }
    const groups = [2400, 3100, 2700]
    for (let k = 0; k < groups.length; k++) {
      const base = t0 + k * 1.3
      for (let j = 0; j < 4; j++) chirp(base + j * 0.14, groups[k] + j * 90, j % 2 === 0)
    }
    return 4
  }
  // soft: a slow warm pad chord (A minor 7 -> F major 7), triangle waves with long attack and release
  const chords = [
    [220, 261.63, 329.63, 392],
    [174.61, 220, 261.63, 329.63],
  ]
  for (let i = 0; i < chords.length; i++) {
    for (let j = 0; j < chords[i].length; j++) tone(c, out, 'triangle', chords[i][j], t0 + i * 2.6, 3.4, 0.16, 1.2)
  }
  return 5.2
}

function start(kind: AlarmSoundKind, rise: number, level: number, loop: boolean): () => void {
  const c = getCtx()
  if (!c || kind === 'none') return function () {}
  try {
    if (c.state === 'suspended' && c.resume) c.resume()
  } catch (e) {
    /* ignore */
  }
  const master = c.createGain()
  master.connect(c.destination)
  const now = c.currentTime
  if (rise > 0) {
    master.gain.setValueAtTime(0.02 * level, now)
    master.gain.linearRampToValueAtTime(level, now + rise)
  } else {
    master.gain.setValueAtTime(level, now)
  }
  let stopped = false
  let timer = 0
  let next = now + 0.05
  const fill = () => {
    if (stopped) return
    // keep about 6 s scheduled ahead
    while (next < c.currentTime + 6) {
      next += pattern(c, master, kind, next) + (loop ? 0.8 : 100)
      if (!loop) break
    }
  }
  fill()
  if (loop) timer = window.setInterval(fill, 1500)
  return function () {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    try {
      const t = c.currentTime
      master.gain.cancelScheduledValues(t)
      master.gain.setValueAtTime(master.gain.value, t)
      master.gain.linearRampToValueAtTime(0.0001, t + 0.25)
      setTimeout(() => {
        try {
          master.disconnect()
        } catch (e) {
          /* ignore */
        }
      }, 400)
    } catch (e) {
      /* ignore */
    }
  }
}

export function playAlarm(kind: AlarmSoundKind, riseSeconds: number): () => void {
  return start(kind, riseSeconds, 0.9, true)
}

export function previewSound(kind: AlarmSoundKind): () => void {
  const stop = start(kind, 0, 0.5, false)
  const t = window.setTimeout(stop, 5200)
  return function () {
    clearTimeout(t)
    stop()
  }
}
