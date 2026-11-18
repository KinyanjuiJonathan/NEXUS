import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { CalendarEvent, Task } from "@/data/types";
import { describeRule, nextOccurrence, occurrencesBetween } from "./recurrence";
import { conflictPairs, expandEvents, findConflicts, findFreeSlots, findMissed, moveEvent, smartRescheduleOptions } from "./schedule";
import { remindersForEvent, remindersForTask } from "./reminders";

const CHI = "America/Chicago";
const NBO = "Africa/Nairobi";
const at = (iso: string, zone = NBO) => DateTime.fromISO(iso, { zone }).toMillis();
const fmt = (ms: number, zone = NBO) => DateTime.fromMillis(ms, { zone }).toFormat("ccc yyyy-LL-dd HH:mm");

let seq = 0;
const ev = (start: string, end: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `e${++seq}`,
  title: `Event ${seq}`,
  notes: "",
  startAt: at(start, over.tz ?? NBO),
  endAt: at(end, over.tz ?? NBO),
  tz: NBO,
  taskId: null,
  recurrence: null,
  important: false,
  reminders: [],
  color: null,
  fixed: over.taskId == null,
  sched: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: `t${++seq}`,
  title: "Task",
  notes: "",
  priority: "medium",
  categoryId: "work",
  status: "todo",
  dueAt: null,
  dueTz: NBO,
  estimateMin: 60,
  spentMs: 0,
  sortOrder: 0,
  recurrence: null,
  reminders: [],
  subtasks: [],
  completedAt: null,
  archivedAt: null,
  deletedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("recurrence", () => {
  it("weekly series keeps 3 PM Texas wall time across the DST change", () => {
    const start = at("2026-10-23T15:00", CHI); // Friday, CDT
    const occ = occurrencesBetween(start, CHI, { freq: "weekly", interval: 1 }, start, at("2026-11-14T00:00", CHI));
    expect(occ.map((o) => fmt(o, CHI))).toEqual([
      "Fri 2026-10-23 15:00",
      "Fri 2026-10-30 15:00",
      "Fri 2026-11-06 15:00",
      "Fri 2026-11-13 15:00",
    ]);
    // …which moves by an hour in Kenya time when Texas leaves DST
    expect(fmt(occ[1])).toBe("Fri 2026-10-30 23:00");
    expect(fmt(occ[2])).toBe("Sat 2026-11-07 00:00");
  });

  it("weekdays, by-weekday, count, until and exdates", () => {
    const mon = at("2026-11-16T09:00");
    const wk = occurrencesBetween(mon, NBO, { freq: "weekdays", interval: 1 }, mon, at("2026-11-24T00:00"));
    expect(wk.map((o) => fmt(o).slice(0, 3))).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Mon"]);
    const mwf = occurrencesBetween(mon, NBO, { freq: "weekly", interval: 1, byWeekday: [1, 3, 5], count: 4 }, mon, at("2027-01-01T00:00"));
    expect(mwf.map((o) => fmt(o).slice(0, 3))).toEqual(["Mon", "Wed", "Fri", "Mon"]);
    const ex = occurrencesBetween(mon, NBO, { freq: "daily", interval: 1, exdates: [at("2026-11-17T09:00")], until: at("2026-11-19T09:00") }, mon, at("2027-01-01T00:00"));
    expect(ex.map((o) => fmt(o).slice(0, 3))).toEqual(["Mon", "Wed", "Thu"]);
  });

  it("monthly on the 31st clamps to month end without drifting", () => {
    const jan31 = at("2027-01-31T10:00");
    const occ = occurrencesBetween(jan31, NBO, { freq: "monthly", interval: 1, count: 3 }, jan31, at("2028-01-01T00:00"));
    expect(occ.map((o) => fmt(o).slice(4, 14))).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
  });

  it("next occurrence and description", () => {
    const start = at("2026-11-02T08:00");
    expect(fmt(nextOccurrence(start, NBO, { freq: "daily", interval: 2 }, at("2026-11-17T10:00"))!)).toBe("Wed 2026-11-18 08:00");
    expect(describeRule({ freq: "weekly", interval: 1, byWeekday: [1, 5] })).toBe("Every week on Mon, Fri");
  });
});

describe("calendar conflicts", () => {
  const a = ev("2026-11-18T09:00", "2026-11-18T10:00");
  const b = ev("2026-11-18T09:30", "2026-11-18T11:00");
  const c = ev("2026-11-18T11:00", "2026-11-18T12:00");

  it("detects overlaps but not touching edges", () => {
    expect(findConflicts([a, b, c], { start: at("2026-11-18T09:45"), end: at("2026-11-18T10:15") }).map((o) => o.event.id)).toEqual([a.id, b.id]);
    expect(findConflicts([a, b, c], { start: at("2026-11-18T12:00"), end: at("2026-11-18T13:00") })).toHaveLength(0);
    expect(findConflicts([a], { start: a.startAt, end: a.endAt }, a.id)).toHaveLength(0);
    expect(conflictPairs([a, b, c], at("2026-11-18T00:00"), at("2026-11-19T00:00"))).toHaveLength(1);
  });

  it("detects conflicts with recurring events across zones", () => {
    const weeklyTexas = ev("2026-11-13T07:00", "2026-11-13T08:00", { tz: CHI, recurrence: { freq: "weekly", interval: 1 } });
    // Friday 7 AM CST = 16:00 Nairobi
    expect(findConflicts([weeklyTexas], { start: at("2026-11-20T16:30"), end: at("2026-11-20T17:00") })).toHaveLength(1);
  });

  it("moving keeps duration", () => {
    const moved = moveEvent(a, at("2026-11-20T14:00"), 1);
    expect(moved.endAt - moved.startAt).toBe(3600_000);
    expect(expandEvents([moved], at("2026-11-20T00:00"), at("2026-11-21T00:00"))).toHaveLength(1);
  });
});

describe("free slots and Smart Reschedule", () => {
  const wh = { zone: NBO, startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] };

  it("finds gaps within working hours, skipping weekends and busy blocks", () => {
    const busy = [ev("2026-11-20T09:00", "2026-11-20T12:00"), ev("2026-11-20T13:00", "2026-11-20T17:00")];
    const now = at("2026-11-20T08:00"); // Friday
    const slots = findFreeSlots(busy, 60 * 60_000, now, wh, { maxSlots: 3, perDay: 2 });
    expect(slots.map((s) => fmt(s.start))).toEqual(["Fri 2026-11-20 12:00", "Mon 2026-11-23 09:00", "Mon 2026-11-23 10:00"]);
  });

  it("does not suggest slots in the past and aligns to 15 minutes", () => {
    const now = at("2026-11-18T10:07");
    const [first] = findFreeSlots([], 30 * 60_000, now, wh);
    expect(fmt(first.start)).toBe("Wed 2026-11-18 10:15");
  });

  it("finds missed tasks and blocks; offers options but never applies them", () => {
    const now = at("2026-11-18T15:00");
    const overdue = task({ title: "Report", dueAt: at("2026-11-18T09:00"), estimateMin: 90 });
    const done = task({ title: "Done", dueAt: at("2026-11-18T09:00"), status: "done" });
    const linked = task({ title: "Deck" });
    const block = ev("2026-11-18T10:00", "2026-11-18T11:00", { taskId: linked.id, title: "Deck block" });
    const missed = findMissed([overdue, done, linked], [block], now);
    expect(missed.map((m) => m.title)).toEqual(["Report", "Deck block"]);
    const opts = smartRescheduleOptions(missed[0], [block], wh, now);
    expect(opts.length).toBeGreaterThan(0);
    expect(opts.every((o) => o.start > now && o.end - o.start === 90 * 60_000)).toBe(true);
    // inputs untouched
    expect(overdue.dueAt).toBe(at("2026-11-18T09:00"));
  });
});

describe("reminder planning", () => {
  const now = at("2026-11-18T08:00");
  it("task reminders at offsets, only in the future", () => {
    const t = task({ title: "Pay rent", dueAt: at("2026-11-18T09:00"), reminders: [0, 5, 15, 30, 60, 120] });
    const r = remindersForTask(t, now, false);
    expect(r.map((x) => fmt(x.fireAt).slice(-5))).toEqual(["08:00", "08:30", "08:45", "08:55", "09:00"].slice(1));
    expect(r.at(-1)!.title).toBe("Due now: Pay rent");
    expect(remindersForTask({ ...t, status: "done" }, now, false)).toHaveLength(0);
  });

  it("event reminders cover upcoming occurrences of a series", () => {
    const e = ev("2026-11-18T10:00", "2026-11-18T10:30", { title: "Standup", reminders: [15], recurrence: { freq: "daily", interval: 1 } });
    const r = remindersForEvent(e, now, false, 3);
    expect(r.slice(0, 2).map((x) => fmt(x.fireAt))).toEqual(["Wed 2026-11-18 09:45", "Thu 2026-11-19 09:45"]);
    expect(r[0].title).toBe("Standup starts in 15 min");
  });
});
