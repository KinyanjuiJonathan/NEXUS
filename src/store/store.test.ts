import { beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { createLocalBackend, memoryKV, readLocalReminders, type KV } from "@/data/backend";
import { createNexusStore } from "./store";
import { executeIntent, findTarget } from "@/lib/voice/execute";
import { parseCommand } from "@/lib/voice/parser";
import { clampOpacity, ensureVisible, nextMode, sizeForMode } from "@/lib/overlayGeometry";
import { dayStats, history } from "@/lib/stats";
import { suggestNext, proposeReorganization, breakdownLocally } from "@/lib/assistant";

const NBO = "Africa/Nairobi";
const at = (iso: string, zone = NBO) => DateTime.fromISO(iso, { zone }).toMillis();

let clock = at("2026-11-17T10:00");
let seq = 0;
let kv: KV;

function makeStore(shared?: KV) {
  kv = shared ?? memoryKV();
  const s = createNexusStore({ backend: createLocalBackend(kv), now: () => clock, id: () => `id${++seq}` });
  return s;
}

beforeEach(() => {
  clock = at("2026-11-17T10:00");
  seq = 0;
});

describe("tasks: create / edit / delete / restore / archive", () => {
  it("creates, edits and persists tasks across a 'restart'", async () => {
    const store = makeStore();
    await store.getState().init();
    await store.getState().setSetting("homeZone", NBO);
    const t = await store.getState().addTask({ title: "  Write report ", dueAt: at("2026-11-18T09:00"), priority: "high", estimateMin: 90 });
    expect(t.title).toBe("Write report");
    expect(t.reminders).toEqual([15, 0]); // default reminders applied when a deadline exists
    await store.getState().updateTask(t.id, {
      notes: "Q4 numbers",
      subtasks: [{ id: "s1", title: "Collect data", done: false }],
      categoryId: "projects",
    });

    // simulate app restart: brand-new store over the same storage
    const reopened = makeStore(kv);
    await reopened.getState().init();
    const got = reopened.getState().tasks.find((x) => x.id === t.id)!;
    expect(got).toMatchObject({ title: "Write report", notes: "Q4 numbers", priority: "high", categoryId: "projects", estimateMin: 90 });
    expect(got.subtasks).toHaveLength(1);
    expect(reopened.getState().settings.homeZone).toBe(NBO);
  });

  it("rejects empty titles", async () => {
    const store = makeStore();
    await store.getState().init();
    await expect(store.getState().addTask({ title: "   " })).rejects.toThrow();
    expect(store.getState().tasks).toHaveLength(0);
  });

  it("soft-deletes to trash with undo, restores and purges", async () => {
    const store = makeStore();
    await store.getState().init();
    const t = await store.getState().addTask({ title: "Groceries" });
    await store.getState().deleteTask(t.id);
    expect(store.getState().tasks[0].deletedAt).toBe(clock);
    const toast = store.getState().toasts.at(-1)!;
    expect(toast.action?.label).toBe("Undo");
    toast.action!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.getState().tasks[0].deletedAt).toBeNull();
    await store.getState().deleteTask(t.id);
    await store.getState().emptyTrash();
    expect(store.getState().tasks).toHaveLength(0);
  });

  it("completes, archives completed work and keeps history", async () => {
    const store = makeStore();
    await store.getState().init();
    const a = await store.getState().addTask({ title: "A" });
    await store.getState().addTask({ title: "B" });
    await store.getState().setTaskDone(a.id, true);
    expect(store.getState().tasks.find((t) => t.id === a.id)).toMatchObject({ status: "done", completedAt: clock });
    expect(await store.getState().archiveCompleted()).toBe(1);
    expect(store.getState().tasks.find((t) => t.id === a.id)!.archivedAt).toBe(clock);
  });

  it("recurring task spawns the next occurrence on completion", async () => {
    const store = makeStore();
    await store.getState().init();
    const t = await store.getState().addTask({
      title: "Weekly review",
      dueAt: at("2026-11-20T16:00"),
      dueTz: NBO,
      recurrence: { freq: "weekly", interval: 1 },
      subtasks: [{ id: "x", title: "Inbox zero", done: true }],
    });
    await store.getState().setTaskDone(t.id, true);
    const open = store.getState().tasks.filter((x) => x.status !== "done");
    expect(open).toHaveLength(1);
    expect(DateTime.fromMillis(open[0].dueAt!, { zone: NBO }).toFormat("ccc yyyy-LL-dd HH:mm")).toBe("Fri 2026-11-27 16:00");
    expect(open[0].subtasks[0].done).toBe(false);
  });

  it("reorders by drag and drop and persists order", async () => {
    const store = makeStore();
    await store.getState().init();
    const a = await store.getState().addTask({ title: "A" });
    const b = await store.getState().addTask({ title: "B" });
    const c = await store.getState().addTask({ title: "C" });
    await store.getState().reorderTasks([a.id, c.id, b.id]);
    const reopened = makeStore(kv);
    await reopened.getState().init();
    expect(reopened.getState().tasks.map((t) => t.title)).toEqual(["A", "C", "B"]);
  });
});

