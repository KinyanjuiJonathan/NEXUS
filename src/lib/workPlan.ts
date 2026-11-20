import { DateTime } from "luxon";

/**
 * When the user intends to work.
 *
 * Working hours are not a fixed 9-to-5: each day can have its own plan (a
 * start and an end as instants, so "8 AM Texas time" and "5 PM Kenya time"
 * are the same thing), or be a day off. A day without a plan follows the most
 * recent plan's pattern, weekends included; only when no plan was ever given
 * do the fixed hours and working days from Settings apply.
 */

export type DayPlan = { start: number; end: number; zone: string } | { off: true };
export type WorkPlans = Record<string, DayPlan>;

export interface WorkHours {
  zone: string;
  startHour: number;
  endHour: number;
  /** ISO weekdays (1 = Monday) used when there is no plan at all. */
  days: number[];
  /** Plans by ISO date in `zone`. */
  plans?: WorkPlans;
}

interface Interval {
  start: number;
  end: number;
}

const MIN = 60_000;
const isOff = (p: DayPlan | undefined): p is { off: true } => !!p && "off" in p;

export const dayKey = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toISODate()!;

/** The pattern a day without its own plan follows: the latest planned day's start (minutes after midnight) and length. */
export function usualPattern(plans: WorkPlans | undefined, zone: string): { offsetMin: number; lengthMs: number } | null {
  if (!plans) return null;
  const key = Object.keys(plans).filter((k) => !isOff(plans[k])).sort().pop();
  if (!key) return null;
  const p = plans[key] as { start: number; end: number };
  const midnight = DateTime.fromISO(key, { zone }).startOf("day").toMillis();
  return { offsetMin: Math.round((p.start - midnight) / MIN), lengthMs: Math.max(0, p.end - p.start) };
}

/** Working time of the day `key` (ISO date in the home zone), or null for a day off. `planned` says whether the user set it. */
export function hoursFor(key: string, wh: WorkHours): (Interval & { planned: boolean }) | null {
  const own = wh.plans?.[key];
  if (isOff(own)) return null;
  if (own) return { start: own.start, end: own.end, planned: true };
  const day = DateTime.fromISO(key, { zone: wh.zone }).startOf("day");
  const usual = usualPattern(wh.plans, wh.zone);
  if (usual) {
    const start = day.plus({ minutes: usual.offsetMin }).toMillis();
    return { start, end: start + usual.lengthMs, planned: false };
  }
  if (!wh.days.includes(day.weekday)) return null;
  const start = day.set({ hour: Math.min(23, wh.startHour) }).toMillis();
  const end = wh.endHour >= 24 ? day.plus({ days: 1 }).toMillis() : day.set({ hour: wh.endHour }).toMillis();
  return { start, end: Math.max(start, end), planned: false };
}

/** Working time overlapping [from, to), one interval per working day, earliest first. */
export function workWindows(from: number, to: number, wh: WorkHours): Interval[] {
  const out: Interval[] = [];
  // a plan can run past midnight, so the day before `from` may still be under way
  let d = DateTime.fromMillis(from, { zone: wh.zone }).startOf("day").minus({ days: 1 });
  for (let i = 0; i < 64 && d.toMillis() < to; i++, d = d.plus({ days: 1 })) {
    const h = hoursFor(d.toISODate()!, wh);
    if (h && h.end > from && h.start < to && h.end > h.start) out.push({ start: h.start, end: h.end });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Working hours as the schedulers need them, from the settings. */
export function workHours(s: { homeZone: string; workStartHour: number; workEndHour: number; workDays: number[]; workPlans?: WorkPlans }): WorkHours {
  return { zone: s.homeZone, startHour: s.workStartHour, endHour: s.workEndHour, days: s.workDays, plans: s.workPlans };
}

/** Plans worth keeping: the last two weeks and everything ahead. */
export function prunePlans(plans: WorkPlans, now: number, zone: string): WorkPlans {
  const cutoff = DateTime.fromMillis(now, { zone }).minus({ days: 14 }).toISODate()!;
  return Object.fromEntries(Object.entries(plans).filter(([k]) => k >= cutoff));
}
