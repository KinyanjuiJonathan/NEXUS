import type { CalendarEvent, Task } from "@/data/types";
import { DAY, MIN, expandEvents } from "@/lib/schedule";

/**
 * The schedule as every part of NEXUS should show it: one list, computed from
 * the stored tasks and calendar entries, never kept as a separate copy. An
 * entry disappears the moment its task or appointment is deleted, cancelled
 * or (for time reserved for a task) completed.
 */

export interface AgendaItem {
  /** Stable key for lists. */
  key: string;
  title: string;
  start: number;
  end: number;
  /** fixed: an appointment that never moves. flexible: time reserved for a task. deadline: a task's due time. */
  kind: "fixed" | "flexible" | "deadline";
  /** now: under way. overdue: its time passed and the task is still open. */
  status: "now" | "upcoming" | "overdue";
  taskId: string | null;
  eventId: string | null;
  /** NEXUS has moved it automatically. */
  moved: boolean;
}

const LOOKBACK = 7 * DAY;

const openTask = (t: Task | undefined): t is Task => !!t && !t.deletedAt && !t.archivedAt && t.status !== "done";

/**
 * What is under way, coming up, or overdue, in chronological order.
 * Overdue entries are included (they are the earliest) so they can be highlighted.
 */
export function agenda(tasks: Task[], events: CalendarEvent[], now: number, opts: { horizonDays?: number; limit?: number } = {}): AgendaItem[] {
  const { horizonDays = 7, limit = 6 } = opts;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const items: AgendaItem[] = [];
  const planned = new Set<string>();

  // appointments and reserved time that have not ended
  for (const o of expandEvents(events, now - DAY, now + horizonDays * DAY)) {
    if (o.end <= now) continue;
    const e = o.event;
    // time reserved for a task only counts while that task is still to be done
    if (e.taskId && !openTask(byId.get(e.taskId))) continue;
    if (e.taskId) planned.add(e.taskId);
    items.push({
      key: `e-${e.id}-${o.start}`,
      title: e.title,
      start: o.start,
      end: o.end,
      kind: e.fixed ? "fixed" : "flexible",
      status: o.start <= now ? "now" : "upcoming",
      taskId: e.taskId,
      eventId: e.id,
      moved: e.sched?.origin === "auto" && (e.sched?.moves ?? 0) > 0,
    });
  }

  // reserved time that passed with the task still open (waiting to be re-planned or decided)
  const latestPast = new Map<string, CalendarEvent>();
  for (const e of events) {
    if (e.deletedAt || !e.taskId || e.recurrence || e.endAt > now || e.endAt < now - LOOKBACK || planned.has(e.taskId)) continue;
    const cur = latestPast.get(e.taskId);
    if (!cur || e.endAt > cur.endAt) latestPast.set(e.taskId, e);
  }
  for (const [taskId, e] of latestPast) {
    const t = byId.get(taskId);
    if (!openTask(t)) continue;
    planned.add(taskId);
    items.push({ key: `e-${e.id}`, title: t.title, start: e.startAt, end: e.endAt, kind: e.fixed ? "fixed" : "flexible", status: "overdue", taskId, eventId: e.id, moved: false });
  }

  // tasks that only have a due time
  for (const t of tasks) {
    if (!openTask(t) || t.dueAt == null || planned.has(t.id)) continue;
    if (t.dueAt < now - LOOKBACK || t.dueAt > now + horizonDays * DAY) continue;
    items.push({ key: `t-${t.id}`, title: t.title, start: t.dueAt, end: t.dueAt, kind: "deadline", status: t.dueAt < now ? "overdue" : "upcoming", taskId: t.id, eventId: null, moved: false });
  }

  return items.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title)).slice(0, limit);
}

/** "now", "in 25 min", "in 3 h", "in 2 d", "45 min overdue". */
export function untilLabel(item: Pick<AgendaItem, "start" | "end" | "status" | "kind">, now: number): string {
  const span = (ms: number) => {
    const m = Math.max(1, Math.round(ms / MIN));
    if (m < 60) return `${m} min`;
    const h = m / 60;
    if (h < 24) return Number.isInteger(h) || h >= 10 ? `${Math.round(h)} h` : `${Math.floor(h)} h ${m % 60} min`;
    return `${Math.round(h / 24)} d`;
  };
  if (item.status === "overdue") return `${span(now - (item.kind === "deadline" ? item.start : item.end))} overdue`;
  if (item.status === "now") return `now · ${span(item.end - now)} left`;
  return `in ${span(item.start - now)}`;
}
