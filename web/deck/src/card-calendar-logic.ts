/**
 * Where everything goes in a `month` and a `week` card part, for a box of a given size in px. Pure (card-calendar.tsx draws
 * it), and Safari 12 syntax. Dates are handled as UTC days so that the phone's own time zone cannot move one: what is
 * "today" and "now" comes from the card.
 */
import type { CardWeekEvent } from '../../../src/plugins/card'

const DAY_MS = 86400000
export const dayMs = (day: string): number => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))
const two = (n: number): string => (n < 10 ? '0' + n : '' + n)
export function dayText(ms: number): string {
  const d = new Date(ms)
  return d.getUTCFullYear() + '-' + two(d.getUTCMonth() + 1) + '-' + two(d.getUTCDate())
}

// ------------------------------------------------------------------------------------------------ month

/*!
 * The month and week card parts take their look, and the month grid its arithmetic, from the free `calendar` and
 * `day-agenda` items of Knowns UI (https://github.com/knowns-dev/knowns-ui), MIT License, Copyright (c) 2026 Knowns Lab.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and
 * this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
 * "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
 * ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
/** The days of "YYYY-MM" in weeks starting on `weekStart`: null before the 1st and after the last; only the weeks needed. */
export function monthCells(month: string, weekStart: number): (string | null)[] {
  const y = +month.slice(0, 4)
  const m = +month.slice(5, 7) - 1
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() - weekStart + 7) % 7
  const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const cells: (string | null)[] = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= count; d++) cells.push(month + '-' + two(d))
  while (cells.length % 7) cells.push(null)
  return cells
}

export interface MonthLayout {
  /** the month's name is drawn */
  title: boolean
  /** height of the name and of the weekday letters, px */
  headH: number
  rowH: number
  /** the grid is no wider than this, and centred */
  gridW: number
  /** the circle of a day, px */
  d: number
  font: number
  /** dots have their own room under the circle; otherwise they sit on its bottom edge */
  dotRoom: boolean
}

/** Short of height, the room under the circles for dots goes first, then the month's name. */
export function monthLayout(w: number, h: number, weeks: number, base: number): MonthLayout {
  const head = Math.round(Math.max(10, Math.min(16, base * 1.25)))
  const rowFor = (title: boolean): number => (h - head * (title ? 2 : 1)) / weeks
  let title = true
  let dotRoom = rowFor(true) >= 19
  if (!dotRoom && rowFor(true) < 13) {
    title = false
    dotRoom = rowFor(false) >= 19
  }
  const colW = w / 7
  // on a tall box the weeks stay together: a row is not much higher than a day is wide
  const rowH = Math.max(0, Math.min(rowFor(title), Math.max(colW * 1.35, 24)))
  const d = Math.max(0, Math.floor(Math.min(rowH - (dotRoom ? 5 : 1), colW - 1, 30)))
  return {
    title,
    headH: head,
    rowH,
    gridW: Math.min(w, Math.floor(Math.max(rowH * 1.5, 14) * 7)),
    d,
    font: Math.max(8, Math.min(15, Math.round(d * 0.54 * 2) / 2)),
    dotRoom,
  }
}

/** Beside other parts in a row, a month is about as wide as it is high (square days), and at most 45% of the row. */
export function monthWidth(rowW: number, rowH: number, weeks: number): number {
  return Math.max(0, Math.floor(Math.min((rowH * 7) / (weeks + 2), rowW * 0.45)))
}

// ------------------------------------------------------------------------------------------------ week

export const minutes = (t: string): number => +t.slice(0, 2) * 60 + +t.slice(3, 5)

/** "09:30", or "9:30 AM". */
export function clockText(min: number, hour24: boolean): string {
  const h = Math.floor(min / 60) % 24
  const m = two(min % 60)
  if (hour24) return two(h) + ':' + m
  return (h % 12 || 12) + ':' + m + (h < 12 ? ' AM' : ' PM')
}
export const hourText = (h: number, hour24: boolean): string => (hour24 ? two(h % 24) + ':00' : (h % 12 || 12) + (h % 24 < 12 ? ' AM' : ' PM'))

