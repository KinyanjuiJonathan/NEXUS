import { DateTime } from "luxon";
import type { CalendarEvent, Priority, Task, WorkSession } from "@/data/types";
import { blockClock } from "@/lib/taskClock";
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
 * The work clock decides how much is left: time that was clocked during the
 * block counts, time away does not. Only what is left is moved; flexible
 * blocks that are in the way are pushed later, in their original order. A
 * block whose planned time was clocked in full stays where it is and the user
 * is asked whether the task is complete.
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
  reason: "unfinished" | "conflict" | "pushed" | "bulk" | "queue";
  /** Why it was not moved: it would miss its deadline, it has been moved too often, nothing is free, or its planned time was clocked in full. */
  problem?: "deadline" | "limit" | "nofit" | "worked";
  /** Time clocked on the task so far and the total it was given (unfinished blocks only). */
  workedMs?: number;
  targetMs?: number;
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

const FIVE = 5 * MIN;
const openTask = (t: Task | undefined | null): t is Task => !!t && !t.deletedAt && !t.archivedAt && t.status !== "done";

interface PlaceOptions {
  /** Work clock sessions: only the time that was not clocked is moved. */
  sessions?: WorkSession[];
  /** Flexible blocks that may be pushed later to make room, earliest first. */
  push?: CalendarEvent[];
}

function place(items: { event: CalendarEvent; task: Task | null }[], events: CalendarEvent[], now: number, s: RescheduleSettings, reason: Move["reason"], opts: PlaceOptions = {}): Move[] {
  const bufferMs = Math.max(0, s.bufferMin) * MIN;
  const push = opts.push ?? [];
  // The blocks being moved give up their old time; everything else stays where it is.
  const moving = new Set([...items.map((i) => i.event.id), ...push.map((e) => e.id)]);
  const busy = busyIntervals(events, now, now + HORIZON + DAY, bufferMs, moving);
  const taken: Interval[] = [];
  const take = (to: Interval) => {
    const padded = { start: to.start - bufferMs, end: to.end + bufferMs };
    taken.push(padded);
    busy.push(padded);
    busy.sort((a, b) => a.start - b.start);
  };
  const ordered = [...items].sort(
    (a, b) =>
      (b.task ? WEIGHT[b.task.priority] : 0) - (a.task ? WEIGHT[a.task.priority] : 0) ||
      (a.task?.dueAt ?? Infinity) - (b.task?.dueAt ?? Infinity) ||
      a.event.startAt - b.event.startAt,
  );
  const moves: Move[] = [];
  for (const { event, task } of ordered) {
    const from = { start: event.startAt, end: event.endAt };
    const clock = reason === "unfinished" && opts.sessions ? blockClock(event, opts.sessions, now) : null;
    const base = { eventId: event.id, taskId: event.taskId, title: task?.title ?? event.title, from, reason, ...(clock ? { workedMs: clock.workedMs, targetMs: clock.targetMs } : {}) };
    if (clock?.done) {
      moves.push({ ...base, to: null, problem: "worked" });
      continue;
    }
    if ((event.sched?.moves ?? 0) >= MAX_AUTO_MOVES) {
      moves.push({ ...base, to: null, problem: "limit" });
      continue;
    }
    // Only what was not clocked still needs a place.
    const dur = Math.max(15 * MIN, clock && clock.workedMs > 0 ? Math.ceil(clock.remainingMs / FIVE) * FIVE : event.endAt - event.startAt);
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
    take(to);
  }
  // Blocks that were in the way keep their order and move only as far as they have to.
  for (const event of [...push].sort((a, b) => a.startAt - b.startAt)) {
    const from = { start: event.startAt, end: event.endAt };
    if (!taken.some((t) => overlaps(t, from))) {
      take(from);
      continue;
    }
    const to = firstFit([...windowsFor(event, now, s), ...workingWindows(now, now + HORIZON, s)], busy, event.endAt - event.startAt, Math.max(now, event.startAt));
    if (!to) {
      take(from);
      continue;
    }
    moves.push({ eventId: event.id, taskId: event.taskId, title: event.title, from, to, reason: "pushed" });
    take(to);
  }
  return moves;
}

/** Flexible blocks still to come that may give way: time for an open task that has no deadline to protect. */
function pushable(tasks: Task[], events: CalendarEvent[], now: number, except: ReadonlySet<string>): CalendarEvent[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return events.filter((e) => {
    if (e.deletedAt || e.fixed || e.recurrence || !e.taskId || except.has(e.id) || e.startAt <= now) return false;
    const t = byId.get(e.taskId);
    return openTask(t) && (t.dueAt == null || t.dueAt <= now);
  });
}

/**
 * New times for every unfinished flexible block, most important first. With
 * the work clock's sessions, only the time that was not clocked is moved.
 */
export function planUnfinished(tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings, sessions?: WorkSession[]): Move[] {
  const items = unfinishedBlocks(tasks, events, now, s);
  if (!items.length) return [];
  return place(items, events, now, s, "unfinished", { sessions, push: pushable(tasks, events, now, new Set(items.map((i) => i.event.id))) });
}

