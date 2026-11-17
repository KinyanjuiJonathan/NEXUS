import { DateTime } from "luxon";
import type { CalendarEvent, FocusSession, Task } from "@/data/types";
import { expandEvents } from "./schedule";

export interface DayStats {
  totalToday: number;
  completedToday: number;
  pendingToday: number;
  overdue: number;
  focusMsToday: number;
  completionRate: number;
}

/** "Today's tasks" = due today, or completed today, or in progress. */
export function isTodayTask(t: Task, start: number, end: number): boolean {
  if (t.deletedAt) return false;
  if (t.completedAt != null && t.completedAt >= start && t.completedAt < end) return true;
  if (t.status === "done" || t.archivedAt) return false;
  if (t.dueAt != null && t.dueAt >= start && t.dueAt < end) return true;
  return t.status === "in_progress";
}

export function dayStats(tasks: Task[], focus: FocusSession[], now: number, zone: string): DayStats {
  const start = DateTime.fromMillis(now, { zone }).startOf("day").toMillis();
  const end = DateTime.fromMillis(now, { zone }).endOf("day").toMillis() + 1;
  const today = tasks.filter((t) => isTodayTask(t, start, end));
  const completedToday = today.filter((t) => t.status === "done").length;
  const overdue = tasks.filter((t) => !t.deletedAt && !t.archivedAt && t.status !== "done" && t.dueAt != null && t.dueAt < now).length;
  const focusMsToday = focus.filter((f) => f.endedAt >= start && f.startedAt < end).reduce((a, f) => a + f.durationMs, 0);
  return {
    totalToday: today.length,
    completedToday,
    pendingToday: today.length - completedToday,
    overdue,
    focusMsToday,
    completionRate: today.length ? completedToday / today.length : 0,
  };
}

export interface DayBucket {
  day: number;
  label: string;
  completed: number;
  created: number;
  focusMin: number;
}

/** Last `days` days (oldest first) of completions / focus minutes. */
export function history(tasks: Task[], focus: FocusSession[], now: number, zone: string, days = 7): DayBucket[] {
  const out: DayBucket[] = [];
  const today = DateTime.fromMillis(now, { zone }).startOf("day");
  for (let i = days - 1; i >= 0; i--) {
    const d = today.minus({ days: i });
    const s = d.toMillis();
    const e = d.plus({ days: 1 }).toMillis();
    out.push({
      day: s,
      label: d.toFormat("ccc"),
      completed: tasks.filter((t) => t.completedAt != null && t.completedAt >= s && t.completedAt < e).length,
      created: tasks.filter((t) => t.createdAt >= s && t.createdAt < e).length,
      focusMin: Math.round(focus.filter((f) => f.startedAt >= s && f.startedAt < e).reduce((a, f) => a + f.durationMs, 0) / 60_000),
    });
  }
  return out;
}

export function nextAppointment(events: CalendarEvent[], now: number) {
  return expandEvents(events, now - 12 * 3600_000, now + 60 * 86_400_000).find((o) => o.end > now) ?? null;
}
