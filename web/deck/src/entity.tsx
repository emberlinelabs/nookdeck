import { Icon, TileIcon } from './icon'
import { t } from './i18n'
import { isIconName } from '../../shared/icons'
import { readableOn, tint } from './theme'
import { convTemp, isTempUnit, tempUnit, unitOf } from './temp'
import { lightColor, swatchesFor } from './light-color'
import type { EntityOptions, HassEntity, IconAssets } from './types'

/**
 * Home Assistant entity tile (item.widget 'entity'), iOS Home look: icon top-left, name and state bottom-left; on = filled bright tile
 * (item colour, warm yellow for lights), off = dim; sensors show the value big with its unit; climate shows the current temperature with
 * the target and mode; unavailable is greyed with "Unavailable". Wide short tiles switch to an icon-left row layout.
 */

export interface EntityProps {
  id: string
  cfg: EntityOptions
  ent?: HassEntity
  /** optimistic override of the on/off state (a tap whose result has not come back as state yet) */
  forceOn?: boolean
  /** climate: target temperature typed with -/+ that is not sent yet (or not confirmed) */
  pend?: number
  onStep?: (delta: number) => void
  /** light: quick colour swatches and the brightness slider send ops through this */
  onLight?: (op: string, value: unknown) => void
  connected: boolean
  tw: number
  th: number
  scale: number
  showLabel: boolean
  color?: string
  textColor?: string
  assets?: IconAssets
}

const TOGGLE = ['light', 'switch', 'fan', 'input_boolean', 'automation', 'cover', 'media_player', 'lock', 'vacuum']

const domainOf = (id: string, e?: HassEntity) => (e && e.domain) || id.split('.')[0]
const attr = (e: HassEntity | undefined, k: string): any => (e && e.attrs ? (e.attrs as { [k: string]: any })[k] : undefined)

/** Tabler names tried in order: the first one that is built in (or shipped in layout.assets) is drawn. */
function iconCandidates(domain: string, dc: string, on: boolean, mode?: string): string[] {
  if (domain === 'light') return on ? ['bulb', 'sun'] : ['bulb-off', 'bulb']
  if (domain === 'switch' || domain === 'input_boolean') return on ? ['plug-connected', 'plug', 'power', 'bolt'] : ['plug-off', 'plug', 'power']
  if (domain === 'climate') {
    if (mode === 'cool') return ['snowflake', 'air-conditioning']
    if (mode === 'heat') return ['flame', 'air-conditioning']
    if (mode === 'dry') return ['droplet', 'air-conditioning']
    if (mode === 'fan_only') return ['propeller', 'wind', 'air-conditioning']
    return ['air-conditioning', 'temperature']
  }
  if (domain === 'fan') return ['propeller', 'wind', 'power']
  if (domain === 'cover') {
    if (dc === 'garage') return ['garage', 'door']
    if (dc === 'door' || dc === 'gate') return on ? ['door-open', 'door'] : ['door']
    if (dc === 'window') return on ? ['window-open', 'window'] : ['window']
    return ['blinds', on ? 'window-open' : 'window'] // blind, curtain, shade, shutter, awning
  }
  if (domain === 'lock') return on ? ['lock-open'] : ['lock']
  if (domain === 'vacuum') return ['robot']
  if (domain === 'media_player') return ['device-speaker', 'music']
  if (domain === 'scene') return ['movie', 'sun']
  if (domain === 'script' || domain === 'button') return ['player-play', 'bolt']
  if (domain === 'automation') return ['bolt', 'power']
  if (domain === 'binary_sensor') {
    if (dc === 'door' || dc === 'garage_door' || dc === 'opening') return on ? ['door-open', 'door', 'lock-open'] : ['door', 'lock']
    if (dc === 'window') return on ? ['window-open', 'window', 'lock-open'] : ['window', 'lock']
    if (dc === 'motion' || dc === 'moving') return ['walk', 'user']
    if (dc === 'occupancy' || dc === 'presence') return on ? ['user', 'walk'] : ['user-off', 'user']
    if (dc === 'smoke' || dc === 'gas' || dc === 'problem' || dc === 'safety') return ['alert-triangle']
    if (dc === 'moisture') return ['droplet', 'alert-triangle']
    if (dc === 'battery') return ['battery']
    if (dc === 'connectivity') return ['wifi']
    return on ? ['bolt', 'power'] : ['power']
  }
  if (domain === 'sensor') {
    if (dc === 'temperature') return ['temperature', 'thermometer', 'sun']
    if (dc === 'humidity' || dc === 'moisture') return ['droplet', 'droplet-half', 'gauge']
    if (dc === 'battery') return ['battery']
    if (dc === 'power' || dc === 'energy' || dc === 'current' || dc === 'voltage') return ['bolt']
    if (dc === 'illuminance') return ['sun']
    return ['gauge']
  }
  return ['gauge']
}

