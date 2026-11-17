import type { CalendarEvent, Task, Timer } from "@/data/types";
import { expandEvents } from "./schedule";
import { nextOccurrence } from "./recurrence";
import { formatWithZone } from "./time";
import { finishAt } from "./countdown";

export interface PlannedReminder {
  fireAt: number;
  title: string;
  body: string;
}

export const REMINDER_PRESETS = [0, 5, 15, 30, 60] as const;

export function offsetLabel(min: number): string {
  if (min === 0) return "At time";
  if (min < 60) return `${min} min before`;
  if (min % 1440 === 0) return `${min / 1440} day${min > 1440 ? "s" : ""} before`;
  if (min % 60 === 0) return `${min / 60} h before`;
  return `${Math.floor(min / 60)} h ${min % 60} min before`;
}

function lead(min: number): string {
  if (min === 0) return "now";
  if (min < 60) return `in ${min} min`;
  if (min % 60 === 0) return `in ${min / 60} h`;
  return `in ${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * Reminders the OS scheduler should hold for a task. Only future instants are
 * returned; the Rust side replaces the pending set for the owner atomically.
 */
export function remindersForTask(task: Task, now: number, hour12: boolean): PlannedReminder[] {
  if (task.deletedAt || task.archivedAt || task.status === "done" || task.dueAt == null) return [];
  const zone = task.dueTz || "UTC";
  return [...new Set(task.reminders)]
    .map((off) => ({
      fireAt: task.dueAt! - off * 60_000,
      title: off === 0 ? `Due now: ${task.title}` : `Due ${lead(off)}: ${task.title}`,
      body: `Deadline ${formatWithZone(task.dueAt!, zone, hour12)}`,
    }))
    .filter((r) => r.fireAt > now)
    .sort((a, b) => a.fireAt - b.fireAt);
}

/** Reminders for the next occurrence(s) of an event within the horizon. */
export function remindersForEvent(ev: CalendarEvent, now: number, hour12: boolean, horizonDays = 14): PlannedReminder[] {
  if (ev.deletedAt || !ev.reminders.length) return [];
  const maxOff = Math.max(...ev.reminders) * 60_000;
  const occ = expandEvents([ev], now, now + horizonDays * 86_400_000 + maxOff);
  // Make sure at least the next occurrence beyond the horizon is covered for sparse series.
  if (!occ.length && ev.recurrence) {
    const n = nextOccurrence(ev.startAt, ev.tz, ev.recurrence, now);
    if (n != null) occ.push({ event: ev, start: n, end: n + (ev.endAt - ev.startAt), seriesStart: n, recurring: true });
  }
  const out: PlannedReminder[] = [];
  for (const o of occ.slice(0, 30)) {
    for (const off of new Set(ev.reminders)) {
      const fireAt = o.start - off * 60_000;
      if (fireAt <= now) continue;
      out.push({
        fireAt,
        title: off === 0 ? `Starting now: ${ev.title}` : `${ev.title} starts ${lead(off)}`,
        body: formatWithZone(o.start, ev.tz, hour12),
      });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

export function reminderForTimer(t: Timer, now: number): PlannedReminder[] {
  const at = finishAt(t, now);
  if (at == null || at <= now) return [];
  const what =
    t.kind === "pomodoro"
      ? t.phase === "focus"
        ? "Focus session complete — time for a break"
        : "Break is over — ready to focus?"
      : "Countdown finished";
  return [{ fireAt: at, title: what, body: t.label || "NEXUS timer" }];
}