describe("reminders", () => {
  it("syncs future reminders for tasks and clears them on completion", async () => {
    const store = makeStore();
    await store.getState().init();
    const t = await store.getState().addTask({ title: "Call bank", dueAt: at("2026-11-17T12:00"), reminders: [60, 15, 0] });
    expect(readLocalReminders(kv).filter((r) => !r.firedAt).map((r) => r.fireAt)).toEqual([
      at("2026-11-17T11:00"), at("2026-11-17T11:45"), at("2026-11-17T12:00"),
    ]);
    await store.getState().setTaskDone(t.id, true);
    expect(readLocalReminders(kv).filter((r) => !r.firedAt)).toHaveLength(0);
  });

  it("schedules a notification when a countdown is started", async () => {
    const store = makeStore();
    await store.getState().init();
    const timer = await store.getState().startTimer({ kind: "countdown", minutes: 10 });
    const r = readLocalReminders(kv).find((x) => x.ownerId === timer.id)!;
    expect(r.fireAt).toBe(clock + 10 * 60_000);
    await store.getState().pauseTimer(timer.id);
    expect(readLocalReminders(kv).filter((x) => x.ownerId === timer.id && !x.firedAt)).toHaveLength(0);
  });
});

describe("timers in the store", () => {
  it("tracks focus time against the task and survives restart", async () => {
    const store = makeStore();
    await store.getState().init();
    const task = await store.getState().addTask({ title: "Deep work", estimateMin: 50 });
    const timer = await store.getState().startTimer({ kind: "pomodoro", taskId: task.id });
    expect(store.getState().settings.activeTaskId).toBe(task.id);
    expect(store.getState().tasks.find((t) => t.id === task.id)!.status).toBe("in_progress");

    // app closed for 10 minutes, then reopened
    clock += 10 * 60_000;
    const reopened = makeStore(kv);
    await reopened.getState().init();
    const t2 = reopened.getState().timers.find((t) => t.id === timer.id)!;
    expect(t2.state).toBe("running");

    // wakes up after the focus block ended → processed exactly once
    clock += 30 * 60_000;
    await reopened.getState().processTimers();
    const after = reopened.getState().timers.find((t) => t.id === timer.id)!;
    expect(after.phase).toBe("short_break");
    expect(after.state).toBe("idle");
    expect(reopened.getState().focusSessions.at(-1)!.durationMs).toBe(25 * 60_000);
    expect(reopened.getState().tasks.find((t) => t.id === task.id)!.spentMs).toBe(25 * 60_000);
    await reopened.getState().processTimers();
    expect(reopened.getState().focusSessions).toHaveLength(1);
  });
});