function pickIcon(c: string[], assets?: IconAssets, emoji?: string): string {
  for (let i = 0; i < c.length; i++) {
    if (isIconName(c[i]) || (assets && Object.prototype.hasOwnProperty.call(assets, c[i]))) return c[i]
  }
  // none of the Tabler names is available yet (gen-assets has not shipped them): an emoji reads better than a wrong glyph
  return emoji || 'gauge'
}
const CLIMATE_EMOJI: { [k: string]: string } = { cool: '❄️', heat: '🔥', dry: '💧', fan_only: '💨' }

export const HVAC_COLOR: { [k: string]: string } = { cool: '#60a5fa', heat: '#fb923c', auto: '#34d399', heat_cool: '#34d399', dry: '#2dd4bf', fan_only: '#9ca3af', off: '#6b7280' }
export const HVAC_LABEL: { [k: string]: string } = { cool: 'Cool', heat: 'Heat', auto: 'Auto', heat_cool: 'Auto', dry: 'Dry', fan_only: 'Fan', off: 'Off' }
export const hvacLabel = (m: string): string => (HVAC_LABEL[m] ? t(HVAC_LABEL[m]) : m)
const num = (v: any): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return isFinite(n) ? n : null
}
const fmt = (n: number) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1))

/** Text for the state line of a toggle-like or binary entity. */
function stateText(domain: string, dc: string, st: string, e?: HassEntity, small?: boolean): string {
  if (domain === 'light') {
    const b = num(attr(e, 'brightness'))
    return st === 'on' ? t('On') + (b !== null ? ' · ' + Math.round((b / 255) * 100) + '%' : '') : t('Off')
  }
  if (domain === 'fan') { const p = num(attr(e, 'percentage')); return st === 'on' ? t('On') + (p !== null ? ' · ' + Math.round(p) + '%' : '') : t('Off') }
  if (domain === 'cover') { const p = num(attr(e, 'current_position')); if (p !== null && (st === 'open' || st === 'closed')) return st === 'open' ? t('Open') + ' · ' + Math.round(p) + '%' : t('Closed') }
  if (domain === 'cover') return st === 'open' ? t('Open') : st === 'closed' ? t('Closed') : st === 'opening' ? t('Opening…') : st === 'closing' ? t('Closing…') : st
  if (domain === 'lock') return st === 'locked' ? t('Locked') : st === 'unlocked' ? t('Unlocked') : st === 'jammed' ? t('Jammed') : st
  if (domain === 'media_player') return st === 'playing' ? t('Playing') : st === 'paused' ? t('Paused') : st === 'idle' ? t('Idle') : st === 'off' ? t('Off') : st
  if (domain === 'vacuum') return st === 'cleaning' ? t('Cleaning') : st === 'docked' ? t('Docked') : st === 'returning' ? t('Returning to dock') : st === 'paused' ? t('Paused') : st === 'idle' ? t('Idle') : st
  if (domain === 'scene' || domain === 'script' || domain === 'button') return t('Run')
  if (domain === 'binary_sensor') {
    const on = st === 'on'
    if (dc === 'door' || dc === 'garage_door' || dc === 'opening' || dc === 'window') return on ? t('Open') : t('Closed')
    if (dc === 'motion' || dc === 'moving') return on ? t('Motion') : t('No motion')
    if (dc === 'occupancy' || dc === 'presence') return on ? t('Occupied') : small ? t('Empty') : t('Nobody here')
    if (dc === 'smoke' || dc === 'gas' || dc === 'problem' || dc === 'safety' || dc === 'moisture') return on ? t('Alert') : t('Normal')
    if (dc === 'connectivity') return on ? t('Connected') : t('Disconnected')
    if (dc === 'battery') return on ? t('Battery low') : t('Battery OK')
    return on ? t('On') : t('Off')
  }
  return st === 'on' ? t('On') : st === 'off' ? t('Off') : st
}

