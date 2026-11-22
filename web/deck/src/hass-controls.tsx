import { convTemp, tempUnit, unitOf } from './temp'
import { useState } from 'preact/hooks'
import { t } from './i18n'
import { Icon } from './icon'
import { HVAC_COLOR, hvacLabel } from './entity'
import { tint } from './theme'
import { swatchesFor } from './light-color'
import type { HassEntity } from './types'

/**
 * Control sheet for a Home Assistant entity (climate, light, fan, cover, vacuum). Look after a typical Home Assistant climate card: big -/+ with the target,
 * a segmented mode row, chips. Every change goes out as one op through `send(op, value)`; the sheet shows the optimistic value from `ovr`
 * and rolls back by itself when the owner clears it. Touch targets are 44 px or more.
 */

export interface SheetProps {
  id: string
  ent: HassEntity
  name: string
  /** optimistic values by op, owned by the deck */
  ovr: { [op: string]: any }
  /** climate target typed with -/+ and not confirmed yet */
  pend?: number
  /** light: the scene select of the same device (options + current), when there is one */
  scene?: { id: string; options: string[]; current: string } | null
  send: (op: string, value?: unknown) => void
  step: (delta: number) => void
  onClose: () => void
  /** landscape phone: two columns so the sheet does not scroll */
  short?: boolean
}

const A = (e: HassEntity, k: string): any => (e.attrs ? (e.attrs as { [k: string]: any })[k] : undefined)
const num = (v: any): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return isFinite(n) ? n : null
}
const fmt = (n: number) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1))

const FAN_LABEL: { [k: string]: string } = { auto: 'Auto', low: 'Low', medium: 'Medium', middle: 'Medium', mid: 'Medium', high: 'High', quiet: 'Quiet', silent: 'Quiet', turbo: 'Turbo', powerful: 'Powerful', sleep: 'Sleep', favorite: 'Favorite', manual: 'Manual' }
const lb = (map: { [k: string]: string }, k: string): string => (map[k.toLowerCase()] ? t(map[k.toLowerCase()]) : k)
const SWING_LABEL: { [k: string]: string } = { off: 'Off', on: 'On', vertical: 'Vertical', horizontal: 'Horizontal', both: 'Both' }

/** Up to four modes get words; longer lists (five speeds + auto) become Auto, 1, 2, 3... to fit a phone. */
function fanOptions(modes: string[]) {
  if (modes.length <= 4) return modes.map((m) => ({ value: m, label: lb(FAN_LABEL, m) }))
  let n = 0
  return modes.map((m) => ({ value: m, label: m.toLowerCase() === 'auto' ? 'Auto' : String(++n) }))
}

