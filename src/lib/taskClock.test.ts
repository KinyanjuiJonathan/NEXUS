import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { CalendarEvent, Task, WorkSession } from "@/data/types";
import { createLocalBackend, memoryKV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { findConflicts, findMissed } from "@/lib/schedule";
import { planBulk, planUnfinished, type RescheduleSettings } from "@/lib/smart/reschedule";
import { awayMs, blockClock, clockState, countableMs, currentBlock, unclockedMs } from "./taskClock";

const NBO = "Africa/Nairobi";
const at = (iso: string) => DateTime.fromISO(iso, { zone: NBO }).toMillis();
const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: NBO }).toFormat("ccc HH:mm");
const MIN = 60_000;
/** Wednesday 18 November 2026, 10:00 in Nairobi. */
const NOW = at("2026-11-18T10:00");
const SET: RescheduleSettings = {
  homeZone: NBO, workStartHour: 9, workEndHour: 17, workDays: [1, 2, 3, 4, 5], bufferMin: 10,
  periods: { morning: [6, 12], afternoon: [12, 17], evening: [17, 22] }, protectFixed: true,
};

let n = 0;
const ev = (start: string, end: string, o: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `e${++n}`, title: "Busy", notes: "", startAt: at(start), endAt: at(end), tz: NBO, taskId: null, recurrence: null,
  important: false, reminders: [], color: null, fixed: o.taskId == null, sched: null, createdAt: 0, updatedAt: 0, deletedAt: null, ...o,
});
const task = (o: Partial<Task> = {}): Task => ({
  id: `t${++n}`, title: `Task ${n}`, notes: "", priority: "medium", categoryId: "work", status: "todo", dueAt: null, dueTz: NBO, estimateMin: 60,
  spentMs: 0, sortOrder: n, recurrence: null, reminders: [], subtasks: [], completedAt: null, archivedAt: null, deletedAt: null, createdAt: 0, updatedAt: 0, ...o,
});
const block = (t: Task, start: string, end: string, o: Partial<CalendarEvent> = {}) => ev(start, end, { title: t.title, taskId: t.id, fixed: false, ...o });
const session = (start: string, end: string | null, pauses: [string, string | null, ("idle" | "manual")?][] = []): WorkSession => ({
  id: `w${++n}`, startedAt: at(start), endedAt: end ? at(end) : null, note: "", createdAt: 0, updatedAt: 0,
  pauses: pauses.map(([s, e, reason]) => ({ start: at(s), end: e ? at(e) : null, reason: reason ?? "idle" })),
});

describe("clocked time on a task", () => {
  it("counts only the time the work clock was running during the block", () => {
    const t = task();
    const b = block(t, "2026-11-18T08:00", "2026-11-18T09:00");
    const s = [session("2026-11-18T07:30", null, [["2026-11-18T08:20", "2026-11-18T08:50"]])];
    expect(blockClock(b, s, NOW)).toMatchObject({ targetMs: 60 * MIN, workedMs: 30 * MIN, remainingMs: 30 * MIN, done: false });
    expect(blockClock(b, [], NOW)).toMatchObject({ workedMs: 0, remainingMs: 60 * MIN });
    expect(blockClock(b, [session("2026-11-18T07:00", null)], NOW).done).toBe(true);
    // time carried over from an earlier block counts towards the same total
    const later = block(t, "2026-11-18T09:30", "2026-11-18T10:00", { sched: { workedMs: 30 * MIN, targetMs: 60 * MIN } });
    expect(blockClock(later, [session("2026-11-18T09:45", null)], NOW)).toMatchObject({ workedMs: 45 * MIN, remainingMs: 15 * MIN });
  });

  it("knows the task under way, the clock's state, and what can still be counted by hand", () => {
    const t = task();
    const b = block(t, "2026-11-18T09:30", "2026-11-18T10:30");
    expect(currentBlock([t], [b, ev("2026-11-18T09:00", "2026-11-18T11:00")], NOW)?.event.id).toBe(b.id);
    expect(currentBlock([{ ...t, status: "done" }], [b], NOW)).toBeNull();
    expect(clockState([]).state).toBe("off");
    expect(clockState([session("2026-11-18T09:00", null)]).state).toBe("working");
    expect(clockState([session("2026-11-18T09:00", null, [["2026-11-18T09:50", null]])]).state).toBe("away");
    expect(clockState([session("2026-11-18T09:00", null, [["2026-11-18T09:50", null, "manual"]])]).state).toBe("break");
    const s = [session("2026-11-18T09:40", null, [["2026-11-18T09:45", "2026-11-18T09:55"]])];
    expect(awayMs(s, b.startAt, NOW)).toBe(10 * MIN);
    expect(unclockedMs(s, b.startAt, NOW, NOW)).toBe(10 * MIN); // 09:30–09:40, before clocking in
    expect(countableMs(b, s, NOW)).toBe(20 * MIN);
  });
});

