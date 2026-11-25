/** When a camera picture is loaded (spec release 0.5, D7). No DOM here, so it can be tested. */

export const CAMERA_VIEW_S = 2
/** A request that has not answered after this long is given up, so one stuck load cannot stop the refreshing. */
export const CAMERA_STUCK_MS = 15000

/** Seconds between a tile's pictures: its own setting, 5 to 60, else 10. */
export function cameraEvery(refresh: number | undefined): number {
  return typeof refresh === 'number' && isFinite(refresh) ? Math.max(5, Math.min(60, Math.round(refresh))) : 10
}

export interface CameraClock {
  /** when the last load started; 0 = never */
  started: number
  loading: boolean
}

/** True when a new picture should be asked for now. Never while off screen; never a second request on top of one under way. */
export function cameraDue(c: CameraClock, now: number, everyS: number, visible: boolean): boolean {
  if (!visible) return false
  if (c.loading) return now - c.started >= CAMERA_STUCK_MS
  return !c.started || now - c.started >= everyS * 1000
}

export function cameraUrl(base: string, entityId: string, stamp: number): string {
  return base + '/api/hass/camera/' + encodeURIComponent(entityId) + '?t=' + stamp
}
