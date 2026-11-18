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
  setView: (view) => set({ view }),
  openTask: (taskId, defaults) => set({ taskEditor: { open: true, taskId, defaults } }),
  closeTask: () => set((s) => ({ taskEditor: { ...s.taskEditor, open: false } })),
  openEvent: (eventId, draft, occurrenceStart) => set({ eventEditor: { open: true, eventId, draft, occurrenceStart } }),
  closeEvent: () => set((s) => ({ eventEditor: { ...s.eventEditor, open: false } })),
  openCommand: (listen = false, initial) => set({ command: { open: true, listen, initial } }),
  closeCommand: () => set({ command: { open: false, listen: false } }),
  openReschedule: (reschedule) => set({ reschedule }),
}));