describe("pushing unfinished work forward by the clock", () => {
  it("moves only what was not clocked, the whole block when nothing was, and asks when the time was clocked in full", () => {
    const t = task({ title: "Write report" });
    const b = block(t, "2026-11-18T08:00", "2026-11-18T09:00");
    const half = [session("2026-11-18T08:00", "2026-11-18T08:30")];
    const [partial] = planUnfinished([t], [b], NOW, SET, half);
    expect(partial).toMatchObject({ reason: "unfinished", workedMs: 30 * MIN, targetMs: 60 * MIN });
    expect(partial.to!.end - partial.to!.start).toBe(30 * MIN);
    const [none] = planUnfinished([t], [b], NOW, SET, []);
    expect(none.to!.end - none.to!.start).toBe(60 * MIN);
    const [full] = planUnfinished([t], [b], NOW, SET, [session("2026-11-18T07:55", "2026-11-18T09:05")]);
    expect(full).toMatchObject({ to: null, problem: "worked" });
  });

  it("pushes later flexible tasks along in order, around fixed appointments, and leaves deadline work alone", () => {
    const [a, b, c, d] = [task({ title: "A" }), task({ title: "B" }), task({ title: "C" }), task({ title: "D", dueAt: at("2026-11-18T16:00") })];
    const zoom = ev("2026-11-18T13:00", "2026-11-18T14:00", { title: "Zoom" });
    const events = [
      block(a, "2026-11-18T08:00", "2026-11-18T09:00"),
      block(b, "2026-11-18T10:15", "2026-11-18T11:15"),
      block(c, "2026-11-18T11:30", "2026-11-18T12:30"),
      block(d, "2026-11-18T14:30", "2026-11-18T15:30"),
      zoom,
    ];
    const moves = planUnfinished([a, b, c, d], events, NOW, SET, []);
    const to = (t: Task) => moves.find((m) => m.taskId === t.id)?.to;
    expect(moves.find((m) => m.taskId === a.id)?.reason).toBe("unfinished");
    expect(fmt(to(a)!.start)).toBe("Wed 10:00"); // straight away, not after everything else
    expect(moves.filter((m) => m.reason === "pushed").map((m) => m.title)).toEqual(["B", "C"]);
    expect(to(a)!.end).toBeLessThanOrEqual(to(b)!.start);
    expect(to(b)!.end).toBeLessThanOrEqual(to(c)!.start);
    for (const t of [a, b, c]) expect(findConflicts([zoom, events[3]], to(t)!)).toEqual([]);
    expect(moves.some((m) => m.taskId === d.id || m.eventId === zoom.id)).toBe(false);
  });

  it("does not disturb later tasks when the unfinished one fits before them", () => {
    const [a, b] = [task(), task()];
    const events = [block(a, "2026-11-18T08:00", "2026-11-18T08:30"), block(b, "2026-11-18T11:00", "2026-11-18T12:00")];
    const moves = planUnfinished([a, b], events, NOW, SET, []);
    expect(moves).toHaveLength(1);
    expect(fmt(moves[0].to!.start)).toBe("Wed 10:00");
  });
});

