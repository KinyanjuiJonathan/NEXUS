import type { CalendarEvent, Task, WorkSession } from "@/data/types";
import { activeSession, openPause, workedBetween } from "@/lib/work";

/**
 * How much of a task's reserved time was really worked, measured by the work
 * clock. A flexible block is only "used up" once the planned time has been
 * clocked (or the task is marked complete): time away from the computer does
 * not count, and what is left is carried to the block's next time.
 */

const MIN = 60_000;
/** Less than this left counts as the planned time being done. */
export const DONE_SLACK = 2 * MIN;
/** Absences shorter than this are not worth mentioning. */
export const AWAY_MIN = MIN;

export interface BlockClock {
  /** Total time the task was given. */
  targetMs: number;
  /** Clocked so far: earlier blocks, this block, and time counted by hand. */
  workedMs: number;
  remainingMs: number;
  /** The planned time has been clocked. */
  done: boolean;
}

export function blockClock(e: CalendarEvent, sessions: WorkSession[], now: number): BlockClock {
  const targetMs = Math.max(0, e.sched?.targetMs ?? e.endAt - e.startAt);
  const upTo = Math.min(now, e.endAt);
  const inBlock = upTo > e.startAt ? workedBetween(sessions, e.startAt, upTo, now) : 0;
  const workedMs = Math.min(targetMs, (e.sched?.workedMs ?? 0) + inBlock);
  const remainingMs = Math.max(0, targetMs - workedMs);
  return { targetMs, workedMs, remainingMs, done: remainingMs < DONE_SLACK };
}

const open = (t: Task | undefined): t is Task => !!t && !t.deletedAt && !t.archivedAt && t.status !== "done";

/** The flexible task block that is under way right now, if any. */
export function currentBlock(tasks: Task[], events: CalendarEvent[], now: number): { event: CalendarEvent; task: Task } | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let best: { event: CalendarEvent; task: Task } | null = null;
  for (const e of events) {
    if (e.deletedAt || e.fixed || e.recurrence || !e.taskId || e.startAt > now || e.endAt <= now) continue;
    const task = byId.get(e.taskId);
    if (!open(task)) continue;
    if (!best || e.startAt < best.event.startAt) best = { event: e, task };
  }
  return best;
}

/** working: the clock is counting. away: paused for inactivity. break: paused by hand. off: not clocked in. */
export type ClockState = "working" | "away" | "break" | "off";

export function clockState(sessions: WorkSession[]): { state: ClockState; since: number | null } {
  const w = activeSession(sessions);
  if (!w) return { state: "off", since: null };
  const p = openPause(w);
  if (!p) return { state: "working", since: null };
  return { state: p.reason === "idle" ? "away" : "break", since: p.start };
}

/** Time inside [from, to) that the clock skipped for inactivity (pauses that have ended, or all with `includeOpen`). */
export function awayMs(sessions: WorkSession[], from: number, to: number, includeOpen = false): number {
  let total = 0;
  for (const s of sessions) {
    for (const p of s.pauses) {
      if (p.reason !== "idle" || (p.end == null && !includeOpen)) continue;
      total += Math.max(0, Math.min(p.end ?? to, to, s.endedAt ?? to) - Math.max(p.start, from));
    }
  }
  return total;
}

/** Time inside [from, to) with no clock-in at all. */
export function unclockedMs(sessions: WorkSession[], from: number, to: number, now: number): number {
  if (to <= from) return 0;
  const spans = sessions
    .map((s) => ({ start: Math.max(s.startedAt, from), end: Math.min(s.endedAt ?? now, to) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let covered = 0;
  let cursor = from;
  for (const i of spans) {
    const start = Math.max(i.start, cursor);
    if (i.end > start) covered += i.end - start;
    cursor = Math.max(cursor, i.end);
  }
  return Math.max(0, to - from - covered);
}

/** Time in this block, up to now, that can still be counted by hand ("I was working"). */
export function countableMs(e: CalendarEvent, sessions: WorkSession[], now: number): number {
  const to = Math.min(now, e.endAt);
  if (to <= e.startAt) return 0;
  const from = Math.max(e.startAt, e.sched?.creditedTo ?? e.startAt);
  return awayMs(sessions, e.startAt, to) + unclockedMs(sessions, from, to, now);
}
