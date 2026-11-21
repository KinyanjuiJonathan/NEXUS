import { DateTime } from "luxon";
import { workWindows } from "@/lib/workPlan";
import type { CalendarEvent, Priority, Task } from "@/data/types";
import { expandEvents, mergeIntervals, type Interval, type WorkingHours, MIN, DAY } from "./schedule";

/**
 * Auto-placement: fit open tasks into free working time.
 *
 * - Only working hours/days (in the home zone) are used, from "now" onwards.
 * - Existing appointments and already-planned blocks are respected, with a buffer.
 * - Tasks are placed earliest-deadline first, then by priority; long tasks are
 *   split into blocks of at most `chunkMaxMin` (never smaller than `minChunkMin`
 *   unless that is all that's left).
 * - Tasks that already have an upcoming time block are skipped.
 * - Nothing is written here: the caller shows a preview and applies it.
 */

export interface PlanOptions {
  /** Which task is placed first. Without it: nearest deadline, then priority. */
  order?: "fifo" | "priority" | "shortest" | "deadline";
  horizonDays?: number;
  bufferMin?: number;
  chunkMaxMin?: number;
  minChunkMin?: number;
  defaultEstimateMin?: number;
  /** Restrict planning to these task ids. */
  onlyTaskIds?: string[];
}

export interface PlanBlock {
  taskId: string;
  title: string;
  start: number;
  end: number;
  part: number;
  parts: number;
  /** Ends after the task's deadline. */
  late: boolean;
}

export interface PlanResult {
  blocks: PlanBlock[];
  unplaced: { taskId: string; title: string; minutesLeft: number; reason: string }[];
  lateTaskIds: string[];
  /** Free working minutes in the horizon before planning. */
  freeMinutes: number;
}

const PW: Record<Priority, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Free intervals inside working hours between `from` and `from + horizonDays`. */
export function freeWorkingIntervals(events: CalendarEvent[], from: number, wh: WorkingHours, horizonDays: number, bufferMs: number): Interval[] {
  const align = 5 * MIN;
  const start = Math.ceil(from / align) * align;
  const end = DateTime.fromMillis(from, { zone: wh.zone }).startOf("day").plus({ days: horizonDays + 1 }).toMillis();
  const busy = mergeIntervals(expandEvents(events, from - DAY, end + DAY).map((o) => ({ start: o.start - bufferMs, end: o.end + bufferMs })));
  const out: Interval[] = [];
  for (const win of workWindows(from, end, wh)) {
    let ws = Math.max(win.start, start);
    const we = Math.min(win.end, end);
    if (we <= ws) continue;
    for (const b of busy) {
      if (b.end <= ws || b.start >= we) continue;
      if (b.start > ws) out.push({ start: ws, end: b.start });
      ws = Math.max(ws, Math.ceil(b.end / align) * align);
      if (ws >= we) break;
    }
    if (ws < we) out.push({ start: ws, end: we });
  }
  return out.filter((i) => i.end - i.start >= 5 * MIN);
}

export function hasUpcomingBlock(taskId: string, events: CalendarEvent[], now: number): boolean {
  return events.some((e) => !e.deletedAt && e.taskId === taskId && e.endAt > now);
}

export function planTasks(tasks: Task[], events: CalendarEvent[], wh: WorkingHours, now: number, opts: PlanOptions = {}): PlanResult {
  const { horizonDays = 14, bufferMin = 10, chunkMaxMin = 120, minChunkMin = 25, defaultEstimateMin = 30, onlyTaskIds } = opts;
  const bufferMs = bufferMin * MIN;
  const gaps = freeWorkingIntervals(events, now, wh, horizonDays, bufferMs);
  const freeMinutes = Math.round(gaps.reduce((a, g) => a + g.end - g.start, 0) / MIN);

  const candidates = tasks
    .filter((t) => !t.deletedAt && !t.archivedAt && t.status !== "done")
    .filter((t) => !onlyTaskIds || onlyTaskIds.includes(t.id))
    .filter((t) => !hasUpcomingBlock(t.id, events, now))
    .sort(
      opts.order === "fifo"
        ? (a, b) => a.createdAt - b.createdAt || a.sortOrder - b.sortOrder
        : opts.order === "priority"
          ? (a, b) => PW[b.priority] - PW[a.priority] || a.createdAt - b.createdAt
          : opts.order === "shortest"
            ? (a, b) => (a.estimateMin ?? defaultEstimateMin) - (b.estimateMin ?? defaultEstimateMin) || a.createdAt - b.createdAt
            : (a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || PW[b.priority] - PW[a.priority] || a.sortOrder - b.sortOrder,
    );

  const blocks: PlanBlock[] = [];
  const unplaced: PlanResult["unplaced"] = [];
  const late = new Set<string>();

  for (const t of candidates) {
    const est = t.estimateMin ?? defaultEstimateMin;
    let need = Math.max(15, Math.ceil((est * MIN - t.spentMs) / (5 * MIN)) * 5) * MIN;
    const mine: PlanBlock[] = [];
    for (let i = 0; i < gaps.length && need > 0; i++) {
      const g = gaps[i];
      const len = g.end - g.start;
      let take = Math.min(need, chunkMaxMin * MIN, len);
      // Avoid fragments: a block must be at least minChunk unless it finishes the task…
      if (take < Math.min(minChunkMin * MIN, need)) continue;
      // …and must not leave a leftover smaller than minChunk (e.g. 40 + 5 min).
      const remainder = need - take;
      if (remainder > 0 && remainder < minChunkMin * MIN) {
        take = need - minChunkMin * MIN;
        if (take < minChunkMin * MIN) continue;
      }
      const block = { start: g.start, end: g.start + take };
      mine.push({ taskId: t.id, title: t.title, ...block, part: 0, parts: 0, late: t.dueAt != null && block.end > t.dueAt });
      need -= take;
      // Consume the gap (plus buffer after the block).
      const rest = { start: block.end + bufferMs, end: g.end };
      if (rest.end - rest.start >= 5 * MIN) gaps[i] = rest;
      else gaps.splice(i, 1);
      i--; // revisit this position: the remainder of the same gap comes first

    }
    mine.forEach((b, i) => {
      b.part = i + 1;
      b.parts = mine.length;
      if (b.late) late.add(t.id);
    });
    blocks.push(...mine);
    if (need > 0) unplaced.push({ taskId: t.id, title: t.title, minutesLeft: Math.round(need / MIN), reason: `Not enough free working time in the next ${horizonDays} days` });
  }
  return { blocks: blocks.sort((a, b) => a.start - b.start), unplaced, lateTaskIds: [...late], freeMinutes };
}
