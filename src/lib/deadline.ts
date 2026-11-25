import type { Task } from "@/data/types";
import { humanDuration } from "./countdown";

/**
 * How close a task is to its deadline, as one of four levels that every
 * screen shows the same way (colour and motion):
 *   near   due within a day
 *   close  due within two hours, or its planned time ends after the deadline
 *   late   the deadline has passed
 */
export type Heat = "none" | "near" | "close" | "late";

export const NEAR_MS = 24 * 3600_000;
export const CLOSE_MS = 2 * 3600_000;

export interface HeatInfo {
  heat: Heat;
  /** Time to the deadline (negative once it has passed). */
  remaining: number;
  /** 0 → 1 as the last day before the deadline runs out. */
  burn: number;
  /** The time reserved for the task ends after its deadline. */
  atRisk: boolean;
  label: string;
}

const NONE: HeatInfo = { heat: "none", remaining: Infinity, burn: 0, atRisk: false, label: "" };

/** `plannedEnd`: when the last time reserved for the task ends, if it has any. */
export function deadlineHeat(task: Pick<Task, "status" | "dueAt" | "deletedAt" | "archivedAt"> | undefined, now: number, plannedEnd?: number | null): HeatInfo {
  if (!task || task.status === "done" || task.deletedAt || task.archivedAt || task.dueAt == null) return NONE;
  const remaining = task.dueAt - now;
  const atRisk = remaining >= 0 && plannedEnd != null && plannedEnd > task.dueAt;
  const heat: Heat = remaining < 0 ? "late" : remaining <= CLOSE_MS || atRisk ? "close" : remaining <= NEAR_MS ? "near" : "none";
  if (heat === "none") return { ...NONE, remaining };
  const label = remaining < 0 ? `${humanDuration(remaining)} late` : atRisk && remaining > CLOSE_MS ? `Planned past its deadline · ${humanDuration(remaining)} left` : `${humanDuration(remaining)} left`;
  return { heat, remaining, burn: Math.min(1, Math.max(0, 1 - remaining / NEAR_MS)), atRisk, label };
}

export const HEAT_COLOR: Record<Heat, string> = { none: "var(--muted)", near: "var(--warning)", close: "#fb7a2c", late: "var(--danger)" };
export const HEAT_CLASS: Record<Heat, string> = { none: "", near: "heat heat-near", close: "heat heat-close", late: "heat heat-late" };

/** When the last live time reserved for each task ends. */
export function plannedEnds(events: { taskId: string | null; endAt: number; deletedAt: number | null; recurrence?: unknown }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (!e.taskId || e.deletedAt || e.recurrence) continue;
    out.set(e.taskId, Math.max(out.get(e.taskId) ?? 0, e.endAt));
  }
  return out;
}

/** The open tasks that are heating up, most urgent first. */
export function hotTasks<T extends Task>(tasks: T[], events: Parameters<typeof plannedEnds>[0], now: number): { task: T; info: HeatInfo }[] {
  const ends = plannedEnds(events);
  return tasks
    .map((task) => ({ task, info: deadlineHeat(task, now, ends.get(task.id)) }))
    .filter((x) => x.info.heat !== "none")
    .sort((a, b) => a.info.remaining - b.info.remaining);
}
