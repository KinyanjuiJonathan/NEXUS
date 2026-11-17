import { DateTime } from "luxon";
import type { ActivityEntry, Category, FocusSession, Task, WorkSession } from "@/data/types";
import { pausedMs, workedBetween } from "./work";
import { hoursMinutes as humanDuration } from "./countdown";

/** Analysis of how the user works over the last `days` days (pure, testable). */

export interface InsightInput {
  tasks: Task[];
  focus: FocusSession[];
  work: WorkSession[];
  activity: ActivityEntry[];
  categories: Category[];
  now: number;
  zone: string;
  days: number;
}

export interface DayRow {
  day: number;
  label: string;
  workedMin: number;
  focusMin: number;
  completed: number;
}

export interface Insights {
  daily: DayRow[];
  totals: { workedMin: number; focusMin: number; completed: number; created: number; activeDays: number; avgWorkedMinPerActiveDay: number };
  onTime: { rate: number | null; onTime: number; late: number };
  estimate: { bias: number | null; samples: number };
  hourly: number[];
  weekday: number[];
  byCategory: { id: string; name: string; color: string; completed: number; focusMin: number }[];
  sessions: { count: number; avgMin: number; idlePausedMin: number; autoPauses: number };
  streak: number;
  peakHour: number | null;
  findings: string[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const hourLabel = (h: number) => DateTime.fromObject({ hour: h }).toFormat("h a");

export function computeInsights(i: InsightInput): Insights {
  const today = DateTime.fromMillis(i.now, { zone: i.zone }).startOf("day");
  const from = today.minus({ days: i.days - 1 }).toMillis();
  const to = today.plus({ days: 1 }).toMillis();
  const inRange = (ms: number | null | undefined) => ms != null && ms >= from && ms < to;

  const daily: DayRow[] = [];
  for (let d = i.days - 1; d >= 0; d--) {
    const s = today.minus({ days: d });
    const e = s.plus({ days: 1 });
    const sm = s.toMillis();
    const em = e.toMillis();
    daily.push({
      day: sm,
      label: i.days <= 7 ? s.toFormat("ccc") : s.toFormat("d LLL"),
      workedMin: Math.round(workedBetween(i.work, sm, em, i.now) / 60_000),
      focusMin: Math.round(i.focus.filter((f) => f.startedAt >= sm && f.startedAt < em).reduce((a, f) => a + f.durationMs, 0) / 60_000),
      completed: i.tasks.filter((t) => t.completedAt != null && t.completedAt >= sm && t.completedAt < em).length,
    });
  }

  const completed = i.tasks.filter((t) => inRange(t.completedAt) && !t.deletedAt);
  const activeDays = daily.filter((d) => d.workedMin > 0 || d.focusMin > 0 || d.completed > 0).length;
  const workedMin = daily.reduce((a, d) => a + d.workedMin, 0);
  const focusMin = daily.reduce((a, d) => a + d.focusMin, 0);

  const withDue = completed.filter((t) => t.dueAt != null);
  const onTimeN = withDue.filter((t) => t.completedAt! <= t.dueAt!).length;

  const ratios = completed.filter((t) => t.estimateMin && t.spentMs > 60_000).map((t) => t.spentMs / (t.estimateMin! * 60_000));
  const bias = median(ratios);

  // Focus minutes per hour of day (sessions split across hour boundaries).
  const hourly = new Array(24).fill(0);
  for (const f of i.focus) {
    if (!inRange(f.startedAt)) continue;
    let t = f.startedAt;
    const end = f.startedAt + f.durationMs;
    while (t < end) {
      const dt = DateTime.fromMillis(t, { zone: i.zone });
      const next = Math.min(end, dt.startOf("hour").plus({ hours: 1 }).toMillis());
      hourly[dt.hour] += (next - t) / 60_000;
      t = next;
    }
  }
  for (const t of completed) hourly[DateTime.fromMillis(t.completedAt!, { zone: i.zone }).hour] += 5; // a completion ≈ 5 min of signal
  const hourlyRounded = hourly.map((v) => Math.round(v));
  const peak = hourlyRounded.reduce((best, v, h) => (v > (best == null ? 0 : hourlyRounded[best]) ? h : best), null as number | null);

  const weekday = new Array(7).fill(0);
  for (const t of completed) weekday[DateTime.fromMillis(t.completedAt!, { zone: i.zone }).weekday - 1] += 1;

  const focusByTask = new Map<string, number>();
  for (const f of i.focus) if (inRange(f.startedAt) && f.taskId) focusByTask.set(f.taskId, (focusByTask.get(f.taskId) ?? 0) + f.durationMs);
  const catMap = new Map<string, { completed: number; focusMs: number }>();
  for (const t of i.tasks) {
    const c = catMap.get(t.categoryId) ?? { completed: 0, focusMs: 0 };
    if (completed.includes(t)) c.completed++;
    c.focusMs += focusByTask.get(t.id) ?? 0;
    catMap.set(t.categoryId, c);
  }
  const byCategory = [...catMap.entries()]
    .map(([id, v]) => {
      const cat = i.categories.find((c) => c.id === id);
      return { id, name: cat?.name ?? id, color: cat?.color ?? "#94a3b8", completed: v.completed, focusMin: Math.round(v.focusMs / 60_000) };
    })
    .filter((c) => c.completed || c.focusMin)
    .sort((a, b) => b.focusMin - a.focusMin || b.completed - a.completed);

  const sessions = i.work.filter((s) => (s.endedAt ?? i.now) >= from && s.startedAt < to);
  const idlePausedMin = Math.round(sessions.reduce((a, s) => a + pausedMs(s, i.now, "idle"), 0) / 60_000);
  const autoPauses = i.activity.filter((a) => a.kind === "auto_paused" && inRange(a.at)).length;

  let streak = 0;
  for (let d = 0; d < 365; d++) {
    const s = today.minus({ days: d }).toMillis();
    const e = s + 86_400_000;
    const any = i.tasks.some((t) => t.completedAt != null && t.completedAt >= s && t.completedAt < e);
    if (any) streak++;
    else if (d > 0) break;
  }

  const findings: string[] = [];
  if (peak != null && hourlyRounded[peak] > 0) findings.push(`Your most productive time is around ${hourLabel(peak)}–${hourLabel((peak + 1) % 24)}. Protect it for deep work.`);
  if (bias != null && ratios.length >= 3) {
    if (bias > 1.15) findings.push(`Tasks take about ${Math.round((bias - 1) * 100)}% longer than you estimate. Add a buffer when planning.`);
    else if (bias < 0.85) findings.push(`You usually finish ${Math.round((1 - bias) * 100)}% faster than estimated. You can plan tighter.`);
    else findings.push("Your time estimates are accurate (within ±15%).");
  }
  if (withDue.length >= 3) findings.push(`${Math.round((onTimeN / withDue.length) * 100)}% of tasks with a deadline were finished on time.`);
  const bestDay = weekday.indexOf(Math.max(...weekday));
  if (Math.max(...weekday) >= 2) findings.push(`${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][bestDay]} is your most productive weekday.`);
  if (activeDays) findings.push(`You averaged ${humanDuration(Math.round(workedMin / activeDays) * 60_000)} of clocked work on active days.`);
  if (idlePausedMin >= 10) findings.push(`Auto-pause kept ${humanDuration(idlePausedMin * 60_000)} of inactivity out of your work time.`);
  if (workedMin > 0 && focusMin > 0) findings.push(`${Math.round(Math.min(1, focusMin / workedMin) * 100)}% of your clocked time was spent in focus sessions.`);
  if (streak >= 2) findings.push(`🔥 ${streak}-day streak of completing at least one task.`);
  if (byCategory[0] && byCategory.length > 1) findings.push(`Most of your focus went to ${byCategory[0].name}.`);
  if (!findings.length) findings.push("Not enough history yet. Clock in, run focus sessions and complete tasks, and insights will appear here.");

  return {
    daily,
    totals: { workedMin, focusMin, completed: completed.length, created: i.tasks.filter((t) => inRange(t.createdAt)).length, activeDays, avgWorkedMinPerActiveDay: activeDays ? Math.round(workedMin / activeDays) : 0 },
    onTime: { rate: withDue.length ? onTimeN / withDue.length : null, onTime: onTimeN, late: withDue.length - onTimeN },
    estimate: { bias, samples: ratios.length },
    hourly: hourlyRounded,
    weekday,
    byCategory,
    sessions: { count: sessions.length, avgMin: sessions.length ? Math.round(sessions.reduce((a, s) => a + workedBetween([s], from, to, i.now), 0) / sessions.length / 60_000) : 0, idlePausedMin, autoPauses },
    streak,
    peakHour: peak,
    findings,
  };
}
