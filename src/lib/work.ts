import type { WorkPause, WorkSession } from "@/data/types";

/**
 * Clock-in maths. Worked time = session span minus pauses. Everything is
 * computed from stored timestamps, so sleep/restarts never distort it.
 */

export interface Interval {
  start: number;
  end: number;
}

export function activeSession(sessions: WorkSession[]): WorkSession | null {
  return sessions.find((s) => s.endedAt == null) ?? null;
}

export function openPause(s: WorkSession | null): WorkPause | null {
  if (!s) return null;
  const p = s.pauses[s.pauses.length - 1];
  return p && p.end == null ? p : null;
}

/** Intervals during which the user was actually working in this session. */
export function workIntervals(s: WorkSession, now: number): Interval[] {
  const end = s.endedAt ?? now;
  const pauses = [...s.pauses].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  let cursor = s.startedAt;
  for (const p of pauses) {
    const ps = Math.max(p.start, s.startedAt);
    const pe = Math.min(p.end ?? end, end);
    if (ps > cursor) out.push({ start: cursor, end: Math.min(ps, end) });
    cursor = Math.max(cursor, pe);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out.filter((i) => i.end > i.start);
}

export function workedMs(s: WorkSession, now: number): number {
  return workIntervals(s, now).reduce((a, i) => a + i.end - i.start, 0);
}

export function pausedMs(s: WorkSession, now: number, reason?: WorkPause["reason"]): number {
  const end = s.endedAt ?? now;
  return s.pauses
    .filter((p) => !reason || p.reason === reason)
    .reduce((a, p) => a + Math.max(0, Math.min(p.end ?? end, end) - Math.max(p.start, s.startedAt)), 0);
}

/** Worked ms inside [from, to) across sessions (sessions spanning midnight are split correctly). */
export function workedBetween(sessions: WorkSession[], from: number, to: number, now: number): number {
  let total = 0;
  for (const s of sessions) {
    if ((s.endedAt ?? now) <= from || s.startedAt >= to) continue;
    for (const i of workIntervals(s, now)) total += Math.max(0, Math.min(i.end, to) - Math.max(i.start, from));
  }
  return total;
}
