import { Component, createRef } from 'preact'
import { Icon } from './icon'
import { t } from './i18n'
import { CAMERA_VIEW_S, cameraDue, cameraEvery, cameraUrl } from './camera-logic'
import type { EntityOptions, HassEntity } from './types'

/**
 * Home Assistant camera (spec release 0.5, D7): still pictures from the agent (/api/hass/camera/<id>), never from Home
 * Assistant itself. A tile asks every 10 s (5 to 60) while it can be seen; the large view every 2 s while open. No stream.
 * The phone proves who it is with its pairing cookie, so no token is in the address.
 */

let base = ''
/** The deck's agent address ('' = the page's own). */
export function setCameraBase(b: string) {
  base = b.replace(/\/+$/, '')
}

interface FeedProps {
  id: string
  every: number
  /** the manage preview: one picture, no refreshing */
  once?: boolean
  /** extra class of the picture */
  fit: 'cover' | 'contain'
}
interface FeedState { src: string; failed: boolean }

/** The picture: loads off screen first and swaps when ready, so it never flashes; keeps the last good one when a load fails. */
class CameraFeed extends Component<FeedProps, FeedState> {
  state: FeedState = { src: '', failed: false }
  private el = createRef<HTMLDivElement>()
  private timer: number | undefined
  private started = 0
  private loading: HTMLImageElement | null = null

  componentDidMount() {
    document.addEventListener('visibilitychange', this.watch)
    this.watch()
  }
  componentDidUpdate(prev: FeedProps) {
    if (prev.id !== this.props.id) {
      this.drop()
      this.started = 0
      this.setState({ src: '', failed: false })
    }
  }
  componentWillUnmount() {
    document.removeEventListener('visibilitychange', this.watch)
    this.stop()
    this.drop()
  }

  /** No timer at all while the page is hidden. */
  private watch = () => {
    this.stop()
    if (document.visibilityState === 'hidden') return
    this.tick()
    // a short beat, so a tile that comes on screen (a swipe) does not wait a whole period
    this.timer = window.setInterval(this.tick, 500)
  }
  private stop() {
    if (this.timer !== undefined) window.clearInterval(this.timer)
    this.timer = undefined
  }
  private drop() {
    const img = this.loading
    this.loading = null
    if (img) img.onload = img.onerror = null
  }

  private tick = () => {
    const now = Date.now()
    if (this.props.once && this.started) return
    if (!cameraDue({ started: this.started, loading: !!this.loading }, now, this.props.every, onScreen(this.el.current))) return
    this.drop()
    this.started = now
    const img = new Image()
    const url = cameraUrl(base, this.props.id, now)
    img.onload = () => {
      this.loading = null
      this.setState({ src: url, failed: false })
    }
    img.onerror = () => {
      this.loading = null
      this.setState({ failed: true })
    }
    this.loading = img
    img.src = url
  }

  render() {
    const s = this.state
    return (
      <div ref={this.el} class="pd-cam__feed">
        {s.src ? <img class={'pd-cam__img pd-cam__img--' + this.props.fit} src={s.src} alt="" draggable={false} /> : null}
        {!s.src ? <span class="pd-cam__wait">{s.failed ? t('No picture') : <Icon name="video" size={26} />}</span> : null}
        {s.src && s.failed ? <span class="pd-cam__old">{t('Old picture')}</span> : null}
      </div>
    )
  }
}

/** The element is really in front of the viewer: inside the window and not behind the standby clock or a sheet. */
function onScreen(el: HTMLElement | null): boolean {
  if (!el) return false
  const r = el.getBoundingClientRect()
  const x = r.left + r.width / 2
  const y = r.top + r.height / 2
  if (!r.width || !r.height || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
  const top = document.elementFromPoint(x, y)
  if (!top) return false
  // the night dim only darkens the picture, and its tap catcher must not stop it
  return el.contains(top) || (top as Element).classList.contains('pd-dim')
}

export interface CameraTileProps {
  id: string
  cfg: EntityOptions
  ent?: HassEntity
  connected: boolean
  showLabel: boolean
  preview?: boolean
}

export function CameraTile(props: CameraTileProps) {
  const name = props.cfg.name || (props.ent && props.ent.name) || props.id
  const gone = !props.ent || props.ent.state === 'unavailable'
  return (
    <div class="pd-cam" aria-label={name}>
      {gone || !props.connected ? (
        <div class="pd-cam__feed"><span class="pd-cam__wait">{!props.connected ? t('HA offline') : t('Unavailable')}</span></div>
      ) : (
        <CameraFeed id={props.id} every={cameraEvery(props.cfg.refresh)} once={props.preview} fit="cover" />
      )}
      {props.showLabel || props.cfg.name ? <span class="pd-cam__name" data-part="tile-label">{name}</span> : null}
    </div>
  )
}

/** The large view over the deck; tap anywhere or Close to leave. */
export function CameraView(props: { id: string; name: string; onClose: () => void }) {
  return (
    <div class="pd-camview" role="dialog" aria-modal="true" aria-label={props.name} onClick={props.onClose}>
      <CameraFeed id={props.id} every={CAMERA_VIEW_S} fit="contain" />
      <div class="pd-camview__bar">
        <span class="pd-camview__name">{props.name}</span>
        <button type="button" class="pd-camview__x" aria-label={t('Close')} onClick={props.onClose}>
          <Icon name="x" size={22} />
        </button>
      </div>
    </div>
  )
}