/** An hour of the grid is at least this high; with less room the week is a list for each day. */
export const HOUR_MIN_PX = 18
/** Two events side by side each need this much width. */
export const LANE_MIN_PX = 28
const GRID_ALLDAY_ROWS = 2
const SPAN_MIN = 6

interface Timed { ev: CardWeekEvent; start: number; end: number }

export interface Block {
  ev: CardWeekEvent
  /** minutes of the day */
  start: number
  /** px from the top of the grid, and px high */
  top: number
  height: number
  lane: number
  lanes: number
}

export interface WeekColumn {
  date: string
  today: boolean
  allDay: CardWeekEvent[]
  /** grid */
  blocks: Block[]
  /** list: in the order drawn; start is null for all-day */
  list: { ev: CardWeekEvent; start: number | null }[]
  /** what is not shown here, the card's own `more` included */
  more: number
}

/** A line of a week with no timed events: an all-day event and the day, or the run of days, it is on. */
export interface DayRow { ev: CardWeekEvent; from: string; to: string }

export interface WeekLayout {
  /** "days": no event is timed, so there are no hours and no columns under the headers, only a line for each event */
  mode: 'grid' | 'list' | 'days'
  /** days only: the lines drawn, how many events found none, and the height the whole part would take with all of them */
  rows: DayRow[]
  rowH: number
  rowsMore: number
  natural: number
  font: number
  lineH: number
  headH: number
  /** grid only: the hour labels' width, the all-day strip's and the hours' heights, and the hours shown */
  gutter: number
  stripH: number
  gridH: number
  footH: number
  from: number
  to: number
  /** list only: a timed event takes two lines (time, title), or one (title) */
  timeLine: boolean
  columns: WeekColumn[]
}

export interface WeekInput {
  start: string
  days?: number
  today?: string
  from?: number
  to?: number
  hour24?: boolean
  events: CardWeekEvent[]
  more?: number[]
}

const endOf = (e: CardWeekEvent): number => (e.end ? minutes(e.end) : Math.min(1440, minutes(e.start as string) + 60))
const quiet = (e: CardWeekEvent): number => (e.tone === 'muted' ? 1 : 0)

/** The hours the grid shows: what was asked for, else the events' own span, at least six hours. */
export function hourSpan(events: CardWeekEvent[], from?: number, to?: number): { from: number; to: number } {
  let lo = 24
  let hi = 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.allDay) continue
    lo = Math.min(lo, Math.floor(minutes(e.start as string) / 60))
    hi = Math.max(hi, Math.ceil(endOf(e) / 60))
  }
  if (hi <= lo) { lo = 9; hi = 17 }
  if (from !== undefined) { lo = from; if (to === undefined) hi = Math.max(hi, Math.min(24, from + SPAN_MIN)) }
  if (to !== undefined) { hi = to; if (from === undefined) lo = Math.min(lo, Math.max(0, to - SPAN_MIN)) }
  if (from === undefined && to === undefined && hi - lo < SPAN_MIN) {
    hi = Math.min(24, lo + SPAN_MIN)
    lo = Math.max(0, hi - SPAN_MIN)
  }
  return { from: lo, to: Math.max(lo + 1, hi) }
}

/**
 * One day of the grid. A block is at least a line high, so short events that follow each other count as overlapping. Events
 * that are over (tone "muted") are placed after the others, so they are the ones to give way. Returns how many found no lane.
 */
