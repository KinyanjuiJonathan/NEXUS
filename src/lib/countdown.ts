import type { PomodoroPhase, Timer } from "@/data/types";

/**
 * All timer math is derived from persisted timestamps (startedAt + accumulatedMs),
 * never from an in-memory tick counter. A timer therefore stays exact across
 * sleep/hibernate, app restarts and throttled background windows.
 */

export function elapsedMs(t: Pick<Timer, "startedAt" | "accumulatedMs" | "state">, now: number): number {
  const live = t.state === "running" && t.startedAt != null ? Math.max(0, now - t.startedAt) : 0;
  return t.accumulatedMs + live;
}

export function remainingMs(t: Timer, now: number): number {
  if (t.kind === "stopwatch") return 0;
  return Math.max(0, t.durationMs - elapsedMs(t, now));
}

export function progress(t: Timer, now: number): number {
  if (t.kind === "stopwatch" || t.durationMs <= 0) return 0;
  return Math.min(1, elapsedMs(t, now) / t.durationMs);
}

/** Expected finish instant of a running countdown (used to schedule the OS notification). */
export function finishAt(t: Timer, now: number): number | null {
  if (t.kind === "stopwatch" || t.state !== "running") return null;
  return now + remainingMs(t, now);
}

export function isExpired(t: Timer, now: number): boolean {
  return t.kind !== "stopwatch" && t.state === "running" && remainingMs(t, now) <= 0;
}

export function start(t: Timer, now: number): Timer {
  if (t.state === "running") return t;
  const base = t.state === "finished" ? { ...t, accumulatedMs: 0 } : t;
  return { ...base, state: "running", startedAt: now, updatedAt: now };
}

export function pause(t: Timer, now: number): Timer {
  if (t.state !== "running") return t;
  return { ...t, state: "paused", accumulatedMs: elapsedMs(t, now), startedAt: null, updatedAt: now };
}

export function reset(t: Timer, now: number): Timer {
  return { ...t, state: "idle", accumulatedMs: 0, startedAt: null, updatedAt: now };
}

export function finish(t: Timer, now: number): Timer {
  const total = t.kind === "stopwatch" ? elapsedMs(t, now) : t.durationMs;
  return { ...t, state: "finished", accumulatedMs: total, startedAt: null, updatedAt: now };
}

export interface PomodoroConfig {
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  longEvery: number;
}

/** Advance a pomodoro timer to its next phase (not running until started). */
export function nextPomodoroPhase(t: Timer, cfg: PomodoroConfig, now: number): Timer {
  let phase: PomodoroPhase;
  let cycle = t.cycle;
  if (t.phase === "focus") {
    cycle += 1;
    phase = cycle % Math.max(1, cfg.longEvery) === 0 ? "long_break" : "short_break";
  } else {
    phase = "focus";
  }
  const minutes = phase === "focus" ? cfg.focusMin : phase === "short_break" ? cfg.shortBreakMin : cfg.longBreakMin;
  return {
    ...t,
    phase,
    cycle,
    durationMs: minutes * 60_000,
    accumulatedMs: 0,
    startedAt: null,
    state: "idle",
    updatedAt: now,
  };
}

/** 01:23:45 / 23:45 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Compact human duration: "45 min", "2 h 5 min", "3 days". */
export function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60_000);
  if (abs < 60_000) return `${Math.max(0, Math.round(abs / 1000))} sec`;
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rem = min % 60;
  if (hours < 24) return rem ? `${hours} h ${rem} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  if (days < 7 && rh >= 1) return `${days} day${days > 1 ? "s" : ""} ${rh} h`;
  return `${days} day${days > 1 ? "s" : ""}`;
}

export type Urgency = "overdue" | "critical" | "soon" | "later" | "none";

export interface DeadlineInfo {
  label: string;
  urgency: Urgency;
  remaining: number;
}

/**
 * Remaining-time label for a deadline: "Deadline in 2 h", "Overdue by 3 h".
 * `warnMin` controls when the deadline is shown as critical.
 */
export function deadlineInfo(dueAt: number | null, now: number, warnMin = 60, noun = "Due"): DeadlineInfo {
  if (dueAt == null) return { label: "No deadline", urgency: "none", remaining: Infinity };
  const remaining = dueAt - now;
  if (remaining < 0) return { label: `Overdue by ${humanDuration(remaining)}`, urgency: "overdue", remaining };
  const urgency: Urgency =
    remaining <= warnMin * 60_000 ? "critical" : remaining <= 24 * 3600_000 ? "soon" : "later";
  return { label: `${noun} in ${humanDuration(remaining)}`, urgency, remaining };
}

/** "Starts in 45 min" / "In progress · 18 min left" / "Ended 2 h ago" */
export function eventStatus(start: number, end: number, now: number): { label: string; live: boolean; progress: number } {
  if (now < start) return { label: `Starts in ${humanDuration(start - now)}`, live: false, progress: 0 };
  if (now < end) {
    return {
      label: `In progress · ${humanDuration(end - now)} left`,
      live: true,
      progress: (now - start) / Math.max(1, end - start),
    };
  }
  return { label: `Ended ${humanDuration(now - end)} ago`, live: false, progress: 1 };
}

/** Time spent vs estimate: ratio and label. */
export function spentVsEstimate(spentMs: number, estimateMin: number | null): { ratio: number; label: string; over: boolean } {
  if (!estimateMin) return { ratio: 0, label: spentMs ? `${humanDuration(spentMs)} tracked` : "Not tracked", over: false };
  const est = estimateMin * 60_000;
  const ratio = spentMs / est;
  return {
    ratio,
    over: ratio > 1,
    label: `${humanDuration(spentMs)} / ${humanDuration(est)}`,
  };
}
