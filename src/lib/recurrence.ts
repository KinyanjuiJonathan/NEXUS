import { DateTime } from "luxon";
import type { RecurrenceRule } from "@/data/types";

/**
 * Recurrence is evaluated in the zone the item was created in so that a
 * "every Friday 3 PM Texas time" series stays at 3 PM local across DST changes.
 */

const MAX_ITER = 5000;

function step(dt: DateTime, rule: RecurrenceRule): DateTime {
  const n = Math.max(1, rule.interval || 1);
  switch (rule.freq) {
    case "daily":
      return dt.plus({ days: n });
    case "weekdays": {
      let next = dt.plus({ days: 1 });
      while (next.weekday > 5) next = next.plus({ days: 1 });
      return next;
    }
    case "weekly":
      return dt.plus({ weeks: n });
    case "monthly":
      return dt.plus({ months: n });
    case "yearly":
      return dt.plus({ years: n });
  }
}

/**
 * Iterate occurrence starts of a series beginning at `startMs` (the first occurrence).
 * Calls `visit` for each start until it returns false or the rule ends.
 */
export function iterate(
  startMs: number,
  zone: string,
  rule: RecurrenceRule,
  visit: (ms: number, index: number) => boolean,
): void {
  const ex = new Set(rule.exdates ?? []);
  const first = DateTime.fromMillis(startMs, { zone });
  let index = 0;
  const emit = (dt: DateTime): boolean => {
    const ms = dt.toMillis();
    if (rule.until != null && ms > rule.until) return false;
    if (rule.count != null && index >= rule.count) return false;
    const i = index++;
    if (ex.has(ms)) return true;
    return visit(ms, i);
  };

  if (rule.freq === "weekly" && rule.byWeekday && rule.byWeekday.length) {
    const days = [...new Set(rule.byWeekday)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
    const n = Math.max(1, rule.interval || 1);
    let weekStart = first.startOf("week");
    for (let guard = 0; guard < MAX_ITER; guard++) {
      for (const wd of days) {
        const dt = weekStart.plus({ days: wd - 1 }).set({
          hour: first.hour,
          minute: first.minute,
          second: 0,
          millisecond: 0,
        });
        if (dt < first) continue;
        if (!emit(dt)) return;
      }
      weekStart = weekStart.plus({ weeks: n });
    }
    return;
  }

  let dt: DateTime = first;
  // Keep the original day-of-month for monthly rules (Jan 31 -> Feb 28 -> Mar 31).
  for (let guard = 0; guard < MAX_ITER; guard++) {
    if (!emit(dt)) return;
    if (rule.freq === "monthly" || rule.freq === "yearly") {
      const n = Math.max(1, rule.interval || 1);
      const k = guard + 1;
      dt = first.plus(rule.freq === "monthly" ? { months: n * k } : { years: n * k });
    } else {
      dt = step(dt, rule);
    }
  }
}

/** Occurrence starts within [from, to). */
export function occurrencesBetween(
  startMs: number,
  zone: string,
  rule: RecurrenceRule | null,
  from: number,
  to: number,
): number[] {
  if (!rule) return startMs >= from && startMs < to ? [startMs] : [];
  const out: number[] = [];
  iterate(startMs, zone, rule, (ms) => {
    if (ms >= to) return false;
    if (ms >= from) out.push(ms);
    return out.length < 1000;
  });
  return out;
}

/** First occurrence strictly after `after`. */
export function nextOccurrence(startMs: number, zone: string, rule: RecurrenceRule, after: number): number | null {
  let found: number | null = null;
  iterate(startMs, zone, rule, (ms) => {
    if (ms > after) {
      found = ms;
      return false;
    }
    return true;
  });
  return found;
}

export function describeRule(rule: RecurrenceRule | null): string {
  if (!rule) return "Does not repeat";
  const n = Math.max(1, rule.interval || 1);
  const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let s: string;
  switch (rule.freq) {
    case "daily":
      s = n === 1 ? "Every day" : `Every ${n} days`;
      break;
    case "weekdays":
      s = "Every weekday";
      break;
    case "weekly":
      s = n === 1 ? "Every week" : `Every ${n} weeks`;
      if (rule.byWeekday?.length) s += ` on ${rule.byWeekday.map((d) => names[d]).join(", ")}`;
      break;
    case "monthly":
      s = n === 1 ? "Every month" : `Every ${n} months`;
      break;
    case "yearly":
      s = n === 1 ? "Every year" : `Every ${n} years`;
      break;
  }
  if (rule.count) s += `, ${rule.count} times`;
  return s;
}
