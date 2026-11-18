import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { createLocalBackend, memoryKV, type KV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { expandEvents } from "@/lib/schedule";
import { nextAppointment } from "@/lib/stats";
import { parseScheduleRequest } from "./parse";
import { resolveRequest } from "./slots";
import { agenda, untilLabel } from "./agenda";

const NBO = "Africa/Nairobi";
const at = (iso: string) => DateTime.fromISO(iso, { zone: NBO }).toMillis();
const MIN = 60_000;

/**
 * Two windows on one database, as in the desktop app: the main window, where
 * changes are made, and the floating pop-up, which reloads when told that data
 * changed and shows `agenda()` in its Schedule section.
 */
async function setup(shared?: KV) {
  const kv = shared ?? memoryKV();
  let seq = 0;
  const clock = { now: at("2026-11-18T10:00") }; // Wednesday
  const make = () => createNexusStore({ backend: createLocalBackend(kv), now: () => clock.now, id: () => `id${++seq}-${Math.random().toString(36).slice(2, 6)}` });
  const main = make();
  await main.getState().init();
  if (!shared) await main.getState().setSetting("homeZone", NBO);
  const popup = make();
  await popup.getState().init();
  /** What the pop-up's Schedule section shows after it has been told about a change. */
  const popupSchedule = async () => {
    await popup.getState().reload();
    const s = popup.getState();
    return agenda(s.tasks, s.events, clock.now).map((i) => i.title);
  };
  const say = async (text: string) => {
    const s = main.getState();
    const req = parseScheduleRequest(text, { now: clock.now, defaultZone: NBO, texasZone: "America/Chicago" });
    const res = resolveRequest(req, s.events, s.slotSettings(), clock.now);
    if (req.questions.length || res.status !== "ok" || !res.slot) throw new Error(`not schedulable: ${text} (${res.status})`);
    return s.smartCreate(req, res.slot, res.durationMin);
  };
  const calendar = () => expandEvents(main.getState().events, clock.now - 86_400_000, clock.now + 14 * 86_400_000).map((o) => o.event.title);
  return { main, popup, clock, kv, say, popupSchedule, calendar, make };
}

describe("one schedule everywhere", () => {
  it("1. a request creates a clearly titled task that keeps the original wording", async () => {
    const { main, say, popupSchedule } = await setup();
    const { task, event } = await say("Repairing Mineh's phone today, for around 3 hours, preferably in the evening Kenya time.");
    expect(task!.title).toBe("Repair Mineh's Phone");
    expect(event.title).toBe("Repair Mineh's Phone");
    expect(task!.notes).toBe("Requested: “Repairing Mineh's phone today, for around 3 hours, preferably in the evening Kenya time.”");
    expect(task).toMatchObject({ estimateMin: 180 });
    expect(event).toMatchObject({ startAt: at("2026-11-18T17:00"), endAt: at("2026-11-18T20:00"), tz: NBO, fixed: false });
    expect(await popupSchedule()).toEqual(["Repair Mineh's Phone"]);
    expect(main.getState().tasks.filter((t) => !t.deletedAt)).toHaveLength(1);
  });

  it("2. editing the title changes it in the To-Do list, calendar and pop-up, from either side", async () => {
    const { main, say, popupSchedule, calendar } = await setup();
    const { task, event } = await say("Update my CV this evening for 1 hour");
    expect(task!.title).toBe("Update My CV");
    await main.getState().updateTask(task!.id, { title: "Update CV for Safaricom" });
    expect(calendar()).toEqual(["Update CV for Safaricom"]);
    expect(await popupSchedule()).toEqual(["Update CV for Safaricom"]);
    // renamed on the calendar instead
    await main.getState().updateEvent(event.id, { title: "Polish CV" });
    expect(main.getState().tasks.find((t) => t.id === task!.id)!.title).toBe("Polish CV");
    expect(await popupSchedule()).toEqual(["Polish CV"]);
  });

  it("3. deleting a task removes its schedule entry everywhere, at once", async () => {
    const { main, say, popupSchedule, calendar, clock } = await setup();
    const repair = await say("Repair phone today in the evening, 3 hours");
    await say("Zoom interview with James tomorrow at 4 PM");
    expect(await popupSchedule()).toEqual(["Repair Phone", "Zoom Interview with James"]);
    await main.getState().deleteTask(repair.task!.id);
    expect(await popupSchedule()).toEqual(["Zoom Interview with James"]);
    expect(calendar()).toEqual(["Zoom Interview with James"]);
    expect(nextAppointment(main.getState().events, clock.now)!.event.title).toBe("Zoom Interview with James"); // dashboard
    // deleting from the calendar (the block) is reflected too
    const zoom = main.getState().events.find((e) => e.title === "Zoom Interview with James")!;
    await main.getState().deleteEvent(zoom.id);
    expect(await popupSchedule()).toEqual([]);
  });

  it("4. rescheduling shows the new time everywhere", async () => {
    const { main, popup, say, clock } = await setup();
    const { task, event } = await say("Write report today at 2pm for 1 hour");
    await main.getState().updateEvent(event.id, { startAt: at("2026-11-19T09:00"), endAt: at("2026-11-19T10:00") });
    await popup.getState().reload();
    const [item] = agenda(popup.getState().tasks, popup.getState().events, clock.now);
    expect(item).toMatchObject({ title: "Write Report", start: at("2026-11-19T09:00"), end: at("2026-11-19T10:00"), kind: "flexible", status: "upcoming", taskId: task!.id });
    expect(untilLabel(item, clock.now)).toBe("in 23 h");
    // moved automatically after being missed: the pop-up follows and marks it
    clock.now = at("2026-11-19T10:05");
    await main.getState().autoReschedule();
    await popup.getState().reload();
    const [moved] = agenda(popup.getState().tasks, popup.getState().events, clock.now);
    expect(moved).toMatchObject({ title: "Write Report", moved: true, status: "upcoming" });
    expect(moved.start).toBeGreaterThan(clock.now);
  });

  it("5. completing a task clears its upcoming time, and reopening brings it back", async () => {
    const { main, say, popupSchedule, calendar } = await setup();
    const { task } = await say("Repair phone today in the evening, 3 hours");
    await main.getState().setTaskDone(task!.id, true);
    expect(main.getState().tasks.find((t) => t.id === task!.id)!.status).toBe("done");
    expect(await popupSchedule()).toEqual([]);
    expect(calendar()).toEqual([]);
    await main.getState().setTaskDone(task!.id, false);
    expect(await popupSchedule()).toEqual(["Repair Phone"]);
    expect(calendar()).toEqual(["Repair Phone"]);
  });

  it("6. restoring from the trash restores time that is still ahead, not time that has passed", async () => {
    const { main, say, popupSchedule, clock } = await setup();
    const evening = await say("Repair phone today in the evening, 3 hours");
    const morning = await say("Write notes today at 11am for 30 minutes");
    await main.getState().deleteTask(evening.task!.id);
    await main.getState().deleteTask(morning.task!.id);
    expect(await popupSchedule()).toEqual([]);
    clock.now = at("2026-11-18T13:00"); // the morning block's time is over, the evening one is still ahead
    await main.getState().restoreTask(evening.task!.id);
    await main.getState().restoreTask(morning.task!.id);
    expect(await popupSchedule()).toEqual(["Repair Phone"]);
    const live = main.getState().events.filter((e) => !e.deletedAt).map((e) => e.title);
    expect(live).toEqual(["Repair Phone"]);
    expect(main.getState().tasks.filter((t) => !t.deletedAt).map((t) => t.title).sort()).toEqual(["Repair Phone", "Write Notes"]);
  });

  it("7. repeating items: one occurrence or the whole series, and nothing else", async () => {
    const { main, popupSchedule, clock } = await setup();
    const s = main.getState();
    // a weekly appointment
    const standup = await s.addEvent({ title: "Weekly sync", startAt: at("2026-11-19T09:00"), endAt: at("2026-11-19T09:30"), recurrence: { freq: "weekly", interval: 1 } });
    const other = await s.addEvent({ title: "Dentist", startAt: at("2026-11-20T15:00"), endAt: at("2026-11-20T16:00") });
    const weekly = () => expandEvents(main.getState().events, clock.now, clock.now + 22 * 86_400_000).filter((o) => o.event.id === standup.id).map((o) => o.start);
    expect(weekly()).toEqual([at("2026-11-19T09:00"), at("2026-11-26T09:00"), at("2026-12-03T09:00"), at("2026-12-10T09:00")]);
    // only this occurrence (what "Only this one" in the editor does)
    await s.updateEvent(standup.id, { recurrence: { freq: "weekly", interval: 1, exdates: [at("2026-11-19T09:00")] } });
    expect(weekly()).toEqual([at("2026-11-26T09:00"), at("2026-12-03T09:00"), at("2026-12-10T09:00")]);
    // the pop-up looks a week ahead; over two weeks the next weekly sync is there, the removed one is not
    expect(await popupSchedule()).toEqual(["Dentist"]);
    expect(agenda(main.getState().tasks, main.getState().events, clock.now, { horizonDays: 14 }).map((i) => [i.title, i.start])).toEqual([["Dentist", at("2026-11-20T15:00")], ["Weekly sync", at("2026-11-26T09:00")]]);
    // the whole series
    await main.getState().deleteEvent(standup.id);
    expect(weekly()).toEqual([]);
    expect(await popupSchedule()).toEqual(["Dentist"]);
    expect(main.getState().events.find((e) => e.id === other.id)!.deletedAt).toBeNull();

    // a repeating task: "only this one" schedules the next, "entire series" ends it
    const daily = await main.getState().addTask({ title: "Water plants", dueAt: at("2026-11-18T18:00"), dueTz: NBO, recurrence: { freq: "daily", interval: 1 } }, { autoPlace: false });
    await main.getState().deleteTask(daily.id, "occurrence");
    const open = () => main.getState().tasks.filter((t) => !t.deletedAt && t.title === "Water plants");
    expect(open().map((t) => t.dueAt)).toEqual([at("2026-11-19T18:00")]);
    expect(await popupSchedule()).toEqual(["Water plants", "Dentist"]);
    await main.getState().deleteTask(open()[0].id, "series");
    expect(open()).toEqual([]);
    expect(await popupSchedule()).toEqual(["Dentist"]);
  });

  it("8. after closing and reopening, deleted items stay gone and nothing is out of date", async () => {
    const first = await setup();
    const gone = await first.say("Repair phone today in the evening, 3 hours");
    const kept = await first.say("Zoom interview with James tomorrow at 4 PM");
    const done = await first.say("Write notes tomorrow at 10am for 30 minutes");
    await first.main.getState().deleteTask(gone.task!.id);
    await first.main.getState().setTaskDone(done.task!.id, true);
    await first.main.getState().updateEvent(kept.event.id, { title: "Zoom Interview with James K." });

    const second = await setup(first.kv);
    expect(await second.popupSchedule()).toEqual(["Zoom Interview with James K."]);
    expect(second.calendar()).toEqual(["Zoom Interview with James K."]);
    expect(second.main.getState().tasks.find((t) => t.id === gone.task!.id)!.deletedAt).not.toBeNull();
    // emptying the trash removes the reserved time for good
    await second.main.getState().purgeTask(gone.task!.id);
    const third = await setup(first.kv);
    expect(third.main.getState().events.some((e) => e.taskId === gone.task!.id)).toBe(false);
    expect(await third.popupSchedule()).toEqual(["Zoom Interview with James K."]);
  });

  it("clears entries left behind by earlier versions when the app starts", async () => {
    const kv = memoryKV();
    const backend = createLocalBackend(kv);
    const seed = createNexusStore({ backend, now: () => at("2026-11-18T09:00"), id: (() => { let n = 0; return () => `s${++n}`; })() });
    await seed.getState().init();
    const trashed = await seed.getState().addTask({ title: "Trashed" }, { autoPlace: false });
    const finished = await seed.getState().addTask({ title: "Finished" }, { autoPlace: false });
    const base = { notes: "", tz: NBO, recurrence: null, important: false, reminders: [], color: null, fixed: false, sched: null, createdAt: 1, updatedAt: 1, deletedAt: null };
    // what older versions left: the task is gone or done, its time block is still on the calendar
    await backend.upsertEvent({ ...base, id: "b1", title: "Trashed", taskId: trashed.id, startAt: at("2026-11-18T15:00"), endAt: at("2026-11-18T16:00") });
    await backend.upsertEvent({ ...base, id: "b2", title: "Finished", taskId: finished.id, startAt: at("2026-11-18T16:00"), endAt: at("2026-11-18T17:00") });
    await backend.upsertEvent({ ...base, id: "b3", title: "Orphan", taskId: "no-such-task", startAt: at("2026-11-18T17:00"), endAt: at("2026-11-18T18:00") });
    await backend.upsertTask({ ...trashed, deletedAt: 5 });
    await backend.upsertTask({ ...finished, status: "done", completedAt: 5 });
    const { popupSchedule, calendar } = await setup(kv);
    expect(calendar()).toEqual([]);
    expect(await popupSchedule()).toEqual([]);
  });
});

describe("the pop-up's schedule list", () => {
  it("is chronological, tells fixed from flexible, and highlights what is now, next and overdue", async () => {
    const { main, say, clock } = await setup();
    await say("Zoom interview with James today at 4 PM for 1 hour");
    await say("Repair phone today in the evening, 3 hours");
    await say("Write notes today at 11am for 30 minutes");
    await main.getState().addTask({ title: "Pay rent", dueAt: at("2026-11-18T09:00"), dueTz: NBO }, { autoPlace: false });
    await main.getState().addTask({ title: "Someday", dueAt: null }, { autoPlace: false });
    await main.getState().setSetting("smartAutoReschedule", false);
    clock.now = at("2026-11-18T16:20");
    const list = agenda(main.getState().tasks, main.getState().events, clock.now);
    expect(list.map((i) => [i.title, i.kind, i.status])).toEqual([
      ["Pay rent", "deadline", "overdue"],
      ["Write Notes", "flexible", "overdue"],
      ["Zoom Interview with James", "fixed", "now"],
      ["Repair Phone", "flexible", "upcoming"],
    ]);
    expect(list.map((i) => untilLabel(i, clock.now))).toEqual(["7 h 20 min overdue", "4 h 50 min overdue", "now · 40 min left", "in 55 min"]);
    expect(agenda([], [], clock.now)).toEqual([]); // the pop-up then shows its empty state
    expect(agenda(main.getState().tasks, main.getState().events, clock.now, { limit: 2 })).toHaveLength(2);
    void MIN;
  });
});
