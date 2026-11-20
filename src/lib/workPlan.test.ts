import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { CalendarEvent, Task } from "@/data/types";
import { createLocalBackend, memoryKV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { planQueueMove, queueOf, type RescheduleSettings } from "@/lib/smart/reschedule";
import { workingWindows } from "@/lib/smart/slots";
import { hoursFor, prunePlans, usualPattern, workWindows, type WorkHours } from "./workPlan";

const NBO = "Africa/Nairobi";
const CHI = "America/Chicago";
const at = (iso: string, zone = NBO) => DateTime.fromISO(iso, { zone }).toMillis();
const fmt = (ms: number, zone = NBO) => DateTime.fromMillis(ms, { zone }).toFormat("ccc d HH:mm");
const span = (i: { start: number; end: number }, zone = NBO) => `${fmt(i.start, zone)}–${DateTime.fromMillis(i.end, { zone }).toFormat("HH:mm")}`;
const MIN = 60_000;
const BASE: WorkHours = { zone: NBO, startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] };

describe("when I intend to work", () => {
  it("falls back to the fixed hours and working days until a plan is given", () => {
    expect(span(hoursFor("2026-11-18", BASE)!)).toBe("Wed 18 09:00–17:00");
    expect(hoursFor("2026-11-21", BASE)).toBeNull(); // Saturday, not a working day in the fallback
    expect(workWindows(at("2026-11-20T00:00"), at("2026-11-24T00:00"), BASE).map((w) => span(w))).toEqual(["Fri 20 09:00–17:00", "Mon 23 09:00–17:00"]);
  });

  it("uses the day's own plan, any hour, in Kenya or Texas time, past midnight too", () => {
    // 8 AM to 4 PM Texas time on Wednesday = 5 PM Wednesday to 1 AM Thursday in Nairobi
    const plans = { "2026-11-18": { start: at("2026-11-18T08:00", CHI), end: at("2026-11-18T16:00", CHI), zone: CHI } };
    const wh = { ...BASE, plans };
    expect(span(hoursFor("2026-11-18", wh)!)).toBe("Wed 18 17:00–01:00");
    expect(span(hoursFor("2026-11-18", wh)!, CHI)).toBe("Wed 18 08:00–16:00");
    // a window that started yesterday and is still running is found
    expect(workWindows(at("2026-11-19T00:30"), at("2026-11-19T00:45"), wh).map((w) => span(w))).toEqual(["Wed 18 17:00–01:00"]);
  });

  it("days without an answer follow the latest answer, weekends included, and a day off is respected", () => {
    const plans = {
      "2026-11-18": { start: at("2026-11-18T09:00"), end: at("2026-11-18T12:00"), zone: NBO },
      "2026-11-20": { start: at("2026-11-20T14:00"), end: at("2026-11-20T22:00"), zone: NBO },
      "2026-11-22": { off: true as const },
    };
    const wh = { ...BASE, plans };
    expect(usualPattern(plans, NBO)).toEqual({ offsetMin: 14 * 60, lengthMs: 8 * 60 * MIN });
    expect(span(hoursFor("2026-11-21", wh)!)).toBe("Sat 21 14:00–22:00"); // Saturday, after 17:00
    expect(hoursFor("2026-11-22", wh)).toBeNull(); // Sunday off
    expect(span(hoursFor("2026-11-23", wh)!)).toBe("Mon 23 14:00–22:00");
    expect(span(hoursFor("2026-11-18", wh)!)).toBe("Wed 18 09:00–12:00"); // its own answer wins
    expect(Object.keys(prunePlans(plans, at("2026-12-03T10:00"), NBO))).toEqual(["2026-11-20", "2026-11-22"]);
  });

  it("the smart scheduler plans inside the answer", () => {
    const s: RescheduleSettings = {
      homeZone: NBO, workStartHour: 9, workEndHour: 17, workDays: [1, 2, 3, 4, 5], bufferMin: 10,
      periods: { morning: [6, 12], afternoon: [12, 17], evening: [17, 22] }, protectFixed: true,
      plans: { "2026-11-21": { start: at("2026-11-21T18:00"), end: at("2026-11-22T02:00"), zone: NBO } },
    };
    expect(workingWindows(at("2026-11-21T03:00"), at("2026-11-22T00:00"), s).map((w) => span(w))).toEqual(["Sat 21 18:00–02:00"]);
  });
});

