import type { WorkPause, WorkSession } from "@/data/types";

/**
 * Clock-in maths. Worked time = session span minus pauses. Everything is
 * computed from stored timestamps, so sleep/restarts never distort it.
 */

export interface Interval {
  start: number;
  end: number;
}

/**
 * The open session. If more than one is open (older data), the real one is the
 * one NEXUS has been keeping up to date (its pauses and resumes were recorded
 * there); between equals, the most recently started.
 */
export function activeSession(sessions: WorkSession[]): WorkSession | null {
  let best: WorkSession | null = null;
  for (const s of sessions) {
    if (s.endedAt != null) continue;
    if (!best || s.updatedAt > best.updatedAt || (s.updatedAt === best.updatedAt && s.startedAt > best.startedAt)) best = s;
  }
  return best;
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

/**
 * Worked ms inside [from, to) across sessions (sessions spanning midnight are split correctly).
 *
 * The same minute is never counted twice: if two sessions overlap, the
 * overlap counts once. So the total can never be more than the time that
 * actually passed between `from` and `to`.
 */
export function workedBetween(sessions: WorkSession[], from: number, to: number, now: number): number {
  const parts: Interval[] = [];
  for (const s of sessions) {
    if ((s.endedAt ?? now) <= from || s.startedAt >= to) continue;
    for (const i of workIntervals(s, now)) {
      const start = Math.max(i.start, from);
      const end = Math.min(i.end, to);
      if (end > start) parts.push({ start, end });
    }
  }
  parts.sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const p of parts) {
    const start = Math.max(p.start, cursor);
    if (p.end > start) {
      total += p.end - start;
      cursor = p.end;
    }
  }
  return total;
}

/**
 * Only one session can be open. When more are found (two were started at the
 * same moment, or one was left open by an older version), the most recently
 * one being kept up to date stays open and each of the others is closed where
 * its real work stopped: at the pause it was left in, or at the moment the
 * next session began. One that was never touched after it was created is a
 * plain duplicate and counts for nothing. A stray session that never paused
 * would otherwise count around the clock. Returns the sessions that were changed.
 */
export function closeStraySessions(sessions: WorkSession[], now: number): WorkSession[] {
  const open = sessions.filter((s) => s.endedAt == null);
  if (open.length < 2) return [];
  const keep = activeSession(sessions)!;
  const starts = sessions.map((s) => s.startedAt).sort((a, b) => a - b);
  const changed: WorkSession[] = [];
  for (const s of open) {
    if (s === keep) continue;
    const next = starts.find((t) => t > s.startedAt) ?? keep.startedAt;
    const paused = openPause(s)?.start ?? Infinity;
    const duplicate = !s.pauses.length && s.updatedAt <= s.createdAt;
    const endedAt = duplicate ? s.startedAt : Math.max(s.startedAt, Math.min(paused, next, now));
    changed.push({ ...s, endedAt, pauses: s.pauses.filter((p) => p.start < endedAt).map((p) => (p.end == null || p.end > endedAt ? { ...p, end: endedAt } : p)), updatedAt: now });
  }
  return changed;
}
