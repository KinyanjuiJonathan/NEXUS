import { DateTime } from "luxon";
import type { Task } from "@/data/types";

/**
 * How To-Do tasks appear on the calendar. A task is placed on the day of its
 * due date/time; tasks without one stay in the To-Do list only. The calendar
 * and the list read the same store, so a change in either shows in the other
 * immediately.
 */

export type TaskCalendarState = "done" | "overdue" | "pending";

/** Tasks that belong on the calendar: live (not deleted or archived) and scheduled. */
export function scheduledTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.deletedAt && !t.archivedAt && t.dueAt != null);
}

/** Live tasks with no date: they are only in the To-Do list. */
export function unscheduledOpenTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.deletedAt && !t.archivedAt && t.dueAt == null && t.status !== "done");
}

/** Tasks due inside [dayStart, dayEnd), earliest first; open tasks before finished ones at the same time. */
export function tasksForDay(tasks: Task[], dayStart: number, dayEnd: number): Task[] {
  return scheduledTasks(tasks)
    .filter((t) => t.dueAt! >= dayStart && t.dueAt! < dayEnd)
    .sort((a, b) => a.dueAt! - b.dueAt! || Number(a.status === "done") - Number(b.status === "done") || a.title.localeCompare(b.title));
}

export function taskCalendarState(task: Task, now: number): TaskCalendarState {
  if (task.status === "done") return "done";
  return task.dueAt != null && task.dueAt < now ? "overdue" : "pending";
}

export function isHighPriority(task: Task): boolean {
  return task.priority === "high" || task.priority === "critical";
}

/**
 * The due time after moving a task to another calendar day: the date changes,
 * the time of day stays the same in the task's own time zone.
 * `day` is any instant on the target day as shown in `displayZone`.
 */
export function dueOnDay(task: Task, day: number, displayZone: string): number | null {
  if (task.dueAt == null) return null;
  const tz = task.dueTz ?? displayZone;
  const target = DateTime.fromMillis(day, { zone: displayZone });
  const orig = DateTime.fromMillis(task.dueAt, { zone: tz });
  return DateTime.fromObject({ year: target.year, month: target.month, day: target.day, hour: orig.hour, minute: orig.minute }, { zone: tz }).toMillis();
}
