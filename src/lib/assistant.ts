import { DateTime } from "luxon";
import type { CalendarEvent, FocusSession, Priority, Task } from "@/data/types";
import { conflictPairs, expandEvents, findFreeSlots, findMissed, type WorkingHours, DAY } from "./schedule";
import { formatTime, formatWithZone, zoneAbbr } from "./time";
import { humanDuration } from "./countdown";

/**
 * Local (offline) assistant. These heuristics power every AI feature when no
 * API key is configured, and provide the context sent to Claude when it is.
 */

const PW: Record<Priority, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function openTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.deletedAt && !t.archivedAt && t.status !== "done");
}

/** Score = priority + deadline pressure + quick-win bonus + in-progress momentum. */
export function scoreTask(t: Task, now: number): number {
  let s = PW[t.priority] * 10;
  if (t.dueAt != null) {
    const h = (t.dueAt - now) / 3600_000;
    if (h < 0) s += 30;
    else if (h < 3) s += 25;
    else if (h < 24) s += 15;
    else if (h < 72) s += 6;
  }
  if (t.status === "in_progress") s += 8;
  if (t.estimateMin != null && t.estimateMin <= 15) s += 3;
  const doneSubs = t.subtasks.filter((x) => x.done).length;
  if (t.subtasks.length && doneSubs > 0) s += 4 * (doneSubs / t.subtasks.length);
  return s;
}

export interface Suggestion {
  task: Task;
  reason: string;
}

export function suggestNext(tasks: Task[], now: number, freeMinutes?: number): Suggestion | null {
  const ranked = openTasks(tasks)
    .filter((t) => freeMinutes == null || t.estimateMin == null || t.estimateMin <= freeMinutes)
    .map((t) => ({ t, s: scoreTask(t, now) }))
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) return null;
  const t = ranked[0].t;
  const reasons: string[] = [];
  if (t.dueAt != null && t.dueAt < now) reasons.push(`it is overdue by ${humanDuration(now - t.dueAt)}`);
  else if (t.dueAt != null && t.dueAt - now < DAY) reasons.push(`it is due in ${humanDuration(t.dueAt - now)}`);
  if (t.priority === "critical" || t.priority === "high") reasons.push(`it is ${t.priority} priority`);
  if (t.status === "in_progress") reasons.push("you already started it");
  if (t.estimateMin != null && t.estimateMin <= 15) reasons.push("it's a quick win");
  return { task: t, reason: reasons.length ? `Because ${reasons.join(", ")}.` : "It's the most important open task." };
}

/** Estimate a realistic duration from history of similar tasks (by category), else defaults by priority. */
export function suggestEstimate(task: Pick<Task, "categoryId" | "title" | "priority">, history: Task[]): number {
  const similar = history.filter((t) => t.status === "done" && t.categoryId === task.categoryId && t.spentMs > 60_000);
  if (similar.length >= 3) {
    const mins = similar.map((t) => t.spentMs / 60_000).sort((a, b) => a - b);
    const median = mins[Math.floor(mins.length / 2)];
    return Math.max(15, Math.round(median / 15) * 15);
  }
  const words = task.title.split(/\s+/).length;
  const base = /\b(project|build|write|design|prepare|plan|research|report|migrate|launch)\b/i.test(task.title) ? 90 : 30;
  return base + (words > 6 ? 15 : 0);
}

/** Template-based project breakdown used when AI is not configured. */
export function breakdownLocally(title: string): { title: string; estimateMin: number }[] {
  const t = title.toLowerCase();
  const topic = title.replace(/^(finish|complete|do|work on|prepare|write|create|build|plan)\s+/i, "");
  if (/\b(report|document|essay|proposal|article|paper|doc)\b/.test(t))
    return [
      { title: `Gather sources & data for ${topic}`, estimateMin: 45 },
      { title: "Outline key sections", estimateMin: 20 },
      { title: "Write first draft", estimateMin: 90 },
      { title: "Review, edit & fact-check", estimateMin: 40 },
      { title: "Format and send", estimateMin: 15 },
    ];
  if (/\b(meeting|presentation|pitch|demo|talk|workshop)\b/.test(t))
    return [
      { title: "Define goal & agenda", estimateMin: 15 },
      { title: "Prepare slides / materials", estimateMin: 60 },
      { title: "Rehearse once", estimateMin: 20 },
      { title: "Send invite & pre-read", estimateMin: 10 },
      { title: "Write follow-up notes", estimateMin: 15 },
    ];
  if (/\b(app|feature|website|code|bug|release|deploy|api|build)\b/.test(t))
    return [
      { title: "Clarify requirements & acceptance criteria", estimateMin: 30 },
      { title: "Design the approach", estimateMin: 30 },
      { title: "Implement core changes", estimateMin: 120 },
      { title: "Write tests", estimateMin: 45 },
      { title: "Review, fix & ship", estimateMin: 45 },
    ];
  if (/\b(trip|travel|move|event|party|wedding)\b/.test(t))
    return [
      { title: "Set budget & dates", estimateMin: 20 },
      { title: "Book key reservations", estimateMin: 45 },
      { title: "Make a checklist", estimateMin: 15 },
      { title: "Confirm details with everyone", estimateMin: 20 },
    ];
  return [
    { title: `Define the outcome for "${topic}"`, estimateMin: 15 },
    { title: "List the steps & gather what you need", estimateMin: 20 },
    { title: "Do the main work", estimateMin: 60 },
    { title: "Review & wrap up", estimateMin: 20 },
  ];
}

export interface AgendaItem {
  kind: "event" | "task";
  title: string;
  at: number | null;
  end?: number;
  important?: boolean;
}

