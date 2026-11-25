import { locale } from './i18n'
import { clockText, dayMs, hourText, minutes, monthCells, monthLayout, weekLayout, type WeekColumn, type WeekLayout } from './card-calendar-logic'
import type { CardNode, CardTone, CardWeekEvent } from '../../../src/plugins/card'

/**
 * The `month` and `week` card parts (C4): read-only, drawn natively with the theme's tokens. Each takes the free space and
 * fits itself to the box card.tsx measured (nothing in one counts as overflow of the card around it). Layout is
 * card-calendar-logic.ts. Safari 12: no flex gap, no `inset`, tints are a layer with opacity.
 */

export interface CalBox { w: number; h: number; base: number }

interface Paint {
  /** the colour of a tone; `fallback` for "default" and none */
  tone: (t: CardTone | undefined, fallback: string) => string
  accent: string
  textColor?: string
}

const intl = (day: string, o: Intl.DateTimeFormatOptions): string => {
  const opts = { ...o, timeZone: 'UTC' }
  try {
    return new Intl.DateTimeFormat(locale(), opts).format(new Date(dayMs(day)))
  } catch (e) {
    return day
  }
}

const px = (n: number): string => n + 'px'

export function CardMonth(props: { node: Extract<CardNode, { t: 'month' }>; path: string; box?: CalBox; paint: Paint }) {
  const n = props.node
  const start = n.weekStart === 0 ? 0 : 1
  const cells = monthCells(n.month, start)
  const weeks = cells.length / 7
  const name = intl(n.month + '-01', { month: 'long', year: 'numeric' })
  const l = props.box ? monthLayout(props.box.w, props.box.h, weeks, props.box.base) : null
  const marks: { [date: string]: (CardTone | undefined)[] } = {}
  const list = n.marks || []
  for (let i = 0; i < list.length; i++) {
    const had = marks[list[i].date] || (marks[list[i].date] = [])
    if (had.length < 3) had.push(list[i].tone)
  }
  const rows: (string | null)[][] = []
  for (let i = 0; i < weeks; i++) rows.push(cells.slice(i * 7, i * 7 + 7))
  return (
    <span class="pd-pcard__cal pd-pcard__cal--month" data-cal={props.path} data-weeks={weeks} role="img" aria-label={name}>
      {l ? (
        <span class="pd-pcard__cin pd-pcard__cin--month" style={{ fontSize: px(l.font), color: props.paint.textColor }}>
          <span class="pd-pcard__c-grid" style={{ width: px(l.gridW) }}>
            {l.title ? <span class="pd-pcard__c-title" style={{ height: px(l.headH), lineHeight: px(l.headH) }}>{name}</span> : null}
            <span class="pd-pcard__c-line pd-pcard__c-wd" style={{ height: px(l.headH), lineHeight: px(l.headH) }}>
              {rows[0].map((_, i) => <span key={i} class="pd-pcard__c-cell">{intl('2026-01-' + (4 + start + i < 10 ? '0' : '') + (4 + start + i), { weekday: 'narrow' })}</span>)}
            </span>
            {rows.map((week, w) => (
              <span key={w} class="pd-pcard__c-line" style={{ height: px(l.rowH) }}>
                {week.map((day, i) => {
                  if (!day) return <span key={i} class="pd-pcard__c-cell" />
                  const picked = day === n.selected
                  const today = day === n.today
                  const dots = marks[day]
                  return (
                    <span key={i} class="pd-pcard__c-cell">
                      <span
                        class={'pd-pcard__c-num' + (today ? ' pd-pcard__c-num--today' : '') + (picked ? ' pd-pcard__c-num--picked' : '')}
                        style={{ width: px(l.d), height: px(l.d), lineHeight: px(today && !picked ? l.d - 3 : l.d), borderColor: today && !picked ? props.paint.accent : undefined, background: picked ? props.paint.accent : undefined }}
                      >
                        {+day.slice(8)}
                      </span>
                      {dots ? (
                        <span class={'pd-pcard__c-dots' + (l.dotRoom ? '' : ' pd-pcard__c-dots--on')} style={{ marginTop: l.dotRoom ? '1px' : '-4px' }}>
                          {dots.map((t, k) => <i key={k} style={{ background: props.paint.tone(t, props.paint.accent) }} />)}
                        </span>
                      ) : l.dotRoom ? <span class="pd-pcard__c-dots" style={{ marginTop: '1px' }} /> : null}
                    </span>
                  )
                })}
              </span>
            ))}
          </span>
        </span>
      ) : null}
    </span>
  )
}

export function CardWeek(props: { node: Extract<CardNode, { t: 'week' }>; path: string; box?: CalBox; paint: Paint }) {
  const n = props.node
  const l = props.box ? weekLayout(n, props.box.w, props.box.h, props.box.base) : null
  return (
    <span class="pd-pcard__cal pd-pcard__cal--week" data-cal={props.path} role="group" aria-label={intl(n.start, { month: 'long', day: 'numeric' })}>
      {l ? <span class={'pd-pcard__cin pd-pcard__cin--week pd-pcard__cin--' + l.mode} style={{ fontSize: px(l.font), lineHeight: px(l.lineH), color: props.paint.textColor }}>{week(n, l, props.box as CalBox, props.paint)}</span> : null}
    </span>
  )
}

