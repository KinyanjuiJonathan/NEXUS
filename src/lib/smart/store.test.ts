import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { createLocalBackend, memoryKV, type KV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { expandEvents, findConflicts } from "@/lib/schedule";
import { tasksForDay } from "@/lib/calendarTasks";
import { parseScheduleRequest } from "./parse";
import { resolveRequest } from "./slots";
import { MAX_AUTO_MOVES } from "./reschedule";

const NBO = "Africa/Nairobi";
const CHI = "America/Chicago";
const at = (iso: string, zone = NBO) => DateTime.fromISO(iso, { zone }).toMillis();
const fmt = (ms: number, zone = NBO) => DateTime.fromMillis(ms, { zone }).toFormat("ccc d LLL HH:mm");
const MIN = 60_000;

async function setup(shared?: KV) {
  const kv = shared ?? memoryKV();
  let seq = 0;
  const clock = { now: at("2026-11-18T10:00") }; // Wednesday
  const store = createNexusStore({ backend: createLocalBackend(kv), now: () => clock.now, id: () => `id${++seq}-${Math.random().toString(36).slice(2, 6)}` });
  await store.getState().init();
  if (!shared) await store.getState().setSetting("homeZone", NBO);
  /** What the Smart Schedule box does when the request is clear and a time is free. */
  const say = async (text: string) => {
    const s = store.getState();
    const req = parseScheduleRequest(text, { now: clock.now, defaultZone: NBO, texasZone: CHI });
    const res = resolveRequest(req, s.events, s.slotSettings(), clock.now);
    if (req.questions.length || res.status !== "ok" || !res.slot) return { req, res, created: null };
    return { req, res, created: await s.smartCreate(req, res.slot, res.durationMin) };
  };
  const live = () => store.getState().events.filter((e) => !e.deletedAt);
  return { store, clock, kv, say, live };
}

describe("smart scheduling in the app", () => {
  it("creates the task and its time from one sentence, in the To-Do list and the calendar", async () => {
    const { store, say, live } = await setup();
    const { created } = await say("Rooting Mineh's phone today, around three hours, preferably in the evening Kenya time");
    expect(created).not.toBeNull();
    const { task, event } = created!;
    expect(task).toMatchObject({ title: "Root Mineh's Phone", estimateMin: 180, status: "todo" });
    expect(store.getState().tasks.map((t) => t.title)).toContain("Root Mineh's Phone"); // To-Do list
    expect(event).toMatchObject({ title: "Root Mineh's Phone", taskId: task!.id, fixed: false, tz: NBO });
    expect([fmt(event.startAt), fmt(event.endAt)]).toEqual(["Wed 18 Nov 17:00", "Wed 18 Nov 20:00"]);
    expect(fmt(event.startAt, CHI)).toBe("Wed 18 Nov 08:00"); // the same instant in Texas
    expect(expandEvents(live(), at("2026-11-18T00:00"), at("2026-11-19T00:00")).map((o) => o.event.id)).toContain(event.id); // calendar
    expect(event.sched).toMatchObject({ origin: "smart", period: "evening", zone: NBO });
    expect(store.getState().activity.map((a) => a.kind)).toContain("smart_scheduled");
  });

  it("never double-books: each new request goes around what is already there", async () => {
    const { say, live } = await setup();
    await say("Zoom meeting 3:00 PM to 4:00 PM Kenya time");
    await say("Write report today, 2 hours");
    await say("Review budget today, 2 hours");
    await say("Read the brief today in the afternoon, 30 minutes");
    const events = live();
    expect(events).toHaveLength(4);
    for (const e of events) expect(findConflicts(events, { start: e.startAt, end: e.endAt }, e.id)).toEqual([]);
    const zoom = events.find((e) => e.title === "Zoom Meeting")!;
    expect(zoom).toMatchObject({ fixed: true, taskId: null, startAt: at("2026-11-18T15:00"), endAt: at("2026-11-18T16:00") });
  });

  it("does not create anything when the request needs an answer or no time is free", async () => {
    const { store, say } = await setup();
    const unclear = await say("Review contract today, in 3 hours");
    expect(unclear.req.questions).toHaveLength(1);
    await store.getState().addEvent({ title: "Dinner", startAt: at("2026-11-18T17:00"), endAt: at("2026-11-18T22:00") });
    const full = await say("Repair phone today in the evening, 3 hours");
    expect(full.res.status).toBe("alternative");
    expect(store.getState().tasks).toHaveLength(0);
    expect(store.getState().events).toHaveLength(1);
  });

  it("an unfinished flexible task moves to the next free time and is never completed for the user", async () => {
    const { store, clock, say, live } = await setup();
    const { created } = await say("Write report today at 11am for 1 hour");
    await say("Board meeting 12:30 PM to 2:00 PM");
    const block = created!.event;
    const notifications = () => store.getState().toasts.map((x) => x.title);

    // its hour passes, the task is still open
    clock.now = at("2026-11-18T12:05");
    const moves = await store.getState().autoReschedule();
    expect(moves).toHaveLength(1);
    const moved = live().find((e) => e.id === block.id)!;
    expect([fmt(moved.startAt), fmt(moved.endAt)]).toEqual(["Wed 18 Nov 14:15", "Wed 18 Nov 15:15"]); // after the meeting and its buffer
    expect(store.getState().tasks.find((t) => t.id === created!.task!.id)!.status).toBe("todo"); // not completed for me
    expect(live()).toHaveLength(2); // moved, not duplicated
    expect(moved.sched).toMatchObject({ origin: "auto", moves: 1 });
    expect(moved.sched!.history).toEqual([{ at: clock.now, from: [block.startAt, block.endAt], to: [moved.startAt, moved.endAt], reason: "unfinished" }]);
    expect(notifications()).toContain("Rescheduled automatically");
    expect(store.getState().activity.map((a) => a.kind)).toContain("auto_rescheduled");

    // running it again changes nothing (no loop)
    expect(await store.getState().autoReschedule()).toEqual([]);
    clock.now += 30 * MIN;
    expect(await store.getState().autoReschedule()).toEqual([]);

    // once I confirm completion it is left alone for good
    await store.getState().setTaskDone(created!.task!.id, true);
    clock.now = at("2026-11-18T16:00");
    expect(await store.getState().autoReschedule()).toEqual([]);
  });

  it("fixed appointments are never moved, and nothing is planned over them", async () => {
    const { store, clock, say, live } = await setup();
    await say("Zoom meeting 3:00 PM to 4:00 PM Kenya time");
    const zoom = () => live().find((e) => e.title === "Zoom Meeting")!;
    const before = { ...zoom() };
    // the meeting ends without anything being ticked off: it still stays put
    clock.now = at("2026-11-18T16:30");
    expect(await store.getState().autoReschedule()).toEqual([]);
    expect(zoom()).toMatchObject({ startAt: before.startAt, endAt: before.endAt, fixed: true });

    // a fixed appointment linked to a task is protected too
    const t = await store.getState().addTask({ title: "Interview prep" }, { autoPlace: false });
    const fixedBlock = await store.getState().addEvent({ title: "Interview", startAt: at("2026-11-18T09:00"), endAt: at("2026-11-18T10:00"), taskId: t.id, fixed: true });
    expect(await store.getState().autoReschedule()).toEqual([]);
    expect(live().find((e) => e.id === fixedBlock.id)).toMatchObject({ startAt: fixedBlock.startAt });

    // requests for the same afternoon go around tomorrow's fixed meeting
    await store.getState().addEvent({ title: "Client call", startAt: at("2026-11-19T12:00"), endAt: at("2026-11-19T17:00") });
    const r = await say("Plan the launch tomorrow afternoon, 2 hours");
    expect(r.res.status).toBe("alternative");
    for (const a of r.res.alternatives) expect(findConflicts(live(), a)).toEqual([]);
  });

  it("a new fixed appointment pushes flexible work out of its way, and says so", async () => {
    const { store, say, live } = await setup();
    const { created } = await say("Deep work today at 2pm for 2 hours");
    const zoom = await store.getState().addEvent({ title: "Zoom", startAt: at("2026-11-18T15:00"), endAt: at("2026-11-18T16:00") });
    expect(zoom.fixed).toBe(true); // an appointment without a task is fixed by default
    const flex = live().find((e) => e.id === created!.event.id)!;
    expect(findConflicts(live(), { start: flex.startAt, end: flex.endAt }, flex.id)).toEqual([]);
    expect(flex.sched!.history![0]).toMatchObject({ reason: "conflict" });
    expect(live().find((e) => e.id === zoom.id)).toMatchObject({ startAt: zoom.startAt, endAt: zoom.endAt });
    expect(store.getState().toasts.map((x) => x.title)).toContain("Moved to make room");
  });

  it("asks me instead of moving past a deadline or moving forever, and my own choice resets it", async () => {
    const { store, clock, say, live } = await setup();
    const { created } = await say("File the form by today 1pm, 1 hour");
    const block = created!.event;
    expect(fmt(block.startAt)).toBe("Wed 18 Nov 10:00");
    await store.getState().addEvent({ title: "Workshop", startAt: at("2026-11-18T11:30"), endAt: at("2026-11-18T17:00") });
    clock.now = at("2026-11-18T11:10");
    const [move] = await store.getState().autoReschedule();
    expect(move).toMatchObject({ to: null, problem: "deadline" });
    const flagged = live().find((e) => e.id === block.id)!;
    expect(flagged).toMatchObject({ startAt: block.startAt, sched: { attention: "deadline" } }); // left where it was
    const toast = store.getState().toasts.find((x) => x.title.includes("needs a new time"))!;
    expect(toast.action!.label).toMatch(/^Use /); // an alternative is proposed
    expect(await store.getState().autoReschedule()).toEqual([]); // and it is not asked again every minute

    // picking a time myself clears the flag and the move count
    await store.getState().updateEvent(block.id, { startAt: at("2026-11-19T09:00"), endAt: at("2026-11-19T10:00") });
    expect(live().find((e) => e.id === block.id)!.sched).toMatchObject({ origin: "user", moves: 0, attention: null });

    // a block that keeps being missed stops after a few automatic moves
    const other = await say("Tidy inbox tomorrow at 3pm for 30 minutes");
    await store.getState().setTaskDone(created!.task!.id, true);
    let auto = 0;
    for (let i = 0; i < 12; i++) {
      const e = live().find((x) => x.id === other.created!.event.id)!;
      clock.now = e.endAt + 2 * MIN;
      const moves = await store.getState().autoReschedule();
      if (moves[0]?.to) auto++;
    }
    expect(auto).toBe(MAX_AUTO_MOVES);
    expect(live().find((x) => x.id === other.created!.event.id)!.sched).toMatchObject({ attention: "limit", moves: MAX_AUTO_MOVES });
  });

  it("can be switched off, and stays quiet when notifications are off", async () => {
    const { store, clock, say, live } = await setup();
    const { created } = await say("Write report today at 11am for 1 hour");
    clock.now = at("2026-11-18T12:05");
    await store.getState().setSetting("smartAutoReschedule", false);
    expect(await store.getState().autoReschedule()).toEqual([]);
    expect(live().find((e) => e.id === created!.event.id)!.startAt).toBe(created!.event.startAt);
    await store.getState().setSetting("smartAutoReschedule", true);
    await store.getState().setSetting("smartNotify", false);
    expect(await store.getState().autoReschedule()).toHaveLength(1);
    expect(store.getState().toasts).toEqual([]);
    expect(store.getState().activity.map((a) => a.kind)).toContain("auto_rescheduled"); // still in the history
  });

  it("everything survives a restart: tasks, fixed flags, history and settings", async () => {
    const first = await setup();
    await first.say("Zoom meeting 3:00 PM to 4:00 PM Kenya time");
    const { created } = await first.say("Write report today at 11am for 1 hour");
    first.clock.now = at("2026-11-18T12:05");
    await first.store.getState().autoReschedule();
    await first.store.getState().setSetting("smartPeriods", { morning: [5, 11], afternoon: [12, 17], evening: [18, 23] });
    await first.store.getState().setSetting("smartProtectFixed", true);

    const second = await setup(first.kv);
    second.clock.now = first.clock.now;
    const s = second.store.getState();
    expect(s.settings.smartPeriods.evening).toEqual([18, 23]);
    const zoom = s.events.find((e) => e.title === "Zoom Meeting")!;
    expect(zoom).toMatchObject({ fixed: true, startAt: at("2026-11-18T15:00") });
    const block = s.events.find((e) => e.id === created!.event.id)!;
    expect(block).toMatchObject({ fixed: false, sched: { origin: "auto", moves: 1 } });
    expect(block.sched!.history).toHaveLength(1);
    expect(s.tasks.find((t) => t.id === created!.task!.id)!.status).toBe("todo");
    // restarting does not move anything a second time
    expect(await s.autoReschedule()).toEqual([]);
    expect(tasksForDay(s.tasks, at("2026-11-18T00:00"), at("2026-11-19T00:00"))).toEqual([]); // no deadline: it lives on the calendar as its block
  });

  it("older data without the new fields: appointments are fixed, task blocks flexible", async () => {
    const kv = memoryKV();
    const backend = createLocalBackend(kv);
    const base = { notes: "", tz: NBO, recurrence: null, important: false, reminders: [], color: null, createdAt: 1, updatedAt: 1, deletedAt: null };
    // written by a version that had no `fixed` / `sched`
    await backend.upsertEvent({ ...base, id: "old-meeting", title: "Old meeting", startAt: at("2026-11-18T08:00"), endAt: at("2026-11-18T09:00"), taskId: null } as never);
    const seed = createNexusStore({ backend, now: () => at("2026-11-18T09:00"), id: () => "t1" });
    await seed.getState().init();
    await seed.getState().addTask({ title: "Old task" }, { autoPlace: false });
    await backend.upsertEvent({ ...base, id: "old-block", title: "Old block", startAt: at("2026-11-19T08:00"), endAt: at("2026-11-19T09:00"), taskId: "t1" } as never);
    const { store } = await setup(kv);
    const get = (id: string) => store.getState().events.find((e) => e.id === id)!;
    expect(get("old-meeting")).toMatchObject({ fixed: true, sched: null });
    expect(get("old-block")).toMatchObject({ fixed: false, sched: null });
  });
});