describe("in the app", () => {
  async function setup() {
    let seq = 0;
    const clock = { now: at("2026-11-21T10:00") }; // Saturday
    const store = createNexusStore({ backend: createLocalBackend(memoryKV()), now: () => clock.now, id: () => `id${++seq}` });
    await store.getState().init();
    await store.getState().setSetting("homeZone", NBO);
    const s = () => store.getState();
    const add = async (title: string, start: string, end: string) => {
      const t = await s().addTask({ title, estimateMin: 60, reminders: [] }, { autoPlace: false });
      const e = await s().addEvent({ title, startAt: at(start), endAt: at(end), taskId: t.id, tz: NBO, reminders: [] });
      return { t, e };
    };
    const event = (id: string) => s().events.find((x) => x.id === id)!;
    return { s, clock, add, event };
  }

  it("works weekends by default, and an unfinished task is pushed into the hours I said I would work", async () => {
    const { s, clock, add, event } = await setup();
    expect(s().settings.workDays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    await s().setWorkPlan("2026-11-21", { start: at("2026-11-21T19:00"), end: at("2026-11-22T03:00"), zone: NBO });
    const { e } = await add("Write report", "2026-11-21T08:00", "2026-11-21T09:00");
    clock.now = at("2026-11-21T10:00");
    await s().autoReschedule();
    expect(span({ start: event(e.id).startAt, end: event(e.id).endAt })).toBe("Sat 21 19:00–20:00"); // Saturday evening, not Monday morning
    await s().setWorkPlan("2026-11-21", null);
    expect(s().settings.workPlans).toEqual({});
  });

  it("moves a task up or down the queue by trading places with its neighbour, never touching fixed appointments", async () => {
    const { s, add, event } = await setup();
    const a = await add("A", "2026-11-21T11:00", "2026-11-21T12:00");
    const b = await add("B", "2026-11-21T12:00", "2026-11-21T12:30");
    const c = await add("C", "2026-11-21T15:00", "2026-11-21T16:00");
    const zoom = await s().addEvent({ title: "Zoom", startAt: at("2026-11-21T13:00"), endAt: at("2026-11-21T14:00"), tz: NBO });
    const order = () => queueOf(s().tasks, s().events, at("2026-11-21T10:00")).map((e) => e.title);
    const where = (x: { e: CalendarEvent }) => span({ start: event(x.e.id).startAt, end: event(x.e.id).endAt });
    expect(order()).toEqual(["A", "B", "C"]);

    expect(await s().moveInQueue(b.e.id, -1)).toBe(true); // B up: B then A in the same 11:00–12:30 stretch
    expect(order()).toEqual(["B", "A", "C"]);
    expect([where(b), where(a)]).toEqual(["Sat 21 11:00–11:30", "Sat 21 11:30–12:30"]);
    expect(await s().moveInQueue(b.e.id, -1)).toBe(false); // already first

    expect(await s().moveInQueue(a.e.id, 1)).toBe(true); // A down past C, with Zoom in between: both keep clear of it
    expect(order()).toEqual(["B", "C", "A"]);
    expect(where(c)).toBe("Sat 21 11:30–12:30");
    expect(where(a)).toBe("Sat 21 15:00–16:00");
    expect(event(zoom.id)).toMatchObject({ startAt: zoom.startAt, endAt: zoom.endAt });
    expect(event(a.e.id).sched).toMatchObject({ origin: "user" });
    expect(await s().moveInQueue(a.e.id, 1)).toBe(false); // already last
    expect(await s().moveInQueue(zoom.id, -1)).toBe(false); // fixed appointments are not in the queue
  });

  it("falls back to the first free times when the swapped stretch would run into a fixed appointment", () => {
    const task = (id: string): Task => ({ id, title: id, notes: "", priority: "medium", categoryId: "work", status: "todo", dueAt: null, dueTz: NBO, estimateMin: 60, spentMs: 0, sortOrder: 0, recurrence: null, reminders: [], subtasks: [], completedAt: null, archivedAt: null, deletedAt: null, createdAt: 0, updatedAt: 0 });
    const ev = (id: string, start: string, end: string, taskId: string | null): CalendarEvent => ({ id, title: id, notes: "", startAt: at(start), endAt: at(end), tz: NBO, taskId, recurrence: null, important: false, reminders: [], color: null, fixed: taskId == null, sched: null, createdAt: 0, updatedAt: 0, deletedAt: null });
    const s: RescheduleSettings = { homeZone: NBO, workStartHour: 9, workEndHour: 17, workDays: [1, 2, 3, 4, 5, 6, 7], bufferMin: 10, periods: { morning: [6, 12], afternoon: [12, 17], evening: [17, 22] }, protectFixed: true };
    // short A before the meeting, long B after it: B does not fit in A's place
    const events = [ev("a", "2026-11-21T12:00", "2026-11-21T12:30", "A"), ev("zoom", "2026-11-21T12:30", "2026-11-21T13:30", null), ev("b", "2026-11-21T14:00", "2026-11-21T16:00", "B")];
    const moves = planQueueMove([task("A"), task("B")], events, at("2026-11-21T10:00"), s, "b", -1);
    expect(moves.map((m) => m.eventId)).toEqual(["b", "a"]);
    expect(moves[0].to!.end).toBeLessThanOrEqual(moves[1].to!.start);
    for (const m of moves) expect(m.to!.end <= events[1].startAt || m.to!.start >= events[1].endAt).toBe(true);
  });
});