export function placeBlocks(events: Timed[], from: number, to: number, hourPx: number, lineH: number, maxLanes: number): { blocks: Block[]; hidden: number } {
  const lo = from * 60
  const hi = to * 60
  const least = (lineH / hourPx) * 60
  const order = events.slice().sort((a, b) => quiet(a.ev) - quiet(b.ev) || a.start - b.start || b.end - a.end)
  const placed: { t: Timed; a: number; b: number; lane: number }[] = []
  let hidden = 0
  for (let i = 0; i < order.length; i++) {
    const t = order[i]
    if (t.end <= lo || t.start >= hi) { hidden++; continue }
    const a = Math.max(lo, Math.min(t.start, hi - least))
    const b = Math.min(hi, Math.max(t.end, a + least))
    let lane = 0
    while (lane < maxLanes && placed.some((p) => p.lane === lane && p.a < b && a < p.b)) lane++
    if (lane === maxLanes) { hidden++; continue }
    placed.push({ t, a, b, lane })
  }
  placed.sort((x, y) => x.a - y.a || x.lane - y.lane)
  // events that overlap, directly or through another, share the width
  const blocks: Block[] = []
  let first = 0
  let until = -1
  let lanes = 1
  const close = (end: number) => { for (let k = first; k < end; k++) blocks[k].lanes = lanes }
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i]
    if (p.a >= until) { close(i); first = i; lanes = 1 }
    until = Math.max(until, p.b)
    lanes = Math.max(lanes, p.lane + 1)
    blocks.push({ ev: p.t.ev, start: p.t.start, top: ((p.a - lo) / 60) * hourPx, height: ((p.b - p.a) / 60) * hourPx, lane: p.lane, lanes: 1 })
  }
  close(blocks.length)
  return { blocks, hidden }
}

/**
 * One day of the list, in `room` px: all-day events first, then by the clock. When not everything fits, a line is kept for
 * "+n" and events are taken in that order, the ones that are over last.
 */
export function fillList(allDay: CardWeekEvent[], timed: Timed[], room: number, lineH: number, timeLine: boolean, alsoHidden: number): { list: WeekColumn['list']; hidden: number } {
  const items: { ev: CardWeekEvent; start: number | null; h: number; at: number }[] = []
  for (let i = 0; i < allDay.length; i++) items.push({ ev: allDay[i], start: null, h: lineH + 4, at: items.length })
  for (let i = 0; i < timed.length; i++) items.push({ ev: timed[i].ev, start: timed[i].start, h: lineH * (timeLine ? 2 : 1) + 3, at: items.length })
  let all = 0
  for (let i = 0; i < items.length; i++) all += items[i].h
  const left0 = all <= room && !alsoHidden ? room : room - lineH
  const order = items.slice().sort((a, b) => quiet(a.ev) - quiet(b.ev) || a.at - b.at)
  const taken: typeof items = []
  let left = left0
  for (let i = 0; i < order.length && order[i].h <= left; i++) {
    left -= order[i].h
    taken.push(order[i])
  }
  taken.sort((a, b) => a.at - b.at)
  return { list: taken.map((x) => ({ ev: x.ev, start: x.start })), hidden: items.length - taken.length }
}

/** One line for each all-day event; the same one on days that follow each other is a single line. In order of the first day. */
export function dayRows(days: { date: string; allDay: CardWeekEvent[] }[]): DayRow[] {
  const rows: (DayRow & { last: number })[] = []
  for (let i = 0; i < days.length; i++) {
    for (let k = 0; k < days[i].allDay.length; k++) {
      const ev = days[i].allDay[k]
      let run: (DayRow & { last: number }) | null = null
      for (let r = 0; r < rows.length && !run; r++) if (rows[r].last === i - 1 && rows[r].ev.title === ev.title && rows[r].ev.tone === ev.tone) run = rows[r]
      if (run) {
        run.to = days[i].date
        run.last = i
      } else rows.push({ ev, from: days[i].date, to: days[i].date, last: i })
    }
  }
  return rows.map((r) => ({ ev: r.ev, from: r.from, to: r.to }))
}

