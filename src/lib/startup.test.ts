import { describe, expect, it } from "vitest";
import type { Backend } from "@/data/backend";
import { createLocalBackend, memoryKV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { agenda } from "@/lib/smart/agenda";
import { queueUnits } from "@/lib/smart/reschedule";
import { filterTasks } from "@/lib/taskViews";
import { expandEvents } from "@/lib/schedule";
import { backupKind, bestBackup, isStarting, isUnavailable, loadWhenReady, plainError, type BackupInfo } from "./startup";

const NOT_MANAGED = "state not managed for field `state` on command `load_snapshot`. You must call `.manage()` before using this command";
const instant = { sleep: async () => {}, now: (() => { let t = 0; return () => (t += 100); })() };

describe("loading while the app is still starting", () => {
  it("recognises 'not ready yet' answers, old and new, and real failures", () => {
    expect(isStarting(new Error(NOT_MANAGED))).toBe(true);
    expect(isStarting("NEXUS_STARTING: the database is still being opened")).toBe(true);
    expect(isStarting("NEXUS_DATA_UNAVAILABLE: file is not a database")).toBe(false);
    expect(isUnavailable("NEXUS_DATA_UNAVAILABLE: file is not a database")).toBe(true);
    expect(plainError("NEXUS_DATA_UNAVAILABLE: file is not a database")).toBe("file is not a database");
  });

  it("asks again until the database is open, instead of giving up on the first answer", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls < 4) throw new Error(calls === 1 ? NOT_MANAGED : "NEXUS_STARTING: the database is still being opened");
      return "snapshot";
    };
    expect(await loadWhenReady(load, { sleep: async () => {} })).toBe("snapshot");
    expect(calls).toBe(4);
  });

  it("passes a real failure on at once and gives up after the time limit", async () => {
    let calls = 0;
    await expect(loadWhenReady(async () => { calls += 1; throw new Error("NEXUS_DATA_UNAVAILABLE: damaged"); }, instant)).rejects.toThrow("damaged");
    expect(calls).toBe(1);
    await expect(loadWhenReady(async () => { throw new Error(NOT_MANAGED); }, { ...instant, timeoutMs: 1000 })).rejects.toThrow("too long");
  });

  it("offers the newest usable backup first and names each kind", () => {
    const b = (name: string, modifiedMs: number, tasks: number | null, valid = true): BackupInfo => ({ path: `/b/${name}`, name, bytes: 1000, modifiedMs, tasks, events: tasks, valid });
    const list = [b("nexus-set-aside-9.db", 9, 5), b("nexus-recent-8.db", 8, null, false), b("nexus-recent-7.db", 7, 0), b("nexus-auto-6.db", 6, 12), b("nexus-auto-5.db", 5, 11)];
    expect(bestBackup(list)?.name).toBe("nexus-auto-6.db"); // not the damaged one, not the empty one, not a set-aside copy
    expect(bestBackup([b("nexus-recent-7.db", 7, 0)])?.name).toBe("nexus-recent-7.db");
    expect(bestBackup([])).toBeNull();
    expect(backupKind("nexus-auto-000001.db")).toBe("Daily backup");
    expect(backupKind("nexus-pre-v4-123.db")).toBe("Before an update");
  });
});

