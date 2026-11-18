import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { CalendarEvent, Task } from "@/data/types";
import { findConflicts } from "@/lib/schedule";
import { parseScheduleRequest, type ScheduleRequest } from "./parse";
import { resolveRequest, type SlotSettings } from "./slots";
import { MAX_AUTO_MOVES, planDisplaced, planUnfinished, unfinishedBlocks, type RescheduleSettings } from "./reschedule";

const NBO = "Africa/Nairobi";
const CHI = "America/Chicago";
const at = (iso: string, zone = NBO) => DateTime.fromISO(iso, { zone }).toMillis();
const fmt = (ms: number | null | undefined, zone = NBO) => (ms == null ? null : DateTime.fromMillis(ms, { zone }).toFormat("ccc d LLL HH:mm"));
/** Wednesday 18 November 2026, 10:00 in Nairobi. */
const NOW = at("2026-11-18T10:00");
const ctx = { now: NOW, defaultZone: NBO, texasZone: CHI };
const parse = (text: string, answers = {}, now = NOW) => parseScheduleRequest(text, { ...ctx, now }, answers);

const SET: RescheduleSettings = {
  homeZone: NBO, workStartHour: 9, workEndHour: 17, workDays: [1, 2, 3, 4, 5], bufferMin: 10,
  periods: { morning: [6, 12], afternoon: [12, 17], evening: [17, 22] }, protectFixed: true,
};

let n = 0;
const ev = (start: string, end: string, o: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `e${++n}`, title: "Busy", notes: "", startAt: at(start, o.tz ?? NBO), endAt: at(end, o.tz ?? NBO), tz: NBO, taskId: null, recurrence: null,
  important: false, reminders: [], color: null, fixed: o.taskId == null, sched: null, createdAt: 0, updatedAt: 0, deletedAt: null, ...o,
});
const task = (o: Partial<Task> = {}): Task => ({
  id: `t${++n}`, title: `Task ${n}`, notes: "", priority: "medium", categoryId: "work", status: "todo", dueAt: null, dueTz: NBO, estimateMin: 60,
  spentMs: 0, sortOrder: n, recurrence: null, reminders: [], subtasks: [], completedAt: null, archivedAt: null, deletedAt: null, createdAt: 0, updatedAt: 0, ...o,
});
const resolve = (text: string, events: CalendarEvent[] = [], s: SlotSettings = SET, now = NOW, answers = {}) => resolveRequest(parse(text, answers, now), events, s, now);