function week(n: Extract<CardNode, { t: 'week' }>, l: WeekLayout, box: CalBox, paint: Paint) {
  const hour24 = n.hour24 !== false
  const colW = (box.w - l.gutter) / l.columns.length
  const gutter = l.gutter ? <span class="pd-pcard__c-gutter" style={{ width: px(l.gutter) }} /> : null
  const head = (
    <span class="pd-pcard__c-line pd-pcard__c-head" style={{ height: px(l.headH) }}>
      {gutter}
      {l.columns.map((c) => {
        const d = Math.round(l.font * 1.75)
        return (
          <span key={c.date} class="pd-pcard__c-col">
            <span class="pd-pcard__c-dow">{intl(c.date, { weekday: colW < 34 ? 'narrow' : 'short' })}</span>
            <span class={'pd-pcard__c-date' + (c.today ? ' pd-pcard__c-date--today' : '')} style={{ width: px(d), height: px(d), lineHeight: px(d), background: c.today ? paint.accent : undefined }}>{+c.date.slice(8)}</span>
          </span>
        )
      })}
    </span>
  )
  const color = (e: CardWeekEvent) => paint.tone(e.tone, paint.accent)
  const title = (e: CardWeekEvent) => <span class={'pd-pcard__c-t' + (e.tone === 'muted' ? ' pd-pcard__c-t--quiet' : '')} style={{ color: e.tone === 'muted' ? undefined : paint.textColor }}>{e.title}</span>
  const chip = (e: CardWeekEvent, k: number) => (
    <span key={'a' + k} class="pd-pcard__c-ev pd-pcard__c-chip" style={{ color: color(e), height: px(l.lineH + 1) }}>
      <i />
      {title(e)}
    </span>
  )
  const more = (c: WeekColumn) => (c.more ? <span class="pd-pcard__c-more" style={{ height: px(l.lineH) }}>+{c.more}</span> : null)

  if (l.mode === 'list') {
    return [
      head,
      <span key="body" class="pd-pcard__c-line pd-pcard__c-body" style={{ height: px(l.gridH) }}>
        {l.columns.map((c) => (
          <span key={c.date} class="pd-pcard__c-col pd-pcard__c-day">
            {c.list.map((x, k) =>
              x.start === null ? chip(x.ev, k) : (
                <span key={k} class="pd-pcard__c-entry">
                  {l.timeLine ? <b style={{ color: color(x.ev) }}>{clockText(x.start, hour24)}</b> : null}
                  {title(x.ev)}
                </span>
              ),
            )}
            {more(c)}
          </span>
        ))}
      </span>,
    ]
  }

  const hourPx = l.gridH / (l.to - l.from)
  const hours: number[] = []
  for (let h = l.from; h < l.to; h++) hours.push(h)
  const every = hourPx >= l.lineH * 1.5 ? 1 : 2
  const now = n.now ? minutes(n.now) : -1
  return [
    head,
    l.stripH ? (
      <span key="strip" class="pd-pcard__c-line pd-pcard__c-strip" style={{ height: px(l.stripH) }}>
        {gutter}
        {l.columns.map((c) => <span key={c.date} class="pd-pcard__c-col pd-pcard__c-day">{c.allDay.map(chip)}</span>)}
      </span>
    ) : null,
    <span key="grid" class="pd-pcard__c-line pd-pcard__c-time" style={{ height: px(l.gridH) }}>
      <span class="pd-pcard__c-gutter" style={{ width: px(l.gutter) }}>
        {hours.map((h, i) => (i % every ? null : <span key={h} class="pd-pcard__c-hour" style={{ top: px(i * hourPx) }}>{hourText(h, hour24)}</span>))}
      </span>
      {hours.map((h, i) => <span key={'r' + h} class="pd-pcard__c-rule" style={{ top: px(i * hourPx), left: px(l.gutter) }} />)}
      {l.columns.map((c) => (
        <span key={c.date} class="pd-pcard__c-col pd-pcard__c-slot">
          {c.blocks.map((b, k) => (
            <span
              key={k}
              class="pd-pcard__c-ev pd-pcard__c-block"
              style={{ color: color(b.ev), top: px(b.top), height: px(Math.max(1, b.height - 1)), left: (b.lane / b.lanes) * 100 + '%', width: 100 / b.lanes + '%' }}
            >
              <i />
              {title(b.ev)}
              {b.height >= l.lineH * 2 ? <small>{clockText(b.start, hour24)}</small> : null}
            </span>
          ))}
          {c.today && now >= l.from * 60 && now <= l.to * 60 ? <span class="pd-pcard__c-now" style={{ top: px(((now - l.from * 60) / 60) * hourPx) }} /> : null}
        </span>
      ))}
    </span>,
    l.footH ? (
      <span key="foot" class="pd-pcard__c-line" style={{ height: px(l.footH) }}>
        {gutter}
        {l.columns.map((c) => <span key={c.date} class="pd-pcard__c-col">{more(c)}</span>)}
      </span>
    ) : null,
  ]
}
