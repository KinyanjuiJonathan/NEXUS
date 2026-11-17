import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import type { CalendarEvent, Task, WorkSession } from "@/data/types";
import { activeSession, openPause, pausedMs, workIntervals, workedBetween, workedMs } from "./work";
import { freeWorkingIntervals, planTasks } from "./planner";
import { computeInsights } from "./insights";

const NBO = "Africa/Nairobi";
const at = (iso: string) => DateTime.fromISO(iso, { zone: NBO }).toMillis();
const hm = (ms: number) => DateTime.fromMillis(ms, { zone: NBO }).toFormat("ccc HH:mm");
const MIN = 60_000;
const wh = { zone: NBO, startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] };

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: `t${++n}`, title: `Task ${n}`, notes: "", priority: "medium", categoryId: "work", status: "todo", dueAt: null, dueTz: NBO,
  estimateMin: 60, spentMs: 0, sortOrder: n, recurrence: null, reminders: [], subtasks: [], completedAt: null, archivedAt: null,
  deletedAt: null, createdAt: 0, updatedAt: 0, ...o,
});
const ev = (s: string, e: string, o: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `e${++n}`, title: "Busy", notes: "", startAt: at(s), endAt: at(e), tz: NBO, taskId: null, recurrence: null, important: false,
  reminders: [], color: null, createdAt: 0, updatedAt: 0, deletedAt: null, ...o,
});
const session = (o: Partial<WorkSession>): WorkSession => ({ id: `w${++n}`, startedAt: at("2026-11-17T09:00"), endedAt: null, pauses: [], note: "", createdAt: 0, updatedAt: 0, ...o });

describe("work clock", () => {
  it("worked time excludes pauses, including an ongoing one", () => {
    const s = session({ pauses: [{ start: at("2026-11-17T10:00"), end: at("2026-11-17T10:20"), reason: "idle" }, { start: at("2026-11-17T11:30"), end: null, reason: "manual" }] });
    const now = at("2026-11-17T12:00");
    expect(workedMs(s, now)).toBe((60 + 70) * MIN);
    expect(pausedMs(s, now)).toBe(50 * MIN);
    expect(pausedMs(s, now, "idle")).toBe(20 * MIN);
    expect(openPause(s)?.reason).toBe("manual");
    expect(activeSession([s])).toBe(s);
  });

  it("a session spanning midnight is split across days", () => {
    const s = session({ startedAt: at("2026-11-17T22:00"), endedAt: at("2026-11-18T01:00") });
    expect(workedBetween([s], at("2026-11-17T00:00"), at("2026-11-18T00:00"), 0)).toBe(120 * MIN);
    expect(workedBetween([s], at("2026-11-18T00:00"), at("2026-11-19T00:00"), 0)).toBe(60 * MIN);
    expect(workIntervals(s, 0)).toHaveLength(1);
  });

  it("closed sessions ignore 'now'", () => {
    const s = session({ endedAt: at("2026-11-17T10:00") });
    expect(workedMs(s, at("2026-11-20T00:00"))).toBe(60 * MIN);
  });
});

