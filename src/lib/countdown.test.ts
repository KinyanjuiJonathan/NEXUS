import { describe, expect, it } from "vitest";
import type { Timer } from "@/data/types";
import {
  deadlineInfo,
  elapsedMs,
  eventStatus,
  finish,
  finishAt,
  formatClock,
  humanDuration,
  isExpired,
  nextPomodoroPhase,
  pause,
  progress,
  remainingMs,
  reset,
  spentVsEstimate,
  start,
} from "./countdown";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

const timer = (over: Partial<Timer> = {}): Timer => ({
  id: "t",
  kind: "countdown",
  label: "",
  taskId: null,
  durationMs: 25 * MIN,
  startedAt: null,
  accumulatedMs: 0,
  state: "idle",
  phase: null,
  cycle: 0,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

describe("timestamp-based countdowns", () => {
  it("start → pause → resume keeps exact remaining time", () => {
    let t = start(timer(), T0);
    expect(remainingMs(t, T0 + 10 * MIN)).toBe(15 * MIN);
    t = pause(t, T0 + 10 * MIN);
    // time passes while paused — nothing changes
    expect(remainingMs(t, T0 + 60 * MIN)).toBe(15 * MIN);
    t = start(t, T0 + 60 * MIN);
    expect(remainingMs(t, T0 + 67 * MIN)).toBe(8 * MIN);
    expect(progress(t, T0 + 67 * MIN)).toBeCloseTo(17 / 25);
  });

  it("stays accurate across sleep / restart (no ticks needed)", () => {
    // Simulate: timer persisted, app closed / PC asleep for 12 minutes, recomputed on wake.
    const persisted = JSON.parse(JSON.stringify(start(timer(), T0))) as Timer;
    expect(remainingMs(persisted, T0 + 12 * MIN)).toBe(13 * MIN);
    // Woke up after it should have ended
    expect(isExpired(persisted, T0 + 40 * MIN)).toBe(true);
    expect(remainingMs(persisted, T0 + 40 * MIN)).toBe(0);
  });

  it("reports the finish instant for OS notifications", () => {
    const t = start(timer(), T0);
    expect(finishAt(t, T0 + 5 * MIN)).toBe(T0 + 25 * MIN);
    expect(finishAt(pause(t, T0 + 5 * MIN), T0 + 6 * MIN)).toBeNull();
  });

  it("reset and finish", () => {
    const t = start(timer(), T0);
    expect(reset(t, T0 + MIN)).toMatchObject({ state: "idle", accumulatedMs: 0, startedAt: null });
    expect(finish(t, T0 + MIN)).toMatchObject({ state: "finished", accumulatedMs: 25 * MIN });
    // restarting a finished timer starts from zero
    expect(remainingMs(start(finish(t, T0 + MIN), T0 + 2 * MIN), T0 + 2 * MIN)).toBe(25 * MIN);
  });

  it("stopwatch counts up", () => {
    const sw = start(timer({ kind: "stopwatch", durationMs: 0 }), T0);
    expect(elapsedMs(sw, T0 + 90_000)).toBe(90_000);
    expect(remainingMs(sw, T0 + 90_000)).toBe(0);
    expect(isExpired(sw, T0 + 10 * 60 * MIN)).toBe(false);
  });

  it("pomodoro cycles focus → short break … → long break", () => {
    const cfg = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 };
    let t = timer({ kind: "pomodoro", phase: "focus" });
    const phases: string[] = [];
    for (let i = 0; i < 8; i++) {
      t = nextPomodoroPhase(t, cfg, T0);
      phases.push(`${t.phase}:${t.durationMs / MIN}`);
    }
    expect(phases).toEqual([
      "short_break:5", "focus:25", "short_break:5", "focus:25",
      "short_break:5", "focus:25", "long_break:15", "focus:25",
    ]);
  });
});

describe("remaining-time labels", () => {
  it("formats clocks and durations", () => {
    expect(formatClock(25 * MIN)).toBe("25:00");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(humanDuration(45 * MIN)).toBe("45 min");
    expect(humanDuration(125 * MIN)).toBe("2 h 5 min");
    expect(humanDuration(3 * 24 * 60 * MIN)).toBe("3 days");
  });

  it("deadline labels and urgency", () => {
    expect(deadlineInfo(T0 + 2 * 60 * MIN, T0, 60, "Deadline")).toMatchObject({ label: "Deadline in 2 h", urgency: "soon" });
    expect(deadlineInfo(T0 + 30 * MIN, T0, 60)).toMatchObject({ urgency: "critical" });
    expect(deadlineInfo(T0 + 3 * 24 * 60 * MIN, T0, 60, "Project due")).toMatchObject({ label: "Project due in 3 days", urgency: "later" });
    expect(deadlineInfo(T0 - 3 * 60 * MIN, T0)).toMatchObject({ label: "Overdue by 3 h", urgency: "overdue" });
    expect(deadlineInfo(null, T0).urgency).toBe("none");
  });

  it("event status", () => {
    expect(eventStatus(T0 + 45 * MIN, T0 + 90 * MIN, T0).label).toBe("Starts in 45 min");
    const live = eventStatus(T0 - 12 * MIN, T0 + 18 * MIN, T0);
    expect(live.label).toBe("In progress · 18 min left");
    expect(live.progress).toBeCloseTo(0.4);
  });

  it("time spent vs estimate", () => {
    expect(spentVsEstimate(45 * MIN, 30)).toMatchObject({ over: true, label: "45 min / 30 min" });
    expect(spentVsEstimate(15 * MIN, 60).ratio).toBe(0.25);
  });
});