describe("rescheduling everything at once", () => {
  const [a, b, done] = [task({ title: "A" }), task({ title: "B" }), task({ status: "done" })];
  const zoom = ev("2026-11-18T13:00", "2026-11-18T14:00", { title: "Zoom" });
  const events = [block(a, "2026-11-18T11:00", "2026-11-18T12:00"), block(b, "2026-11-18T12:10", "2026-11-18T13:00"), block(done, "2026-11-19T15:00", "2026-11-19T16:00"), zoom];

  it("pushes every open task later, keeps the order and never touches fixed appointments", () => {
    const moves = planBulk([a, b, done], events, NOW, SET, { mode: "shift", byMs: 60 * MIN });
    expect(moves.map((m) => m.title)).toEqual(["A", "B"]);
    expect(fmt(moves[0].to!.start)).toBe("Wed 14:15"); // 12:00 would run into Zoom, so it goes after it
    expect(moves[1].to!.start).toBeGreaterThanOrEqual(moves[0].to!.end);
    expect(moves[1].to!.start).toBeGreaterThanOrEqual(events[1].startAt + 60 * MIN);
    for (const m of moves) expect(findConflicts([zoom], m.to!)).toEqual([]);
  });

  it("starts again from a chosen date and time, even outside working days", () => {
    const sat = at("2026-11-21T10:00");
    const moves = planBulk([a, b, done], events, NOW, SET, { mode: "from", at: sat });
    expect(moves.map((m) => [m.title, fmt(m.to!.start)])).toEqual([["A", "Sat 10:00"], ["B", "Sat 11:15"]]);
    expect(planBulk([done], events, NOW, SET, { mode: "from", at: sat })).toEqual([]);
  });
});

