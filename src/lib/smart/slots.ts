import { DateTime } from "luxon";
import type { CalendarEvent, DayPeriod, Occurrence } from "@/data/types";
import { DAY, MIN, expandEvents, findConflicts, mergeIntervals, type Interval } from "@/lib/schedule";
import type { ScheduleRequest } from "./parse";

/**
 * Finds a free time for a scheduling request.
 *
 * Every appointment already on the calendar is unavailable, fixed or flexible,
 * with the configured buffer around it, so nothing is ever double-booked. All
 * date arithmetic goes through IANA zones (luxon), so "evening Kenya time" is
 * evening in Africa/Nairobi whatever zone the PC is in, across DST changes.
 */

export interface SlotSettings {
  homeZone: string;
  workStartHour: number;
  workEndHour: number;
  /** ISO weekdays (1 = Monday). */
  workDays: number[];
  bufferMin: number;
  periods: { morning: [number, number]; afternoon: [number, number]; evening: [number, number] };
}

export const DEFAULT_DURATION_MIN = 60;
const ALIGN = 15 * MIN;
/** Hours considered reasonable when a request falls outside working hours. */
const WAKING: [number, number] = [7, 23];
const HORIZON_DAYS = 14;

const ceil = (ms: number) => Math.ceil(ms / ALIGN) * ALIGN;
const floor = (ms: number) => Math.floor(ms / ALIGN) * ALIGN;

export function periodHours(period: DayPeriod, s: SlotSettings): [number, number] {
  if (period === "night") return [Math.max(20, Math.min(22, s.periods.evening[0] + 2)), 24];
  return s.periods[period];
}

/** [from, to) hours of one calendar day in a zone, as instants. */
function hoursOf(day: DateTime, [from, to]: [number, number]): Interval {
  const start = day.startOf("day").set({ hour: Math.min(23, from) });
  const end = to >= 24 ? day.startOf("day").plus({ days: 1 }) : day.startOf("day").set({ hour: to });
  return { start: start.toMillis(), end: Math.max(start.toMillis(), end.toMillis()) };
}

/** The calendar days (in `zone`) that overlap [start, end). */
function daysIn(start: number, end: number, zone: string): DateTime[] {
  const out: DateTime[] = [];
  for (let d = DateTime.fromMillis(start, { zone }).startOf("day"); d.toMillis() < end && out.length < 62; d = d.plus({ days: 1 })) out.push(d);
  return out;
}

/** Everything on the calendar, widened by the buffer and merged. */
export function busyIntervals(events: CalendarEvent[], from: number, to: number, bufferMs: number, ignore?: ReadonlySet<string>): Interval[] {
  const live = ignore ? events.filter((e) => !ignore.has(e.id)) : events;
  return mergeIntervals(expandEvents(live, from - DAY, to + DAY).map((o) => ({ start: o.start - bufferMs, end: o.end + bufferMs })));
}

function gapsIn(win: Interval, busy: Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = win.start;
  for (const b of busy) {
    if (b.end <= cursor) continue;
    if (b.start >= win.end) break;
    if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, win.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= win.end) break;
  }
  if (cursor < win.end) out.push({ start: cursor, end: win.end });
  return out;
}

/** Earliest free slot of `dur` inside the windows, not before `notBefore`, ending by `deadline`. */
export function firstFit(wins: Interval[], busy: Interval[], dur: number, notBefore: number, deadline?: number | null): Interval | null {
  for (const win of [...wins].sort((a, b) => a.start - b.start)) {
    for (const gap of gapsIn(win, busy)) {
      const start = ceil(Math.max(gap.start, notBefore));
      if (start + dur > gap.end) continue;
      if (deadline != null && start + dur > deadline) return null; // later gaps only end later
      return { start, end: start + dur };
    }
  }
  return null;
}

/** Free slot of `dur` whose start is closest to `target`. */
export function fitNear(wins: Interval[], busy: Interval[], dur: number, target: number, notBefore: number): Interval | null {
  let best: Interval | null = null;
  for (const win of wins) {
    for (const gap of gapsIn(win, busy)) {
      const lo = ceil(Math.max(gap.start, notBefore));
      const hi = floor(gap.end - dur);
      if (hi < lo) continue;
      const start = Math.min(hi, Math.max(lo, Math.round(target / ALIGN) * ALIGN));
      if (!best || Math.abs(start - target) < Math.abs(best.start - target)) best = { start, end: start + dur };
    }
  }
  return best;
}

/** Working hours of each working day (home zone) overlapping [from, to). */
export function workingWindows(from: number, to: number, s: SlotSettings): Interval[] {
  return daysIn(from, to, s.homeZone)
    .filter((d) => s.workDays.includes(d.weekday))
    .map((d) => hoursOf(d, [s.workStartHour, s.workEndHour]));
}