export function weekLayout(input: WeekInput, w: number, h: number, base: number): WeekLayout {
  const days = input.days || 7
  const hour24 = input.hour24 !== false
  const font = Math.max(9, Math.min(13, w / days < 58 ? base * 0.8 : base * 0.9))
  const lineH = Math.round(font * 1.28)
  const headH = Math.round(lineH + font * 1.75 + 3)
  const first = dayMs(input.start)
  const perDay: { date: string; allDay: CardWeekEvent[]; timed: Timed[]; extra: number }[] = []
  for (let i = 0; i < days; i++) perDay.push({ date: dayText(first + i * DAY_MS), allDay: [], timed: [], extra: (input.more && input.more[i]) || 0 })
  for (let i = 0; i < input.events.length; i++) {
    const e = input.events[i]
    const day = perDay[e.day]
    if (!day) continue
    if (e.allDay) day.allDay.push(e)
    else day.timed.push({ ev: e, start: minutes(e.start as string), end: endOf(e) })
  }
  for (let i = 0; i < days; i++) perDay[i].timed.sort((a, b) => a.start - b.start || a.end - b.end)
  const none = { rows: [] as DayRow[], rowH: 0, rowsMore: 0, natural: 0 }

  if (perDay.every((d) => !d.timed.length)) {
    const all = dayRows(perDay)
    const extra = perDay.reduce((n, d) => n + d.extra, 0)
    const rowH = lineH + 6
    const gap = 6
    // from the width and the events alone, never from h: the part is held to this height, and then measured again
    const natural = headH + (all.length || extra ? gap + all.length * rowH + (extra ? lineH : 0) : 0)
    const room = h - headH - gap
    const fit = !extra && all.length * rowH <= room ? all.length : Math.max(0, Math.min(all.length, Math.floor((room - lineH) / rowH)))
    // the ones that are over give way first
    const keep = all.slice().sort((a, b) => quiet(a.ev) - quiet(b.ev)).slice(0, fit)
    const rows = all.filter((r) => keep.indexOf(r) >= 0)
    const columns = perDay.map((d) => ({ date: d.date, today: d.date === input.today, allDay: [], blocks: [], list: [], more: 0 }))
    return { mode: 'days', rows, rowH, rowsMore: extra + all.length - rows.length, natural, font, lineH, headH, gutter: 0, stripH: 0, gridH: 0, footH: 0, from: 0, to: 0, timeLine: false, columns }
  }

  const span = hourSpan(input.events, input.from, input.to)
  const gutter = Math.round(font * (hour24 ? 3.1 : 3.6))
  const colW = (w - gutter) / days
  let rows = 0
  for (let i = 0; i < days; i++) rows = Math.max(rows, Math.min(GRID_ALLDAY_ROWS, perDay[i].allDay.length))
  const stripH = rows ? rows * (lineH + 3) : 0
  const maxLanes = colW / 2 >= LANE_MIN_PX ? 2 : 1

  const grid = (footH: number): WeekLayout | null => {
    const gridH = h - headH - stripH - footH
    const hourPx = gridH / (span.to - span.from)
    if (hourPx < HOUR_MIN_PX) return null
    const columns = perDay.map((d) => {
      const placed = placeBlocks(d.timed, span.from, span.to, hourPx, lineH, maxLanes)
      const strip = d.allDay.slice().sort((a, b) => quiet(a) - quiet(b)).slice(0, GRID_ALLDAY_ROWS)
      return { date: d.date, today: d.date === input.today, allDay: strip, blocks: placed.blocks, list: [], more: d.extra + placed.hidden + d.allDay.length - strip.length }
    })
    return { ...none, mode: 'grid', font, lineH, headH, gutter, stripH, gridH, footH, from: span.from, to: span.to, timeLine: true, columns }
  }
  let out = grid(0)
  if (out && out.columns.some((c) => c.more > 0)) out = grid(lineH)
  if (out) return out

  const room = Math.max(0, h - headH)
  // too low for even two timed events of two lines: titles alone
  const timeLine = room >= lineH * 5
  const columns = perDay.map((d) => {
    const filled = fillList(d.allDay, d.timed, room, lineH, timeLine, d.extra)
    return { date: d.date, today: d.date === input.today, allDay: [], blocks: [], list: filled.list, more: d.extra + filled.hidden }
  })
  return { ...none, mode: 'list', font, lineH, headH, gutter: 0, stripH: 0, gridH: room, footH: 0, from: span.from, to: span.to, timeLine, columns }
}