describe("in the app", () => {
  async function setup() {
    const kv = memoryKV();
    let seq = 0;
    const clock = { now: NOW };
    const make = () => createNexusStore({ backend: createLocalBackend(kv), now: () => clock.now, id: () => `id${++seq}` });
    const store = make();
    await store.getState().init();
    await store.getState().setSetting("homeZone", NBO);
    await store.getState().setSetting("routine", { ...store.getState().settings.routine, enabled: false }); // these tests cover scheduling without a daily routine
    const s = () => store.getState();
    const add = async (title: string, start: string, end: string) => {
      const t = await s().addTask({ title, estimateMin: 60, reminders: [] }, { autoPlace: false });
      const e = await s().addEvent({ title, startAt: at(start), endAt: at(end), taskId: t.id, tz: NBO, reminders: [] });
      return { t, e };
    };
    const event = (id: string) => s().events.find((x) => x.id === id)!;
    return { store, s, clock, add, event, make };
  }

  it("away time is not counted, can be counted by hand, and a fully clocked task waits to be marked complete", async () => {
    const { s, clock, add, event } = await setup();
    await s().clockIn();
    const { t, e } = await add("Write report", "2026-11-18T10:00", "2026-11-18T11:00");
    clock.now = at("2026-11-18T10:50");
    await s().handleActivity({ kind: "away", since: at("2026-11-18T10:20"), reason: "idle" });
    expect(clockState(s().workSessions).state).toBe("away");
    await s().handleActivity({ kind: "back", at: clock.now });
    expect(s().toasts.find((x) => x.title === "Welcome back")?.action?.label).toBe("I was working on it");
    clock.now = at("2026-11-18T10:55");
    expect(blockClock(event(e.id), s().workSessions, clock.now).workedMs).toBe(25 * MIN);
    expect(await s().countAway(e.id)).toBe(30 * MIN);
    expect(blockClock(event(e.id), s().workSessions, clock.now).workedMs).toBe(55 * MIN);
    expect(await s().countAway(e.id)).toBe(0); // nothing is counted twice
    expect(s().activity.map((x) => x.kind)).toContain("time_counted");

    clock.now = at("2026-11-18T11:02");
    const moves = await s().autoReschedule();
    expect(moves).toMatchObject([{ to: null, problem: "worked" }]);
    expect(event(e.id)).toMatchObject({ startAt: e.startAt, sched: { attention: "worked" } });
    expect(s().tasks.find((x) => x.id === t.id)!.status).toBe("todo"); // never completed for the user
    expect(findMissed(s().tasks, s().events, clock.now)).toEqual([]);
    const ask = s().toasts.find((x) => x.title.startsWith("Time is up"))!;
    expect(ask.action?.label).toBe("Mark complete");
    ask.action!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(s().tasks.find((x) => x.id === t.id)!.status).toBe("done");
  });

  it("moves only the unclocked rest forward and carries the clocked time with it", async () => {
    const { s, clock, add, event } = await setup();
    await s().clockIn();
    const { e } = await add("Write report", "2026-11-18T10:00", "2026-11-18T11:00");
    clock.now = at("2026-11-18T10:40");
    await s().handleActivity({ kind: "away", since: at("2026-11-18T10:20"), reason: "idle" });
    clock.now = at("2026-11-18T11:02");
    await s().handleActivity({ kind: "back", at: clock.now });
    const [m] = await s().autoReschedule();
    expect(m).toMatchObject({ reason: "unfinished", workedMs: 20 * MIN, targetMs: 60 * MIN });
    const moved = event(e.id);
    expect(moved.endAt - moved.startAt).toBe(40 * MIN);
    expect(moved.startAt).toBeGreaterThanOrEqual(clock.now);
    expect(moved.sched).toMatchObject({ workedMs: 20 * MIN, targetMs: 60 * MIN, origin: "auto" });
    expect(s().toasts.map((x) => x.title)).toContain("Rest of the task moved forward");
    // working through the new block finishes the planned hour
    clock.now = moved.endAt;
    expect(blockClock(moved, s().workSessions, clock.now)).toMatchObject({ workedMs: 60 * MIN, done: true });
  });

  it("reschedules every task at once with undo, and clears the history for good", async () => {
    const { s, clock, add, event, make } = await setup();
    const a = await add("A", "2026-11-18T11:00", "2026-11-18T12:00");
    const b = await add("B", "2026-11-18T12:10", "2026-11-18T13:10");
    const zoom = await s().addEvent({ title: "Zoom", startAt: at("2026-11-18T14:00"), endAt: at("2026-11-18T15:00"), tz: NBO });
    await s().rescheduleAll({ mode: "shift", byMs: 120 * MIN });
    expect(fmt(event(a.e.id).startAt)).toBe("Wed 15:15"); // 13:00 would run into Zoom at 14:00, so it goes after it
    expect(event(a.e.id).startAt).toBeGreaterThanOrEqual(a.e.startAt + 120 * MIN);
    expect(event(b.e.id).startAt).toBeGreaterThanOrEqual(event(a.e.id).endAt);
    expect(event(zoom.id)).toMatchObject({ startAt: zoom.startAt, endAt: zoom.endAt });
    for (const x of [a, b]) expect(findConflicts([event(zoom.id)], { start: event(x.e.id).startAt, end: event(x.e.id).endAt })).toEqual([]);
    s().toasts.find((x) => x.title === "2 tasks rescheduled")!.action!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect([event(a.e.id).startAt, event(b.e.id).startAt]).toEqual([a.e.startAt, b.e.startAt]);

    expect(s().activity.length).toBeGreaterThan(0);
    await s().clearHistory();
    expect(s().activity).toEqual([]);
    const again = make();
    await again.getState().init();
    expect(again.getState().activity).toEqual([]);
    expect(again.getState().tasks).toHaveLength(2);
    void clock;
  });
});
