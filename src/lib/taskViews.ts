import { DateTime } from "luxon";
import type { CalendarEvent, Task } from "@/data/types";

/**
 * The lists on the Tasks page. A task's place in them comes from when it is
 * really happening: its deadline, or the time reserved for it on the calendar
 * (a task scheduled by voice, Smart Schedule or Auto-plan often has no
 * deadline at all, only its block). Every list and its count is computed from
 * the same tasks and calendar entries, so they cannot disagree.
 */

export type TaskView = "today" | "upcoming" | "week" | "overdue" | "all" | "completed" | "archive" | "trash";
export const TASK_VIEWS: TaskView[] = ["today", "upcoming", "week", "overdue", "all", "completed", "archive", "trash"];

export interface TaskWhen {
  /** The moment the task is next expected: the start of its next reserved time, otherwise its deadline. */
  at: number | null;
  /** Its time has passed and it is still open. */
  overdue: boolean;
  /** Start of the block reserved next (or under way), if any. */
  blockStart: number | null;
  blockEnd: number | null;
}

/** When each task is happening, from its deadline and its calendar blocks. */
export function taskTimes(tasks: Task[], events: CalendarEvent[], now: number): Map<string, TaskWhen> {
  const next = new Map<string, CalendarEvent>();
  const last = new Map<string, CalendarEvent>();
  for (const e of events) {
    if (e.deletedAt || !e.taskId || e.recurrence) continue;
    if (e.endAt > now) {
      const cur = next.get(e.taskId);
      if (!cur || e.startAt < cur.startAt) next.set(e.taskId, e);
    } else {
      const cur = last.get(e.taskId);
      if (!cur || e.endAt > cur.endAt) last.set(e.taskId, e);
    }
  }
  const out = new Map<string, TaskWhen>();
  for (const t of tasks) {
    const n = next.get(t.id);
    const l = last.get(t.id);
    // A block that ended without a later one means its time passed; "worked" blocks are waiting to be marked complete, not missed.
    const missedBlock = !n && !!l && l.sched?.attention !== "worked";
    const at = n ? n.startAt : t.dueAt ?? (l ? l.startAt : null);
    out.set(t.id, {
      at,
      overdue: t.status !== "done" && ((t.dueAt != null && t.dueAt < now) || missedBlock),
      blockStart: n?.startAt ?? null,
      blockEnd: n?.endAt ?? null,
    });
  }
  return out;
}

export function filterTasks(tasks: Task[], view: TaskView, now: number, zone: string, events: CalendarEvent[] = []): Task[] {
  const d = DateTime.fromMillis(now, { zone });
  const sod = d.startOf("day").toMillis();
  const eod = d.endOf("day").toMillis();
  const eow = d.endOf("week").toMillis();
  const live = tasks.filter((t) => !t.deletedAt && !t.archivedAt);
  const open = live.filter((t) => t.status !== "done");
  const when = taskTimes(open, events, now);
  const at = (t: Task) => when.get(t.id)?.at ?? null;
  const byTime = (a: Task, b: Task) => (at(a) ?? Infinity) - (at(b) ?? Infinity) || a.sortOrder - b.sortOrder;
  switch (view) {
    case "today":
      return open.filter((t) => {
        const w = when.get(t.id)!;
        return (w.at != null && w.at <= eod) || w.overdue || t.status === "in_progress" || (w.at == null && t.createdAt >= sod);
      });
    case "upcoming":
      return open.filter((t) => at(t) != null && at(t)! > eod).sort(byTime);
    case "week":
      return open.filter((t) => at(t) != null && at(t)! >= sod && at(t)! <= eow).sort(byTime);
    case "overdue":
      return open.filter((t) => when.get(t.id)!.overdue).sort(byTime);
    case "all":
      return open;
    case "completed":
      return live.filter((t) => t.status === "done").sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    case "archive":
      return tasks.filter((t) => t.archivedAt && !t.deletedAt).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    case "trash":
      return tasks.filter((t) => t.deletedAt).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }
}

export function taskCounts(tasks: Task[], now: number, zone: string, events: CalendarEvent[]): Record<TaskView, number> {
  return Object.fromEntries(TASK_VIEWS.map((v) => [v, filterTasks(tasks, v, now, zone, events).length])) as Record<TaskView, number>;
}
