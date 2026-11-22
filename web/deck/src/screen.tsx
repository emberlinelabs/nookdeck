/** Standby clock, dim overlay, keep awake and the friendly alarm. One component with its own timer so the deck does not re-render each second. */
import { useEffect, useRef, useState } from 'preact/hooks'
import { t, getLang } from './i18n'
import { Icon } from './icon'
import { timeWords, timeWordsEn } from './clock-words'
import { NOSLEEP_MP4 } from './nosleep-video'
import { audioState, playAlarm, previewSound, unlockAudio } from './alarm-sound'
import { active, alarmsOn, headerMode, deviceId, dimLevel, inDimWindow, keepAwakeOn, liteOn, localScreen, markFired, myAlarms, onLocalScreen, pad2, RING_MS, saveLocalScreen, standbyCfg, sunriseColor, upcoming, type Due } from './screen-logic'
import type { Alarm, ScreenSettings } from './types'

const DIM_LIFT_MS = 30000

/** the alarm the preview shows for np=alarm / np=sunrise */
const PV_ALARM: Alarm = { id: 'pv', time: '07:00', enabled: true, sound: 'chime', sunriseMin: 20, snoozeMin: 9, label: 'Wake up' }

const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS_VI = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy']

function dateText(d: Date): string {
  if (getLang() === 'vi') return DAYS_VI[d.getDay()] + ', ' + d.getDate() + '/' + (d.getMonth() + 1)
  return DAYS_EN[d.getDay()] + ', ' + MONTHS_EN[d.getMonth()] + ' ' + d.getDate()
}

function AnalogFace(props: { d: Date }) {
  const h = props.d.getHours() % 12
  const m = props.d.getMinutes()
  const ha = (h + m / 60) * 30
  const ma = m * 6
  const ticks = []
  for (let i = 0; i < 12; i++) {
    const a = (i * 30 * Math.PI) / 180
    const big = i % 3 === 0
    ticks.push(<line key={i} x1={50 + Math.sin(a) * (big ? 40 : 43)} y1={50 - Math.cos(a) * (big ? 40 : 43)} x2={50 + Math.sin(a) * 46} y2={50 - Math.cos(a) * 46} stroke="#8a8f98" stroke-width={big ? 2 : 1} stroke-linecap="round" />)
  }
  return (
    <svg class="pd-sb__analog" viewBox="0 0 100 100" aria-hidden="true">
      {ticks}
      <line x1="50" y1="50" x2={50 + Math.sin((ha * Math.PI) / 180) * 24} y2={50 - Math.cos((ha * Math.PI) / 180) * 24} stroke="#c7cbd1" stroke-width="3.2" stroke-linecap="round" />
      <line x1="50" y1="50" x2={50 + Math.sin((ma * Math.PI) / 180) * 36} y2={50 - Math.cos((ma * Math.PI) / 180) * 36} stroke="#c7cbd1" stroke-width="2.2" stroke-linecap="round" />
      <circle cx="50" cy="50" r="2.4" fill="#c7cbd1" />
    </svg>
  )
}

function nextText(due: Due | undefined, now: number): string {
  if (!due) return ''
  const d = new Date(due.at)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return t('Alarm') + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + (sameDay ? '' : ' · ' + (getLang() === 'vi' ? DAYS_VI[d.getDay()] : DAYS_EN[d.getDay()]))
}

export interface ScreenLayerProps {
  settings?: ScreenSettings
  alarms?: Alarm[]
  preview?: boolean
  /** preview flags: standby, alarm, sunrise, dim */
  pvFlags?: string[]
}

