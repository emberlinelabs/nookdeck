/** On Air / mic / camera on the deck: the state badge on buttons, the On Air tile and the full-screen ON AIR sign. Safari 12 safe. */
import { useEffect, useState } from 'preact/hooks'
import { t } from './i18n'
import { NOSLEEP_MP4 } from './nosleep-video'
import { elapsed, onAirView, type LiveView } from './live-logic'
import type { OnAirMsg } from '../../shared/onair'

/** Re-renders every second while `on`. */
function useTick(on: boolean) {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!on) return
    const iv = window.setInterval(() => bump((x) => x + 1), 1000)
    return () => clearInterval(iv)
  }, [on])
}

/** The line a live button shows under its label: a running timer (red states) or a short status. */
export function LiveBadge(props: { view: LiveView; size: number; pill?: boolean }) {
  const v = props.view
  const timer = v.state === 'live' && typeof v.since === 'number'
  useTick(timer)
  const text = timer ? elapsed(Date.now() - (v.since as number)) : v.sub ? t(v.sub) : ''
  if (!text) return null
  return (
    <span class={'pd-live' + (timer ? ' pd-live--timer' : '') + (props.pill ? ' pd-live--pill' : '')} data-part="tile-live" style={{ fontSize: props.size + 'px' }}>
      {v.state === 'live' ? <i class="pd-live__dot" /> : null}
      {text}
    </span>
  )
}

/** Keeps the screen on while `on`: the Wake Lock where there is one, else the muted looping video (iOS 12). */
export function useKeepAwake(on: boolean) {
  useEffect(() => {
    if (!on) return
    const wl = (navigator as any).wakeLock
    let lock: any = null
    let dead = false
    let video: HTMLVideoElement | null = null
    const req = () => {
      if (!wl || document.visibilityState !== 'visible' || (lock && !lock.released)) return
      wl.request('screen').then(
        (l: any) => {
          if (dead) l.release()
          else lock = l
        },
        () => undefined
      )
    }
    const play = () => {
      if (!video) return
      try {
        const p: any = video.play()
        if (p && p.catch) p.catch(() => undefined)
      } catch (e) {
        /* ignore */
      }
    }
    if (wl) {
      req()
      document.addEventListener('visibilitychange', req)
    } else {
      video = document.createElement('video')
      video.setAttribute('muted', '')
      video.setAttribute('playsinline', '')
      video.setAttribute('webkit-playsinline', '')
      video.setAttribute('loop', '')
      video.muted = true
      video.loop = true
      video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1'
      video.src = NOSLEEP_MP4
      document.body.appendChild(video)
      play()
      document.addEventListener('visibilitychange', play)
      document.addEventListener('touchend', play, true)
    }
    return () => {
      dead = true
      document.removeEventListener('visibilitychange', req)
      document.removeEventListener('visibilitychange', play)
      document.removeEventListener('touchend', play, true)
      if (lock) lock.release().catch(() => undefined)
      if (video && video.parentNode) video.parentNode.removeChild(video)
    }
  }, [on])
}

/** The On Air tile (widget "onair"): 1x1 shows the word and the time, 2x1 adds why, 2x2 shows everything large. */
export function OnAirTile(props: { onair?: OnAirMsg | null; cw: number; ch: number; tw: number; th: number; scale: number; showLabel: boolean; label?: string }) {
  const v = onAirView(props.onair)
  useTick(v.on)
  const big = props.cw >= 2 && props.ch >= 2
  const wide = props.cw >= 2
  // 'ON AIR' plus its dot is about 4.6 em wide with the letter spacing: keep it inside the tile with some room on both sides
  const titleSize = Math.round(Math.max(11, Math.min(big ? 44 : 26, Math.min(props.tw * (wide ? 0.13 : 0.15), props.th * (big ? 0.2 : 0.26)))))
  const small = Math.max(10, Math.round(titleSize * 0.5))
  const time = v.on && typeof v.since === 'number' ? elapsed(Date.now() - v.since) : ''
  const why = v.reasons.map((r) => (r.raw ? r.text : t(r.text))).join(', ')
  return (
    <div class={'pd-onair' + (v.on ? ' pd-onair--on' : '') + (v.micOff ? ' pd-onair--micoff' : '')} data-part="onair">
      <div class="pd-onair__title" style={{ fontSize: titleSize + 'px' }}>
        {v.on ? <i class="pd-onair__dot" /> : null}
        {t(v.title)}
      </div>
      {time ? (
        <div class="pd-onair__time" style={{ fontSize: Math.round(titleSize * (big ? 0.7 : wide ? 0.62 : 1)) + 'px' }}>
          {time}
        </div>
      ) : null}
      {v.on && why && (wide || props.ch >= 2 || props.th >= 110) ? (
        <div class="pd-onair__why" style={{ fontSize: small + 'px' }}>
          {why}
        </div>
      ) : null}
      {!v.on && props.showLabel && props.label && props.th >= 90 ? (
        <div class="pd-onair__why" style={{ fontSize: small + 'px' }}>
          {props.label}
        </div>
      ) : null}
    </div>
  )
}

/** Full-screen ON AIR, readable across a room. A tap asks the deck for 30 s (onPeek). */
export function OnAirSign(props: { onair: OnAirMsg; onPeek: () => void }) {
  const v = onAirView(props.onair)
  useTick(true)
  useKeepAwake(true)
  const time = typeof v.since === 'number' ? elapsed(Date.now() - v.since) : ''
  const why = v.reasons.map((r) => (r.raw ? r.text : t(r.text))).join(', ')
  return (
    <div class={'pd-onair-sign' + (v.micOff ? ' pd-onair-sign--micoff' : '')} role="status" aria-live="polite" data-part="onair-sign" onClick={props.onPeek}>
      <div class="pd-onair-sign__title">{t('ON AIR')}</div>
      {time ? <div class="pd-onair-sign__time">{time}</div> : null}
      {why ? <div class="pd-onair-sign__why">{why}</div> : null}
      <div class="pd-onair-sign__hint">{t('Tap to show the deck')}</div>
    </div>
  )
}