describe("auto-placement", () => {
  const now = at("2026-11-17T08:00"); // Tuesday

  it("finds free working intervals around appointments with a buffer", () => {
    const gaps = freeWorkingIntervals([ev("2026-11-17T10:00", "2026-11-17T11:00")], now, wh, 0, 10 * MIN);
    expect(gaps.map((g) => `${hm(g.start)}-${hm(g.end).slice(4)}`)).toEqual(["Tue 09:00-09:50", "Tue 11:10-17:00"]);
  });

  it("places the earliest deadline first and respects existing events", () => {
    const a = task({ title: "Later", dueAt: at("2026-11-20T17:00"), estimateMin: 60 });
    const b = task({ title: "Sooner", dueAt: at("2026-11-17T17:00"), estimateMin: 45 });
    const r = planTasks([a, b], [ev("2026-11-17T09:00", "2026-11-17T10:00")], wh, now, { bufferMin: 10 });
    expect(r.blocks.map((x) => `${x.title} ${hm(x.start)}-${hm(x.end).slice(4)}`)).toEqual(["Sooner Tue 10:10-10:55", "Later Tue 11:05-12:05"]);
    expect(r.unplaced).toHaveLength(0);
    expect(r.lateTaskIds).toHaveLength(0);
  });

  it("splits long tasks into chunks and skips small fragments", () => {
    const big = task({ title: "Big", estimateMin: 300 });
    const r = planTasks([big], [ev("2026-11-17T09:15", "2026-11-17T12:00")], wh, now, { bufferMin: 0, chunkMaxMin: 120, minChunkMin: 25 });
    // 09:00–09:15 is too small; 12:00–14:00, 14:00–16:00, then 1 h left
    expect(r.blocks.map((x) => `${hm(x.start)}-${hm(x.end).slice(4)} ${x.part}/${x.parts}`)).toEqual(["Tue 12:00-14:00 1/3", "Tue 14:00-16:00 2/3", "Tue 16:00-17:00 3/3"]);
  });

  it("never leaves a tiny leftover block", () => {
    const t = task({ title: "PRs", estimateMin: 45 });
    // only 40 min free before a meeting at 10:00 (no buffer), then free afterwards
    const r = planTasks([t], [ev("2026-11-17T09:40", "2026-11-17T10:00"), ev("2026-11-17T08:00", "2026-11-17T09:00")], wh, now, { bufferMin: 0 });
    expect(r.blocks.map((x) => `${hm(x.start)}-${hm(x.end).slice(4)}`)).toEqual(["Tue 10:00-10:45"]);
    const long = task({ title: "Long", estimateMin: 70 });
    const r2 = planTasks([long], [ev("2026-11-17T09:50", "2026-11-17T12:00")], wh, now, { bufferMin: 0, minChunkMin: 25 });
    // 09:00–09:50 can hold 45 min leaving 25 (not 50 + 20)
    expect(r2.blocks.map((x) => (x.end - x.start) / MIN)).toEqual([45, 25]);
  });

  it("subtracts time already spent, skips done tasks and tasks that already have an upcoming block", () => {
    const half = task({ estimateMin: 60, spentMs: 40 * MIN });
    const done = task({ status: "done" });
    const blocked = task({});
    const r = planTasks([half, done, blocked], [ev("2026-11-18T09:00", "2026-11-18T10:00", { taskId: blocked.id })], wh, now);
    expect(r.blocks.map((b) => b.taskId)).toEqual([half.id]);
    expect(r.blocks[0].end - r.blocks[0].start).toBe(20 * MIN);
  });

  it("flags work that can't finish before its deadline and work that doesn't fit at all", () => {
    const urgent = task({ title: "Urgent", dueAt: at("2026-11-17T09:30"), estimateMin: 60 });
    const r1 = planTasks([urgent], [], wh, now);
    expect(r1.lateTaskIds).toEqual([urgent.id]);
    const huge = task({ title: "Huge", estimateMin: 10_000 });
    const r2 = planTasks([huge], [], wh, now, { horizonDays: 2 });
    expect(r2.unplaced[0].title).toBe("Huge");
    expect(r2.unplaced[0].minutesLeft).toBeGreaterThan(0);
  });
});

describe("insights", () => {
  it("summarises work, focus, estimates, on-time rate and peak hours", () => {
    const now = at("2026-11-20T18:00");
    const tasks = [
      task({ completedAt: at("2026-11-18T10:30"), dueAt: at("2026-11-18T12:00"), estimateMin: 60, spentMs: 90 * MIN, status: "done" }),
      task({ completedAt: at("2026-11-19T10:15"), dueAt: at("2026-11-19T09:00"), estimateMin: 30, spentMs: 45 * MIN, status: "done" }),
      task({ completedAt: at("2026-11-20T11:00"), dueAt: at("2026-11-21T09:00"), estimateMin: 40, spentMs: 60 * MIN, status: "done" }),
    ];
    const focus = [
      { id: "f1", taskId: tasks[0].id, kind: "pomodoro" as const, startedAt: at("2026-11-18T10:00"), endedAt: at("2026-11-18T10:50"), durationMs: 50 * MIN },
      { id: "f2", taskId: tasks[1].id, kind: "pomodoro" as const, startedAt: at("2026-11-19T10:00"), endedAt: at("2026-11-19T10:25"), durationMs: 25 * MIN },
    ];
    const work = [session({ startedAt: at("2026-11-18T09:00"), endedAt: at("2026-11-18T13:00"), pauses: [{ start: at("2026-11-18T11:00"), end: at("2026-11-18T11:30"), reason: "idle" }] })];
    const r = computeInsights({ tasks, focus, work, activity: [], categories: [], now, zone: NBO, days: 7 });
    expect(r.totals).toMatchObject({ workedMin: 210, focusMin: 75, completed: 3 });
    expect(r.onTime).toMatchObject({ onTime: 2, late: 1 });
    expect(r.estimate.bias).toBeCloseTo(1.5);
    expect(r.peakHour).toBe(10);
    expect(r.sessions.idlePausedMin).toBe(30);
    expect(r.streak).toBe(3);
    expect(r.findings.some((f) => f.includes("50% longer"))).toBe(true);
    expect(r.findings.some((f) => f.includes("10 AM"))).toBe(true);
    expect(r.daily).toHaveLength(7);
  });

  it("has a friendly message with no history", () => {
    const r = computeInsights({ tasks: [], focus: [], work: [], activity: [], categories: [], now: at("2026-11-20T18:00"), zone: NBO, days: 30 });
    expect(r.findings[0]).toContain("Not enough history");
    expect(r.onTime.rate).toBeNull();
  });
});