export type BulkTarget =
  /** Everything moves later by this much. */
  | { mode: "shift"; byMs: number }
  /** Everything starts again from this moment, in the same order. */
  | { mode: "from"; at: number };

/**
 * The user asked to move every open task at once. Fixed appointments stay
 * where they are and the blocks are fitted around them, in their original order.
 */
export function planBulk(tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings, target: BulkTarget): Move[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const blocks = events
    .filter((e) => !e.deletedAt && !e.fixed && !e.recurrence && !!e.taskId && e.endAt > now - LOOKBACK && openTask(byId.get(e.taskId)))
    .sort((a, b) => a.startAt - b.startAt);
  if (!blocks.length) return [];
  const bufferMs = Math.max(0, s.bufferMin) * MIN;
  const busy = busyIntervals(events, now, now + 2 * HORIZON + DAY, bufferMs, new Set(blocks.map((e) => e.id)));
  const horizon = Math.max(now, target.mode === "from" ? target.at : now + target.byMs) + HORIZON;
  const working = workingWindows(now, horizon, s);
  const inWorking = (ms: number) => working.some((w) => ms >= w.start && ms < w.end);
  const moves: Move[] = [];
  for (const event of blocks) {
    const dur = Math.max(15 * MIN, event.endAt - event.startAt);
    const earliest = Math.max(now, target.mode === "from" ? Math.max(target.at, event.startAt) : event.startAt + target.byMs);
    const wins = [...working];
    // A time the user named outside working hours is still honoured, as is a block that was outside them already.
    if (target.mode === "from" && !inWorking(target.at)) wins.push({ start: target.at, end: DateTime.fromMillis(target.at, { zone: s.homeZone }).endOf("day").toMillis() });
    // "Later by an hour" means that hour, even past the end of the working day; only a fixed appointment sends it further.
    if (target.mode === "shift" || !inWorking(event.startAt)) wins.push({ start: earliest, end: DateTime.fromMillis(earliest, { zone: s.homeZone }).endOf("day").toMillis() });
    const to = firstFit(wins, busy, dur, earliest);
    const from = { start: event.startAt, end: event.endAt };
    if (!to) {
      moves.push({ eventId: event.id, taskId: event.taskId, title: event.title, from, to: null, reason: "bulk", problem: "nofit" });
      continue;
    }
    busy.push({ start: to.start - bufferMs, end: to.end + bufferMs });
    busy.sort((a, b) => a.start - b.start);
    if (to.start !== event.startAt || to.end !== event.endAt) moves.push({ eventId: event.id, taskId: event.taskId, title: event.title, from, to, reason: "bulk" });
  }
  return moves;
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

/** The queue the user can rearrange: flexible task blocks still to come, earliest first. */
export function queueOf(tasks: Task[], events: CalendarEvent[], now: number): CalendarEvent[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return events
    .filter((e) => !e.deletedAt && !e.fixed && !e.recurrence && !!e.taskId && e.startAt > now && openTask(byId.get(e.taskId)))
    .sort((a, b) => a.startAt - b.startAt);
}

/**
 * Move a task one place up (-1) or down (+1) the queue: it trades places with
 * its neighbour. Together they keep the same stretch of time, so nothing else
 * moves; if a fixed appointment sits in that stretch, each takes the first
 * free time instead. Empty when it is already first/last or nothing fits.
 */
export function planQueueMove(tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings, eventId: string, dir: -1 | 1): Move[] {
  const queue = queueOf(tasks, events, now);
  const i = queue.findIndex((e) => e.id === eventId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= queue.length) return [];
  const [a, b] = dir < 0 ? [queue[j], queue[i]] : [queue[i], queue[j]]; // a is earlier; b goes first now
  const durA = a.endAt - a.startAt;
  const durB = b.endAt - b.startAt;
  const others = events.filter((e) => e.id !== a.id && e.id !== b.id);
  let first: Interval | null = { start: a.startAt, end: a.startAt + durB };
  let second: Interval | null = { start: b.endAt - durA, end: b.endAt };
  const clash = (x: Interval) => expandEvents(others, x.start - DAY, x.end + DAY).some((o) => overlaps(o, x));
  if (second.start < first.end || clash(first) || clash(second)) {
    const bufferMs = Math.max(0, s.bufferMin) * MIN;
    const busy = busyIntervals(others, now, now + HORIZON + DAY, bufferMs);
    const win = [{ start: a.startAt, end: a.startAt + HORIZON }];
    first = firstFit(win, busy, durB, Math.max(now, a.startAt));
    if (first) {
      busy.push({ start: first.start - bufferMs, end: first.end + bufferMs });
      busy.sort((x, y) => x.start - y.start);
    }
    second = first ? firstFit(win, busy, durA, first.end) : null;
  }
  if (!first || !second) return [];
  const move = (e: CalendarEvent, to: Interval): Move => ({ eventId: e.id, taskId: e.taskId, title: e.title, from: { start: e.startAt, end: e.endAt }, to, reason: "queue" });
  return [move(b, first), move(a, second)];
}
