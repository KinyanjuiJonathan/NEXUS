import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { CalendarEvent } from "@/data/types";
import { createLocalBackend, memoryKV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { expandEvents } from "@/lib/schedule";
import { agenda } from "@/lib/smart/agenda";
import { queueUnits } from "@/lib/smart/reschedule";
import { occStatus, snapEdge, snapMove } from "./calendarSnap";
import { filterTasks, taskCounts } from "./taskViews";
import { hoursFor } from "./workPlan";

const NBO = "Africa/Nairobi";
const at = (iso: string, zone = NBO) => DateTime.fromISO(iso, { zone }).toMillis();
const fmt = (ms: number, zone = NBO) => DateTime.fromMillis(ms, { zone }).toFormat("ccc d HH:mm");
const span = (e: { startAt: number; endAt: number }) => `${fmt(e.startAt)}–${DateTime.fromMillis(e.endAt, { zone: NBO }).toFormat("HH:mm")}`;
const MIN = 60_000;

async function setup() {
  const kv = memoryKV();
  let seq = 0;
  const clock = { now: at("2026-11-18T10:00") }; // Wednesday
  const make = () => createNexusStore({ backend: createLocalBackend(kv), now: () => clock.now, id: () => `id${++seq}` });
  const store = make();
  await store.getState().init();
  await store.getState().setSetting("homeZone", NBO);
  await store.getState().setSetting("routine", { ...store.getState().settings.routine, enabled: false }); // these tests cover scheduling without a daily routine
  const s = () => store.getState();
  const block = async (title: string, start: string, end: string, taskId?: string) => {
    const t = taskId ? s().tasks.find((x) => x.id === taskId)! : await s().addTask({ title, estimateMin: 60, reminders: [] }, { autoPlace: false });
    const e = await s().addEvent({ title, startAt: at(start), endAt: at(end), taskId: t.id, tz: NBO, reminders: [] });
    return { t, e };
  };
  const event = (id: string) => s().events.find((x) => x.id === id)!;
  const liveBlocks = (taskId: string) => s().events.filter((e) => e.taskId === taskId && !e.deletedAt);
  return { s, clock, block, event, liveBlocks, make };
}

describe("task lists", () => {
  it("places a task by the time reserved for it, not only by its deadline, and every count agrees with its list", async () => {
    const { s, clock, block } = await setup();
    const today = await block("Today block", "2026-11-18T14:00", "2026-11-18T15:00"); // no deadline at all
    const friday = await block("Friday block", "2026-11-20T09:00", "2026-11-20T10:00");
    const nextWeek = await block("Next week block", "2026-11-25T09:00", "2026-11-25T10:00");
    const missed = await block("Missed block", "2026-11-17T09:00", "2026-11-17T10:00");
    const due = await s().addTask({ title: "Deadline Thursday", dueAt: at("2026-11-19T12:00"), dueTz: NBO, reminders: [] }, { autoPlace: false });
    const late = await s().addTask({ title: "Deadline passed", dueAt: at("2026-11-16T12:00"), dueTz: NBO, reminders: [] }, { autoPlace: false });
    const loose = await s().addTask({ title: "No date", reminders: [] }, { autoPlace: false });
    const names = (v: Parameters<typeof filterTasks>[1]) => filterTasks(s().tasks, v, clock.now, NBO, s().events).map((t) => t.title);

    expect(names("upcoming")).toEqual(["Deadline Thursday", "Friday block", "Next week block"]);
    expect(names("week")).toEqual(["Today block", "Deadline Thursday", "Friday block"]);
    expect(names("overdue").sort()).toEqual(["Deadline passed", "Missed block"]);
    expect(names("today").sort()).toEqual(["Deadline passed", "Missed block", "No date", "Today block"]);
    expect(names("all")).toHaveLength(7);
    // without the calendar, the block-only tasks used to vanish from these lists
    expect(filterTasks(s().tasks, "upcoming", clock.now, NBO).map((t) => t.title)).toEqual(["Deadline Thursday"]);

    await s().setTaskDone(today.t.id, true);
    await s().archiveTask(today.t.id, true);
    await s().setTaskDone(friday.t.id, true);
    await s().deleteTask(loose.id);
    const counts = taskCounts(s().tasks, clock.now, NBO, s().events);
    expect(counts).toMatchObject({ completed: 1, archive: 1, trash: 1, all: 4, upcoming: 2, overdue: 2 });
    for (const v of Object.keys(counts) as (keyof typeof counts)[]) expect(counts[v]).toBe(filterTasks(s().tasks, v, clock.now, NBO, s().events).length);

    await s().restoreTask(loose.id);
    await s().archiveTask(today.t.id, false);
    expect(taskCounts(s().tasks, clock.now, NBO, s().events)).toMatchObject({ trash: 0, archive: 0, completed: 2, all: 5 });
    await s().deleteTask(late.id);
    await s().purgeTask(late.id);
    expect(s().tasks.some((t) => t.id === late.id)).toBe(false);
    void due; void nextWeek; void missed;
  });
});

describe("one schedule everywhere", () => {
  it("a reorder shows the same in the queue, the agenda, the calendar and the task lists, and survives a restart", async () => {
    const { s, clock, block, event, make } = await setup();
    const a = await block("A", "2026-11-18T10:30", "2026-11-18T11:30");
    const b = await block("B", "2026-11-18T11:30", "2026-11-18T12:00");
    const c = await block("C", "2026-11-18T14:00", "2026-11-18T15:00");
    const zoom = await s().addEvent({ title: "Zoom", startAt: at("2026-11-18T12:30"), endAt: at("2026-11-18T13:30"), tz: NBO });
    const order = () => queueUnits(s().tasks, s().events, clock.now).map((u) => u.title);

    // B to first place: it starts when A was due to start, A follows it
    expect(await s().reorderQueue([b.t.id, a.t.id, c.t.id])).toBe(true);
    expect([span(event(b.e.id)), span(event(a.e.id)), span(event(c.e.id))]).toEqual(["Wed 18 10:30–11:00", "Wed 18 11:00–12:00", "Wed 18 14:00–15:00"]);
    expect(order()).toEqual(["B", "A", "C"]);
    // the same order everywhere it is shown
    expect(agenda(s().tasks, s().events, clock.now, { limit: 10 }).filter((i) => i.kind === "flexible").map((i) => i.title)).toEqual(["B", "A", "C"]);
    expect(expandEvents(s().events, at("2026-11-18T00:00"), at("2026-11-19T00:00")).map((o) => o.event.title)).toEqual(["B", "A", "Zoom", "C"]);
    expect(filterTasks(s().tasks, "week", clock.now, NBO, s().events).map((t) => t.title)).toEqual(["B", "A", "C"]);
    expect(event(zoom.id)).toMatchObject({ startAt: zoom.startAt, endAt: zoom.endAt });
    // no task or block was duplicated
    expect(s().tasks).toHaveLength(3);
    expect(s().events.filter((e) => !e.deletedAt)).toHaveLength(4);

    // C to first place: later tasks follow by their lengths and keep clear of the fixed appointment
    await s().reorderQueue([c.t.id, b.t.id, a.t.id]);
    const blocks = [c, b, a].map((x) => event(x.e.id));
    expect(span(blocks[0])).toBe("Wed 18 10:30–11:30");
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].startAt).toBeGreaterThanOrEqual(blocks[i - 1].endAt);
    for (const e of blocks) expect(e.endAt <= zoom.startAt || e.startAt >= zoom.endAt).toBe(true);

    const again = make();
    await again.getState().init();
    expect(queueUnits(again.getState().tasks, again.getState().events, clock.now).map((u) => u.title)).toEqual(["C", "B", "A"]);

    // undo puts every block back
    s().toasts.filter((t) => t.title === "Queue updated").pop()!.action!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(order()).toEqual(["B", "A", "C"]);
  });

  it("completing, deleting and restoring a task is reflected in the queue and calendar at once", async () => {
    const { s, clock, block, liveBlocks } = await setup();
    const a = await block("A", "2026-11-18T11:00", "2026-11-18T12:00");
    const b = await block("B", "2026-11-18T13:00", "2026-11-18T14:00");
    const titles = () => queueUnits(s().tasks, s().events, clock.now).map((u) => u.title);
    await s().setTaskDone(a.t.id, true);
    expect(titles()).toEqual(["B"]);
    expect(liveBlocks(a.t.id)).toHaveLength(0);
    await s().setTaskDone(a.t.id, false);
    expect(titles()).toEqual(["A", "B"]);
    await s().deleteTask(b.t.id);
    expect(titles()).toEqual(["A"]);
    await s().restoreTask(b.t.id);
    expect(titles()).toEqual(["A", "B"]);
    await s().updateTask(a.t.id, { title: "A renamed" });
    expect(titles()[0]).toBe("A renamed");
  });
});

