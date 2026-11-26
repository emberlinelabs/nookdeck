/** Pure logic for page swiping and the page dots. No DOM, ES5-safe for Safari 12. */

/**
 * The page a swipe lands on. dir +1 = next page (swipe left), -1 = previous (swipe right). With wrap, next from the last page is the first
 * and previous from the first is the last; without it the ends stay put. One page (or none): always 0.
 */
export function swipeTarget(i: number, dir: number, n: number, wrap: boolean): number {
  if (n <= 1) return 0
  const cur = Math.max(0, Math.min(n - 1, i))
  const next = cur + (dir > 0 ? 1 : dir < 0 ? -1 : 0)
  if (next < 0) return wrap ? n - 1 : 0
  if (next > n - 1) return wrap ? 0 : n - 1
  return next
}

/**
 * A swipe past the first or last page of the native (non-rotated) strip, where the browser cannot scroll further: the jump to make, or -1.
 * dx = finger movement in px (negative = left), dy = vertical, v = speed px/ms. Only a mostly horizontal drag counts.
 */
export function edgeWrap(i: number, n: number, dx: number, dy: number, v: number, wrap: boolean): number {
  if (!wrap || n <= 1) return -1
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return -1
  const far = Math.abs(dx) > 50 || (Math.abs(dx) > 20 && Math.abs(v) > 0.4)
  if (!far) return -1
  if (i >= n - 1 && dx < 0) return 0
  if (i <= 0 && dx > 0) return n - 1
  return -1
}

/** How long the hidden page dots stay visible after the page changes or a swipe starts (ms). */
export const DOTS_FLASH_MS = 1500
/** Page dots: always shown, or only for a moment while swiping (theme.screen.hideDots). */
export function dotsVisible(hide: boolean | undefined, flashUntil: number, now: number): boolean {
  return !hide || flashUntil > now
}
