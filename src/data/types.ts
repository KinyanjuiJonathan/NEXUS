import type { TyperOptions } from "@/lib/typer/engine";
/**
 * NEXUS domain model.
 *
 * All instants are stored as UTC epoch milliseconds. Anything that has a
 * "wall clock" meaning (deadlines, appointments) also stores the IANA zone the
 * user entered it in, so the original intent is preserved (e.g. "3 PM Texas
 * time" stays 3 PM Texas time even across DST changes of a recurring rule).
 * These shapes mirror the Rust structs in src-tauri/core/src/models.rs.
 */

export type Priority = "critical" | "high" | "medium" | "low";
export const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];

export type TaskStatus = "todo" | "in_progress" | "done";

export type Frequency = "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

export interface RecurrenceRule {
  freq: Frequency;
  /** Repeat every N units (default 1). */
  interval: number;
  /** For weekly: ISO weekdays 1 (Mon) … 7 (Sun). Empty = same weekday as start. */
  byWeekday?: number[];
  /** Stop after this instant (inclusive), epoch ms. */
  until?: number | null;
  /** Stop after this many occurrences. */
  count?: number | null;
  /** Occurrence starts (epoch ms) that were removed/detached from the series. */
  exdates?: number[];
}

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  priority: Priority;
  categoryId: string;
  status: TaskStatus;
  /** Deadline (UTC ms) or null. */
  dueAt: number | null;
  /** IANA zone the deadline was entered in. */
  dueTz: string | null;
  /** Estimated duration in minutes. */
  estimateMin: number | null;
  /** Total tracked time in ms (from focus timers). */
  spentMs: number;
  sortOrder: number;
  recurrence: RecurrenceRule | null;
  /** Reminder offsets in minutes before dueAt (0 = at time). */
  reminders: number[];
  subtasks: Subtask[];
  completedAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  icon: string;
  builtin: boolean;
  sortOrder: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  notes: string;
  startAt: number;
  endAt: number;
  /** The zone the appointment was created in (preserved). */
  tz: string;
  taskId: string | null;
  recurrence: RecurrenceRule | null;
  /** Important appointments are never moved without explicit confirmation. */
  important: boolean;
  reminders: number[];
  color: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** A concrete occurrence of an event (recurring series are expanded). */
export interface Occurrence {
  event: CalendarEvent;
  start: number;
  end: number;
  /** Original series start for this occurrence (used for exdates). */
  seriesStart: number;
  recurring: boolean;
}

export type TimerKind = "countdown" | "stopwatch" | "pomodoro";
export type TimerState = "idle" | "running" | "paused" | "finished";
export type PomodoroPhase = "focus" | "short_break" | "long_break";

export interface Timer {
  id: string;
  kind: TimerKind;
  label: string;
  taskId: string | null;
  /** Total duration for countdown/pomodoro phase, ms (0 for stopwatch). */
  durationMs: number;
  /** When the current run segment started (UTC ms) — null if not running. */
  startedAt: number | null;
  /** Elapsed time accumulated in previous segments, ms. */
  accumulatedMs: number;
  state: TimerState;
  phase: PomodoroPhase | null;
  /** Completed focus cycles (pomodoro). */
  cycle: number;
  createdAt: number;
  updatedAt: number;
}

export interface FocusSession {
  id: string;
  taskId: string | null;
  kind: TimerKind;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface ReminderItem {
  id: string;
  ownerKind: "task" | "event" | "timer" | "custom";
  ownerId: string;
  title: string;
  body: string;
  fireAt: number;
  firedAt: number | null;
  snoozedUntil: number | null;
  dismissedAt: number | null;
}

export interface WorkPause {
  start: number;
  /** null while the pause is ongoing. */
  end: number | null;
  reason: "idle" | "manual";
  /** Timers that were paused together with the clock (resumed with it). */
  timerIds?: string[];
}

/** A clock-in period. */
export interface WorkSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  pauses: WorkPause[];
  note: string;
  createdAt: number;
  updatedAt: number;
}

export type ActivityKind =
  | "task_created"
  | "task_completed"
  | "task_reopened"
  | "task_deleted"
  | "task_restored"
  | "task_rescheduled"
  | "event_created"
  | "event_moved"
  | "event_deleted"
  | "focus"
  | "clock_in"
  | "clock_out"
  | "auto_paused"
  | "paused"
  | "resumed"
  | "auto_planned";

/** One entry of the history of what has been done. */
export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  title: string;
  detail: string;
  refId: string | null;
}

