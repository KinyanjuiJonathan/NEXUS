import { DateTime } from "luxon";

/**
 * The daily routine: when the user sleeps, gets ready, works and rests.
 *
 * A day is built forwards from the wake-up time: waking up, exercise, getting
 * ready, breakfast, admin and planning, then work sessions separated by short
 * breaks, with lunch after one of them. Sleep is the stretch before waking;
 * the gym has its own days and time. Everything is in one zone (Kenya by
 * default), so "9 PM gym" is 9 PM there whatever zone the screen shows.
 *
 * Tasks are only planned inside the work sessions. Sleep, the morning routine,
 * admin, lunch and the gym are protected: nothing is scheduled over them.
 * Breaks are a guide: a task longer than one session runs through the break
 * rather than being cut in two.
 */

export interface Routine {
  enabled: boolean;
  zone: string;
  /** Wake-up time, minutes after midnight. */
  wake: number;
  /** Continuous sleep before waking, minutes (never less than 6 hours). */
  sleepMin: number;
  wakeUpMin: number;
  exerciseMin: number;
  prepareMin: number;
  breakfastMin: number;
  adminMin: number;
  sessions: number;
  sessionMin: number;
  breakMin: number;
  lunchMin: number;
  /** Lunch comes after this many sessions. */
  lunchAfter: number;
  /** Gym: ISO weekdays, start (minutes after midnight) and length. */
  gymDays: number[];
  gymStart: number;
  gymMin: number;
}

export const MIN_SLEEP_MIN = 6 * 60;
export const MAX_WORK_MIN = 12 * 60;

export const DEFAULT_ROUTINE: Routine = {
  enabled: true,
  zone: "Africa/Nairobi",
  wake: 6 * 60 + 30,
  sleepMin: 7 * 60,
  wakeUpMin: 15,
  exerciseMin: 30,
  prepareMin: 20,
  breakfastMin: 25,
  adminMin: 30,
  sessions: 5,
  sessionMin: 90,
  breakMin: 15,
  lunchMin: 60,
  lunchAfter: 3,
  gymDays: [1, 2, 3, 4],
  gymStart: 21 * 60,
  gymMin: 90,
};

export type RoutineKind = "sleep" | "wake" | "exercise" | "prepare" | "breakfast" | "admin" | "work" | "break" | "lunch" | "gym";
export interface RoutineBlock {
  kind: RoutineKind;
  label: string;
  start: number;
  end: number;
}

const LABEL: Record<RoutineKind, string> = {
  sleep: "Sleep", wake: "Wake up", exercise: "Exercise", prepare: "Get ready", breakfast: "Breakfast",
  admin: "Admin & planning", work: "Work session", break: "Break", lunch: "Lunch", gym: "Gym",
};
/** Time nothing is ever scheduled over. Breaks are not in it: they are a guide. */
const PROTECTED: ReadonlySet<RoutineKind> = new Set(["sleep", "wake", "exercise", "prepare", "breakfast", "admin", "lunch", "gym"]);
const MIN = 60_000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/** A routine that keeps the rules: at least 6 hours of sleep, at most 12 hours of work a day. */
export function normalizeRoutine(raw: Partial<Routine> | undefined): Routine {
  const r = { ...DEFAULT_ROUTINE, ...(raw ?? {}) };
  r.wake = clamp(Math.round(r.wake), 0, 24 * 60 - 1);
  r.sleepMin = clamp(Math.round(r.sleepMin), MIN_SLEEP_MIN, 12 * 60);
  for (const k of ["wakeUpMin", "exerciseMin", "prepareMin", "breakfastMin", "adminMin", "breakMin"] as const) r[k] = clamp(Math.round(r[k]), 0, 120);
  r.lunchMin = clamp(Math.round(r.lunchMin), 0, 180);
  r.sessionMin = clamp(Math.round(r.sessionMin), 15, 240);
  r.sessions = clamp(Math.round(r.sessions), 1, Math.max(1, Math.floor(MAX_WORK_MIN / r.sessionMin)));
  r.lunchAfter = clamp(Math.round(r.lunchAfter), 1, r.sessions);
  r.gymDays = [...new Set((r.gymDays ?? []).filter((d) => d >= 1 && d <= 7))].sort();
  r.gymStart = clamp(Math.round(r.gymStart), 0, 24 * 60 - 1);
  r.gymMin = clamp(Math.round(r.gymMin), 15, 240);
  return r;
}

export const workMinutes = (r: Routine) => r.sessions * r.sessionMin;

/** Everything that starts on the calendar day `key` (ISO date in the routine's zone), plus the sleep that ends on it. */
export function routineDay(key: string, r: Routine): RoutineBlock[] {
  const day = DateTime.fromISO(key, { zone: r.zone }).startOf("day");
  const at = (min: number) => day.plus({ minutes: min }).toMillis();
  const out: RoutineBlock[] = [];
  const add = (kind: RoutineKind, start: number, minutes: number, label = LABEL[kind]) => {
    if (minutes > 0) out.push({ kind, label, start, end: start + minutes * MIN });
    return start + minutes * MIN;
  };
  add("sleep", at(r.wake - r.sleepMin), r.sleepMin);
  let t = at(r.wake);
  t = add("wake", t, r.wakeUpMin);
  t = add("exercise", t, r.exerciseMin);
  t = add("prepare", t, r.prepareMin);
  t = add("breakfast", t, r.breakfastMin);
  t = add("admin", t, r.adminMin);
  for (let i = 1; i <= r.sessions; i++) {
    t = add("work", t, r.sessionMin, `Work session ${i}`);
    if (i === r.sessions) break;
    t = i === r.lunchAfter ? add("lunch", t, r.lunchMin) : add("break", t, r.breakMin);
  }
  if (r.gymDays.includes(day.weekday)) add("gym", at(r.gymStart), r.gymMin);
  return out.sort((a, b) => a.start - b.start);
}

/** Routine blocks overlapping [from, to). */
export function routineBlocks(from: number, to: number, r: Routine): RoutineBlock[] {
  if (!r.enabled) return [];
  const out: RoutineBlock[] = [];
  let d = DateTime.fromMillis(from, { zone: r.zone }).startOf("day").minus({ days: 1 });
  for (let i = 0; i < 70 && d.toMillis() < to + 24 * 3600_000; i++, d = d.plus({ days: 1 })) {
    for (const b of routineDay(d.toISODate()!, r)) if (b.end > from && b.start < to) out.push(b);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Working time of one day: the sessions, joined across breaks (lunch splits them). */
export function routineWork(key: string, r: Routine): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const b of routineDay(key, r)) {
    if (b.kind !== "work" && b.kind !== "break") continue;
    const last = spans[spans.length - 1];
    if (last && last.end === b.start) last.end = b.end;
    else if (b.kind === "work") spans.push({ start: b.start, end: b.end });
  }
  return spans;
}

/** Protected personal time overlapping [from, to): sleep, the morning routine, admin, lunch and the gym. */
export function personalTime(from: number, to: number, r: Routine | undefined): { start: number; end: number }[] {
  if (!r?.enabled) return [];
  return routineBlocks(from, to, r).filter((b) => PROTECTED.has(b.kind)).map((b) => ({ start: b.start, end: b.end }));
}

/** The block of a given kind that contains `now`, if any. */
export function routineNow(now: number, r: Routine | undefined, kind?: RoutineKind): RoutineBlock | null {
  if (!r?.enabled) return null;
  return routineBlocks(now, now + 1, r).find((b) => b.start <= now && b.end > now && (!kind || b.kind === kind)) ?? null;
}
