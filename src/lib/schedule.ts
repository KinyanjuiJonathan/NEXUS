import { DateTime } from "luxon";
import { workWindows, type WorkHours } from "@/lib/workPlan";
import type { CalendarEvent, Occurrence, Task } from "@/data/types";
import { occurrencesBetween } from "./recurrence";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Expand events (incl. recurring series) to concrete occurrences in [from, to). */
export function expandEvents(events: CalendarEvent[], from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const ev of events) {
    if (ev.deletedAt) continue;
    const dur = Math.max(0, ev.endAt - ev.startAt);
    // Include occurrences that started before `from` but are still running.
    const starts = occurrencesBetween(ev.startAt, ev.tz, ev.recurrence, from - dur, to);
    for (const s of starts) {
      if (s + dur <= from && dur > 0) continue;
      out.push({ event: ev, start: s, end: s + dur, seriesStart: s, recurring: !!ev.recurrence });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

export interface Interval {
  start: number;
  end: number;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Occurrences that overlap a proposed slot. `ignoreEventId` excludes the event
 * being moved/edited itself.
 */
export function findConflicts(
  events: CalendarEvent[],
  slot: Interval,
  ignoreEventId?: string | null,
): Occurrence[] {
  const occ = expandEvents(
    events.filter((e) => e.id !== ignoreEventId),
    slot.start - DAY,
    slot.end + DAY,
  );
  return occ.filter((o) => overlaps(o, slot));
}

/** All pairs of overlapping occurrences in a range (for the "identify conflicts" assistant). */
export function conflictPairs(events: CalendarEvent[], from: number, to: number): [Occurrence, Occurrence][] {
  const occ = expandEvents(events, from, to);
  const pairs: [Occurrence, Occurrence][] = [];
  for (let i = 0; i < occ.length; i++) {
    for (let j = i + 1; j < occ.length && occ[j].start < occ[i].end; j++) {
      if (overlaps(occ[i], occ[j])) pairs.push([occ[i], occ[j]]);
    }
  }
  return pairs;
}

export type WorkingHours = WorkHours;

/** Merge overlapping busy intervals. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

/**
 * Free slots of at least `durationMs` within working hours, starting no
 * earlier than `from`, up to `maxSlots`, scanning `horizonDays` days.
 * Slots are aligned to 15 minutes. Each returned slot is exactly `durationMs` long;
 * at most `perDay` slots per day keep suggestions spread out.
 */
export function findFreeSlots(
  events: CalendarEvent[],
  durationMs: number,
  from: number,
  wh: WorkingHours,
  opts: { maxSlots?: number; horizonDays?: number; perDay?: number; bufferMs?: number } = {},
): Interval[] {
  const { maxSlots = 5, horizonDays = 14, perDay = 2, bufferMs = 0 } = opts;
  const align = 15 * MIN;
  const startAligned = Math.ceil(from / align) * align;
  const horizonEnd = DateTime.fromMillis(from, { zone: wh.zone }).plus({ days: horizonDays }).toMillis();
  const busy = mergeIntervals(
    expandEvents(events, from - DAY, horizonEnd + DAY).map((o) => ({
      start: o.start - bufferMs,
      end: o.end + bufferMs,
    })),
  );
  const slots: Interval[] = [];
  for (const win of workWindows(from, horizonEnd + DAY, wh)) {
    if (slots.length >= maxSlots) break;
    const winStart = Math.max(win.start, startAligned);
    const winEnd = win.end;
    let cursor = winStart;
    let today = 0;
    for (const b of [...busy.filter((b) => b.end > winStart && b.start < winEnd), { start: winEnd, end: winEnd }]) {
      const gapEnd = Math.min(b.start, winEnd);
      // Offer consecutive slots inside a large gap (spaced by the duration, min 30 min).
      const stride = Math.max(durationMs, 30 * MIN);
      while (gapEnd - cursor >= durationMs && slots.length < maxSlots && today < perDay) {
        slots.push({ start: cursor, end: cursor + durationMs });
        today++;
        cursor += stride;
      }
      if (slots.length >= maxSlots || today >= perDay) break;
      cursor = Math.max(cursor, Math.ceil(b.end / align) * align);
      if (cursor >= winEnd) break;
    }
  }
  return slots;
}

export interface MissedItem {
  kind: "task" | "event";
  id: string;
  title: string;
  /** When it was supposed to happen. */
  at: number;
  durationMs: number;
  important: boolean;
  taskId: string | null;
}

/**
 * Missed work = overdue unfinished tasks, plus time blocks linked to tasks
 * that ended without the task being completed.
 */
export function findMissed(tasks: Task[], events: CalendarEvent[], now: number, lookbackDays = 7): MissedItem[] {
  const out: MissedItem[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    if (t.deletedAt || t.archivedAt || t.status === "done" || t.dueAt == null) continue;
    if (t.dueAt < now && t.dueAt > now - lookbackDays * DAY) {
      out.push({
        kind: "task",
        id: t.id,
        title: t.title,
        at: t.dueAt,
        durationMs: (t.estimateMin ?? 30) * MIN,
        important: t.priority === "critical",
        taskId: t.id,
      });
    }
  }
  for (const o of expandEvents(events, now - lookbackDays * DAY, now)) {
    // "worked": its planned time was clocked in full, so it was not missed.
    if (o.end > now || o.recurring || !o.event.taskId || o.event.sched?.attention === "worked") continue;
    const t = byId.get(o.event.taskId);
    if (!t || t.status === "done" || t.deletedAt) continue;
    if (out.some((m) => m.taskId === t.id)) continue;
    out.push({
      kind: "event",
      id: o.event.id,
      title: o.event.title,
      at: o.start,
      durationMs: o.end - o.start,
      important: o.event.important,
      taskId: t.id,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Smart Reschedule: candidate future slots for a missed item. Never applies them. */
export function smartRescheduleOptions(
  item: Pick<MissedItem, "durationMs" | "kind" | "id">,
  events: CalendarEvent[],
  wh: WorkingHours,
  now: number,
  maxSlots = 4,
): Interval[] {
  const others = item.kind === "event" ? events.filter((e) => e.id !== item.id) : events;
  return findFreeSlots(others, Math.max(15 * MIN, item.durationMs), now + 5 * MIN, wh, {
    maxSlots,
    horizonDays: 14,
    perDay: 2,
  });
}

/** Shift an event to a new start, keeping duration. */
export function moveEvent(ev: CalendarEvent, newStart: number, now: number): CalendarEvent {
  const dur = ev.endAt - ev.startAt;
  return { ...ev, startAt: newStart, endAt: newStart + dur, updatedAt: now };
}

/** Snap to the nearest step (default 15 min). */
export function snap(ms: number, stepMs = 15 * MIN): number {
  return Math.round(ms / stepMs) * stepMs;
}