export function ScreenLayer(props: ScreenLayerProps) {
  const preview = !!props.preview
  const flags = props.pvFlags || []
  const [now, setNow] = useState(() => Date.now())
  const [, bump] = useState(0)
  const lastTouch = useRef(Date.now())
  const standbyRef = useRef(false)
  const dismissed = useRef<{ [key: string]: true }>({})
  const snz = useRef<{ alarm: Alarm; until: number } | null>(null)
  const ringSince = useRef(0)
  const catcher = useRef(0)

  const s = props.settings
  const dev = deviceId()
  const mine = alarmsOn() ? myAlarms(props.alarms, dev) : []
  const cfg = standbyCfg(s)

  useEffect(() => onLocalScreen(() => bump((x) => x + 1)), [])

  // keep awake: Deck.tsx holds the Wake Lock; phones without it (iOS 12) get the muted looping inline video trick
  useEffect(() => {
    if (preview || !keepAwakeOn(s) || (navigator as any).wakeLock) return
    const video = document.createElement('video')
    video.setAttribute('muted', '')
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.setAttribute('loop', '')
    video.muted = true
    video.loop = true
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1'
    video.src = NOSLEEP_MP4
    document.body.appendChild(video)
    const play = () => {
      try {
        const p: any = video.play()
        if (p && p.catch) p.catch(() => {})
      } catch (e) {
        /* ignore */
      }
    }
    document.addEventListener('visibilitychange', play)
    document.addEventListener('touchend', play, true)
    document.addEventListener('click', play, true)
    return () => {
      document.removeEventListener('visibilitychange', play)
      document.removeEventListener('touchend', play, true)
      document.removeEventListener('click', play, true)
      if (video.parentNode) video.parentNode.removeChild(video)
    }
  }, [preview, !!(s && s.keepAwake === false)])

  // touches: idle clock + audio unlock
  useEffect(() => {
    if (preview) return
    const down = () => {
      if (!standbyRef.current) lastTouch.current = Date.now()
    }
    const up = () => {
      if (audioState() !== 'ready') unlockAudio()
    }
    window.addEventListener('touchstart', down, { capture: true, passive: true } as any)
    window.addEventListener('mousedown', down, true)
    window.addEventListener('touchend', up, true)
    window.addEventListener('click', up, true)
    return () => {
      window.removeEventListener('touchstart', down, true)
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('touchend', up, true)
      window.removeEventListener('click', up, true)
    }
  }, [preview])

  // the alarm in play (sunrise / ring) for this tick
  let cur: Due | null = null
  let ringing = false
  let progress = 0
  let ringStart = 0
  const sn = snz.current
  if (preview) {
    if (flags.indexOf('alarm') >= 0) {
      cur = { alarm: PV_ALARM, at: now - 5000, key: 'pv' }
      ringing = true
      ringStart = now - 5000
    } else if (flags.indexOf('sunrise') >= 0) {
      cur = { alarm: PV_ALARM, at: now + 6 * 60000, key: 'pv' }
      progress = 0.7
    }
  } else if (sn && now >= sn.until) {
    cur = { alarm: sn.alarm, at: sn.until, key: 'snz' }
    ringing = true
    ringStart = sn.until
  } else if (!sn) {
    const a = active(mine, now, dismissed.current)
    if (a) {
      cur = a
      if (now >= a.at) {
        ringing = true
        ringStart = a.at
      } else {
        const sun = Math.max(1, a.alarm.sunriseMin) * 60000
        progress = (now - (a.at - Math.max(0, a.alarm.sunriseMin) * 60000)) / sun
      }
    }
  }
  const ringKey = ringing && cur ? cur.key : ''

  const stopAlarm = (snooze: boolean) => {
    if (!cur) return
    const c = cur
    if (snooze && !preview) {
      dismissed.current[c.key] = true
      snz.current = { alarm: c.alarm, until: Date.now() + Math.max(1, Math.min(30, c.alarm.snoozeMin || 9)) * 60000 }
    } else {
      dismissed.current[c.key] = true
      snz.current = null
      markFired(c.alarm)
    }
    lastTouch.current = Date.now()
    setNow(Date.now())
  }

  // sound while ringing
  useEffect(() => {
    if (!ringKey || preview || !cur) return
    const stop = playAlarm(cur.alarm.sound, 60)
    let vib = 0
    const nav: any = navigator
    if (nav.vibrate) {
      nav.vibrate([500, 300, 500])
      vib = window.setInterval(() => nav.vibrate([500, 300, 500]), 4000)
    }
    return () => {
      stop()
      if (vib) clearInterval(vib)
      if (nav.vibrate) nav.vibrate(0)
    }
  }, [ringKey, preview])

  ringSince.current = ringing ? ringStart : 0

  // timer: 1 s while something is on screen, else 5 s
  const standby = preview ? flags.indexOf('standby') >= 0 : !!cfg && now - lastTouch.current >= cfg.afterMin * 60000 && !cur
  standbyRef.current = standby
  const dimWin = preview ? flags.indexOf('dim') >= 0 : inDimWindow(s, new Date(now)) && now - lastTouch.current >= DIM_LIFT_MS
  const dimmed = standby || dimWin
  const fast = standby || !!cur || (!!cfg && now - lastTouch.current >= cfg.afterMin * 60000 - 6000) || (inDimWindow(s, new Date(now)) && now - lastTouch.current < DIM_LIFT_MS + 1500)
  useEffect(() => {
    if (preview) return
    const iv = window.setInterval(() => {
      const n = Date.now()
      // auto stop after 10 minutes of ringing
      if (ringSince.current && n - ringSince.current >= RING_MS) {
        const a = active(mine, n, dismissed.current)
        if (snz.current) {
          markFired(snz.current.alarm)
          snz.current = null
        } else if (a) {
          dismissed.current[a.key] = true
          markFired(a.alarm)
        }
        ringSince.current = 0
      }
      setNow(n)
    }, fast ? 1000 : 5000)
    return () => clearInterval(iv)
  }, [preview, fast, props.alarms, props.settings])

  const d = new Date(now)
  const wakeFromStandby = (e: any) => {
    if (e && e.preventDefault && e.cancelable !== false) e.preventDefault()
    lastTouch.current = Date.now()
    standbyRef.current = false
    // a transparent catcher stays 350 ms so the synthesized click does not hit a tile
    catcher.current = Date.now() + 350
    setNow(Date.now())
    setTimeout(() => setNow(Date.now()), 400)
  }
  const catching = !standby && Date.now() < catcher.current

  const sbStyle = cfg ? cfg.style : preview ? 'digital' : 'digital'
  const showDate = cfg ? cfg.showDate : true
  const showNext = cfg ? cfg.showNext : true
  const nx = showNext ? nextText(upcoming(mine, now)[0], now) : ''
  const mm = d.getMinutes()
  const drift = { transform: 'translate(' + ((mm % 5) - 2) + 'px,' + ((Math.floor(mm / 5) % 5) - 2) + 'px)', WebkitTransform: 'translate(' + ((mm % 5) - 2) + 'px,' + ((Math.floor(mm / 5) % 5) - 2) + 'px)' }
  const words = getLang() === 'vi' ? timeWords(d.getHours(), mm) : timeWordsEn(d.getHours(), mm)

  const al = cur ? cur.alarm : null
  const lite = liteOn(s)
  const sunOpacity = Math.min(1, 0.25 + progress * 1.5)
  const locked = audioState() !== 'ready'

  return (
    <>
      {standby ? (
        <div class="pd-sb" role="presentation" onTouchStart={wakeFromStandby} onMouseDown={wakeFromStandby} onClick={(e) => e.preventDefault()}>
          <div class="pd-sb__in" style={drift}>
            {sbStyle === 'analog' ? (
              <AnalogFace d={d} />
            ) : sbStyle === 'words' ? (
              <div class="pd-sb__words">
                {words.text}
                <small>{words.part}</small>
              </div>
            ) : (
              <div class="pd-sb__time">
                {pad2(d.getHours())}
                <i>:</i>
                {pad2(mm)}
              </div>
            )}
            {showDate ? <div class="pd-sb__date">{dateText(d)}</div> : null}
            {nx ? (
              <div class="pd-sb__next">
                <Icon name="alarm" size={14} /> {nx.replace(t('Alarm') + ' ', '')}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {catching ? <div class="pd-sb__catch" onTouchStart={(e) => e.preventDefault()} onClick={(e) => e.preventDefault()} /> : null}
      {dimmed ? <div class={'pd-dim' + (lite ? ' pd-dim--lite' : '')} style={{ opacity: dimLevel(s) }} /> : null}
      {al ? (
        <div class={'pd-alarm' + (ringing ? ' pd-alarm--ring' : ' pd-alarm--sun')} style={{ background: ringing ? sunriseColor(1) : sunriseColor(progress), opacity: ringing ? 1 : sunOpacity }} role={ringing ? 'alertdialog' : 'presentation'} aria-label={t('Alarm')}>
          {ringing ? (
            <div class="pd-alarm__in">
              <div class="pd-alarm__time">{al.time}</div>
              <div class="pd-alarm__label">{al.label || t('Alarm')}</div>
              {locked && !preview ? <div class="pd-alarm__hint">{t('Tap to turn on the sound')}</div> : null}
              <button type="button" class="pd-alarm__snooze" onClick={() => stopAlarm(true)}>
                {t('Snooze')} · {al.snoozeMin || 9} {t('min')}
              </button>
              <button type="button" class="pd-alarm__stop" onClick={() => stopAlarm(false)}>
                {t('Stop')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/** Per-phone toggles. Local choices live in localStorage pd.screen.local and win over the layout. */
export function ScreenSheet(props: { settings?: ScreenSettings; alarms?: Alarm[]; header?: string; onClose: () => void }) {
  const [, bump] = useState(0)
  useEffect(() => onLocalScreen(() => bump((x) => x + 1)), [])
  useEffect(() => {
    const iv = window.setInterval(() => bump((x) => x + 1), 1000)
    return () => clearInterval(iv)
  }, [])
  const s = props.settings
  const loc = localScreen()
  const hm = headerMode({ header: props.header })
  const lite = loc.lite || (s && s.lite) || 'auto'
  const sbConfigured = !!(s && s.standby && s.standby.enabled)
  const stand = loc.standby !== false
  const alOn = loc.alarms !== false
  const mine = myAlarms(props.alarms, deviceId())
  const st = audioState()
  const seg = (v: 'auto' | 'on' | 'off', label: string) => (
    <button type="button" class={'pd-toggle__b' + (lite === v ? ' pd-toggle__b--on' : '')} onClick={() => saveLocalScreen({ lite: v })}>
      {label}
    </button>
  )
  const sw = (on: boolean, fn: () => void, label: string) => (
    <button type="button" class={'pd-sw' + (on ? ' pd-sw--on' : '')} role="switch" aria-checked={on} aria-label={label} onClick={fn}>
      <i />
    </button>
  )
  return (
    <div class="pd-modal" role="dialog" aria-label={t('Screen & alarms')} onClick={props.onClose}>
      <div class="pd-modal__panel pd-modal__panel--proc pd-scr" onClick={(e) => e.stopPropagation()}>
        <div class="pd-proc__head">
          <b>{t('Screen & alarms')}</b>
          <span class="pd-spacer" />
          <button type="button" class="pd-iconbtn" aria-label={t('Close')} onClick={props.onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div class="pd-scr__list">
          <div class="pd-scr__row">
            <div class="pd-scr__t">
              {t('Lite mode')}
              <small>{t('Fewer effects, smoother on old phones')}</small>
            </div>
            <div class="pd-toggle" role="tablist">
              {seg('auto', t('Auto'))}
              {seg('on', t('On'))}
              {seg('off', t('Off'))}
            </div>
          </div>
          <div class="pd-scr__row">
            <div class="pd-scr__t">
              {t('Top bar')}
              <small>{t('Computer name, CPU and RAM')}</small>
            </div>
            <div class="pd-toggle" role="tablist">
              {(['full', 'minimal', 'hidden'] as const).map((v) => (
                <button key={v} type="button" class={'pd-toggle__b' + (hm === v ? ' pd-toggle__b--on' : '')} onClick={() => saveLocalScreen({ header: v })}>
                  {v === 'full' ? t('Full') : v === 'minimal' ? t('Minimal') : t('Hidden')}
                </button>
              ))}
            </div>
          </div>
          <div class="pd-scr__row">
            <div class="pd-scr__t">
              {t('Standby clock')}
              <small>{sbConfigured ? t('After {0} min without a touch', (s && s.standby && s.standby.afterMin) || 5) : t('Off in the layout')}</small>
            </div>
            {sw(stand && sbConfigured, () => saveLocalScreen({ standby: !stand }), t('Standby clock'))}
          </div>
          <div class="pd-scr__row">
            <div class="pd-scr__t">
              {t('Alarms on this phone')}
              <small>{mine.length ? t('{0} armed', mine.length) : t('None for this phone')}</small>
            </div>
            {sw(alOn, () => saveLocalScreen({ alarms: !alOn }), t('Alarms on this phone'))}
          </div>
          <div class="pd-scr__row">
            <div class="pd-scr__t">
              {t('Alarm sound')}
              <small>{st === 'ready' ? t('ready') : st === 'locked' ? t('touch to turn on') : t('not supported')}</small>
            </div>
            <button type="button" class="pd-scr__btn" disabled={st === 'unsupported'} onClick={() => { unlockAudio(); previewSound('chime') }}>
              {t('Test sound')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