describe("understanding a request", () => {
  it("reads the example: task, day, length, part of the day and zone", () => {
    for (const text of [
      "Repairing Mineh's phone today, in around 3 hours, preferably in the evening Kenya time.",
      "Rooting Mineh's phone today, around three hours, preferably in the evening Kenya time",
    ]) {
      const r = parse(text);
      expect(r.title).toMatch(/^(Repair|Root) Mineh's Phone$/);
      expect(r).toMatchObject({ durationMin: 180, durationApprox: true, period: "evening", zone: NBO, zoneLabel: "Kenya time", startAt: null, deadline: null, fixed: false });
      expect(r.window).toMatchObject({ start: at("2026-11-18T00:00"), end: at("2026-11-19T00:00"), label: "today" });
      expect(r.questions).toEqual([]);
    }
  });

  it("tells a length, a start time, a deadline and a preferred period apart", () => {
    expect(parse("Write the report tomorrow morning for 2 hours")).toMatchObject({ title: "Write Report", durationMin: 120, period: "morning", startAt: null, deadline: null });
    expect(parse("Finish proposal by Friday 5pm, takes 90 minutes, urgent")).toMatchObject({ title: "Complete Proposal", durationMin: 90, deadline: at("2026-11-20T17:00"), startAt: null, window: null, priority: "critical" });
    expect(parse("Fix bug around 4pm for half an hour")).toMatchObject({ title: "Fix Bug", durationMin: 30, startAt: at("2026-11-18T16:00"), startApprox: true });
    expect(parse("Team sync at 3pm for 30 minutes")).toMatchObject({ startAt: at("2026-11-18T15:00"), startApprox: false, durationMin: 30 });
    expect(parse("Pay rent by tomorrow")).toMatchObject({ title: "Pay Rent", deadline: at("2026-11-19T23:59:59.999"), startAt: null });
  });

  it("handles the everyday expressions", () => {
    expect(parse("Call the bank later tonight")).toMatchObject({ title: "Call Bank", period: "night", later: true, window: { label: "today" } });
    expect(parse("Submit tax form in two hours")).toMatchObject({ title: "Submit Tax Form", startAt: NOW + 2 * 3600_000, startApprox: true, durationMin: null });
    const weekend = parse("Clean the garage sometime this weekend, about 2 hours");
    expect(weekend).toMatchObject({ title: "Clean Garage", durationMin: 120 });
    expect([fmt(weekend.window!.start), fmt(weekend.window!.end)]).toEqual(["Sat 21 Nov 00:00", "Mon 23 Nov 00:00"]);
    expect(parse("Prepare slides before my next meeting, 45 minutes")).toMatchObject({ title: "Prepare Slides", beforeNextMeeting: true, durationMin: 45 });
    expect(fmt(parse("Deploy on 25 November in the afternoon, 1h30").window!.start)).toBe("Wed 25 Nov 00:00");
    expect(parse("Deploy on 25 November in the afternoon, 1h30")).toMatchObject({ title: "Deploy", period: "afternoon", durationMin: 90 });
    expect(fmt(parse("Gym on Monday at 6pm for an hour").startAt)).toBe("Mon 23 Nov 18:00");
    expect(parse("Read pages 3 to 4 of the manual tomorrow")).toMatchObject({ title: "Read Pages 3 to 4 of the Manual", startAt: null });
  });

  it("reads times in the zone that was named", () => {
    const kenya = parse("Zoom meeting 3:00 PM to 4:00 PM Kenya time");
    expect(kenya).toMatchObject({ title: "Zoom Meeting", zone: NBO, startAt: at("2026-11-18T15:00"), endAt: at("2026-11-18T16:00"), durationMin: 60, fixed: true });
    const texas = parse("Client call tomorrow at 3pm Texas time for 30 minutes");
    expect(texas).toMatchObject({ zone: CHI, fixed: true, durationMin: 30 });
    expect(fmt(texas.startAt, CHI)).toBe("Thu 19 Nov 15:00");
    expect(fmt(texas.startAt, NBO)).toBe("Fri 20 Nov 00:00"); // nine hours ahead in winter
    // "today" is today in the named zone: at 10:00 Nairobi it is still 01:00 in Texas
    expect(fmt(parse("Report today evening Texas time, 1 hour").window!.start, CHI)).toBe("Wed 18 Nov 00:00");
  });

  it("asks instead of guessing when two readings would change the schedule", () => {
    const hours = parse("Review contract today, in 3 hours");
    expect(hours.questions.map((q) => q.id)).toEqual(["inHours"]);
    expect(parse("Review contract today, in 3 hours", { inHours: "duration" })).toMatchObject({ durationMin: 180, startAt: null, questions: [] });
    expect(parse("Review contract today, in 3 hours", { inHours: "start" })).toMatchObject({ durationMin: null, startAt: NOW + 3 * 3600_000, questions: [] });

    const nine = parse("Doctor appointment tomorrow at 9");
    expect(nine.questions.map((q) => q.id)).toEqual(["meridiem"]);
    expect(fmt(parse("Doctor appointment tomorrow at 9", { meridiem: "pm" }).startAt)).toBe("Thu 19 Nov 21:00");
    expect(parse("Stretch tomorrow morning at 7").questions).toEqual([]); // "morning" settles it
    expect(fmt(parse("Stretch tomorrow morning at 7").startAt)).toBe("Thu 19 Nov 07:00");

    const friday = parse("Gym next Friday at 6pm");
    expect(friday.questions.map((q) => q.id)).toEqual(["nextWeekday"]);
    expect(fmt(parse("Gym next Friday at 6pm", { nextWeekday: "following" }).startAt)).toBe("Fri 27 Nov 18:00");
    expect(parse("Gym next Monday at 6pm").questions).toEqual([]); // Monday has passed this week: only one reading
  });

  it("recognises fixed commitments", () => {
    expect(parse("Interview on Monday from 11 to 1pm")).toMatchObject({ fixed: true, startAt: at("2026-11-23T11:00"), endAt: at("2026-11-23T13:00") });
    expect(parse("Write code tomorrow at 2pm fixed time")).toMatchObject({ fixed: true, title: "Write Code" });
    expect(parse("Prepare for the interview tomorrow morning").fixed).toBe(false); // no set time: flexible work
  });
});

describe("choosing a time", () => {
  it("picks a free three-hour slot this evening, Kenya time", () => {
    const r = resolve("Repairing Mineh's phone today, in around 3 hours, preferably in the evening Kenya time.");
    expect(r.status).toBe("ok");
    expect([fmt(r.slot!.start), fmt(r.slot!.end)]).toEqual(["Wed 18 Nov 17:00", "Wed 18 Nov 20:00"]);
    expect(r).toMatchObject({ durationMin: 180, assumedDuration: false, late: false });
  });

  it("works around what is already booked, with the buffer", () => {
    const zoom = ev("2026-11-18T17:30", "2026-11-18T18:30", { title: "Zoom" });
    const r = resolve("Repairing Mineh's phone today, around 3 hours, evening Kenya time", [zoom]);
    expect(r.status).toBe("ok");
    expect([fmt(r.slot!.start), fmt(r.slot!.end)]).toEqual(["Wed 18 Nov 18:45", "Wed 18 Nov 21:45"]); // 10-minute buffer, then the next quarter hour
    expect(findConflicts([zoom], r.slot!)).toEqual([]);
  });

  it("offers the closest alternatives instead of double-booking when the evening is full", () => {
    const events = [ev("2026-11-18T18:00", "2026-11-18T21:00", { title: "Dinner" })];
    const r = resolve("Repairing Mineh's phone today, around 3 hours, evening Kenya time", events);
    expect(r.status).toBe("alternative");
    expect(r.slot).toBeNull();
    expect(r.alternatives.length).toBeGreaterThan(0);
    for (const a of r.alternatives) {
      expect(a.end - a.start).toBe(3 * 3600_000);
      expect(findConflicts(events, a)).toEqual([]);
      expect(a.start).toBeGreaterThanOrEqual(NOW);
    }
    // the nearest one: this afternoon, ending before dinner
    expect([fmt(r.alternatives[0].start), fmt(r.alternatives[0].end)]).toEqual(["Wed 18 Nov 14:45", "Wed 18 Nov 17:45"]);
    // and the same evening slot tomorrow
    expect(r.alternatives.map((a) => fmt(a.start))).toContain("Thu 19 Nov 17:00");
  });

  it("never offers time that has already passed", () => {
    const late = at("2026-11-18T19:40");
    const r = resolve("Tidy desk today in the evening, 1 hour", [], SET, late);
    expect(fmt(r.slot!.start)).toBe("Wed 18 Nov 19:45");
    expect(resolve("Tidy desk today in the evening, 3 hours", [], SET, late).status).toBe("alternative");
    expect(resolve("Standup at 9am today", [], SET, NOW).status).toBe("past");
  });

  it("keeps an exact time when it is free and warns with alternatives when it is not", () => {
    expect(resolve("Zoom meeting 3:00 PM to 4:00 PM Kenya time")).toMatchObject({ status: "ok", slot: { start: at("2026-11-18T15:00"), end: at("2026-11-18T16:00") } });
    const events = [ev("2026-11-18T15:30", "2026-11-18T16:30", { title: "Interview" })];
    const r = resolve("Zoom meeting 3:00 PM to 4:00 PM Kenya time", events);
    expect(r.status).toBe("conflict");
    expect(r.conflicts.map((c) => c.event.title)).toEqual(["Interview"]);
    expect(r.alternatives.length).toBeGreaterThan(0);
    for (const a of r.alternatives) expect(findConflicts(events, a)).toEqual([]);
  });

  it("respects working hours, working days and deadlines when no time is named", () => {
    expect(fmt(resolve("Write summary, 2 hours").slot!.start)).toBe("Wed 18 Nov 10:00");
    // Friday 16:30: nothing fits before the working day ends, so Monday morning
    expect(fmt(resolve("Write summary, 2 hours", [], SET, at("2026-11-20T16:30")).slot!.start)).toBe("Mon 23 Nov 09:00");
    // a named day outside working days still honours the request
    expect(fmt(resolve("Clean the garage sometime this weekend, about 2 hours").slot!.start)).toBe("Sat 21 Nov 07:00");
    // must end by the deadline
    const busyDay = [ev("2026-11-18T10:00", "2026-11-18T17:00")];
    const r = resolve("Finish proposal by today 5pm, takes 90 minutes", busyDay);
    expect(r.status).toBe("alternative");
    expect(r.message).toMatch(/before the deadline/);
  });

  it("schedules before the next fixed appointment", () => {
    const events = [ev("2026-11-18T14:00", "2026-11-18T15:00", { title: "Board meeting" }), ev("2026-11-18T10:30", "2026-11-18T11:00", { title: "Deep work", taskId: "t", fixed: false })];
    const r = resolve("Prepare slides before my next meeting, 45 minutes", events);
    expect(r.status).toBe("ok");
    expect(r.slot!.end).toBeLessThanOrEqual(at("2026-11-18T14:00"));
    expect(fmt(r.slot!.start)).toBe("Wed 18 Nov 11:15"); // after the flexible block and its buffer
    expect(r.notes.join(" ")).toMatch(/Board meeting/);
  });

  it("gets Kenya and Texas right across the US daylight-saving change", () => {
    // Asked on Friday 6 March 2026 (Texas is UTC-6); Monday 9 March is after the change (UTC-5)
    const friday = at("2026-03-06T10:00");
    const before = parseScheduleRequest("Client call today at 3pm Texas time", { now: friday, defaultZone: NBO, texasZone: CHI });
    const after = parseScheduleRequest("Client call on Monday at 3pm Texas time", { now: friday, defaultZone: NBO, texasZone: CHI });
    expect(fmt(before.startAt, NBO)).toBe("Sat 7 Mar 00:00"); // 9 hours ahead
    expect(fmt(after.startAt, NBO)).toBe("Mon 9 Mar 23:00"); // 8 hours ahead
    expect(fmt(after.startAt, CHI)).toBe("Mon 9 Mar 15:00");
    // an evening in Texas is found in Texas hours, whatever the home zone
    const r = resolveRequest(parseScheduleRequest("Review numbers on Monday evening Texas time, 2 hours", { now: friday, defaultZone: NBO, texasZone: CHI }), [], SET, friday);
    expect(fmt(r.slot!.start, CHI)).toBe("Mon 9 Mar 17:00");
  });

  it("uses the configured meaning of morning, afternoon and evening", () => {
    const s = { ...SET, periods: { ...SET.periods, evening: [19, 23] as [number, number] } };
    expect(fmt(resolve("Yoga today in the evening, 1 hour", [], s).slot!.start)).toBe("Wed 18 Nov 19:00");
    expect(fmt(resolve("Yoga tomorrow morning, 1 hour", [], s).slot!.start)).toBe("Thu 19 Nov 06:00");
  });
});

describe("re-planning unfinished work", () => {
  const block = (t: Task, start: string, end: string, o: Partial<CalendarEvent> = {}) => ev(start, end, { title: t.title, taskId: t.id, fixed: false, ...o });

  it("moves a block whose time passed with the task still open to the next free time", () => {
    const t = task({ title: "Write report" });
    const events = [block(t, "2026-11-18T08:00", "2026-11-18T09:00"), ev("2026-11-18T10:00", "2026-11-18T12:00", { title: "Zoom" })];
    const [move] = planUnfinished([t], events, NOW, SET);
    expect(move).toMatchObject({ eventId: events[0].id, taskId: t.id, reason: "unfinished" });
    expect([fmt(move.to!.start), fmt(move.to!.end)]).toEqual(["Wed 18 Nov 12:15", "Wed 18 Nov 13:15"]);
    expect(findConflicts([events[1]], move.to!)).toEqual([]);
  });

  it("leaves completed tasks, running blocks, tasks with time still reserved, and fixed appointments alone", () => {
    const done = task({ status: "done", completedAt: NOW });
    const running = task();
    const planned = task();
    const meeting = task();
    const events = [
      block(done, "2026-11-18T08:00", "2026-11-18T09:00"),
      block(running, "2026-11-18T09:30", "2026-11-18T10:30"),
      block(planned, "2026-11-18T08:00", "2026-11-18T09:00"),
      block(planned, "2026-11-19T08:00", "2026-11-19T09:00"),
      block(meeting, "2026-11-18T08:00", "2026-11-18T09:00", { fixed: true }),
      ev("2026-11-18T07:00", "2026-11-18T08:00", { title: "Plain appointment" }),
    ];
    expect(unfinishedBlocks([done, running, planned, meeting], events, NOW, SET)).toEqual([]);
    // only with protection switched off may a fixed block for a task be re-planned
    expect(unfinishedBlocks([meeting], events, NOW, { ...SET, protectFixed: false }).map((u) => u.task.id)).toEqual([meeting.id]);
  });

  it("gives earlier time to higher priority and nearer deadlines, without overlaps", () => {
    const low = task({ title: "Low", priority: "low" });
    const critical = task({ title: "Critical", priority: "critical" });
    const soon = task({ title: "Due soon", dueAt: at("2026-11-18T16:00") });
    const later = task({ title: "Due later", dueAt: at("2026-11-20T16:00") });
    const tasks = [low, critical, soon, later];
    const events = tasks.map((t) => block(t, "2026-11-18T08:00", "2026-11-18T09:00"));
    const moves = planUnfinished(tasks, events, NOW, SET);
    const order = [...moves].sort((a, b) => a.to!.start - b.to!.start).map((m) => m.title);
    expect(order).toEqual(["Critical", "Due soon", "Due later", "Low"]);
    const slots = moves.map((m) => m.to!);
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) expect(slots[i].start < slots[j].end && slots[j].start < slots[i].end).toBe(false);
    expect(moves.find((m) => m.title === "Due soon")!.to!.end).toBeLessThanOrEqual(soon.dueAt!);
  });

  it("keeps the preferred part of the day from the original request", () => {
    const t = task({ title: "Repair phone" });
    const events = [block(t, "2026-11-17T17:00", "2026-11-17T20:00", { sched: { origin: "smart", period: "evening", zone: NBO } })];
    const [move] = planUnfinished([t], events, NOW, SET);
    expect([fmt(move.to!.start), fmt(move.to!.end)]).toEqual(["Wed 18 Nov 17:00", "Wed 18 Nov 20:00"]);
  });

  it("asks instead of moving when the deadline cannot be met, and stops after repeated moves", () => {
    const tight = task({ title: "Tight", dueAt: at("2026-11-18T11:00") });
    const events = [block(tight, "2026-11-18T08:00", "2026-11-18T09:00"), ev("2026-11-18T09:30", "2026-11-18T16:00", { title: "Workshop" })];
    const [m] = planUnfinished([tight], events, NOW, SET);
    expect(m).toMatchObject({ to: null, problem: "deadline" });
    expect(m.suggestion).toBeTruthy();

    const weary = task({ title: "Weary" });
    const moved = block(weary, "2026-11-18T08:00", "2026-11-18T09:00", { sched: { moves: MAX_AUTO_MOVES } });
    expect(planUnfinished([weary], [moved], NOW, SET)[0]).toMatchObject({ to: null, problem: "limit" });
    // once flagged for the user it is not picked up again
    expect(planUnfinished([weary], [{ ...moved, sched: { moves: MAX_AUTO_MOVES, attention: "limit" } }], NOW, SET)).toEqual([]);
  });

  it("does not move the same block again until its new time has passed too", () => {
    const t = task();
    const original = block(t, "2026-11-18T08:00", "2026-11-18T09:00");
    const [move] = planUnfinished([t], [original], NOW, SET);
    const moved = { ...original, startAt: move.to!.start, endAt: move.to!.end };
    expect(planUnfinished([t], [moved], NOW + 5 * 60_000, SET)).toEqual([]);
    expect(planUnfinished([t], [moved], moved.endAt + 2 * 60_000, SET)).toHaveLength(1);
  });

  it("moves flexible blocks out of the way of a new fixed appointment, never the appointment", () => {
    const t = task({ title: "Deep work" });
    const flexible = block(t, "2026-11-18T14:00", "2026-11-18T16:00");
    const other = ev("2026-11-18T16:30", "2026-11-18T17:00", { title: "Other fixed" });
    const zoom = ev("2026-11-18T15:00", "2026-11-18T16:00", { title: "Zoom meeting" });
    const moves = planDisplaced(zoom, [t], [flexible, other, zoom], NOW, SET);
    expect(moves.map((m) => m.eventId)).toEqual([flexible.id]);
    expect(moves[0].reason).toBe("conflict");
    expect(findConflicts([zoom, other], moves[0].to!)).toEqual([]);
    // a flexible block is not a reason to move anything
    expect(planDisplaced(flexible, [t], [flexible, zoom], NOW, SET)).toEqual([]);
  });
});

// keep the unused-type import honest
export type { ScheduleRequest };
