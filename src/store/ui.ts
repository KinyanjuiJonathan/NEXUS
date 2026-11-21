import { create } from "zustand";
import type { MissedItem } from "@/lib/schedule";

export type View = "dashboard" | "tasks" | "calendar" | "focus" | "clocks" | "assistant" | "insights" | "history" | "typer" | "settings";

export interface EventDraft {
  startAt: number;
  endAt: number;
  taskId?: string | null;
  title?: string;
}

interface UIState {
  view: View;
  taskEditor: { open: boolean; taskId: string | null; defaults?: { dueAt?: number | null; categoryId?: string } };
  eventEditor: { open: boolean; eventId: string | null; draft?: EventDraft; occurrenceStart?: number };
  command: { open: boolean; listen: boolean; initial?: string };
  reschedule: MissedItem | null;
  autoPlan: boolean;
  rescheduleAll: boolean;
  /** "When do you intend to work?" dialog, and until when it should not open by itself. */
  workPlan: boolean;
  workPlanSnooze: number;
  /** Time zone & working hours panel. */
  timeHours: boolean;
  /** Daily routine editor. */
  routine: boolean;
  openRoutine(open: boolean): void;
  openTimeHours(open: boolean): void;
  openWorkPlan(open: boolean): void;
  snoozeWorkPlan(until: number): void;
  openRescheduleAll(open: boolean): void;
  openAutoPlan(open: boolean): void;
  setView(v: View): void;
  openTask(taskId: string | null, defaults?: UIState["taskEditor"]["defaults"]): void;
  closeTask(): void;
  openEvent(eventId: string | null, draft?: EventDraft, occurrenceStart?: number): void;
  closeEvent(): void;
  openCommand(listen?: boolean, initial?: string): void;
  closeCommand(): void;
  openReschedule(item: MissedItem | null): void;
}

export const useUI = create<UIState>((set) => ({
  view: "dashboard",
  taskEditor: { open: false, taskId: null },
  eventEditor: { open: false, eventId: null },
  command: { open: false, listen: false },
  reschedule: null,
  autoPlan: false,
  openAutoPlan: (autoPlan) => set({ autoPlan }),
  rescheduleAll: false,
  workPlan: false,
  workPlanSnooze: 0,
  timeHours: false,
  routine: false,
  openRoutine: (routine) => set({ routine }),
  openTimeHours: (timeHours) => set({ timeHours }),
  openWorkPlan: (workPlan) => set({ workPlan }),
  snoozeWorkPlan: (workPlanSnooze) => set({ workPlanSnooze }),
  openRescheduleAll: (rescheduleAll) => set({ rescheduleAll }),
  setView: (view) => set({ view }),
  openTask: (taskId, defaults) => set({ taskEditor: { open: true, taskId, defaults } }),
  closeTask: () => set((s) => ({ taskEditor: { ...s.taskEditor, open: false } })),
  openEvent: (eventId, draft, occurrenceStart) => set({ eventEditor: { open: true, eventId, draft, occurrenceStart } }),
  closeEvent: () => set((s) => ({ eventEditor: { ...s.eventEditor, open: false } })),
  openCommand: (listen = false, initial) => set({ command: { open: true, listen, initial } }),
  closeCommand: () => set({ command: { open: false, listen: false } }),
  openReschedule: (reschedule) => set({ reschedule }),
}));
