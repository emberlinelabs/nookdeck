import { describe, expect, test } from "bun:test";
import { CARD_LIMITS, card, validateCard } from "../src/plugins/card";
import { unknownCardIcons } from "../src/plugins/card-icons";
import {
  HOUR_MIN_PX, clockText, fillList, hourSpan, hourText, monthCells, monthLayout, monthWidth, placeBlocks, weekLayout,
} from "../web/deck/src/card-calendar-logic";
import type { CardWeekEvent } from "../src/plugins/card";

const err = (node: unknown): string => { const r = validateCard({ root: node }); return "error" in r ? r.error : ""; };
const ev = (start: string, end: string | undefined, title = "x", more: Partial<CardWeekEvent> = {}): CardWeekEvent => ({ day: 0, start, ...(end ? { end } : {}), title, ...more });
const timed = (a: number, b: number, title: string, tone?: "muted") => ({ ev: { day: 0, title, ...(tone ? { tone } : {}) } as CardWeekEvent, start: a * 60, end: b * 60 });

describe("month and week: the check", () => {
  test("every field passes and comes back unchanged", () => {
    const month = card.month("2026-11", { today: "2026-11-25", selected: "2026-11-27", weekStart: 0, marks: [{ date: "2026-11-27", tone: "ok" }, { date: "2026-12-01" }] });
    const week = card.week("2026-11-23", [
      { day: 0, start: "09:30", end: "10:00", title: "Plan", tone: "muted" },
      { day: 3, allDay: true, title: "Release", tone: "accent" },
      { day: 6, start: "23:00", end: "24:00", title: "Late" },
      { day: 2, start: "08:00", title: "No end" },
    ], { days: 7, today: "2026-11-25", now: "16:20", hour24: false, from: 8, to: 24, more: [0, 2] });
    const data = card.root(card.col([month, week]));
    expect(validateCard(data)).toEqual({ data });
    expect(unknownCardIcons(data.root)).toEqual([]);
  });
  test("dates must be in the calendar", () => {
    expect(err({ t: "month", month: "2026-13" })).toContain("a month like");
    expect(err({ t: "month", month: "2026-11", today: "2026-11-31" })).toContain("a date like");
    expect(err({ t: "month", month: "2026-02", selected: "2026-02-29" })).toContain("a date like");
    expect(err({ t: "month", month: "2028-02", selected: "2028-02-29" })).toBe("");
    expect(err({ t: "week", start: "23/11/2026", events: [] })).toContain("a date like");
  });
  test("limits: marks, events, title, more", () => {
    const marks = (n: number) => ({ t: "month", month: "2026-11", marks: Array(n).fill({ date: "2026-11-01" }) });
    expect(err(marks(CARD_LIMITS.marks))).toBe("");
    expect(err(marks(CARD_LIMITS.marks + 1))).toContain("at most 62");
    const events = (n: number) => ({ t: "week", start: "2026-11-23", events: Array(n).fill({ day: 0, allDay: true, title: "a" }) });
    expect(err(events(40))).toBe("");
    expect(err(events(41))).toContain("at most 40");
    expect(err({ t: "week", start: "2026-11-23", events: [{ day: 0, allDay: true, title: "a".repeat(81) }] })).toContain("longer than 80");
    const more = (m: unknown) => ({ t: "week", start: "2026-11-23", days: 2, events: [], more: m });
    expect(err(more([999, 0]))).toBe("");
    for (const m of [[1, 2, 3], [-1], [1.5], [1000], 4]) expect(err(more(m))).not.toBe("");
  });
  test("an event's times", () => {
    const one = (e: object, extra: object = {}) => err({ t: "week", start: "2026-11-23", events: [{ day: 0, title: "a", ...e }], ...extra });
    expect(one({ start: "09:00" })).toBe("");
    expect(one({})).toContain("start must be a time");
    expect(one({ allDay: true, start: "09:00" })).toContain("no start or end");
    expect(one({ start: "24:00" })).toContain("a time like");
    expect(one({ start: "9:00" })).toContain("a time like");
    expect(one({ start: "10:00", end: "10:00" })).toContain("after its start");
    expect(one({ start: "22:00", end: "01:00" })).toContain("over midnight");
    expect(one({ start: "09:00", day: 7 })).toContain("from 0 to 6");
    expect(one({ start: "09:00", day: 2 }, { days: 2 })).toContain("from 0 to 1");
    expect(one({ start: "09:00", color: "red" })).toContain("not one of its fields");
    expect(one({ start: "09:00" }, { from: 10, to: 10 })).toContain("after from");
    expect(one({ start: "09:00" }, { days: 8 })).toContain("from 1 to 7");
  });
  test("each counts as one part, however much is in it", () => {
    const full = { t: "week", start: "2026-11-23", events: Array(40).fill({ day: 1, start: "09:00", title: "a".repeat(80) }) };
    expect(err({ t: "col", children: [full, ...Array(58).fill({ t: "spacer" })] })).toBe("");
  });
});