describe("split tasks", () => {
  it("stay one task and become one block again when there is room, keeping their total time and progress", async () => {
    const { s, clock, block, event, liveBlocks } = await setup();
    // a 90-minute task that had to be split around a meeting
    const p1 = await block("Report (1/2)", "2026-11-18T11:00", "2026-11-18T12:00");
    await s().updateTask(p1.t.id, { title: "Report", notes: "Quarterly figures" });
    const p2 = await block("Report (2/2)", "2026-11-18T13:10", "2026-11-18T13:40", p1.t.id);
    await s().updateEvent(p1.e.id, { sched: { workedMs: 20 * MIN, targetMs: 60 * MIN } });
    const zoom = await s().addEvent({ title: "Zoom", startAt: at("2026-11-18T12:00"), endAt: at("2026-11-18T13:00"), tz: NBO });
    expect(queueUnits(s().tasks, s().events, clock.now)).toMatchObject([{ title: "Report", durationMs: 90 * MIN }]);
    expect(await s().mergeSplitTasks()).toBe(0); // the meeting is still in the way

    await s().deleteEvent(zoom.id);
    expect(await s().mergeSplitTasks()).toBe(1);
    const left = liveBlocks(p1.t.id);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: p1.e.id, title: "Report" });
    expect(span(left[0])).toBe("Wed 18 11:00–12:30"); // 60 + 30 minutes, nothing lost or doubled
    expect(left[0].sched).toMatchObject({ workedMs: 20 * MIN, targetMs: 90 * MIN });
    expect(event(p2.e.id)).toMatchObject({ sched: { removed: "merged" } });
    expect(s().tasks.find((t) => t.id === p1.t.id)).toMatchObject({ title: "Report", notes: "Quarterly figures", status: "todo" });
    expect(await s().mergeSplitTasks()).toBe(0);
  });

  it("are joined when the queue is reordered, and long tasks that were split on purpose are left in parts", async () => {
    const { s, clock, block, liveBlocks } = await setup();
    const first = await block("Review", "2026-11-18T11:00", "2026-11-18T12:00");
    const p1 = await block("Slides", "2026-11-18T12:00", "2026-11-18T12:30");
    await block("Slides", "2026-11-18T15:00", "2026-11-18T15:30", p1.t.id);
    const long1 = await block("Migration", "2026-11-19T09:00", "2026-11-19T11:00");
    await block("Migration", "2026-11-19T11:10", "2026-11-19T13:10", long1.t.id); // 4 h in all: longer than one block may be
    await s().reorderQueue([p1.t.id, first.t.id, long1.t.id]);
    expect(liveBlocks(p1.t.id).map(span)).toEqual(["Wed 18 11:00–12:00"]);
    expect(liveBlocks(first.t.id).map(span)).toEqual(["Wed 18 12:00–13:00"]);
    expect(liveBlocks(long1.t.id)).toHaveLength(2);
    expect(queueUnits(s().tasks, s().events, clock.now).map((u) => [u.title, u.durationMs / MIN])).toEqual([["Slides", 60], ["Review", 60], ["Migration", 240]]);
  });
});