export interface Resolution {
  /**
   * ok: `slot` satisfies the request. alternative: nothing free where asked;
   * `alternatives` are the closest options. conflict: the requested exact time
   * overlaps something. past: the requested time has gone. none: nothing found.
   */
  status: "ok" | "alternative" | "conflict" | "past" | "none";
  slot: Interval | null;
  alternatives: Interval[];
  conflicts: Occurrence[];
  /** Minutes used (the request's, or the default when it gave none). */
  durationMin: number;
  assumedDuration: boolean;
  /** The deadline in force, including "before my next meeting". */
  deadline: number | null;
  /** The slot ends after the deadline. */
  late: boolean;
  message: string;
  notes: string[];
}

export function resolveRequest(req: ScheduleRequest, events: CalendarEvent[], s: SlotSettings, now: number): Resolution {
  const notes: string[] = [];
  const assumedDuration = req.durationMin == null;
  const durationMin = req.durationMin ?? DEFAULT_DURATION_MIN;
  const dur = durationMin * MIN;
  const bufferMs = Math.max(0, s.bufferMin) * MIN;
  const horizonEnd = now + (HORIZON_DAYS + 1) * DAY;
  const busy = busyIntervals(events, now, Math.max(horizonEnd, (req.window?.end ?? 0) + 8 * DAY), bufferMs);
  const notBefore = now;

  let deadline = req.deadline;
  if (req.beforeNextMeeting) {
    const next = expandEvents(events, now, now + 30 * DAY).find((o) => o.event.fixed && o.start > now);
    if (next) {
      deadline = Math.min(deadline ?? Infinity, next.start - bufferMs);
      notes.push(`Before “${next.event.title}”.`);
    } else notes.push("No upcoming fixed appointment found, so there is no cut-off.");
  }
  if (assumedDuration) notes.push(`No length given: ${durationMin} minutes assumed.`);
  const base = { conflicts: [] as Occurrence[], durationMin, assumedDuration, deadline, notes };
  const done = (status: Resolution["status"], slot: Interval | null, alternatives: Interval[], message: string, conflicts: Occurrence[] = []): Resolution => ({
    ...base,
    status,
    slot,
    alternatives: alternatives.filter((a, i, all) => all.findIndex((b) => b.start === a.start) === i).slice(0, 3),
    conflicts,
    late: !!slot && deadline != null && slot.end > deadline,
    message,
  });

  const zoneDay = (ms: number) => DateTime.fromMillis(ms, { zone: req.zone });
  const waking = (from: number, to: number) => daysIn(from, to, req.zone).map((d) => hoursOf(d, WAKING));

  // ---- an exact time: use it, or explain what is in the way
  if (req.startAt != null && !req.startApprox) {
    const slot = { start: req.startAt, end: req.endAt ?? req.startAt + dur };
    const sameDay = waking(slot.start, slot.start + 1);
    if (slot.start < now - MIN) {
      const tomorrow = { start: zoneDay(slot.start).plus({ days: 1 }).toMillis(), end: zoneDay(slot.end).plus({ days: 1 }).toMillis() };
      const alts = [fitNear(sameDay, busy, dur, now, notBefore), findConflicts(events, tomorrow).length ? null : tomorrow].filter((x): x is Interval => !!x);
      return done("past", null, alts, "That time has already passed.");
    }
    const conflicts = findConflicts(events, slot);
    if (!conflicts.length) return done("ok", slot, [], "Free at the requested time.");
    const tomorrow = { start: zoneDay(slot.start).plus({ days: 1 }).toMillis(), end: zoneDay(slot.end).plus({ days: 1 }).toMillis() };
    const near = fitNear(sameDay, busy, slot.end - slot.start, slot.start, notBefore);
    const after = firstFit([{ start: slot.end, end: slot.end + 2 * DAY }], busy, slot.end - slot.start, notBefore);
    const alts = [near, findConflicts(events, tomorrow).length ? null : tomorrow, after].filter((x): x is Interval => !!x);
    return done("conflict", slot, alts, `That overlaps “${conflicts[0].event.title}”${conflicts.length > 1 ? ` and ${conflicts.length - 1} more` : ""}.`, conflicts);
  }

  // ---- an approximate time: the nearest free slot to it
  if (req.startAt != null) {
    const near = fitNear(waking(req.startAt, req.startAt + 1), busy, dur, req.startAt, notBefore);
    if (near && Math.abs(near.start - req.startAt) <= 30 * MIN) return done("ok", near, [], "Free around the requested time.");
    const later = firstFit([{ start: req.startAt, end: req.startAt + 3 * DAY }], busy, dur, notBefore);
    const alts = [near, later].filter((x): x is Interval => !!x);
    return done(alts.length ? "alternative" : "none", null, alts, alts.length ? "Nothing is free around that time. The closest options:" : "Nothing free was found near that time.");
  }

  // ---- a day and/or part of the day: the first free slot inside it
  const from = Math.max(now, req.window?.start ?? now);
  const to = req.window?.end ?? horizonEnd;
  const days = daysIn(from, to, req.zone);
  const hours = req.period ? periodHours(req.period, s) : null;
  let primary: Interval[];
  if (hours) primary = days.map((d) => hoursOf(d, hours));
  else if (req.window) primary = workingWindows(from, to, s).map((w) => ({ start: Math.max(w.start, from), end: Math.min(w.end, to) })).filter((w) => w.end > w.start);
  else primary = workingWindows(from, to, s);

  let slot = firstFit(primary, busy, dur, notBefore, deadline);
  if (slot) return done("ok", slot, [], req.period ? `Free in the ${req.period}.` : "First free time.");

  // A named day with no part of the day: outside working hours on that day still honours the request.
  if (req.window && !hours) {
    const rest = waking(from, to).map((w) => ({ start: Math.max(w.start, from), end: Math.min(w.end, to) })).filter((w) => w.end > w.start);
    slot = firstFit(rest, busy, dur, notBefore, deadline);
    if (slot) {
      notes.push("Outside your working hours: nothing was free inside them.");
      return done("ok", slot, [], "First free time that day.");
    }
  }

  // ---- nothing where asked: the closest reasonable alternatives
  const alts: (Interval | null)[] = [];
  const target = primary.find((w) => w.end > now)?.start ?? from;
  if (hours && req.window) alts.push(fitNear(waking(from, to).map((w) => ({ start: Math.max(w.start, from), end: Math.min(w.end, to) })).filter((w) => w.end > w.start), busy, dur, target, notBefore));
  if (req.window) {
    // the same part of the day (or working hours) on the following days
    const next = daysIn(to, to + 7 * DAY, req.zone);
    alts.push(firstFit(hours ? next.map((d) => hoursOf(d, hours)) : workingWindows(to, to + 7 * DAY, s), busy, dur, notBefore));
  }
  alts.push(firstFit(workingWindows(now, horizonEnd, s), busy, dur, notBefore));
  if (deadline != null) alts.push(firstFit(primary, busy, dur, notBefore)); // possible, but after the deadline
  const found = alts.filter((x): x is Interval => !!x).sort((a, b) => Math.abs(a.start - target) - Math.abs(b.start - target));
  const where = req.period ? `${req.window ? `${req.window.label} ` : ""}in the ${req.period}` : req.window ? req.window.label : "in the next two weeks";
  const lengthText = durationMin >= 60 && durationMin % 60 === 0 ? `${durationMin / 60}-hour` : `${durationMin}-minute`;
  if (!found.length) return done("none", null, [], `No free ${lengthText} slot was found ${where}.`);
  return done("alternative", null, found, `No free ${lengthText} slot ${where}${deadline != null ? " before the deadline" : ""}. The closest options:`);
}