describe("month: layout", () => {
  test("only the weeks the month needs, from either first day", () => {
    const nov = monthCells("2026-11", 1);
    expect([nov.length, nov.indexOf("2026-11-01"), nov[nov.length - 1]]).toEqual([42, 6, null]);
    expect(monthCells("2026-11", 0).length).toBe(35);
    expect(monthCells("2027-02", 1).length).toBe(28);
  });
  test("short of height, the dots' room goes first, then the name", () => {
    expect(monthLayout(220, 220, 6, 14)).toMatchObject({ title: true, dotRoom: true });
    expect(monthLayout(200, 130, 6, 12)).toMatchObject({ title: true, dotRoom: false });
    expect(monthLayout(150, 90, 6, 11)).toMatchObject({ title: false });
    // a tall narrow box does not spread the weeks out
    expect(monthLayout(150, 300, 6, 12).rowH).toBeLessThanOrEqual(29);
    const l = monthLayout(400, 200, 5, 14);
    expect(l.d).toBeLessThanOrEqual(30);
    expect(l.gridW).toBeLessThan(400);
  });
  test("beside other parts it takes about its height, at most 45% of the row", () => {
    expect(monthWidth(500, 210, 5)).toBe(210);
    expect(monthWidth(300, 260, 5)).toBe(135);
  });
});