describe("calendar snapping", () => {
  const day = at("2026-11-18T00:00");
  const boundaries = [at("2026-11-18T10:00"), at("2026-11-18T11:20")];
  const starts = [boundaries[0]];
  const ends = [boundaries[1]];
  it("pulls a dragged block to a neighbour's start or end, otherwise to the quarter hour, and lets Alt override", () => {
    const hour = 60 * MIN;
    // start lands 6 minutes after a neighbour's end: snaps back to it
    expect(snapMove(at("2026-11-18T11:26"), hour, { boundaries, starts, ends, dayStart: day })).toEqual({ start: boundaries[1], end: boundaries[1] + hour, guide: boundaries[1] });
    // end lands 4 minutes before a neighbour's start: ends exactly there
    expect(snapMove(at("2026-11-18T08:56"), hour, { boundaries, starts, ends, dayStart: day })).toMatchObject({ end: boundaries[0], guide: boundaries[0] });
    // a start is never pulled onto another block's start (that would stack them): quarter hour instead
    expect(fmt(snapMove(at("2026-11-18T10:04"), hour, { boundaries, starts, ends, dayStart: day }).start)).toBe("Wed 18 10:00");
    expect(snapMove(at("2026-11-18T10:04"), hour, { boundaries, starts, ends, dayStart: day }).guide).toBeNull();
    // nothing near: the quarter hour
    expect(fmt(snapMove(at("2026-11-18T14:08"), hour, { boundaries, dayStart: day }).start)).toBe("Wed 18 14:15");
    expect(snapMove(at("2026-11-18T14:08"), hour, { boundaries, dayStart: day }).guide).toBeNull();
    // Alt: exactly where it was dropped
    expect(fmt(snapMove(at("2026-11-18T11:26"), hour, { boundaries, dayStart: day, free: true }).start)).toBe("Wed 18 11:26");
    expect(snapEdge(at("2026-11-18T11:14"), { boundaries, dayStart: day })).toEqual({ t: boundaries[1], guide: boundaries[1] });
    expect(fmt(snapEdge(at("2026-11-18T16:22"), { boundaries, dayStart: day }).t)).toBe("Wed 18 16:15");
  });

  it("tells completed, overdue, running and upcoming blocks apart", () => {
    const o = (start: string, end: string, sched: CalendarEvent["sched"] = null) => ({ event: { sched, taskId: "t" } as CalendarEvent, start: at(start), end: at(end), seriesStart: at(start), recurring: false });
    const open = { status: "todo", deletedAt: null } as never;
    const now = at("2026-11-18T10:00");
    expect(occStatus(o("2026-11-18T08:00", "2026-11-18T09:00"), { status: "done" } as never, now)).toBe("done");
    expect(occStatus(o("2026-11-18T08:00", "2026-11-18T09:00"), open, now)).toBe("overdue");
    expect(occStatus(o("2026-11-18T08:00", "2026-11-18T09:00", { attention: "worked" }), open, now)).toBe("worked");
    expect(occStatus(o("2026-11-18T09:30", "2026-11-18T10:30"), open, now)).toBe("now");
    expect(occStatus(o("2026-11-18T11:00", "2026-11-18T12:00"), open, now)).toBe("upcoming");
    expect(occStatus(o("2026-11-18T08:00", "2026-11-18T09:00"), undefined, now)).toBe("past");
  });
});