export function agendaForDay(tasks: Task[], events: CalendarEvent[], dayMs: number, zone: string): AgendaItem[] {
  const start = DateTime.fromMillis(dayMs, { zone }).startOf("day").toMillis();
  const end = start + DAY;
  const items: AgendaItem[] = expandEvents(events, start, end).map((o) => ({
    kind: "event",
    title: o.event.title,
    at: o.start,
    end: o.end,
    important: o.event.important,
  }));
  for (const t of openTasks(tasks)) {
    if (t.dueAt != null && t.dueAt >= start && t.dueAt < end) items.push({ kind: "task", title: t.title, at: t.dueAt });
  }
  return items.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
}

export interface DaySummaryInput {
  tasks: Task[];
  events: CalendarEvent[];
  focus: FocusSession[];
  now: number;
  zone: string;
  zones: string[];
  hour12: boolean;
  wh: WorkingHours;
}

export function summarizeDay(i: DaySummaryInput): string {
  const items = agendaForDay(i.tasks, i.events, i.now, i.zone);
  const open = openTasks(i.tasks);
  const overdue = open.filter((t) => t.dueAt != null && t.dueAt < i.now);
  const dayStart = DateTime.fromMillis(i.now, { zone: i.zone }).startOf("day").toMillis();
  const focusMs = i.focus.filter((f) => f.startedAt >= dayStart).reduce((a, f) => a + f.durationMs, 0);
  const lines: string[] = [];
  const events = items.filter((x) => x.kind === "event");
  const due = items.filter((x) => x.kind === "task");
  lines.push(
    `Today you have ${events.length} appointment${events.length === 1 ? "" : "s"} and ${due.length} task${due.length === 1 ? "" : "s"} due` +
      (overdue.length ? `, plus ${overdue.length} overdue.` : "."),
  );
  for (const e of events.slice(0, 6)) {
    const times = i.zones.map((z) => `${formatTime(e.at!, z, i.hour12)} ${zoneAbbr(z, e.at!)}`).join(" / ");
    lines.push(`• ${e.title} — ${times}${e.important ? " (important)" : ""}`);
  }
  for (const t of due.slice(0, 6)) lines.push(`• Due: ${t.title} at ${formatTime(t.at!, i.zone, i.hour12)}`);
  const next = suggestNext(i.tasks, i.now);
  if (next) lines.push(`Suggested focus: “${next.task.title}”. ${next.reason}`);
  const conflicts = conflictPairs(i.events, dayStart, dayStart + DAY);
  if (conflicts.length) lines.push(`⚠ ${conflicts.length} scheduling conflict${conflicts.length > 1 ? "s" : ""} today.`);
  if (focusMs) lines.push(`Focus time so far: ${humanDuration(focusMs)}.`);
  const slots = findFreeSlots(i.events, 60 * 60_000, i.now, i.wh, { maxSlots: 2, horizonDays: 1 });
  if (slots.length) lines.push(`Free hour${slots.length > 1 ? "s" : ""}: ${slots.map((s) => formatTime(s.start, i.zone, i.hour12)).join(", ")}.`);
  return lines.join("\n");
}

export function describeConflicts(events: CalendarEvent[], now: number, zone: string, hour12: boolean, days = 14): string[] {
  return conflictPairs(events, now, now + days * DAY).map(
    ([a, b]) => `“${a.event.title}” overlaps “${b.event.title}” on ${formatWithZone(Math.max(a.start, b.start), zone, hour12)}`,
  );
}

export interface ReorgProposal {
  task: Task;
  slot: { start: number; end: number } | null;
}

/** Propose new slots for unfinished/missed work. Never applied automatically. */
export function proposeReorganization(tasks: Task[], events: CalendarEvent[], now: number, wh: WorkingHours): ReorgProposal[] {
  const missed = findMissed(tasks, events, now).filter((m) => m.kind === "task");
  const taken: CalendarEvent[] = [...events];
  const out: ReorgProposal[] = [];
  const byScore = missed
    .map((m) => tasks.find((t) => t.id === m.id)!)
    .filter(Boolean)
    .sort((a, b) => scoreTask(b, now) - scoreTask(a, now));
  for (const t of byScore.slice(0, 8)) {
    const dur = (t.estimateMin ?? 30) * 60_000;
    const [slot] = findFreeSlots(taken, dur, now + 10 * 60_000, wh, { maxSlots: 1 });
    out.push({ task: t, slot: slot ?? null });
    if (slot) {
      taken.push({
        id: `tmp-${t.id}`, title: t.title, notes: "", startAt: slot.start, endAt: slot.end, tz: wh.zone, taskId: t.id,
        recurrence: null, important: false, reminders: [], color: null, fixed: false, sched: null, createdAt: now, updatedAt: now, deletedAt: null,
      });
    }
  }
  return out;
}

/** Compact JSON context for the AI assistant (no notes/PII beyond titles). */
export function aiContext(tasks: Task[], events: CalendarEvent[], now: number, zone: string, texasZone: string, wh: WorkingHours) {
  const iso = (ms: number | null) => (ms == null ? null : DateTime.fromMillis(ms, { zone }).toISO({ suppressMilliseconds: true }));
  return {
    now: iso(now),
    zone,
    kenyaZone: "Africa/Nairobi",
    texasZone,
    workingHours: { start: wh.startHour, end: wh.endHour, days: wh.days },
    openTasks: openTasks(tasks)
      .slice(0, 60)
      .map((t) => ({ title: t.title, priority: t.priority, due: iso(t.dueAt), estimateMin: t.estimateMin, status: t.status, category: t.categoryId })),
    appointments: expandEvents(events, now - DAY, now + 7 * DAY)
      .slice(0, 60)
      .map((o) => ({ title: o.event.title, start: iso(o.start), end: iso(o.end), originalZone: o.event.tz, important: o.event.important })),
  };
}
