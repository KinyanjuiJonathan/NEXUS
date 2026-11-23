import { DateTime } from "luxon";
import type { CalendarEvent, Priority, Task, WorkSession } from "@/data/types";
import { blockClock } from "@/lib/taskClock";
import { personalTime } from "@/lib/routine";
import type { SchedOrder } from "@/data/types";
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
  /** Longest single block (minutes): a split task is only joined back up to this length. */
  chunkMaxMin?: number;
  /** Which task goes first when several are placed at once. Without it: most important first. */
  order?: SchedOrder;
}

/** Sort key for a scheduling order. FIFO is "first in, first out": the order tasks were added in. */
export function compareBy(order: SchedOrder): (a: { task: Task | null; at: number; dur: number }, b: { task: Task | null; at: number; dur: number }) => number {
  const created = (x: { task: Task | null; at: number }) => x.task?.createdAt ?? x.at;
  const fifo = (a: { task: Task | null; at: number }, b: { task: Task | null; at: number }) => created(a) - created(b) || a.at - b.at;
  if (order === "priority") return (a, b) => (b.task ? WEIGHT[b.task.priority] : 0) - (a.task ? WEIGHT[a.task.priority] : 0) || fifo(a, b);
  if (order === "shortest") return (a, b) => a.dur - b.dur || fifo(a, b);
  if (order === "deadline") return (a, b) => (a.task?.dueAt ?? Infinity) - (b.task?.dueAt ?? Infinity) || fifo(a, b);
  return fifo;
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
  const busy = busyIntervals(events, now, now + HORIZON + DAY, bufferMs, moving, s.routine);
  const taken: Interval[] = [];
  const take = (to: Interval) => {
    const padded = { start: to.start - bufferMs, end: to.end + bufferMs };
    taken.push(padded);
    busy.push(padded);
    busy.sort((a, b) => a.start - b.start);
  };
  const key = (i: { event: CalendarEvent; task: Task | null }) => ({ task: i.task, at: i.event.startAt, dur: i.event.endAt - i.event.startAt });
  const ordered = [...items].sort(
    s.order
      ? (a, b) => compareBy(s.order!)(key(a), key(b))
      : (a, b) =>
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
  | {
      mode: "from";
      at: number;
      /** Only inside working hours, even if `at` is outside them. */
      strict?: boolean;
      /** Blocks that start before this moment are pulled forward to follow one another from `at` (the day starts earlier than planned); later ones only move if they have to. */
      packUntil?: number;
    };

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
  const busy = busyIntervals(events, now, now + 2 * HORIZON + DAY, bufferMs, new Set(blocks.map((e) => e.id)), s.routine);
  const horizon = Math.max(now, target.mode === "from" ? target.at : now + target.byMs) + HORIZON;
  const working = workingWindows(now, horizon, s);
  const inWorking = (ms: number) => working.some((w) => ms >= w.start && ms < w.end);
  const moves: Move[] = [];
  for (const event of blocks) {
    const dur = Math.max(15 * MIN, event.endAt - event.startAt);
    const packed = target.mode === "from" && target.packUntil != null && event.startAt < target.packUntil;
    const earliest = Math.max(now, target.mode === "from" ? (packed ? target.at : Math.max(target.at, event.startAt)) : event.startAt + target.byMs);
    const wins = [...working];
    // A time the user named outside working hours is still honoured, as is a block that was outside them already.
    if (target.mode === "from" && !target.strict && !inWorking(target.at)) wins.push({ start: target.at, end: DateTime.fromMillis(target.at, { zone: s.homeZone }).endOf("day").toMillis() });
    // "Later by an hour" means that hour, even past the end of the working day; only a fixed appointment sends it further.
    if (target.mode === "shift" || (!inWorking(event.startAt) && !(target.mode === "from" && target.strict))) wins.push({ start: earliest, end: DateTime.fromMillis(earliest, { zone: s.homeZone }).endOf("day").toMillis() });
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

export interface QueueUnit {
  taskId: string;
  title: string;
  /** Its blocks still to come, earliest first (more than one when the task is split). */
  blocks: CalendarEvent[];
  start: number;
  end: number;
  durationMs: number;
}

/** The queue by task: a task split into several blocks is one entry. */
export function queueUnits(tasks: Task[], events: CalendarEvent[], now: number): QueueUnit[] {
  const byTask = new Map<string, CalendarEvent[]>();
  for (const e of queueOf(tasks, events, now)) byTask.set(e.taskId!, [...(byTask.get(e.taskId!) ?? []), e]);
  const title = new Map(tasks.map((t) => [t.id, t.title]));
  return [...byTask.entries()]
    .map(([taskId, blocks]) => ({
      taskId,
      title: title.get(taskId) ?? blocks[0].title,
      blocks,
      start: blocks[0].startAt,
      end: blocks[blocks.length - 1].endAt,
      durationMs: blocks.reduce((a, b) => a + b.endAt - b.startAt, 0),
    }))
    .sort((a, b) => a.start - b.start);
}

/** What happens to one task's blocks: new times for the ones that stay, and the ones folded into the first. */
export interface UnitPlan {
  taskId: string;
  title: string;
  parts: { eventId: string; from: Interval; to: Interval }[];
  /** Blocks merged into parts[0] (their time is already included in its new length). */
  merged: string[];
}

/** A split task becomes one block again when its whole length fits and is no longer than the longest block allowed. */
const mergeable = (u: QueueUnit, s: RescheduleSettings) => u.blocks.length > 1 && u.durationMs <= (s.chunkMaxMin ?? 120) * MIN;

/**
 * Put the queue in a new order. Each position keeps its start time: the task
 * moved to position 1 starts when position 1 started, and so on. Tasks after
 * it follow by their own lengths, inside working hours and around everything
 * that is not in the queue, so nothing overlaps. Split tasks are joined into
 * one block when there is room.
 */
export function planQueueOrder(tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings, order: string[]): UnitPlan[] {
  const units = queueUnits(tasks, events, now);
  const byId = new Map(units.map((u) => [u.taskId, u]));
  const wanted = [...order.filter((id) => byId.has(id)), ...units.map((u) => u.taskId).filter((id) => !order.includes(id))];
  const slots = units.map((u) => u.start);
  const bufferMs = Math.max(0, s.bufferMin) * MIN;
  const mine = new Set(units.flatMap((u) => u.blocks.map((b) => b.id)));
  const busy = busyIntervals(events, now, now + 2 * HORIZON, bufferMs, mine, s.routine);
  const horizon = Math.max(now, ...units.map((u) => u.end)) + HORIZON;
  // Working time, plus the times the queue already occupies (the user may have put a task outside working hours on purpose).
  const wins = mergeWins([...workingWindows(now, horizon, s), ...units.flatMap((u) => u.blocks.map((b) => ({ start: b.startAt, end: b.endAt })))]);
  const take = (to: Interval) => {
    busy.push({ start: to.start, end: to.end });
    busy.sort((a, b) => a.start - b.start);
  };
  // A place's own start time when it is free; otherwise straight after the task before it, rather than far away.
  const fit = (dur: number, want: number, after: number) => {
    const exact = fitExact(wins, busy, dur, want);
    return exact && exact.start === want ? exact : fitExact(wins, busy, dur, after) ?? exact;
  };
  const plans: UnitPlan[] = [];
  let cursor = now;
  wanted.forEach((taskId, k) => {
    const u = byId.get(taskId)!;
    const earliest = Math.max(cursor, slots[k]);
    const plan: UnitPlan = { taskId, title: u.title, parts: [], merged: [] };
    const whole = u.blocks.length === 1 || mergeable(u, s) ? fit(u.durationMs, earliest, cursor) : null;
    if (whole) {
      const [first, ...rest] = u.blocks;
      plan.parts.push({ eventId: first.id, from: { start: first.startAt, end: first.endAt }, to: whole });
      plan.merged = rest.map((b) => b.id);
      take(whole);
      cursor = whole.end;
    } else {
      let at = earliest;
      for (const b of u.blocks) {
        const to = fit(b.endAt - b.startAt, at, at === earliest ? cursor : at) ?? { start: b.startAt, end: b.endAt };
        plan.parts.push({ eventId: b.id, from: { start: b.startAt, end: b.endAt }, to });
        take(to);
        at = to.end;
      }
      cursor = at;
    }
    plans.push(plan);
  });
  return plans;
}

/**
 * Split tasks that can be one block again: the whole length now fits in one
 * piece, starting where the first part starts or no later than the last part
 * would have ended.
 */
export function planMerges(tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings): UnitPlan[] {
  const bufferMs = Math.max(0, s.bufferMin) * MIN;
  const plans: UnitPlan[] = [];
  let live = events;
  for (const u of queueUnits(tasks, events, now)) {
    if (!mergeable(u, s)) continue;
    const own = new Set(u.blocks.map((b) => b.id));
    const others = live.filter((e) => !own.has(e.id));
    const [first, ...rest] = u.blocks;
    const here = { start: first.startAt, end: first.startAt + u.durationMs };
    const clash = expandEvents(others, here.start - DAY, here.end + DAY).some((o) => overlaps(o, here)) || personalTime(here.start, here.end, s.routine).some((p) => overlaps(p, here));
    let to: Interval | null = clash ? null : here;
    if (!to) {
      const fit = firstFit(workingWindows(first.startAt, u.end + DAY, s), busyIntervals(others, now, u.end + DAY, bufferMs, undefined, s.routine), u.durationMs, first.startAt);
      if (fit && fit.end <= u.end) to = fit;
    }
    if (!to) continue;
    plans.push({ taskId: u.taskId, title: u.title, parts: [{ eventId: first.id, from: { start: first.startAt, end: first.endAt }, to }], merged: rest.map((b) => b.id) });
    // later tasks see this one in its merged place
    const target = to;
    live = others.concat([{ ...first, startAt: target.start, endAt: target.end }]);
  }
  return plans;
}

function mergeWins(wins: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const w of [...wins].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

/** First free time of `dur` at or after `notBefore`, to the minute (no rounding to the quarter hour, so a slot's exact start is kept). */
function fitExact(wins: Interval[], busy: Interval[], dur: number, notBefore: number): Interval | null {
  for (const win of wins) {
    let start = Math.max(win.start, notBefore);
    for (const b of busy) {
      if (b.end <= start) continue;
      if (b.start >= start + dur) break;
      start = b.end;
    }
    if (start + dur <= win.end) return { start, end: start + dur };
  }
  return null;
}

/** The queue's task ids in a scheduling order (FIFO, priority, shortest first, nearest deadline). */
export function sortedQueue(tasks: Task[], events: CalendarEvent[], now: number, order: SchedOrder, first?: (t: Task) => boolean): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cmp = compareBy(order);
  // `first`: tasks that go ahead of everything else whatever the order (admin and planning after sleep)
  const lead = (x: { task: Task | null }) => (first && x.task && first(x.task) ? 0 : 1);
  return queueUnits(tasks, events, now)
    .map((u) => ({ id: u.taskId, task: byId.get(u.taskId) ?? null, at: u.start, dur: u.durationMs }))
    .sort((a, b) => lead(a) - lead(b) || cmp(a, b))
    .map((u) => u.id);
}

/**
 * A flexible block was given a new time (`to`): the flexible blocks after it
 * that it now runs into are pushed later, in the same order, each only as far
 * as it has to go. Fixed appointments and personal time are stepped over.
 * Blocks that are not touched are not in the result.
 */
export function planRipple(tasks: Task[], events: CalendarEvent[], now: number, s: RescheduleSettings, changedId: string, to: Interval, fromStart: number, opts: { anyTime?: boolean; keep?: string[] } = {}): Move[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const after = events
    // `keep`: blocks that were just placed on purpose and must stay exactly where they are
    .filter((e) => e.id !== changedId && !opts.keep?.includes(e.id) && !e.deletedAt && !e.fixed && !e.recurrence && !!e.taskId && openTask(byId.get(e.taskId)) && e.endAt > now && e.startAt >= Math.min(fromStart, to.start))
    .sort((a, b) => a.startAt - b.startAt);
  if (!after.length) return [];
  // The user set this time by hand: what follows goes straight after it, with no gap added.
  const bufferMs = 0;
  const moving = new Set([changedId, ...after.map((e) => e.id)]);
  // anyTime: the user started something now on purpose, so what follows comes straight after it, whatever the hour; only fixed appointments are stepped over.
  const busy = busyIntervals(events, now, now + 2 * HORIZON, bufferMs, moving, opts.anyTime ? undefined : s.routine);
  const horizon = Math.max(to.end, ...after.map((e) => e.endAt)) + HORIZON;
  const wins = opts.anyTime ? [{ start: now, end: horizon }] : mergeWins([...workingWindows(now, horizon, s), ...after.map((e) => ({ start: e.startAt, end: e.endAt }))]);
  const take = (x: Interval) => {
    busy.push({ ...x });
    busy.sort((a, b) => a.start - b.start);
  };
  take(to);
  const moves: Move[] = [];
  let cursor = to.end;
  for (const e of after) {
    const from = { start: e.startAt, end: e.endAt };
    if (e.startAt >= cursor && !busy.some((b) => overlaps(b, from))) {
      take(from);
      cursor = from.end;
      continue;
    }
    const fit = fitExact(wins, busy, e.endAt - e.startAt, Math.max(cursor, e.startAt));
    if (!fit) {
      take(from);
      continue;
    }
    moves.push({ eventId: e.id, taskId: e.taskId, title: e.title, from, to: fit, reason: "pushed" });
    take(fit);
    cursor = fit.end;
  }
  return moves;
}

/** The first free time of `dur` at or after `at`, whatever the working hours: for a time the user asked for exactly. */
export function freeFrom(events: CalendarEvent[], now: number, s: RescheduleSettings, at: number, dur: number, ignore: ReadonlySet<string>): Interval {
  const busy = busyIntervals(events, now, at + HORIZON, 0, ignore, s.routine);
  return fitExact([{ start: at, end: at + HORIZON }], busy, dur, at) ?? { start: at, end: at + dur };
}