describe("the app when saved data cannot be loaded", () => {
  /** A backend whose load fails until `heal()` is called; every write is recorded. */
  function flaky(error: string, kv = memoryKV()) {
    const real = createLocalBackend(kv);
    const writes: string[] = [];
    let broken = true;
    const backend = new Proxy(real, {
      get(target, prop: string) {
        const v = (target as unknown as Record<string, unknown>)[prop];
        if (prop === "load") return async () => { if (broken) throw new Error(error); return target.load(); };
        if (typeof v !== "function" || prop.startsWith("on")) return v;
        return (...args: unknown[]) => { writes.push(prop); return (v as (...a: unknown[]) => unknown).apply(target, args); };
      },
    }) as Backend;
    return { backend, real, kv, writes, heal: () => (broken = false) };
  }

  it("shows nothing as if it were empty data, saves nothing, and loads everything once the database is back", async () => {
    // a first session with real data
    const kv = memoryKV();
    let seq = 0;
    const first = createNexusStore({ backend: createLocalBackend(kv), now: () => 1_800_000_000_000, id: () => `id${++seq}` });
    await first.getState().init();
    const t = await first.getState().addTask({ title: "Write report", estimateMin: 60, reminders: [] }, { autoPlace: false });
    await first.getState().addEvent({ title: "Write report", startAt: 1_800_000_000_000 + 3600_000, endAt: 1_800_000_000_000 + 7200_000, taskId: t.id, reminders: [] });
    await first.getState().addEvent({ title: "Client call", startAt: 1_800_000_000_000 + 9000_000, endAt: 1_800_000_000_000 + 12600_000, reminders: [] });
    await first.getState().setSetting("homeZone", "Africa/Nairobi");

    // the next start: loading fails
    const f = flaky("NEXUS_DATA_UNAVAILABLE: The database failed its integrity check.", kv); // the same stored data underneath
    const store = createNexusStore({ backend: f.backend, now: () => 1_800_000_000_000, id: () => `x${++seq}` });
    await store.getState().init();
    expect(store.getState().ready).toBe(false);
    expect(store.getState().error).toContain("integrity check");
    // nothing runs or saves on top of data that was not loaded
    await store.getState().handleActivity({ kind: "back", at: 1_800_000_000_000 });
    await store.getState().handleIdle(600);
    expect(await store.getState().autoReschedule()).toEqual([]);
    expect(await store.getState().mergeSplitTasks()).toBe(0);
    expect(f.writes).toEqual([]);
    expect(store.getState().workSessions).toEqual([]);

    // the database is readable again ("Try again" on the recovery screen)
    f.heal();
    await store.getState().init();
    expect(store.getState()).toMatchObject({ ready: true, error: null });
    expect(store.getState().tasks.map((x) => x.title)).toEqual(["Write report"]);
    expect(store.getState().events.map((x) => x.title).sort()).toEqual(["Client call", "Write report"]);
    expect(store.getState().settings.homeZone).toBe("Africa/Nairobi");
  });

  it("recovered data is the same in every part of the app, and in a second window", async () => {
    const kv = memoryKV();
    let seq = 0;
    const now = Date.UTC(2026, 10, 18, 7, 0);
    const make = () => createNexusStore({ backend: createLocalBackend(kv), now: () => now, id: () => `id${++seq}` });
    const first = make();
    await first.getState().init();
    await first.getState().setSetting("homeZone", "Africa/Nairobi");
    const t = await first.getState().addTask({ title: "Write report", estimateMin: 60, reminders: [], subtasks: [{ id: "s1", title: "Outline", done: true }] }, { autoPlace: false });
    await first.getState().addEvent({ title: "Write report", startAt: now + 3600_000, endAt: now + 7200_000, taskId: t.id, reminders: [], sched: { origin: "smart", request: "Write the report today" } });
    await first.getState().addEvent({ title: "Client call", startAt: now + 9000_000, endAt: now + 12600_000, reminders: [] });
    const done = await first.getState().addTask({ title: "Send invoice", reminders: [] }, { autoPlace: false });
    await first.getState().setTaskDone(done.id, true);

    // after a restart: the main window and the overlay each load from the same stored data
    for (const win of [make(), make()]) {
      await win.getState().init();
      const s = win.getState();
      expect(s).toMatchObject({ ready: true, error: null });
      expect(s.settings.homeZone).toBe("Africa/Nairobi"); // preferences
      expect(filterTasks(s.tasks, "all", now, "Africa/Nairobi", s.events).map((x) => x.title)).toEqual(["Write report"]); // Tasks
      expect(filterTasks(s.tasks, "completed", now, "Africa/Nairobi", s.events).map((x) => x.title)).toEqual(["Send invoice"]); // history of completed tasks
      expect(s.tasks.find((x) => x.id === t.id)!.subtasks).toEqual([{ id: "s1", title: "Outline", done: true }]);
      expect(expandEvents(s.events, now, now + 86_400_000).map((o) => o.event.title)).toEqual(["Write report", "Client call"]); // Calendar
      expect(queueUnits(s.tasks, s.events, now).map((u) => u.title)).toEqual(["Write report"]); // Dashboard queue
      expect(agenda(s.tasks, s.events, now, { limit: 5 }).map((i) => i.title)).toEqual(["Write report", "Client call"]); // overlay schedule
      expect(s.events.find((e) => e.taskId === t.id)!.sched).toMatchObject({ origin: "smart", request: "Write the report today" }); // AI scheduler details
      expect(s.activity.some((a) => a.kind === "task_completed")).toBe(true);
    }
  });
});
