import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { createLocalBackend, memoryKV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { dueOnDay, isHighPriority, scheduledTasks, taskCalendarState, tasksForDay, unscheduledOpenTasks } from "./calendarTasks";

const NBO = "Africa/Nairobi";
const at = (iso: string, zone = NBO) => DateTime.fromISO(iso, { zone }).toMillis();
const day = (iso: string) => [at(`${iso}T00:00`), at(`${iso}T00:00`) + 86_400_000] as const;

async function setup() {
  let seq = 0;
  const clock = { now: at("2026-11-18T10:00") };
  const store = createNexusStore({ backend: createLocalBackend(memoryKV()), now: () => clock.now, id: () => `id${++seq}` });
  await store.getState().init();
  await store.getState().setSetting("homeZone", NBO);
  const add = (title: string, due: string | null, extra: Record<string, unknown> = {}) =>
    store.getState().addTask({ title, dueAt: due ? at(due) : null, dueTz: due ? NBO : null, ...extra }, { autoPlace: false });
  const on = (iso: string) => tasksForDay(store.getState().tasks, ...day(iso)).map((t) => t.title);
  return { store, clock, add, on };
}

describe("To-Do tasks on the calendar", () => {
  it("shows every scheduled task on the day it is due, in time order", async () => {
    const { add, on, store } = await setup();
    await add("Afternoon", "2026-11-18T15:00");
    await add("Morning", "2026-11-18T08:30");
    await add("Tomorrow", "2026-11-19T09:00");
    await add("Last minute of the day", "2026-11-18T23:59");
    await add("Someday", null);
    expect(on("2026-11-18")).toEqual(["Morning", "Afternoon", "Last minute of the day"]);
    expect(on("2026-11-19")).toEqual(["Tomorrow"]);
    expect(on("2026-11-20")).toEqual([]);
    // tasks without a date are not on the calendar but stay in the To-Do list
    expect(scheduledTasks(store.getState().tasks).map((t) => t.title)).not.toContain("Someday");
    expect(unscheduledOpenTasks(store.getState().tasks).map((t) => t.title)).toEqual(["Someday"]);
    expect(store.getState().tasks.some((t) => t.title === "Someday" && !t.deletedAt)).toBe(true);
  });

  it("follows the To-Do list immediately: reschedule, complete, date added or removed, delete, archive", async () => {
    const { add, on, store } = await setup();
    const t = await add("Report", "2026-11-18T12:00");
    const someday = await add("Someday", null);
    expect(on("2026-11-18")).toEqual(["Report"]);

    await store.getState().updateTask(t.id, { dueAt: at("2026-11-21T12:00") });
    expect(on("2026-11-18")).toEqual([]);
    expect(on("2026-11-21")).toEqual(["Report"]);

    await store.getState().updateTask(someday.id, { dueAt: at("2026-11-21T09:00"), dueTz: NBO });
    expect(on("2026-11-21")).toEqual(["Someday", "Report"]);
    await store.getState().updateTask(someday.id, { dueAt: null });
    expect(on("2026-11-21")).toEqual(["Report"]);

    await store.getState().setTaskDone(t.id, true);
    const done = tasksForDay(store.getState().tasks, ...day("2026-11-21"))[0];
    expect(taskCalendarState(done, at("2026-11-18T10:00"))).toBe("done"); // still shown, marked completed
    await store.getState().setTaskDone(t.id, false);

    await store.getState().archiveTask(t.id, true);
    expect(on("2026-11-21")).toEqual([]);
    await store.getState().archiveTask(t.id, false);
    await store.getState().deleteTask(t.id);
    expect(on("2026-11-21")).toEqual([]);
  });

  it("a change made from the calendar shows in the To-Do list", async () => {
    const { add, store } = await setup();
    const t = await add("Call the bank", "2026-11-18T16:30");
    // what dropping the task on another day in the calendar does
    const moved = dueOnDay(store.getState().tasks.find((x) => x.id === t.id)!, at("2026-11-25T00:00"), NBO)!;
    await store.getState().updateTask(t.id, { dueAt: moved });
    const inList = store.getState().tasks.find((x) => x.id === t.id)!;
    expect(DateTime.fromMillis(inList.dueAt!, { zone: NBO }).toFormat("yyyy-LL-dd HH:mm")).toBe("2026-11-25 16:30");
    // ticking it off in the calendar
    await store.getState().setTaskDone(t.id, true);
    expect(store.getState().tasks.find((x) => x.id === t.id)!.status).toBe("done");
  });

  it("tells pending, overdue, completed and high-priority tasks apart", async () => {
    const { add, store, clock } = await setup();
    const late = await add("Late", "2026-11-18T09:00");
    const soon = await add("Soon", "2026-11-18T11:00", { priority: "critical" });
    const low = await add("Low", "2026-11-18T12:00", { priority: "low" });
    const get = (id: string) => store.getState().tasks.find((t) => t.id === id)!;
    expect(taskCalendarState(get(late.id), clock.now)).toBe("overdue");
    expect(taskCalendarState(get(soon.id), clock.now)).toBe("pending");
    expect(isHighPriority(get(soon.id))).toBe(true);
    expect(isHighPriority(get(low.id))).toBe(false);
    await store.getState().setTaskDone(late.id, true);
    expect(taskCalendarState(get(late.id), clock.now)).toBe("done"); // completed is never "overdue"
  });

  it("keeps the time of day in the task's own zone when moved to another day", () => {
    const task = { dueAt: at("2026-11-18T09:15", "America/Chicago"), dueTz: "America/Chicago" } as Parameters<typeof dueOnDay>[0];
    // dropped on 22 Nov in a calendar showing Nairobi time
    const moved = dueOnDay(task, at("2026-11-22T00:00"), NBO)!;
    expect(DateTime.fromMillis(moved, { zone: "America/Chicago" }).toFormat("yyyy-LL-dd HH:mm")).toBe("2026-11-22 09:15");
    expect(dueOnDay({ ...task, dueAt: null }, at("2026-11-22T00:00"), NBO)).toBeNull();
  });
});
