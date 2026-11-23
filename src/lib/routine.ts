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

/** How one day actually went, when it differs from the plan. Keyed by the ISO date (routine zone) of the wake-up. */
export interface DayAnchor {
  /** When the day really starts (the wake-up moment). */
  wake?: number;
  /** When the sleep before it really began (an absence the user confirmed as sleep). */
  sleptFrom?: number;
  /** Planned length of that night's sleep, when part of it was already taken earlier (minutes). */
  sleepMin?: number;
  /** Morning items already taken care of (breakfast eaten while away). */
  skip?: RoutineKind[];
}

export interface Routine {
  enabled: boolean;
  /**
   * Adapt to what actually happens instead of the clock: sleep moves later
   * while the user is still working, a long absence can be counted as the
   * sleep, the day starts when the user really gets up, and the whole waking
   * day after the morning routine is open for work. Only the gym keeps its time.
   */
  flexible: boolean;
  anchors: Record<string, DayAnchor>;
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
  flexible: true,
  anchors: {},
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

export type RoutineKind = "sleep" | "wake" | "exercise" | "prepare" | "breakfast" | "admin" | "work" | "break" | "lunch" | "gym" | "open";
export interface RoutineBlock {
  /** The day (ISO date in the routine's zone) this block belongs to. */
  day: string;
  kind: RoutineKind;
  label: string;
  start: number;
  end: number;
}

const LABEL: Record<RoutineKind, string> = {
  sleep: "Sleep", wake: "Wake up", exercise: "Exercise", prepare: "Get ready", breakfast: "Breakfast",
  admin: "Admin & planning", work: "Work session", break: "Break", lunch: "Lunch", gym: "Gym", open: "Open for work",
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
  r.flexible = r.flexible !== false;
  r.anchors = r.anchors && typeof r.anchors === "object" ? r.anchors : {};
  return r;
}

export const workMinutes = (r: Routine) => r.sessions * r.sessionMin;

const dayOf = (key: string, r: Routine) => DateTime.fromISO(key, { zone: r.zone }).startOf("day");

/** When the day `key` starts: the real wake-up if it is known, otherwise the planned time. */
export function wakeAt(key: string, r: Routine): number {
  return r.anchors?.[key]?.wake ?? dayOf(key, r).plus({ minutes: r.wake }).toMillis();
}

/** The sleep that ends with the wake-up of day `key`. */
export function sleepOf(key: string, r: Routine): { start: number; end: number } {
  const a = r.anchors?.[key];
  const end = wakeAt(key, r);
  const start = a?.sleptFrom ?? end - Math.max(0, a?.sleepMin ?? r.sleepMin) * MIN;
  return { start: Math.min(start, end), end };
}

/** Everything that belongs to the day `key` (ISO date in the routine's zone): the sleep before it, the morning, work, and the gym. */
export function routineDay(key: string, r: Routine): RoutineBlock[] {
  const day = dayOf(key, r);
  const skip = new Set(r.anchors?.[key]?.skip ?? []);
  const out: RoutineBlock[] = [];
  const add = (kind: RoutineKind, start: number, minutes: number, label = LABEL[kind]) => {
    if (minutes > 0 && !skip.has(kind)) out.push({ day: key, kind, label, start, end: start + minutes * MIN });
    return skip.has(kind) ? start : start + minutes * MIN;
  };
  const sleep = sleepOf(key, r);
  if (sleep.end > sleep.start) out.push({ day: key, kind: "sleep", label: LABEL.sleep, start: sleep.start, end: sleep.end });
  let t = sleep.end;
  t = add("wake", t, r.wakeUpMin);
  t = add("exercise", t, r.exerciseMin);
  t = add("prepare", t, r.prepareMin);
  t = add("breakfast", t, r.breakfastMin);
  // Admin and planning always comes first after sleep, before any other work.
  t = add("admin", t, r.adminMin);
  for (let i = 1; i <= r.sessions; i++) {
    t = add("work", t, r.sessionMin, `Work session ${i}`);
    if (i === r.sessions) break;
    t = i === r.lunchAfter ? add("lunch", t, r.lunchMin) : add("break", t, r.breakMin);
  }
  if (r.flexible) {
    // A freelancer's day does not end at a set hour: the rest of the waking day stays open for work,
    // up to 12 hours of work in all and never into the next sleep.
    const next = day.plus({ days: 1 }).toISODate()!;
    const until = Math.min(sleepOf(next, r).start, t + Math.max(0, MAX_WORK_MIN - workMinutes(r)) * MIN);
    if (until - t >= 15 * MIN) out.push({ day: key, kind: "open", label: LABEL.open, start: t, end: until });
  }
  if (r.gymDays.includes(day.weekday)) out.push({ day: key, kind: "gym", label: LABEL.gym, start: day.plus({ minutes: r.gymStart }).toMillis(), end: day.plus({ minutes: r.gymStart + r.gymMin }).toMillis() });
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

/** Working time of one day: the sessions joined across breaks, plus the open time after them. Lunch and the gym split it. */
export function routineWork(key: string, r: Routine): { start: number; end: number }[] {
  const blocks = routineDay(key, r);
  const spans: { start: number; end: number }[] = [];
  for (const b of blocks) {
    if (b.kind !== "work" && b.kind !== "break" && b.kind !== "open") continue;
    const last = spans[spans.length - 1];
    if (last && last.end === b.start) last.end = b.end;
    else if (b.kind !== "break") spans.push({ start: b.start, end: b.end });
  }
  // the gym is the one fixed commitment: working time never includes it
  const out: { start: number; end: number }[] = [];
  const gyms = [...blocks, ...routineDay(dayOf(key, r).plus({ days: 1 }).toISODate()!, r)].filter((b) => b.kind === "gym");
  for (const s of spans) {
    let pieces = [s];
    for (const g of gyms) pieces = pieces.flatMap((p) => (g.end <= p.start || g.start >= p.end ? [p] : [{ start: p.start, end: g.start }, { start: g.end, end: p.end }].filter((x) => x.end - x.start >= 5 * MIN)));
    out.push(...pieces);
  }
  return out;
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

// ------------------------------------------------------------------ adapting to what really happens

/** The sleep that is under way or comes next. */
export function nextSleep(now: number, r: Routine): (RoutineBlock & { kind: "sleep" }) | null {
  if (!r.enabled) return null;
  const b = routineBlocks(now, now + 36 * 3600_000, r).find((x) => x.kind === "sleep" && x.end > now);
  return (b as (RoutineBlock & { kind: "sleep" }) | undefined) ?? null;
}

/** A copy of the routine with one day's anchor changed; anchors older than ten days are dropped. */
export function withAnchor(r: Routine, key: string, patch: DayAnchor | null, now: number): Routine {
  const cutoff = DateTime.fromMillis(now, { zone: r.zone }).minus({ days: 10 }).toISODate()!;
  const anchors = Object.fromEntries(Object.entries(r.anchors ?? {}).filter(([k]) => k >= cutoff));
  if (patch) anchors[key] = { ...(anchors[key] ?? {}), ...patch };
  else delete anchors[key];
  return { ...r, anchors };
}

const QUARTER = 15 * MIN;

/**
 * The user is still working when sleep is about to begin (or has begun):
 * sleep is moved later, full length, starting half an hour from now. Returns
 * the changed routine and the new sleep, or null when nothing needs to move.
 */
export function postponeSleep(now: number, r: Routine): { routine: Routine; start: number; end: number } | null {
  if (!r.enabled || !r.flexible) return null;
  const sleep = nextSleep(now, r);
  // only a planned sleep that is due: one the user already confirmed is in the past and stays as it is
  if (!sleep || r.anchors?.[sleep.day]?.sleptFrom != null || sleep.start > now + 5 * MIN) return null;
  const start = Math.ceil((now + 30 * MIN) / QUARTER) * QUARTER;
  const length = Math.max(0, r.anchors?.[sleep.day]?.sleepMin ?? r.sleepMin) * MIN;
  const end = start + length;
  if (end <= sleep.end) return null;
  return { routine: withAnchor(r, sleep.day, { wake: end }, now), start, end };
}

/**
 * The user was away from `from` to `to` and says it was sleep. If that fits a
 * night (the day's wake-up had not happened yet), it becomes that night's
 * sleep and the day starts at `to`. If the day was already under way (a long
 * break in the afternoon), the time is deducted from the next planned sleep
 * instead. `breakfast` also counts breakfast as done.
 */
export function countAsSleep(r: Routine, from: number, to: number, breakfast: boolean, now: number): { routine: Routine; kind: "night" | "deducted"; day: string } {
  const key = DateTime.fromMillis(to, { zone: r.zone }).toISODate()!;
  const startedAlready = wakeAt(key, r) <= from && r.anchors?.[key]?.sleptFrom == null;
  if (!startedAlready || r.anchors?.[key]?.sleptFrom != null) {
    const prior = r.anchors?.[key]?.sleptFrom;
    return { routine: withAnchor(r, key, { wake: to, sleptFrom: prior != null ? Math.min(prior, from) : from, skip: breakfast ? ["breakfast"] : [] }, now), kind: "night", day: key };
  }
  const next = DateTime.fromISO(key, { zone: r.zone }).plus({ days: 1 }).toISODate()!;
  const left = Math.max(0, (r.anchors?.[next]?.sleepMin ?? r.sleepMin) - Math.round((to - from) / MIN));
  return { routine: withAnchor(r, next, { sleepMin: left < 60 ? 0 : left, skip: breakfast ? ["breakfast"] : r.anchors?.[next]?.skip }, now), kind: "deducted", day: next };
}

/** Admin and planning work: it goes first after sleep. */
export function isAdminTask(t: { title: string; notes?: string }, categoryName?: string): boolean {
  return /\b(admin(?:istration|istrative)?|planning|plan (?:the|my) (?:day|week)|daily plan|paperwork|invoic\w*|emails?|inbox)\b/i.test(`${t.title} ${categoryName ?? ""}`);
}

/** Absences this long are worth asking about. */
export const SLEEP_CHECK_MS = 4 * 3600_000;
