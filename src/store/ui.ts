import { create } from "zustand";
import type { MissedItem } from "@/lib/schedule";

export type View = "dashboard" | "tasks" | "calendar" | "focus" | "clocks" | "assistant" | "insights" | "history" | "typer" | "accounts" | "settings";

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
  /** Raised to start ambient mode now (the preview button in Settings). */
  ambientPreview: number;
  previewAmbient(): void;
  openTask(taskId: string | null, defaults?: UIState["taskEditor"]["defaults"]): void;
  closeTask(): void;
  openEvent(eventId: string | null, draft?: EventDraft, occurrenceStart?: number): void;
  closeEvent(): void;
  openCommand(listen?: boolean, initial?: string): void;
  closeCommand(): void;
  openReschedule(item: MissedItem | null): void;
}

const VIEW_KEY = "nexus.view";
const VIEWS: View[] = ["dashboard", "tasks", "calendar", "focus", "clocks", "assistant", "insights", "history", "typer", "accounts", "settings"];
/** The page that was open last time, so closing and reopening NEXUS (for an update, say) comes back to the same place. */
function lastView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY) as View | null;
    return v && VIEWS.includes(v) ? v : "dashboard";
  } catch {
    return "dashboard";
  }
}
/** Ambient mode moves between pages by itself; those moves are not the user's place and are not remembered. */
let remember = true;
export const rememberView = (on: boolean) => {
  remember = on;
};

export const useUI = create<UIState>((set) => ({
  view: lastView(),
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
  setView: (view) => {
    set({ view });
    if (!remember) return;
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* not essential */
    }
  },
  ambientPreview: 0,
  previewAmbient: () => set((s) => ({ ambientPreview: s.ambientPreview + 1 })),
  openTask: (taskId, defaults) => set({ taskEditor: { open: true, taskId, defaults } }),
  closeTask: () => set((s) => ({ taskEditor: { ...s.taskEditor, open: false } })),
  openEvent: (eventId, draft, occurrenceStart) => set({ eventEditor: { open: true, eventId, draft, occurrenceStart } }),
  closeEvent: () => set((s) => ({ eventEditor: { ...s.eventEditor, open: false } })),
  openCommand: (listen = false, initial) => set({ command: { open: true, listen, initial } }),
  closeCommand: () => set({ command: { open: false, listen: false } }),
  openReschedule: (reschedule) => set({ reschedule }),
}));