describe("events & rescheduling in the store", () => {
  it("moves a single occurrence of a series without touching the others", async () => {
    const store = makeStore();
    await store.getState().init();
    const e = await store.getState().addEvent({
      title: "Standup", startAt: at("2026-11-16T09:00"), endAt: at("2026-11-16T09:15"), tz: NBO,
      recurrence: { freq: "daily", interval: 1 },
    });
    const { expandEvents } = await import("@/lib/schedule");
    const occ = expandEvents(store.getState().events, at("2026-11-18T00:00"), at("2026-11-19T00:00"))[0];
    await store.getState().moveOccurrence(occ, at("2026-11-18T11:00"), at("2026-11-18T11:15"), "single");
    const day = expandEvents(store.getState().events, at("2026-11-18T00:00"), at("2026-11-19T00:00"));
    expect(day.map((o) => DateTime.fromMillis(o.start, { zone: NBO }).toFormat("HH:mm"))).toEqual(["11:00"]);
    const next = expandEvents(store.getState().events, at("2026-11-19T00:00"), at("2026-11-20T00:00"));
    expect(DateTime.fromMillis(next[0].start, { zone: NBO }).toFormat("HH:mm")).toBe("09:00");
    expect(store.getState().events.find((x) => x.id === e.id)!.tz).toBe(NBO);
  });
});

describe("voice commands end-to-end", () => {
  const ctx = () => ({ now: clock, homeZone: NBO, texasZone: "America/Chicago" });

  it("adds, queries, focuses, reschedules and completes", async () => {
    const store = makeStore();
    await store.getState().init();
    await store.getState().setSetting("homeZone", NBO);
    const deps = { state: store.getState, now: () => clock };

    let r = await executeIntent(parseCommand("Add a task to finish my report tomorrow at 9 AM", ctx()).intent, deps);
    expect(r.ok).toBe(true);
    await executeIntent(parseCommand("Schedule a meeting with the client on Thursday at 2 pm", ctx()).intent, deps);

    r = await executeIntent(parseCommand("Move my meeting to Friday at 3 PM Texas time", ctx()).intent, deps);
    expect(r.message).toContain("Moved");
    const ev = store.getState().events[0];
    expect(DateTime.fromMillis(ev.startAt, { zone: "America/Chicago" }).toFormat("ccc HH:mm")).toBe("Fri 15:00");

    r = await executeIntent(parseCommand("Start a 25-minute focus session", ctx()).intent, deps);
    expect(r.message).toContain("25-minute");
    clock += 7 * 60_000;
    r = await executeIntent(parseCommand("How much time is left?", ctx()).intent, deps);
    expect(r.message).toContain("18:00 remaining");

    const report = store.getState().tasks.find((t) => t.title === "Finish my report")!;
    await store.getState().setActiveTask(report.id);
    r = await executeIntent(parseCommand("Mark my current task as complete", ctx()).intent, deps);
    expect(r.ok).toBe(true);
    expect(store.getState().tasks.find((t) => t.id === report.id)!.status).toBe("done");

    r = await executeIntent(parseCommand("Show my upcoming appointments", ctx()).intent, deps);
    expect(r.lines).toHaveLength(1);
  });

  it("target matching prefers the closest title", async () => {
    const store = makeStore();
    await store.getState().init();
    await store.getState().addTask({ title: "Dentist appointment" });
    await store.getState().addTask({ title: "Gym" });
    expect(findTarget(store.getState(), "the dentist", clock)?.title).toBe("Dentist appointment");
    expect(findTarget(store.getState(), "taxes", clock)).toBeNull();
  });
});