/**
 * Free times to offer instead of `slot` when it overlaps something: the nearest
 * one the same day, the same time the next day, and the first one afterwards.
 */
export function alternativesFor(slot: Interval, events: CalendarEvent[], s: SlotSettings, now: number, zone: string, ignoreEventId?: string | null): Interval[] {
  const dur = slot.end - slot.start;
  const ignore = ignoreEventId ? new Set([ignoreEventId]) : undefined;
  const busy = busyIntervals(events, now, slot.end + 8 * DAY, Math.max(0, s.bufferMin) * MIN, ignore);
  const others = ignoreEventId ? events.filter((e) => e.id !== ignoreEventId) : events;
  const day = DateTime.fromMillis(slot.start, { zone });
  const tomorrow = { start: day.plus({ days: 1 }).toMillis(), end: DateTime.fromMillis(slot.end, { zone }).plus({ days: 1 }).toMillis() };
  const out = [
    fitNear([hoursOf(day, WAKING)], busy, dur, slot.start, now),
    findConflicts(others, tomorrow).length ? null : tomorrow,
    firstFit([{ start: slot.end, end: slot.end + 3 * DAY }], busy, dur, now),
  ].filter((x): x is Interval => !!x && x.start !== slot.start);
  return out.filter((a, i) => out.findIndex((b) => b.start === a.start) === i).slice(0, 3);
}