describe("week: layout", () => {
  test("the hours shown come from the events, at least six", () => {
    expect(hourSpan([ev("09:30", "11:00"), ev("15:00", "17:15")])).toEqual({ from: 9, to: 18 });
    expect(hourSpan([ev("10:00", "11:00")])).toEqual({ from: 10, to: 16 });
    expect(hourSpan([ev("22:00", "24:00")])).toEqual({ from: 18, to: 24 });
    expect(hourSpan([{ day: 0, allDay: true, title: "a" }])).toEqual({ from: 9, to: 17 });
    expect(hourSpan([ev("09:00", "10:00")], 6, 20)).toEqual({ from: 6, to: 20 });
  });
  test("overlaps: two lanes side by side, the rest counted; one lane in a narrow column", () => {
    const three = [timed(9, 11, "a"), timed(9, 11, "b"), timed(10, 12, "c"), timed(13, 14, "d")];
    const two = placeBlocks(three, 8, 16, 30, 14, 2);
    expect(two.blocks.map((b) => [b.ev.title, b.lane, b.lanes])).toEqual([["a", 0, 2], ["b", 1, 2], ["d", 0, 1]]);
    expect(two.hidden).toBe(1);
    expect(two.blocks[0]).toMatchObject({ top: 30, height: 60 });
    expect(placeBlocks(three, 8, 16, 30, 14, 1).hidden).toBe(2);
  });
  test("events that are over give way; short ones are at least a line high; outside the hours is counted", () => {
    expect(placeBlocks([timed(9, 10, "past", "muted"), timed(9.5, 10.5, "next")], 8, 16, 30, 14, 1).blocks.map((b) => b.ev.title)).toEqual(["next"]);
    expect(placeBlocks([timed(9, 9.1, "tiny")], 8, 16, 28, 14, 1).blocks[0]!.height).toBe(14);
    expect(placeBlocks([timed(5, 6, "early"), timed(7, 9, "partly")], 8, 16, 30, 14, 1)).toMatchObject({ hidden: 1, blocks: [{ top: 0, height: 30 }] });
    // one that would hang below the last hour moves up into it
    const last = placeBlocks([timed(15.9, 16, "late")], 8, 16, 28, 14, 1).blocks[0]!;
    expect(last.top + last.height).toBeCloseTo(8 * 28);
  });
  const events: CardWeekEvent[] = [
    { day: 0, start: "09:00", end: "10:00", title: "a" }, { day: 0, start: "11:00", end: "12:00", title: "b" }, { day: 0, start: "14:00", end: "15:00", title: "c" },
    { day: 0, allDay: true, title: "d" }, { day: 3, allDay: true, title: "e" },
  ];
  test("a grid when an hour has room, else a list", () => {
    const tall = weekLayout({ start: "2026-11-23", today: "2026-11-25", events }, 600, 300, 13);
    expect(tall.mode).toBe("grid");
    expect(tall.gridH / (tall.to - tall.from)).toBeGreaterThanOrEqual(HOUR_MIN_PX);
    expect(tall.columns.map((c) => c.date)[0]).toBe("2026-11-23");
    expect(tall.columns.map((c) => c.today)).toEqual([false, false, true, false, false, false, false]);
    expect(tall.columns[0]!.blocks).toHaveLength(3);
    expect(weekLayout({ start: "2026-11-23", events }, 600, 120, 13).mode).toBe("list");
    expect(weekLayout({ start: "2026-12-29", days: 4, events: [] }, 600, 300, 13).columns.map((c) => c.date)).toEqual(["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01"]);
  });
  test("no timed events: no hours, a line for each all-day event, no taller than its lines", () => {
    const day = (d: number, title: string, tone?: "muted"): CardWeekEvent => ({ day: d, allDay: true, title, ...(tone ? { tone } : {}) });
    const holidays = [day(1, "Vietnam Culture Day", "muted"), day(3, "Trip"), day(4, "Trip"), day(5, "Trip"), day(4, "Market")];
    const l = weekLayout({ start: "2026-11-23", today: "2026-11-25", events: holidays, from: 8, to: 20 }, 600, 300, 13);
    expect(l.mode).toBe("days");
    expect(l.columns.map((c) => [c.date.slice(8), c.today])).toEqual([["23", false], ["24", false], ["25", true], ["26", false], ["27", false], ["28", false], ["29", false]]);
    expect(l.rows.map((r) => `${r.from.slice(8)}-${r.to.slice(8)} ${r.ev.title}`)).toEqual(["24-24 Vietnam Culture Day", "26-28 Trip", "27-27 Market"]);
    expect([l.rowsMore, l.gridH]).toEqual([0, 0]);
    expect(l.natural).toBe(l.headH + 6 + 3 * l.rowH);
    // held to its own height and measured again, it draws the same
    expect(weekLayout({ start: "2026-11-23", today: "2026-11-25", events: holidays }, 600, l.natural, 13).rows).toEqual(l.rows);
    // nothing at all: the days alone
    const empty = weekLayout({ start: "2026-11-23", events: [] }, 600, 300, 13);
    expect([empty.mode, empty.rows.length, empty.natural]).toEqual(["days", 0, empty.headH]);
    // one timed event brings the columns back
    expect(weekLayout({ start: "2026-11-23", events: [...holidays, { day: 0, start: "09:00", title: "x" }] }, 600, 300, 13).mode).toBe("grid");
  });
  test("too many lines for the room: past ones give way, the rest and the card's own more are counted", () => {
    const events: CardWeekEvent[] = [0, 1, 2, 3, 4, 5].map((d) => ({ day: d, allDay: true, title: `e${d}`, ...(d < 2 ? { tone: "muted" as const } : {}) }));
    const probe = weekLayout({ start: "2026-11-23", events, more: [0, 0, 0, 0, 0, 0, 2] }, 600, 400, 13);
    expect([probe.rows.length, probe.rowsMore, probe.natural]).toEqual([6, 2, probe.headH + 6 + 6 * probe.rowH + probe.lineH]);
    expect(weekLayout({ start: "2026-11-23", events, more: [0, 0, 0, 0, 0, 0, 2] }, 600, probe.natural, 13).rows).toHaveLength(6);
    const low = weekLayout({ start: "2026-11-23", events }, 600, probe.headH + 6 + 3 * probe.rowH + probe.lineH, 13);
    expect([low.rows.map((r) => r.ev.title), low.rowsMore]).toEqual([["e2", "e3", "e4"], 3]);
    expect(weekLayout({ start: "2026-11-23", events }, 600, 20, 13).rows).toEqual([]);
  });
  test("the list: all day first, +n includes the card's own more", () => {
    const l = weekLayout({ start: "2026-11-23", events, more: [3] }, 420, 150, 12);
    expect(l.mode).toBe("list");
    const first = l.columns[0]!;
    expect(first.list.map((x) => x.ev.title)[0]).toBe("d");
    expect(first.list.length + first.more).toBe(4 + 3);
    expect(l.columns[1]).toMatchObject({ list: [], more: 0 });
  });
  test("a list column keeps a line for +n, and drops what is over first", () => {
    const day = [timed(9, 10, "past", "muted"), timed(11, 12, "one"), timed(13, 14, "two")];
    // room for two entries and the "+n" line
    const out = fillList([], day, 2 * 33 + 15, 15, true, 0);
    expect(out.list.map((x) => x.ev.title)).toEqual(["one", "two"]);
    expect(out.hidden).toBe(1);
    expect(fillList([], day, 3 * 33, 15, true, 0)).toMatchObject({ hidden: 0 });
    expect(fillList([], day, 3 * 33, 15, true, 2).list).toHaveLength(2);
  });
  test("clocks", () => {
    expect([clockText(570, true), clockText(570, false), clockText(0, false), clockText(780, false)]).toEqual(["09:30", "9:30 AM", "12:00 AM", "1:00 PM"]);
    expect([hourText(9, true), hourText(12, false), hourText(15, false)]).toEqual(["09:00", "12 PM", "3 PM"]);
  });
});