export type OverlayMode = "mini" | "standard" | "expanded";
/** A system metric that can be charted over time. */
export type PerfMetric = "cpu" | "ram" | "gpu" | "vram" | "fps" | "temp";
/** America/Denver = Mountain time used by El Paso (tzdb has no America/El_Paso). */
export type TexasZone = "America/Chicago" | "America/Denver";
export type ThemeMode = "dark" | "light" | "system";

export interface Settings {
  theme: ThemeMode;
  hour12: boolean;
  texasZone: TexasZone;
  /** Zone used when a time is entered without an explicit zone. */
  homeZone: string;
  workStartHour: number;
  workEndHour: number;
  /** ISO weekdays considered working days. */
  workDays: number[];
  defaultReminders: number[];
  notificationSound: boolean;
  snoozeMinutes: number;
  pomodoroFocusMin: number;
  pomodoroShortBreakMin: number;
  pomodoroLongBreakMin: number;
  pomodoroLongEvery: number;
  deadlineWarningMin: number;
  calendarDisplayZone: "local" | "kenya" | "texas";
  activeTaskId: string | null;
  overlayMode: OverlayMode;
  overlayOpacity: number;
  overlayPinned: boolean;
  overlayClickThrough: boolean;
  overlaySizes: Partial<Record<OverlayMode, { w: number; h: number }>>;
  overlayOnStartup: boolean;
  /** Show CPU / GPU / VRAM / RAM in the overlay. */
  overlayPerf: boolean;
  /** Also measure FPS of the foreground app (needs ETW permission on Windows). */
  overlayFps: boolean;
  /** When false, click-through can't be turned on at all (button, shortcut and tray). */
  overlayAllowClickThrough: boolean;
  /** Show CPU/GPU temperature in the overlay. */
  overlayTemp: boolean;
  tempUnit: "C" | "F";
  /** Show the live performance graph in the overlay. */
  overlayGraph: boolean;
  /** Which metric the performance graph follows. */
  perfGraphMetric: PerfMetric;
  /** Show the system monitor card on the dashboard. */
  dashboardPerf: boolean;
  /** Auto Typer options (the text itself is kept separately). */
  typer: TyperOptions;
  /** Minutes without keyboard/mouse input before the work clock auto-pauses. */
  idleMinutes: number;
  /** Resume automatically when activity returns after an auto-pause. */
  idleAutoResume: boolean;
  /** Also pause running focus timers when idle. */
  idlePauseTimers: boolean;
  /** Automatically reserve a time block for new tasks that have an estimate. */
  autoPlaceNewTasks: boolean;
  /** Gap kept around planned blocks (minutes). */
  planBufferMin: number;
  /** Longest single block the planner creates (minutes); longer tasks are split. */
  planChunkMaxMin: number;
  closeToTray: boolean;
  startMinimized: boolean;
  shortcuts: Shortcuts;
  voiceEngine: "auto" | "native" | "web" | "keyboard";
  voiceLanguage: string;
  aiEnabled: boolean;
  aiConsent: boolean;
  aiModel: string;
  reducedMotion: boolean;
  onboarded: boolean;
}

export interface Shortcuts {
  toggleOverlay: string;
  toggleClickThrough: string;
  quickAdd: string;
  voice: string;
  showMain: string;
  toggleTyper: string;
}

export const DEFAULT_SHORTCUTS: Shortcuts = {
  toggleOverlay: "CommandOrControl+Shift+Space",
  toggleClickThrough: "CommandOrControl+Shift+X",
  quickAdd: "CommandOrControl+Shift+N",
  voice: "CommandOrControl+Shift+V",
  showMain: "CommandOrControl+Shift+H",
  toggleTyper: "F6",
};

export interface Snapshot {
  tasks: Task[];
  categories: Category[];
  events: CalendarEvent[];
  timers: Timer[];
  focusSessions: FocusSession[];
  settings: Partial<Settings>;
  workSessions?: WorkSession[];
  activity?: ActivityEntry[];
}

export const BUILTIN_CATEGORIES: Category[] = [
  { id: "work", name: "Work", color: "#38bdf8", icon: "briefcase", builtin: true, sortOrder: 0 },
  { id: "personal", name: "Personal", color: "#a78bfa", icon: "user", builtin: true, sortOrder: 1 },
  { id: "projects", name: "Projects", color: "#22d3ee", icon: "folder", builtin: true, sortOrder: 2 },
  { id: "meetings", name: "Meetings", color: "#f472b6", icon: "users", builtin: true, sortOrder: 3 },
];