describe("dashboard stats & assistant", () => {
  it("computes today's stats and weekly history", async () => {
    const store = makeStore();
    await store.getState().init();
    const a = await store.getState().addTask({ title: "A", dueAt: at("2026-11-17T15:00") });
    await store.getState().addTask({ title: "B", dueAt: at("2026-11-17T18:00") });
    await store.getState().addTask({ title: "Late", dueAt: at("2026-11-16T18:00") });
    await store.getState().setTaskDone(a.id, true);
    const st = dayStats(store.getState().tasks, [], clock, NBO);
    expect(st).toMatchObject({ totalToday: 2, completedToday: 1, pendingToday: 1, overdue: 1 });
    const h = history(store.getState().tasks, [], clock, NBO, 7);
    expect(h).toHaveLength(7);
    expect(h.at(-1)!.completed).toBe(1);
  });

  it("suggests the overdue critical task first and proposes slots without applying them", async () => {
    const store = makeStore();
    await store.getState().init();
    await store.getState().addTask({ title: "Someday", priority: "low" });
    const urgent = await store.getState().addTask({ title: "Tax filing", priority: "critical", dueAt: at("2026-11-16T12:00"), estimateMin: 60 });
    expect(suggestNext(store.getState().tasks, clock)!.task.id).toBe(urgent.id);
    const props = proposeReorganization(store.getState().tasks, [], clock, { zone: NBO, startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] });
    expect(props[0].task.id).toBe(urgent.id);
    expect(props[0].slot!.start).toBeGreaterThan(clock);
    expect(store.getState().tasks.find((t) => t.id === urgent.id)!.dueAt).toBe(at("2026-11-16T12:00"));
    expect(breakdownLocally("Write the quarterly report").length).toBeGreaterThan(3);
  });
});

describe("overlay positioning & settings", () => {
  const primary = { x: 0, y: 0, w: 1920, h: 1080 };
  const right = { x: 1920, y: 0, w: 2560, h: 1440 };

  it("keeps a visible window where it is (multi-monitor)", () => {
    expect(ensureVisible({ x: 3000, y: 100, w: 360, h: 236 }, [primary, right])).toEqual({ x: 3000, y: 100, w: 360, h: 236 });
  });

  it("clamps a window hanging off the edge", () => {
    expect(ensureVisible({ x: 1800, y: -20, w: 360, h: 236 }, [primary])).toEqual({ x: 1560, y: 0, w: 360, h: 236 });
  });

  it("rescues a window from a disconnected monitor to the primary's top-right", () => {
    expect(ensureVisible({ x: 3000, y: 100, w: 360, h: 236 }, [primary])).toEqual({ x: 1920 - 360 - 16, y: 16, w: 360, h: 236 });
  });

  it("mode sizes, cycling and opacity bounds", () => {
    expect(sizeForMode("mini")).toEqual({ w: 300, h: 64 });
    expect(sizeForMode("standard", { standard: { w: 500, h: 300 } })).toEqual({ w: 500, h: 300 });
    expect(sizeForMode("standard", { standard: { w: 5, h: 5 } })).toEqual({ w: 360, h: 236 });
    expect([nextMode("mini"), nextMode("standard"), nextMode("expanded")]).toEqual(["standard", "expanded", "mini"]);
    expect(clampOpacity(0.05)).toBe(0.25);
    expect(clampOpacity(2)).toBe(1);
    expect(clampOpacity(NaN)).toBe(0.86);
  });

  it("persists overlay settings", async () => {
    const store = makeStore();
    await store.getState().init();
    await store.getState().setSetting("overlayMode", "mini");
    await store.getState().setSetting("overlayOpacity", 0.6);
    await store.getState().setSetting("overlaySizes", { mini: { w: 320, h: 70 } });
    const reopened = makeStore(kv);
    await reopened.getState().init();
    expect(reopened.getState().settings).toMatchObject({ overlayMode: "mini", overlayOpacity: 0.6, overlaySizes: { mini: { w: 320, h: 70 } } });
  });

  it("migrates the America/El_Paso alias in stored settings", async () => {
    const shared = memoryKV();
    const s1 = makeStore(shared);
    await s1.getState().init();
    await createLocalBackend(shared).setSetting("texasZone", "America/El_Paso");
    const s2 = makeStore(shared);
    await s2.getState().init();
    expect(s2.getState().settings.texasZone).toBe("America/Denver");
  });
});