describe("time zone and weekly hours", () => {
  it("changing the scheduling zone moves nothing, and weekly hours can differ per day", async () => {
    const { s, block, event } = await setup();
    const a = await block("A", "2026-11-18T15:00", "2026-11-18T16:00");
    await s().setSetting("homeZone", "America/Chicago");
    await s().setSetting("routine", { ...s().settings.routine, enabled: false }); // these tests cover scheduling without a daily routine
    expect(event(a.e.id)).toMatchObject({ startAt: a.e.startAt, endAt: a.e.endAt, tz: NBO }); // the same instant
    expect(fmt(event(a.e.id).startAt, "America/Chicago")).toBe("Wed 18 06:00");

    const wh = { zone: "Europe/London", startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5, 6, 7], week: { 1: [8 * 60, 12 * 60] as [number, number], 6: [22 * 60, 2 * 60] as [number, number], 7: "off" as const } };
    const show = (key: string) => { const h = hoursFor(key, wh); return h ? `${fmt(h.start, "Europe/London")}–${DateTime.fromMillis(h.end, { zone: "Europe/London" }).toFormat("HH:mm")}` : null; };
    expect(show("2026-11-23")).toBe("Mon 23 08:00–12:00");
    expect(show("2026-11-24")).toBe("Tue 24 09:00–17:00"); // no entry: the fallback
    expect(show("2026-11-28")).toBe("Sat 28 22:00–02:00"); // runs into Sunday
    expect(show("2026-11-29")).toBeNull();
    // across the UK clock change (29 March 2026) the hours stay 08:00–12:00 on the wall
    expect(show("2026-03-30")).toBe("Mon 30 08:00–12:00");
    // a plan for one date wins over the weekly table
    expect(hoursFor("2026-11-23", { ...wh, plans: { "2026-11-23": { off: true } } })).toBeNull();
  });
});