function Chips(props: { value: string | null; options: { value: string; label: string; color?: string }[]; onPick: (v: string) => void; disabled?: boolean }) {
  return (
    <div class={'pd-cs__chips' + (props.disabled ? ' pd-cs__chips--off' : '')} role="radiogroup">
      {props.options.map((o) => {
        const on = props.value === o.value
        const c = o.color
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            class={'pd-cs__chip' + (on ? ' pd-cs__chip--on' : '')}
            style={on && c ? { color: c, background: tint(c, 0.18) || undefined, borderColor: tint(c, 0.5) || undefined } : undefined}
            onClick={() => !props.disabled && props.onPick(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Native range input, shown live while dragging and sent once on release. */
function Slider(props: { label: string; min: number; max: number; step?: number; value: number; unit?: string; onCommit: (v: number) => void; track?: string; disabled?: boolean }) {
  const [drag, setDrag] = useState<number | null>(null)
  const v = drag !== null ? drag : props.value
  return (
    <div class={'pd-cs__sl' + (props.disabled ? ' pd-cs__sl--off' : '')}>
      <div class="pd-cs__slh">
        <span>{props.label}</span>
        <b>{Math.round(v)}{props.unit || ''}</b>
      </div>
      <input
        class="pd-cs__rg"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step || 1}
        value={v}
        disabled={props.disabled}
        style={props.track ? { background: props.track } : undefined}
        aria-label={props.label}
        onInput={(ev) => setDrag(parseFloat((ev.target as HTMLInputElement).value))}
        onChange={(ev) => {
          const x = parseFloat((ev.target as HTMLInputElement).value)
          setDrag(null)
          props.onCommit(x)
        }}
      />
    </div>
  )
}

function Btn(props: { label: string; icon?: string; onClick: () => void; on?: boolean; disabled?: boolean }) {
  return (
    <button type="button" class={'pd-cs__btn' + (props.on ? ' pd-cs__btn--on' : '')} disabled={props.disabled} onClick={props.onClick}>
      {props.icon ? <Icon name={props.icon} size={20} /> : null}
      <span>{props.label}</span>
    </button>
  )
}

function Climate(p: SheetProps) {
  const e = p.ent
  const raw = String(e.state)
  const mode = p.ovr.hvac_mode !== undefined ? String(p.ovr.hvac_mode) : raw
  const on = mode !== 'off'
  const min = num(A(e, 'min_temp')) || 16
  const tgtAttr = num(A(e, 'temperature'))
  const target = p.pend !== undefined ? p.pend : p.ovr.temperature !== undefined ? p.ovr.temperature : tgtAttr !== null ? tgtAttr : min
  const cur0 = num(A(e, 'current_temperature'))
  const nu = unitOf(A(e, 'temperature_unit'))
  // display only: the -/+ steps and the value sent stay in the device's own unit
  const dsp = (v: number) => convTemp(v, nu, tempUnit())
  const cur = cur0 === null ? null : dsp(cur0)
  const hum = num(A(e, 'current_humidity'))
  const modes: string[] = Array.isArray(A(e, 'hvac_modes')) ? A(e, 'hvac_modes') : []
  const order = ['cool', 'heat', 'auto', 'heat_cool', 'dry', 'fan_only', 'off']
  const sorted = modes.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const fans: string[] = Array.isArray(A(e, 'fan_modes')) ? A(e, 'fan_modes') : []
  const swings: string[] = Array.isArray(A(e, 'swing_modes')) ? A(e, 'swing_modes') : []
  const fan = p.ovr.fan_mode !== undefined ? p.ovr.fan_mode : A(e, 'fan_mode')
  const swing = p.ovr.swing_mode !== undefined ? p.ovr.swing_mode : A(e, 'swing_mode')
  const room = [cur !== null ? t('Room {0}', fmt(cur) + '°') : '', hum !== null ? t('Humidity {0}', Math.round(hum) + '%') : ''].filter(Boolean).join(' · ')
  const mc = HVAC_COLOR[mode] || '#34d399'
  return (
    <>
      <div class={p.short ? 'pd-cs__cols' : ''}>
      <div class="pd-cs__l">
      <div class="pd-cs__sub">{room || (on ? hvacLabel(mode) : t('Off'))}</div>
      <div class="pd-cs__hero">
        <button type="button" class="pd-cs__pm" aria-label={t('Decrease temperature')} disabled={!on} onClick={() => p.step(-1)}>
          <Icon name="minus" size={26} />
        </button>
        <span class={'pd-cs__val' + (on ? '' : ' pd-cs__val--off') + (p.pend !== undefined ? ' pd-cs__val--pend' : '')} style={on ? { color: mc } : undefined}>
          {fmt(dsp(target))}
          <i>°</i>
        </span>
        <button type="button" class="pd-cs__pm" aria-label={t('Increase temperature')} disabled={!on} onClick={() => p.step(1)}>
          <Icon name="plus" size={26} />
        </button>
      </div>
      </div>
      <div class="pd-cs__r">
      {sorted.length > 1 ? (
        <>
          <div class="pd-cs__lb">{t('Mode')}</div>
          <Chips value={mode} options={sorted.map((m) => ({ value: m, label: hvacLabel(m), color: HVAC_COLOR[m] }))} onPick={(m) => p.send('hvac_mode', m)} />
        </>
      ) : null}
      {fans.length > 1 ? (
        <>
          <div class="pd-cs__lb">{t('Fan speed')}</div>
          <Chips value={fan === undefined ? null : String(fan)} disabled={!on} options={fanOptions(fans)} onPick={(m) => p.send('fan_mode', m)} />
        </>
      ) : null}
      {swings.length > 1 ? (
        <>
          <div class="pd-cs__lb">{t('Swing')}</div>
          <Chips value={swing === undefined ? null : String(swing)} disabled={!on} options={swings.map((m) => ({ value: m, label: lb(SWING_LABEL, m) }))} onPick={(m) => p.send('swing_mode', m)} />
        </>
      ) : null}
      </div>
      </div>
    </>
  )
}

const HUE_TRACK = 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'

function Light(p: SheetProps) {
  const e = p.ent
  const on = p.ovr.power !== undefined ? !!p.ovr.power : String(e.state) === 'on'
  const modes: string[] = Array.isArray(A(e, 'supported_color_modes')) ? A(e, 'supported_color_modes') : []
  const br = num(A(e, 'brightness'))
  const dim = modes.length ? modes.some((m) => m !== 'onoff') : br !== null
  const ct = modes.indexOf('color_temp') >= 0
  const hue = modes.some((m) => m === 'hs' || m === 'xy' || m.indexOf('rgb') === 0)
  const pct = p.ovr.brightness !== undefined ? p.ovr.brightness : br !== null ? Math.round((br / 255) * 100) : on ? 100 : 0
  const kmin = num(A(e, 'min_color_temp_kelvin')) || 2000
  const kmax = num(A(e, 'max_color_temp_kelvin')) || 6500
  const k = p.ovr.color_temp !== undefined ? p.ovr.color_temp : num(A(e, 'color_temp_kelvin')) || Math.round((kmin + kmax) / 2)
  const hs = A(e, 'hs_color')
  const h = p.ovr.hue !== undefined ? p.ovr.hue : Array.isArray(hs) ? num(hs[0]) || 0 : 0
  const swatches = swatchesFor(e)
  const effects: string[] = Array.isArray(A(e, 'effect_list')) ? A(e, 'effect_list').filter((x: string) => x && x !== 'None') : []
  const effect = A(e, 'effect')
  return (
    <div class={p.short ? 'pd-cs__cols' : ''}>
      <div class="pd-cs__l">
      <div class="pd-cs__sub">{on ? t('On') + (dim ? ' · ' + Math.round(pct) + '%' : '') : t('Off')}</div>
      <Chips value={on ? 'on' : 'off'} options={[{ value: 'on', label: t('On'), color: '#fbbf24' }, { value: 'off', label: t('Off') }]} onPick={(v) => p.send('power', v === 'on')} />
      {dim ? <Slider label={t('Brightness')} min={1} max={100} value={pct} unit="%" disabled={!on} onCommit={(v) => p.send('brightness', Math.round(v))} /> : null}
      {ct ? <Slider label={t('Color temperature')} min={kmin} max={kmax} step={50} value={k} unit="K" disabled={!on} track="linear-gradient(90deg,#ffb25b,#fff,#9ec9ff)" onCommit={(v) => p.send('color_temp', Math.round(v))} /> : null}
      {hue ? <Slider label={t('Color')} min={0} max={360} value={h} unit="°" disabled={!on} track={HUE_TRACK} onCommit={(v) => p.send('hue', Math.round(v))} /> : null}
      </div>
      <div class="pd-cs__r">
      {swatches.length ? (
        <div class="pd-cs__row">
          <div class="pd-cs__lb">{t('Presets')}</div>
          <div class="pd-cs__sw">
            {swatches.map((s) => (
              <button key={s.id} type="button" class="pd-cs__swb" aria-label={t(s.label)} disabled={!on} style={{ background: s.color }} onClick={() => p.send(s.op, s.value)} />
            ))}
          </div>
        </div>
      ) : null}
      {p.scene && p.scene.options.length ? (
        <div class="pd-cs__row">
          <div class="pd-cs__lb">{t('Scene')}</div>
          <Chips value={p.ovr.scene !== undefined ? String(p.ovr.scene) : p.scene.current} options={p.scene.options.map((o) => ({ value: o, label: o }))} onPick={(v) => p.send('scene', v)} />
        </div>
      ) : null}
      {effects.length ? (
        <div class="pd-cs__row">
          <div class="pd-cs__lb">{t('Effects')}</div>
          <Chips value={p.ovr.effect !== undefined ? String(p.ovr.effect) : effect ? String(effect) : null} options={effects.map((o) => ({ value: o, label: o }))} disabled={!on} onPick={(v) => p.send('effect', v)} />
        </div>
      ) : null}
      </div>
    </div>
  )
}

function FanCtl(p: SheetProps) {
  const e = p.ent
  const on = p.ovr.power !== undefined ? !!p.ovr.power : String(e.state) === 'on'
  const pc = p.ovr.percentage !== undefined ? p.ovr.percentage : num(A(e, 'percentage')) || 0
  const step = num(A(e, 'percentage_step')) || 1
  const presets: string[] = Array.isArray(A(e, 'preset_modes')) ? A(e, 'preset_modes') : []
  const preset = p.ovr.preset !== undefined ? p.ovr.preset : A(e, 'preset_mode')
  const pm = num(A(e, 'pm25')) !== null ? num(A(e, 'pm25')) : num(A(e, 'pm_2_5'))
  const steps = step >= 10 ? Math.round(100 / step) : 0
  return (
    <>
      <div class="pd-cs__sub">{on ? t('On') + (pc ? ' · ' + Math.round(pc) + '%' : '') : t('Off')}{pm !== null ? ' · PM2.5 ' + Math.round(pm as number) : ''}</div>
      <Chips value={on ? 'on' : 'off'} options={[{ value: 'on', label: t('On'), color: '#60a5fa' }, { value: 'off', label: t('Off') }]} onPick={(v) => p.send('power', v === 'on')} />
      {steps > 1 && steps <= 6 ? (
        <>
          <div class="pd-cs__lb">{t('Speed')}</div>
          <Chips
            value={on ? String(Math.round(pc)) : null}
            options={Array.apply(null, Array(steps)).map((_x, i) => ({ value: String(Math.round((i + 1) * step)), label: String(i + 1) }))}
            onPick={(v) => p.send('percentage', parseInt(v, 10))}
          />
        </>
      ) : (
        <Slider label={t('Speed')} min={0} max={100} step={step} value={pc} unit="%" disabled={!on} onCommit={(v) => p.send('percentage', Math.round(v))} />
      )}
      {presets.length ? (
        <>
          <div class="pd-cs__lb">{t('Mode')}</div>
          <Chips value={preset === undefined || preset === null ? null : String(preset)} options={presets.map((m) => ({ value: m, label: lb(FAN_LABEL, m) }))} onPick={(m) => p.send('preset', m)} />
        </>
      ) : null}
    </>
  )
}

const COVER_TEXT: { [k: string]: string } = { open: 'Open', closed: 'Closed', opening: 'Opening…', closing: 'Closing…', stopped: 'Stopped' }

function Cover(p: SheetProps) {
  const e = p.ent
  const pos = p.ovr.position !== undefined ? p.ovr.position : num(A(e, 'current_position'))
  return (
    <>
      <div class="pd-cs__sub">{COVER_TEXT[String(e.state)] ? t(COVER_TEXT[String(e.state)]) : String(e.state)}{pos !== null ? ' · ' + Math.round(pos) + '%' : ''}</div>
      {pos !== null ? <Slider label={t('Position')} min={0} max={100} value={pos} unit="%" onCommit={(v) => p.send('position', Math.round(v))} /> : null}
      <div class="pd-cs__row">
        <Btn label={t('Open')} icon="arrow-up" onClick={() => p.send('open')} />
        <Btn label={t('Stop')} icon="player-stop" onClick={() => p.send('stop')} />
        <Btn label={t('Close')} icon="arrow-down" onClick={() => p.send('close')} />
      </div>
    </>
  )
}

const VAC_TEXT: { [k: string]: string } = { cleaning: 'Cleaning', docked: 'Docked', returning: 'Returning to dock', paused: 'Paused', idle: 'Idle', error: 'Error' }

function Vacuum(p: SheetProps) {
  const e = p.ent
  const st = String(e.state)
  const bat = num(A(e, 'battery_level'))
  return (
    <>
      <div class="pd-cs__sub">{VAC_TEXT[st] ? t(VAC_TEXT[st]) : st}{bat !== null ? ' · ' + t('Battery {0}%', Math.round(bat)) : ''}</div>
      <div class="pd-cs__row">
        <Btn label={t('Start')} icon="player-play" on={st === 'cleaning'} onClick={() => p.send('start')} />
        <Btn label={t('Pause')} icon="player-pause" on={st === 'paused'} onClick={() => p.send('pause')} />
        <Btn label={t('Dock')} icon="home" on={st === 'returning' || st === 'docked'} onClick={() => p.send('dock')} />
      </div>
    </>
  )
}

export const hasSheet = (id: string): boolean => ['climate', 'light', 'fan', 'cover', 'vacuum'].indexOf(id.split('.')[0]) >= 0

export function ControlSheet(p: SheetProps) {
  const dom = p.id.split('.')[0]
  return (
    <div class="pd-modal" role="dialog" aria-label={p.name} onClick={p.onClose}>
      <div class={'pd-modal__panel pd-cs' + (p.short ? ' pd-cs--short' : '')} onClick={(ev) => ev.stopPropagation()}>
        <div class="pd-cs__head">
          <b>{p.name}</b>
          <span class="pd-spacer" />
          <button type="button" class="pd-iconbtn" data-part="button" aria-label={t('Close')} onClick={p.onClose}>
            <Icon name="x" size={18} />
          </button>
        </div>
        {dom === 'climate' ? <Climate {...p} /> : dom === 'light' ? <Light {...p} /> : dom === 'fan' ? <FanCtl {...p} /> : dom === 'cover' ? <Cover {...p} /> : dom === 'vacuum' ? <Vacuum {...p} /> : null}
      </div>
    </div>
  )
}
