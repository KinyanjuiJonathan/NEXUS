import { DateTime } from "luxon";
import type { CalendarEvent, Priority, Task } from "@/data/types";
import { DAY, MIN, expandEvents, overlaps, type Interval } from "@/lib/schedule";
import { busyIntervals, firstFit, periodHours, workingWindows, type SlotSettings } from "./slots";

/**
 * Automatic re-planning of flexible time blocks.
 *
 * A block is "unfinished" when its time has passed and the task it was for is
 * still open. NEXUS never marks a task complete by itself: it moves the block
 * to the next suitable free time instead. Fixed appointments are never moved,
 * and their time is never given to anything else.
 *
 * These functions only decide; the store applies the result.
 */

/** After this many automatic moves a block is left alone and the user is asked. */
export const MAX_AUTO_MOVES = 4;
/** A block is only unfinished once it has been over for this long. */
const GRACE = MIN;
const LOOKBACK = 14 * DAY;
const HORIZON = 14 * DAY;
const WEIGHT: Record<Priority, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface Move {
  eventId: string;
  taskId: string | null;
  title: string;
  from: Interval;
  /** New time, or null when NEXUS will not move it by itself. */
  to: Interval | null;
  reason: "unfinished" | "conflict";
  /** Why it was not moved: it would miss its deadline, it has been moved too often, or nothing is free. */
  problem?: "deadline" | "limit" | "nofit";
  /** A possible time for the user to approve when `to` is null. */
  suggestion?: Interval | null;
}

export interface RescheduleSettings extends SlotSettings {
  /** Fixed appointments are never moved automatically. */
  protectFixed: boolean;
}

const isProtected = (e: CalendarEvent, s: RescheduleSettings) => e.fixed && s.protectFixed;

/** Flexible blocks whose time is over while their task is still open and has no other time reserved. */
export function unfinishedBlocks(tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings): { event: CalendarEvent; task: Task }[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const latest = new Map<string, CalendarEvent>();
  const stillPlanned = new Set<string>();
  for (const e of events) {
    if (e.deletedAt || !e.taskId) continue;
    // a block that is running or still to come: the task is already taken care of
    if (e.endAt > now - GRACE || e.recurrence) stillPlanned.add(e.taskId);
    else if (e.endAt > now - LOOKBACK) {
      const cur = latest.get(e.taskId);
      if (!cur || e.endAt > cur.endAt) latest.set(e.taskId, e);
    }
  }
  const out: { event: CalendarEvent; task: Task }[] = [];
  for (const [taskId, event] of latest) {
    const task = byId.get(taskId);
    if (!task || task.deletedAt || task.archivedAt || task.status === "done") continue; // only the user completes a task
    if (stillPlanned.has(taskId) || isProtected(event, s) || event.sched?.attention) continue;
    out.push({ event, task });
  }
  return out;
}

/** Where a block may go: its preferred part of the day if it has one, otherwise working hours. */
function windowsFor(event: CalendarEvent, now: number, s: RescheduleSettings): Interval[] {
  const period = event.sched?.period;
  if (!period) return workingWindows(now, now + HORIZON, s);
  const zone = event.sched?.zone ?? event.tz;
  const [from, to] = periodHours(period, s);
  const out: Interval[] = [];
  let d = DateTime.fromMillis(now, { zone }).startOf("day");
  for (let i = 0; i <= 14; i++, d = d.plus({ days: 1 })) {
    out.push({ start: d.set({ hour: Math.min(23, from) }).toMillis(), end: to >= 24 ? d.plus({ days: 1 }).toMillis() : d.set({ hour: to }).toMillis() });
  }
  return out;
}

function place(items: { event: CalendarEvent; task: Task | null }[], events: CalendarEvent[], now: number, s: RescheduleSettings, reason: Move["reason"]): Move[] {
  const bufferMs = Math.max(0, s.bufferMin) * MIN;
  // The blocks being moved give up their old time; everything else stays where it is.
  const moving = new Set(items.map((i) => i.event.id));
  const busy = busyIntervals(events, now, now + HORIZON + DAY, bufferMs, moving);
  const ordered = [...items].sort(
    (a, b) =>
      (b.task ? WEIGHT[b.task.priority] : 0) - (a.task ? WEIGHT[a.task.priority] : 0) ||
      (a.task?.dueAt ?? Infinity) - (b.task?.dueAt ?? Infinity) ||
      a.event.startAt - b.event.startAt,
  );
  const moves: Move[] = [];
  for (const { event, task } of ordered) {
    const from = { start: event.startAt, end: event.endAt };
    const base = { eventId: event.id, taskId: event.taskId, title: task?.title ?? event.title, from, reason };
    if ((event.sched?.moves ?? 0) >= MAX_AUTO_MOVES) {
      moves.push({ ...base, to: null, problem: "limit" });
      continue;
    }
    const dur = Math.max(15 * MIN, event.endAt - event.startAt);
    let wins = windowsFor(event, now, s);
    let any = firstFit(wins, busy, dur, now);
    if (!any && event.sched?.period) {
      wins = workingWindows(now, now + HORIZON, s);
      any = firstFit(wins, busy, dur, now);
    }
    const deadline = task?.dueAt ?? null;
    // A deadline that has already passed cannot be met any more; a future one must be.
    const to = deadline != null && deadline > now ? firstFit(wins, busy, dur, now, deadline) : any;
    if (!to) {
      moves.push({ ...base, to: null, problem: any ? "deadline" : "nofit", suggestion: any });
      continue;
    }
    moves.push({ ...base, to });
    // later (lower-priority) blocks must not take the same time
    busy.push({ start: to.start - bufferMs, end: to.end + bufferMs });
    busy.sort((a, b) => a.start - b.start);
  }
  return moves;
}

/** New times for every unfinished flexible block, most important first. */
export function planUnfinished(tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings): Move[] {
  return place(unfinishedBlocks(tasks, events, now, s), events, now, s, "unfinished");
}

/**
 * A fixed appointment has been placed where flexible blocks were: new times
 * for those blocks. The appointment itself never moves.
 */
export function planDisplaced(fixed: CalendarEvent, tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings): Move[] {
  if (!fixed.fixed || fixed.deletedAt) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const taken = expandEvents([fixed], now - DAY, now + HORIZON);
  const hit = events.filter(
    (e) => e.id !== fixed.id && !e.deletedAt && !e.fixed && !e.recurrence && e.endAt > now && taken.some((o) => overlaps(o, { start: e.startAt, end: e.endAt })),
  );
  return place(hit.map((event) => ({ event, task: event.taskId ? byId.get(event.taskId) ?? null : null })), events, now, s, "conflict");
}