export function EntityTile(props: EntityProps) {
  const cfg = props.cfg
  const e = props.ent
  const domain = domainOf(props.id, e)
  const dc = String(attr(e, 'device_class') || '')
  const raw = e ? String(e.state) : 'unavailable'
  const gone = !e || raw === 'unavailable' || raw === 'unknown'
  const name = cfg.name || (e && e.name) || props.id
  const isSensor = domain === 'sensor'
  const isClimate = domain === 'climate'
  const toggleLike = TOGGLE.indexOf(domain) >= 0 || domain === 'binary_sensor'
  const isOnState = domain === 'cover' ? raw === 'open' || raw === 'opening' : domain === 'lock' ? raw === 'unlocked' : domain === 'media_player' ? raw === 'playing' : domain === 'vacuum' ? raw === 'cleaning' : raw === 'on'
  const on = props.forceOn !== undefined ? props.forceOn : isOnState
  const hot = !gone && toggleLike && on && domain !== 'light'
  const accent = props.color || (domain === 'light' ? '#fbbf24' : domain === 'binary_sensor' ? '#34d399' : '#60a5fa')
  const climateColor = raw === 'heat' ? '#fb923c' : raw === 'cool' ? '#60a5fa' : raw === 'off' ? '' : '#34d399'
  const show = cfg.show || 'auto'

  // ---- text ----
  let value = ''
  let unit = ''
  let line = ''
  let textVal = ''
  let roomShort = ''
  if (gone) line = t('Unavailable')
  else if (isSensor && show !== 'state') {
    const n = num(raw)
    if (n !== null && e && isTempUnit(e.unit)) {
      value = fmt(convTemp(n, unitOf(e.unit), tempUnit()))
      unit = '°' + tempUnit()
    } else if (n !== null) {
      value = fmt(n)
      unit = (e && e.unit) || ''
    } else textVal = raw + ((e && e.unit) ? ' ' + e.unit : '')
  } else if (isClimate) {
    // the device speaks its own unit (attrs.temperature_unit); pend stays in it too, only the display is converted
    const nu = unitOf(attr(e, 'temperature_unit'))
    const dsp = (v: number | null) => (v === null ? null : convTemp(v, nu, tempUnit()))
    const cur = dsp(num(attr(e, 'current_temperature')))
    const tgt = dsp(props.pend !== undefined ? props.pend : num(attr(e, 'temperature')))
    const hum = num(attr(e, 'current_humidity'))
    roomShort = cur !== null ? fmt(cur) + '°' : ''
    const room = [cur !== null ? t('Room {0}', fmt(cur) + '°') : '', hum !== null ? Math.round(hum) + '%' : ''].filter(Boolean).join(' · ')
    if (raw === 'off') line = [t('Off'), room].filter(Boolean).join(' · ')
    else {
      const v = tgt !== null ? tgt : cur
      value = v !== null ? fmt(v) : ''
      unit = v !== null ? '°' : ''
      line = room
    }
  } else if (isSensor) line = raw + ((e && e.unit) ? ' ' + e.unit : '')
  else line = stateText(domain, dc, props.forceOn !== undefined ? (props.forceOn ? 'on' : 'off') : raw, e, props.tw < 120)
  if (props.forceOn !== undefined && domain === 'light' && !gone) line = props.forceOn ? t('On') : t('Off')

  const doorish = (domain === 'binary_sensor' && (dc === 'door' || dc === 'garage_door' || dc === 'opening')) || (domain === 'cover' && (dc === 'door' || dc === 'gate' || dc === 'garage'))
  const presence = domain === 'binary_sensor' && (dc === 'occupancy' || dc === 'presence' || dc === 'motion' || dc === 'moving')
  const icon = pickIcon(iconCandidates(domain, dc, isClimate ? raw !== 'off' : on, isClimate ? raw : undefined), props.assets, isClimate ? CLIMATE_EMOJI[raw] || '🌡️' : presence ? (dc === 'motion' || dc === 'moving' ? '🚶' : '🧍') : doorish ? '🚪' : domain === 'cover' || (domain === 'binary_sensor' && dc === 'window') ? '▤' : undefined)

  // ---- colours ----
  let bg = 'rgba(139,139,148,0.12)'
  let fg = props.textColor || ''
  let sub = 'var(--pd-muted)'
  let icFg = isClimate && climateColor ? climateColor : props.color || 'var(--pd-text-2)'
  const isLight = domain === 'light'
  const lit = isLight && !gone && on
  // a lit light wears its real colour (hs / rgb / colour temperature): a soft wash and a glyph in that colour; off stays neutral
  const lc = lit ? lightColor(e) || '#fbbf24' : ''
  if (lit) {
    bg = tint(lc, 0.2) || bg
    icFg = lc
  } else if (hot) {
    bg = accent
    const r = readableOn(accent) || '#111'
    fg = props.textColor || r
    sub = r === '#ffffff' ? 'rgba(255,255,255,0.78)' : 'rgba(0,0,0,0.6)'
    icFg = r
  } else if (isSensor && props.color) icFg = props.color
  else if (!gone && domain === 'binary_sensor') icFg = 'var(--pd-muted)'
  if (gone) bg = 'rgba(139,139,148,0.08)'

  const tw = props.tw
  const th = props.th
  const row = tw >= th * 1.7 && th < 130
  // 1x1 on a small phone: icon plus one line (the value or the state), no name; everything scaled to the cell
  const tiny = !row && th < 84 && tw < 110
  const pad = tiny ? 7 : tw >= 170 ? 14 : 10
  const isz = tiny ? Math.round(Math.max(20, Math.min(30, th * 0.4))) : row ? Math.round(Math.min(th - pad * 2, 44)) : Math.round(Math.max(22, Math.min(40, Math.min(th * 0.3, tw * 0.3)))) * Math.min(1.2, props.scale)
  const nameSize = Math.max(10, Math.min(15, Math.round(12.5 * Math.min(1.25, props.scale))))
  const avail = (row ? tw - pad * 2 - isz - 10 : tw - pad * 2)
  const vLen = (value + unit).length
  const vSize = value ? Math.max(14, Math.min(Math.floor(th * (row ? 0.4 : 0.26)), Math.floor(avail / (Math.max(2, vLen) * 0.58)), 44)) : 0
  const showName = !tiny && (props.showLabel || !!cfg.name)
  const compactStp = isClimate && !gone && raw !== 'off' && row && !!props.onStep && tw < 260
  const nameText = compactStp && roomShort ? name + ' · ' + roomShort : name

  const icon$ = (
    <span class="pd-ent__ic" data-part="tile-icon" style={{ color: icFg, width: isz + 'px', height: isz + 'px' }}>
      <TileIcon value={icon} size={Math.round(isz * 0.78)} assets={props.assets} weight={hot ? 'Filled' : undefined} />
    </span>
  )
  const mchipMode = isClimate && !gone && raw !== 'off' ? raw : ''
  const mchip = mchipMode ? (
    <span class="pd-ent__chip pd-ent__chip--in" style={{ color: HVAC_COLOR[mchipMode] || '#34d399', background: tint(HVAC_COLOR[mchipMode] || '#34d399', 0.16) || undefined }}>
      {hvacLabel(mchipMode)}
    </span>
  ) : null
  const text$ = (
    <span class="pd-ent__tx">
      {value ? (
        <span class={'pd-ent__v' + (props.pend !== undefined ? ' pd-ent__v--pend' : '')} data-part="num" style={{ fontSize: vSize + 'px', color: isClimate && !gone && raw !== 'off' && !fg ? HVAC_COLOR[raw] || undefined : fg || undefined }}>
          {value}
          {unit ? <span class="pd-ent__u" style={{ fontSize: Math.max(10, Math.round(vSize * 0.45)) + 'px' }}>{unit}</span> : null}
          {compactStp && tw >= 200 ? mchip : null}
        </span>
      ) : null}
      {textVal ? (
        <span class="pd-ent__tv" data-part="tile-value" style={{ fontSize: Math.max(13, nameSize + 3) + 'px', color: fg || undefined }}>
          {textVal}
        </span>
      ) : null}
      {showName ? (
        <span class="pd-ent__n" data-part="tile-label" style={{ fontSize: nameSize + 'px', color: fg || undefined }}>
          {nameText}
        </span>
      ) : null}
      {line && (th >= 110 || !value) && !(tiny && textVal) ? (
        <span class="pd-ent__s" data-part="tile-sub" style={{ fontSize: Math.max(10, nameSize - 1) + 'px', color: sub }}>
          {line}
        </span>
      ) : null}
    </span>
  )
  const mode = isClimate && !gone && raw !== 'off' ? raw : ''
  const chip = mode && tw >= 110 ? (
    <span class="pd-ent__chip" style={{ color: HVAC_COLOR[mode] || '#34d399', background: tint(HVAC_COLOR[mode] || '#34d399', 0.16) || undefined }}>
      {hvacLabel(mode)}
    </span>
  ) : null
  const stp =
    isClimate && !gone && raw !== 'off' && row && props.onStep ? (
      <span class="pd-ent__stp">
        <button type="button" class="pd-ent__sb" aria-label={t('Decrease temperature')} onClick={(ev) => { ev.stopPropagation(); props.onStep && props.onStep(-1) }}>
          <Icon name="minus" size={20} />
        </button>
        <button type="button" class="pd-ent__sb" aria-label={t('Increase temperature')} onClick={(ev) => { ev.stopPropagation(); props.onStep && props.onStep(1) }}>
          <Icon name="plus" size={20} />
        </button>
      </span>
    ) : null
  const badge = !props.connected ? (
    <span class={'pd-ent__bd' + (tw < 130 ? ' pd-ent__bd--dot' : '')} title={t('HA offline')}>
      {tw < 130 ? '!' : t('HA offline')}
    </span>
  ) : null
  // light: five quick colours (2x1 and up) and a brightness slider when there is room; taps never toggle the tile
  const stop = (ev: Event) => ev.stopPropagation()
  const swatches = isLight && !gone && props.onLight && tw >= 150 && th >= 92 ? swatchesFor(e) : []
  const brRaw = num(attr(e, 'brightness'))
  const brPct = brRaw !== null ? Math.max(1, Math.round((brRaw / 255) * 100)) : 100
  const showBr = swatches.length > 0 && th >= 150 && !!attr(e, 'supported_color_modes') && on
  const sw$ = swatches.length ? (
    <span class="pd-ent__sw" onClick={stop} onPointerDown={stop} onTouchStart={stop} onMouseDown={stop}>
      {swatches.map((s) => (
        <button key={s.id} type="button" class="pd-ent__swb" aria-label={t(s.label)} style={{ background: s.color }} onClick={(ev) => { ev.stopPropagation(); props.onLight && props.onLight(s.op, s.value) }} />
      ))}
    </span>
  ) : null
  const br$ = showBr ? (
    <span class="pd-ent__br" onClick={stop} onPointerDown={stop} onTouchStart={stop} onMouseDown={stop}>
      <input type="range" min={1} max={100} value={brPct} aria-label={t('Brightness')} onChange={(ev) => props.onLight && props.onLight('brightness', Math.round(Number((ev.target as HTMLInputElement).value)))} />
    </span>
  ) : null
  const style: { [k: string]: string } = { background: bg }
  if (!props.connected || gone) style.opacity = gone ? '0.6' : '0.75'
  return (
    <div class={'pd-ent' + (tiny ? ' pd-ent--tiny' : '') + (row ? ' pd-ent--row' : '') + (hot ? ' pd-ent--on' : '') + (lit ? ' pd-ent--lit' : '') + (sw$ ? ' pd-ent--sw' : '')} style={Object.assign({ padding: pad + 'px' }, style)} aria-label={name + ': ' + (value ? value + unit : line)}>
      {stp && tw < 260 ? null : icon$}
      {text$}
      {stp && tw < 260 ? null : chip}
      {stp}
      {sw$}
      {br$}
      {badge}
    </div>
  )
}
