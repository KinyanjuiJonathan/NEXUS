import type { Occurrence, Task } from "@/data/types";

/**
 * Snapping for dragging blocks on the calendar. A block being moved is drawn
 * to the start or end of a neighbouring block when it comes close (so tasks
 * line up back to back without overlapping by accident), otherwise to the
 * quarter hour. Holding Alt turns both off for minute-exact placement.
 */

const MIN = 60_000;

export interface SnapOptions {
  /** Other blocks' starts and ends that an edge being resized can snap to. */
  boundaries: number[];
  /** For a move: the block's end snaps to other blocks' starts, and its start to their ends, so blocks sit back to back and never overlap by snapping. Default: `boundaries` for both. */
  starts?: number[];
  ends?: number[];
  /** Local midnight of the day being dropped on: grid lines are counted from it. */
  dayStart: number;
  gridMs?: number;
  /** How close (ms) a boundary has to be to pull the block in. */
  thresholdMs?: number;
  /** Alt held: no snapping, to the minute. */
  free?: boolean;
}

const toGrid = (t: number, dayStart: number, grid: number) => dayStart + Math.round((t - dayStart) / grid) * grid;

function nearest(t: number, boundaries: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const b of boundaries) if (Math.abs(b - t) <= threshold && (best == null || Math.abs(b - t) < Math.abs(best - t))) best = b;
  return best;
}

/** Where a block of `dur` lands when its start is dragged to `start`. `guide` is the boundary it snapped to, if any. */
export function snapMove(start: number, dur: number, o: SnapOptions): { start: number; end: number; guide: number | null } {
  const grid = o.gridMs ?? 15 * MIN;
  if (o.free) {
    const s = toGrid(start, o.dayStart, MIN);
    return { start: s, end: s + dur, guide: null };
  }
  const threshold = o.thresholdMs ?? 10 * MIN;
  const byStart = nearest(start, o.ends ?? o.boundaries, threshold);
  const byEnd = nearest(start + dur, o.starts ?? o.boundaries, threshold);
  // whichever edge is closer to a neighbour wins
  if (byStart != null && (byEnd == null || Math.abs(byStart - start) <= Math.abs(byEnd - (start + dur)))) return { start: byStart, end: byStart + dur, guide: byStart };
  if (byEnd != null) return { start: byEnd - dur, end: byEnd, guide: byEnd };
  const s = toGrid(start, o.dayStart, grid);
  return { start: s, end: s + dur, guide: null };
}

/** Where one edge lands when it is dragged to `t` (resizing). */
export function snapEdge(t: number, o: SnapOptions): { t: number; guide: number | null } {
  if (o.free) return { t: toGrid(t, o.dayStart, MIN), guide: null };
  const b = nearest(t, o.boundaries, o.thresholdMs ?? 10 * MIN);
  return b != null ? { t: b, guide: b } : { t: toGrid(t, o.dayStart, o.gridMs ?? 15 * MIN), guide: null };
}

/** done: its task is complete. overdue: its time passed with the task open. worked: time clocked in full, waiting to be marked complete. */
export type OccStatus = "done" | "overdue" | "worked" | "now" | "past" | "upcoming";

export function occStatus(o: Occurrence, task: Task | undefined, now: number): OccStatus {
  if (task?.status === "done") return "done";
  if (o.start <= now && o.end > now) return "now";
  if (o.end <= now) {
    if (task && !task.deletedAt && !o.recurring) return o.event.sched?.attention === "worked" ? "worked" : "overdue";
    return "past";
  }
  return "upcoming";
}
