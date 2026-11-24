import { createStore } from "zustand/vanilla";
import { DateTime } from "luxon";
import { DEFAULT_TYPER } from "@/lib/typer/engine";
import type { Backend } from "@/data/backend";
import {
  DEFAULT_SHORTCUTS,
  type ActivityEntry,
  type ActivityEvent,
  type ActivityKind,
  type WorkSession,
  type CalendarEvent,
  type Category,
  type FocusSession,
  type Occurrence,
  type Priority,
  type ReminderItem,
  type Settings,
  type Snapshot,
  type Task,
  type Timer,
  type TimerKind,
} from "@/data/types";
import { KENYA_ZONE, TEXAS_CENTRAL, localZone, normalizeZone } from "@/lib/time";
import { nextOccurrence } from "@/lib/recurrence";
import * as cd from "@/lib/countdown";
import { reminderForTimer, remindersForEvent, remindersForTask } from "@/lib/reminders";
import { activeSession, openPause } from "@/lib/work";
import { freeFrom, planPullForward, planBulk, planDisplaced, planMerges, planQueueOrder, planRipple, planUnfinished, queueUnits, sortedQueue, type BulkTarget, type Move, type RescheduleSettings, type UnitPlan } from "@/lib/smart/reschedule";
import { blockClock, currentBlock, unclockedMs } from "@/lib/taskClock";
import { dayKey, prunePlans, workHours, type DayPlan } from "@/lib/workPlan";
import { closeStraySessions } from "@/lib/work";
import { DEFAULT_ROUTINE, SLEEP_CHECK_MS, countAsSleep, isAdminTask, nextSleep, normalizeRoutine, postponeSleep } from "@/lib/routine";
import type { ScheduleRequest } from "@/lib/smart/parse";
import type { Interval } from "@/lib/schedule";
import { planTasks, type PlanBlock, type PlanOptions, type PlanResult } from "@/lib/planner";
import { humanDuration } from "@/lib/countdown";
import { formatTime, formatWithZone } from "@/lib/time";
import type { SchedOrder } from "@/data/types";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  hour12: true,
  texasZone: TEXAS_CENTRAL,
  homeZone: localZone(),
  workStartHour: 9,
  workEndHour: 17,
  // Every day can be a working day; the daily "when do you intend to work?" answer decides the hours.
  workDays: [1, 2, 3, 4, 5, 6, 7],
  workPlans: {},
  workWeek: {},
  updateAuto: true,
  lastVersion: null,
  previousVersion: null,
  routine: DEFAULT_ROUTINE,
  schedOrder: "fifo",
  workPlanAsk: true,
  workDayHours: 8,
  defaultReminders: [15, 0],
  notificationSound: true,
  snoozeMinutes: 10,
  pomodoroFocusMin: 25,
  pomodoroShortBreakMin: 5,
  pomodoroLongBreakMin: 15,
  pomodoroLongEvery: 4,
  deadlineWarningMin: 60,
  calendarDisplayZone: "local",
  activeTaskId: null,
  overlayMode: "standard",
  overlayOpacity: 0.86,
  overlayPinned: true,
  overlayClickThrough: false,
  overlaySizes: {},
  overlayOnStartup: false,
  overlayPerf: true,
  overlayFps: true,
  overlayAllowClickThrough: true,
  overlayTemp: true,
  tempUnit: "C",
  overlayGraph: false,
  perfGraphMetric: "cpu",
  dashboardPerf: true,
  typer: DEFAULT_TYPER,
  smartEnabled: true,
  smartAutoReschedule: true,
  smartZone: "home",
  smartProtectFixed: true,
  smartNotify: true,
  smartPeriods: { morning: [6, 12], afternoon: [12, 17], evening: [17, 22] },
  perfThresholds: { cpu: { elevated: 60, high: 80 } },
  workAuto: true,
  workAutoHoldDay: null,
  typerIdleReturn: true,
  typerIdleReturnMin: 5,
  idleMinutes: 1,
  idleAutoResume: true,
  idlePauseTimers: true,
  autoPlaceNewTasks: true,
  planBufferMin: 10,
  planChunkMaxMin: 120,
  closeToTray: true,
  startMinimized: true,
  shortcuts: DEFAULT_SHORTCUTS,
  voiceEngine: "auto",
  voiceLanguage: "en-US",
  aiEnabled: false,
  aiConsent: false,
  aiModel: "claude-opus-5-5",
  reducedMotion: false,
  onboarded: false,
};

/** Absences at least this long pause focus timers and are mentioned to the user. */
const LONG_AWAY_MS = 5 * 60_000;
/** A heartbeat older than this at start-up means NEXUS was not running in between. */
const RESTART_GAP_MS = 90_000;

export type ToastKind = "info" | "success" | "warning" | "error" | "reminder";
export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
  reminder?: ReminderItem;
  ttl?: number;
}

export type NewTask = Partial<Omit<Task, "id" | "createdAt" | "updatedAt">> & { title: string };
export type NewEvent = Partial<Omit<CalendarEvent, "id" | "createdAt" | "updatedAt">> & {
  title: string;
  startAt: number;
  endAt: number;
};

export interface NexusState {
  ready: boolean;
  error: string | null;
  tasks: Task[];
  categories: Category[];
  events: CalendarEvent[];
  timers: Timer[];
  focusSessions: FocusSession[];
  settings: Settings;
  toasts: Toast[];
  workSessions: WorkSession[];
  activity: ActivityEntry[];

  init(): Promise<void>;
  reload(): Promise<void>;

  // tasks
  addTask(input: NewTask, opts?: { autoPlace?: boolean }): Promise<Task>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task | null>;
  setTaskDone(id: string, done: boolean): Promise<void>;
  /**
   * Move a task to the trash, together with the calendar time reserved for it.
   * For a repeating task, "occurrence" removes only this one and schedules the
   * next; "series" (the default) ends the repetition.
   */
  deleteTask(id: string, scope?: "occurrence" | "series"): Promise<void>;
  restoreTask(id: string): Promise<void>;
  purgeTask(id: string): Promise<void>;
  emptyTrash(): Promise<void>;
  archiveTask(id: string, archived: boolean): Promise<void>;
  archiveCompleted(): Promise<number>;
  reorderTasks(ids: string[]): Promise<void>;
  setActiveTask(id: string | null): Promise<void>;

  // categories
  saveCategory(c: Category): Promise<void>;
  deleteCategory(id: string): Promise<void>;

  // events
  addEvent(input: NewEvent): Promise<CalendarEvent>;
  updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent | null>;
  deleteEvent(id: string): Promise<void>;
  restoreEvent(id: string): Promise<void>;
  /** Move one occurrence of an event. For a series, scope chooses this-occurrence vs whole series. */
  moveOccurrence(occ: Occurrence, newStart: number, newEnd: number, scope: "single" | "series"): Promise<void>;

  // timers
  startTimer(opts: { kind: TimerKind; minutes?: number; taskId?: string | null; label?: string }): Promise<Timer>;
  pauseTimer(id: string, at?: number): Promise<void>;
  resumeTimer(id: string): Promise<void>;
  resetTimer(id: string): Promise<void>;
  stopTimer(id: string): Promise<void>;
  removeTimer(id: string): Promise<void>;
  /** Pomodoro: end the current phase now and move to the next one (not started). */
  skipPhase(id: string): Promise<void>;
  /** Called every second by the main window: finishes expired timers. */
  processTimers(now?: number): Promise<void>;
  activeTimer(): Timer | null;

  // settings
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;

  // work clock & history
  clockIn(): Promise<void>;
  clockOut(): Promise<void>;
  pauseWork(): Promise<void>;
  resumeWork(): Promise<void>;
  /** Feed the system idle time; auto-pauses/resumes per settings (used where the native activity monitor is unavailable). */
  handleIdle(idleSeconds: number): Promise<void>;
  /** Apply an away / back report from the native activity monitor. Reports are handled strictly in order. */
  handleActivity(event: ActivityEvent): Promise<void>;
  log(kind: ActivityKind, title: string, detail?: string, refId?: string | null): void;

  // planning
  autoPlan(opts?: PlanOptions): PlanResult;
  applyPlan(blocks: PlanBlock[]): Promise<CalendarEvent[]>;

  // smart scheduling
  /** Settings the slot finder and the automatic rescheduler work from. */
  slotSettings(): RescheduleSettings;
  /**
   * Put an understood request on the calendar at `slot`: a fixed appointment,
   * or a To-Do task with a flexible block of time reserved for it.
   */
  smartCreate(req: ScheduleRequest, slot: Interval, durationMin: number, opts?: { existingTaskId?: string | null }): Promise<{ task: Task | null; event: CalendarEvent }>;
  /**
   * Move flexible blocks whose time passed while their task is still open to
   * the next suitable free time. Never completes a task and never touches a
   * fixed appointment. Returns what it decided.
   */
  autoReschedule(): Promise<Move[]>;
  /** Move every open task's reserved time at once: later by a set amount, or starting again from a moment. Fixed appointments stay. */
  rescheduleAll(target: BulkTarget, opts?: { title?: string; quiet?: boolean; note?: string; since?: CalendarEvent[] }): Promise<Move[]>;
  /** A long absence the user may have slept through, waiting for their answer. */
  sleepCheck: { from: number; to: number } | null;
  /** Answer the question about a long absence: it was sleep, sleep and breakfast, or neither. */
  answerSleepCheck(answer: "sleep" | "sleep+breakfast" | "no"): Promise<void>;
  /** Once a minute: while the user is still working, sleep that is due moves later. Returns the new sleep start, if it moved. */
  adaptRoutine(): Promise<number | null>;
  /** The day begins: admin and planning tasks go to the front of the queue and everything is fitted into the day as it now looks. */
  startDay(note?: string): Promise<void>;
  /** Move a task one place up (-1) or down (+1) the queue of upcoming flexible tasks. False when it cannot move. */
  moveInQueue(eventId: string, dir: -1 | 1): Promise<boolean>;
  /** Put the queue of upcoming flexible tasks in this order (task ids). Each position keeps its start time; later tasks follow. */
  reorderQueue(taskIds: string[]): Promise<boolean>;
  /** Join split tasks back into one block wherever their whole length now fits. Returns how many were joined. */
  mergeSplitTasks(): Promise<number>;
  /** "I was working": count the time the clock skipped during this task's block (inactivity, or not being clocked in). Returns the ms counted. */
  countAway(eventId: string): Promise<number>;
  /** Move a task's block later (or earlier) by exactly this much; the tasks after it are pushed along in order. */
  shiftTask(eventId: string, byMs: number): Promise<boolean>;
  /** Start this queued task now. The task under way gives up its place: what is left of it follows straight after. */
  startTaskNow(taskId: string): Promise<boolean>;
  /** Reorganise the queue by a scheduling order (the one in Settings when none is given). */
  sortQueue(order?: SchedOrder): Promise<boolean>;
  /** Say when you intend to work on a day (ISO date in the home zone): hours, a day off, or null to forget the answer. */
  setWorkPlan(day: string, plan: DayPlan | null): Promise<void>;
  /** Empty the history log. Tasks, appointments, work sessions and statistics are kept. */
  clearHistory(): Promise<void>;

  // reminders
  resyncAllReminders(): Promise<void>;
  snoozeReminder(r: ReminderItem, minutes?: number): Promise<void>;
  dismissReminder(r: ReminderItem): Promise<void>;

  // toasts
  toast(t: Omit<Toast, "id">): string;
  dismissToast(id: string): void;
}

export interface StoreDeps {
  backend: Backend;
  now?: () => number;
  id?: () => string;
}

function mergeSettings(raw: Partial<Settings>): Settings {
  const s = { ...DEFAULT_SETTINGS, ...raw, shortcuts: { ...DEFAULT_SHORTCUTS, ...(raw.shortcuts ?? {}) }, typer: { ...DEFAULT_TYPER, ...(raw.typer ?? {}) },
    smartPeriods: { ...DEFAULT_SETTINGS.smartPeriods, ...(raw.smartPeriods ?? {}) },
    perfThresholds: { cpu: { ...DEFAULT_SETTINGS.perfThresholds.cpu, ...(raw.perfThresholds?.cpu ?? {}) } },
  };
  // Accept the legacy/alias "America/El_Paso" and guard against invalid zones.
  s.texasZone = normalizeZone(s.texasZone, TEXAS_CENTRAL) as Settings["texasZone"];
  if (s.texasZone !== "America/Chicago" && s.texasZone !== "America/Denver") s.texasZone = TEXAS_CENTRAL;
  s.homeZone = normalizeZone(s.homeZone, localZone());
  s.routine = normalizeRoutine(raw.routine);
  return s;
}

export function createNexusStore({ backend, now = () => Date.now(), id = () => crypto.randomUUID() }: StoreDeps) {
  const store = createStore<NexusState>()((set, get) => {
    const fail = (e: unknown, what: string) => {
      const msg = e instanceof Error ? e.message : String(e);
      get().toast({ kind: "error", title: `Couldn't ${what}`, body: msg });
      throw e;
    };

    const syncTask = async (t: Task) => {
      const items = remindersForTask(t, now(), get().settings.hour12);
      try {
        if (items.length) await backend.syncReminders("task", t.id, items);
        else await backend.clearReminders("task", t.id);
      } catch {
        /* reminder sync failure must not block saving */
      }
    };
    const syncEvent = async (e: CalendarEvent) => {
      const items = remindersForEvent(e, now(), get().settings.hour12);
      try {
        if (items.length) await backend.syncReminders("event", e.id, items);
        else await backend.clearReminders("event", e.id);
      } catch {
        /* ignore */
      }
    };
    const syncTimer = async (t: Timer) => {
      try {
        const items = reminderForTimer(t, now());
        if (items.length) await backend.syncReminders("timer", t.id, items);
        else await backend.clearReminders("timer", t.id);
      } catch {
        /* ignore */
      }
    };

    const saveTask = async (t: Task) => {
      set({ tasks: get().tasks.map((x) => (x.id === t.id ? t : x)) });
      try {
        await backend.upsertTask(t);
      } catch (e) {
        fail(e, "save the task");
      }
      await syncTask(t);
    };

    const saveTimer = async (t: Timer) => {
      set({ timers: get().timers.some((x) => x.id === t.id) ? get().timers.map((x) => (x.id === t.id ? t : x)) : [...get().timers, t] });
      await backend.upsertTimer(t);
      await syncTimer(t);
    };

    const saveEvent = async (e: CalendarEvent) => {
      set({ events: get().events.some((x) => x.id === e.id) ? get().events.map((x) => (x.id === e.id ? e : x)) : [...get().events, e] });
      try {
        await backend.upsertEvent(e);
      } catch (err) {
        fail(err, "save the appointment");
      }
      await syncEvent(e);
    };

    /** Log tracked time of a timer segment against its task and focus stats. */
    const logFocus = async (t: Timer, elapsed: number) => {
      if (elapsed < 30_000) return;
      if (t.kind === "pomodoro" && t.phase !== "focus") return;
      const end = now();
      const s: FocusSession = { id: id(), taskId: t.taskId, kind: t.kind, startedAt: end - elapsed, endedAt: end, durationMs: elapsed };
      set({ focusSessions: [...get().focusSessions, s] });
      await backend.addFocus(s);
      const task = t.taskId ? get().tasks.find((x) => x.id === t.taskId) : undefined;
      get().log("focus", task?.title ?? t.label ?? "Focus session", humanDuration(elapsed), t.taskId);
      if (t.taskId) {
        const task = get().tasks.find((x) => x.id === t.taskId);
        if (task) await saveTask({ ...task, spentMs: task.spentMs + elapsed, updatedAt: end });
      }
    };

    const apply = (snap: Snapshot) => {
      const settings = mergeSettings(snap.settings ?? {});
      set({
        tasks: snap.tasks,
        categories: snap.categories,
        // Data from before fixed appointments existed: an appointment without a task is fixed.
        events: snap.events.map((e) => ({ ...e, fixed: e.fixed ?? e.taskId == null, sched: e.sched ?? null })),
        timers: snap.timers,
        focusSessions: snap.focusSessions,
        settings,
        workSessions: snap.workSessions ?? [],
        activity: snap.activity ?? [],
      });
    };

    const saveWork = async (w: WorkSession) => {
      set({ workSessions: get().workSessions.some((x) => x.id === w.id) ? get().workSessions.map((x) => (x.id === w.id ? w : x)) : [...get().workSessions, w] });
      await backend.upsertWork(w);
    };

    const homeDay = (ms: number) => DateTime.fromMillis(ms, { zone: get().settings.homeZone }).toISODate();

    /**
     * The user went away at `since`: pause the work clock from that moment, so
     * the time without input is never counted. `timers` also pauses running
     * focus timers; `quiet` skips the notice and history entry (short absences).
     */
    const goAway = async (since: number, opts: { timers: boolean; quiet: boolean }) => {
      const s = get().settings;
      const ts = now();
      const w = activeSession(get().workSessions);
      const p = openPause(w);
      const running = opts.timers && s.idlePauseTimers ? get().timers.filter((t) => t.state === "running") : [];
      const needsPause = !!w && !p;
      if (!needsPause && !running.length) {
        if (!opts.quiet && p?.reason === "idle") awayNotice(p.start);
        return;
      }
      for (const t of running) await get().pauseTimer(t.id, since);
      if (w && !p) {
        const start = Math.min(ts, Math.max(w.startedAt, since));
        await saveWork({ ...w, pauses: [...w.pauses, { start, end: null, reason: "idle", timerIds: running.map((t) => t.id) }], updatedAt: ts });
        if (!opts.quiet) get().log("auto_paused", "Auto-paused (no activity)", "No keyboard or mouse input", w.id);
      } else if (w && p && p.reason === "idle") {
        await saveWork({ ...w, pauses: w.pauses.map((x) => (x === p ? { ...x, timerIds: [...(x.timerIds ?? []), ...running.map((t) => t.id)] } : x)) });
      }
      if (!opts.quiet) awayNotice(since);
    };

    const AWAY_TOAST = "Paused — no activity";
    const awayNotice = (since: number) => {
      if (get().toasts.some((x) => x.title === AWAY_TOAST)) return;
      const s = get().settings;
      get().toast({ kind: "info", title: AWAY_TOAST, body: `Nothing was counted after ${formatWithZone(since, s.homeZone, s.hour12)}.`, ttl: 0 });
    };

    /** More than one open session (see closeStraySessions): close the strays so only real work is counted. */
    const repairWork = async () => {
      const fixed = closeStraySessions(get().workSessions, now());
      for (const w of fixed) await saveWork(w);
      return fixed.length;
    };

    /** In automatic mode, start a work session if none is running (unless the user clocked out today). */
    const ensureAutoWork = async (at: number) => {
      const s = get().settings;
      await repairWork();
      if (!s.workAuto || activeSession(get().workSessions)) return;
      const ts = now();
      if (s.workAutoHoldDay && s.workAutoHoldDay === homeDay(ts)) return;
      const startedAt = Math.min(ts, at);
      const w: WorkSession = { id: id(), startedAt, endedAt: null, pauses: [], note: "", createdAt: ts, updatedAt: ts };
      await saveWork(w);
      get().log("clock_in", "Work clock started", "Started automatically when you became active", w.id);
    };

    /** The user is active again since `at`: close an automatic pause and, in automatic mode, make sure the clock runs. */
    const comeBack = async (at: number) => {
      const s = get().settings;
      const ts = now();
      const w = activeSession(get().workSessions);
      const p = openPause(w);
      if (w && p && p.reason === "idle" && s.idleAutoResume) {
        const resumeAt = Math.min(ts, Math.max(p.start, at));
        const away = resumeAt - p.start;
        // Four hours or more without a sign of life: ask whether that was the sleep, instead of assuming a timetable.
        if (away >= SLEEP_CHECK_MS && s.routine?.enabled && s.routine.flexible) set({ sleepCheck: { from: p.start, to: resumeAt } });
        if (s.workAuto && homeDay(p.start) !== homeDay(resumeAt)) {
          // Away over midnight: yesterday's session ends where the activity stopped; today starts fresh.
          const pauses = w.pauses.filter((x) => x !== p);
          await saveWork({ ...w, pauses, endedAt: Math.max(w.startedAt, p.start), updatedAt: ts });
        } else {
          await saveWork({ ...w, pauses: w.pauses.map((x) => (x === p ? { ...x, end: resumeAt } : x)), updatedAt: ts });
        }
        for (const tid of p.timerIds ?? []) {
          const t = get().timers.find((x) => x.id === tid);
          if (t && t.state === "paused") await get().resumeTimer(tid);
        }
        set({ toasts: get().toasts.filter((x) => x.title !== AWAY_TOAST) });
        if (away >= LONG_AWAY_MS) {
          get().log("resumed", "Resumed after inactivity", `${humanDuration(away)} idle not counted`, w.id);
          // Away in the middle of a task: the time can still be counted if the work went on elsewhere.
          const cur = currentBlock(get().tasks, get().events, ts);
          get().toast({
            kind: "success",
            title: "Welcome back",
            body: cur ? `${humanDuration(away)} of inactivity wasn't counted towards “${cur.task.title}”.` : `${humanDuration(away)} of inactivity wasn't counted.`,
            action: cur ? { label: "I was working on it", run: () => void get().countAway(cur.event.id) } : undefined,
            ttl: cur ? 20_000 : 6000,
          });
        }
      }
      await ensureAutoWork(at);
    };

    /**
     * NEXUS was not running since `heartbeat` (closed, crashed, PC off) while a
     * session was open: that gap is not work, so it becomes a pause.
     */
    const reconcileWork = async (heartbeat: unknown) => {
      const hb = typeof heartbeat === "number" ? heartbeat : NaN;
      const w = activeSession(get().workSessions);
      const ts = now();
      if (!w || openPause(w) || !Number.isFinite(hb) || hb <= 0 || ts - hb < RESTART_GAP_MS) return;
      const start = Math.min(ts, Math.max(w.startedAt, hb));
      await saveWork({ ...w, pauses: [...w.pauses, { start, end: null, reason: "idle" }], updatedAt: ts });
    };

    // ---- one source of truth: a task's reserved calendar time follows the task
    const blocksOf = (taskId: string) => get().events.filter((e) => e.taskId === taskId);
    const removeBlock = (e: CalendarEvent, why: "task-deleted" | "task-done") =>
      saveEvent({ ...e, deletedAt: now(), updatedAt: now(), sched: { ...(e.sched ?? {}), removed: why } });
    /** Bring back blocks that left with their task, unless their time has already passed. */
    const restoreBlocks = async (taskId: string, why: "task-deleted" | "task-done") => {
      const ts = now();
      for (const e of blocksOf(taskId)) {
        if (e.deletedAt && e.sched?.removed === why && (e.endAt > ts || !!e.recurrence)) await saveEvent({ ...e, deletedAt: null, updatedAt: ts, sched: { ...e.sched, removed: null } });
      }
    };

    /** A repeating task: create its next occurrence. */
    const spawnNext = async (cur: Task, ts: number) => {
      if (!cur.recurrence || cur.dueAt == null) return;
      const zone = cur.dueTz || get().settings.homeZone;
      const nextDue = nextOccurrence(cur.dueAt, zone, cur.recurrence, Math.max(cur.dueAt, ts));
      if (nextDue == null) return;
      const remainingCount = cur.recurrence.count != null ? cur.recurrence.count - 1 : null;
      if (remainingCount != null && remainingCount <= 0) return;
      await get().addTask(
        {
          ...cur,
          title: cur.title,
          status: "todo",
          dueAt: nextDue,
          spentMs: 0,
          subtasks: cur.subtasks.map((s) => ({ ...s, id: id(), done: false })),
          recurrence: { ...cur.recurrence, count: remainingCount },
          reminders: cur.reminders,
          sortOrder: cur.sortOrder,
        },
        { autoPlace: false },
      );
    };

    /**
     * Calendar blocks left behind by older versions: time reserved for a task
     * that is in the trash, was removed for good, or was completed before the
     * block began. They are taken off the calendar so no view shows them.
     */
    const tidySchedule = async () => {
      const ts = now();
      const byId = new Map(get().tasks.map((t) => [t.id, t]));
      for (const e of get().events) {
        if (e.deletedAt || !e.taskId) continue;
        const t = byId.get(e.taskId);
        if (!t || t.deletedAt) await removeBlock(e, "task-deleted");
        else if (t.status === "done" && !e.recurrence && e.startAt > ts) await removeBlock(e, "task-done");
      }
    };

    let activityQueue: Promise<void> = Promise.resolve();
    /**
     * Everything that starts, pauses, resumes or ends the work clock runs one
     * at a time. Two of them running together (the idle check and an activity
     * report, or a click and either) could each see "no session open" and
     * each open one; the extra one would then count for ever.
     */
    const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
      const result = activityQueue.then(fn, fn);
      activityQueue = result.then(() => undefined, () => undefined);
      return result;
    };
    let rescheduling = false;

    /** Apply decisions of the automatic scheduler, keeping a history on each block. */
    const applyMoves = async (moves: Move[]) => {
      const s = get().settings;
      for (const m of moves) {
        const e = get().events.find((x) => x.id === m.eventId);
        if (!e || e.deletedAt) continue;
        const ts = now();
        const sched = e.sched ?? {};
        const when = (ms: number) => formatWithZone(ms, e.tz, s.hour12);
        if (m.to) {
          const history = [...(sched.history ?? []), { at: ts, from: [e.startAt, e.endAt] as [number, number], to: [m.to.start, m.to.end] as [number, number], reason: m.reason }].slice(-20);
          // What was clocked stays with the task: only the rest is given a new time.
          const partly = m.reason === "unfinished" && (m.workedMs ?? 0) >= 60_000 && m.targetMs != null;
          const carried = m.reason === "unfinished" && m.targetMs != null ? { workedMs: m.workedMs ?? 0, targetMs: m.targetMs, creditedTo: null } : {};
          const pushed = m.reason === "pushed";
          await saveEvent({ ...e, startAt: m.to.start, endAt: m.to.end, sched: { ...sched, ...carried, origin: "auto", moves: (sched.moves ?? 0) + (pushed ? 0 : 1), history, attention: null }, updatedAt: ts });
          const why =
            m.reason === "unfinished"
              ? partly
                ? `${humanDuration(m.workedMs!)} of ${humanDuration(m.targetMs!)} clocked, ${humanDuration(m.to.end - m.to.start)} left`
                : "No time was clocked on it"
              : pushed
                ? "An unfinished task needed its time"
                : "A fixed appointment took its time";
          get().log("auto_rescheduled", m.title, `${why}: ${when(m.from.start)} → ${when(m.to.start)}`, e.taskId ?? e.id);
          if (s.smartNotify) {
            get().toast({
              kind: "info",
              title: m.reason === "unfinished" ? (partly ? "Rest of the task moved forward" : "Pushed forward") : "Moved to make room",
              body: `${m.title}: ${why.charAt(0).toLowerCase()}${why.slice(1)}. New time ${when(m.to.start)}.`,
              // Putting it back leaves it for the user to decide, so it is not moved again straight away.
              action: { label: "Undo", run: () => void saveEvent({ ...e, sched: { ...sched, attention: "kept" }, updatedAt: now() }) },
              ttl: 12_000,
            });
          }
        } else if (m.problem === "worked") {
          // The planned time was clocked in full: it is the user's call whether the task is finished.
          await saveEvent({ ...e, sched: { ...sched, attention: "worked" }, updatedAt: ts });
          get().log("auto_rescheduled", m.title, `Planned time clocked in full (${humanDuration(m.targetMs ?? 0)}). Waiting for you to mark it complete.`, e.taskId ?? e.id);
          const taskId = e.taskId;
          get().toast({
            kind: "success",
            title: `Time is up for “${m.title}”`,
            body: `You clocked the full ${humanDuration(m.targetMs ?? 0)}. Is it finished? If not, it stays open until you mark it complete or give it more time.`,
            action: taskId ? { label: "Mark complete", run: () => void get().setTaskDone(taskId, true) } : undefined,
            ttl: 0,
          });
        } else {
          await saveEvent({ ...e, sched: { ...sched, attention: m.problem ?? "nofit" }, updatedAt: ts });
          const suggestion = m.suggestion;
          const body =
            m.problem === "deadline"
              ? `It was not completed in its time, and the next free time${suggestion ? ` (${when(suggestion.start)})` : ""} is after its deadline.`
              : m.problem === "limit"
                ? "It has been moved automatically several times without being completed. Pick a time that works, or mark it complete."
                : "It was not completed in its time and no free time was found in the next two weeks.";
          get().log("auto_rescheduled", m.title, `Needs your decision: ${body}`, e.taskId ?? e.id);
          get().toast({
            kind: "warning",
            title: `“${m.title}” needs a new time`,
            body,
            action: suggestion ? { label: `Use ${when(suggestion.start)}`, run: () => void applyMoves([{ ...m, to: suggestion, problem: undefined }]) } : undefined,
            ttl: 0,
          });
        }
      }
    };

    let merging = false;
    const SLEEP_MOVED = "Sleep moved later";

    /** Make sure the work clock is counting: clock in, or end a pause. */
    const startClock = async () => {
      const w = activeSession(get().workSessions);
      if (!w) await get().clockIn();
      else if (openPause(w)) await get().resumeWork();
    };

    const flexibleBlock = (e: CalendarEvent) => !e.fixed && !e.recurrence && !!e.taskId && !e.deletedAt;

    /** "A: 10:00 → 11:00" for every block whose time differs from `before`, for the notice after a change. */
    const describeChanges = (before: CalendarEvent[]) => {
      const s = get().settings;
      const was = new Map(before.map((e) => [e.id, e]));
      const t = (ms: number) => formatTime(ms, s.homeZone, s.hour12);
      const day = (ms: number) => DateTime.fromMillis(ms, { zone: s.homeZone }).toFormat("ccc d");
      const lines: string[] = [];
      for (const e of [...get().events].sort((a, b) => a.startAt - b.startAt)) {
        const old = was.get(e.id);
        if (!old || e.deletedAt || (old.startAt === e.startAt && old.endAt === e.endAt)) continue;
        const sameDay = day(old.startAt) === day(e.startAt);
        lines.push(`${e.title}: ${sameDay ? "" : `${day(old.startAt)} `}${t(old.startAt)}–${t(old.endAt)} → ${sameDay ? "" : `${day(e.startAt)} `}${t(e.startAt)}–${t(e.endAt)}`);
      }
      return lines;
    };

    /** Tell the user exactly what moved (original → new time), with Undo. */
    const announce = (title: string, before: CalendarEvent[], note = "") => {
      const lines = describeChanges(before);
      if (!lines.length) return;
      const shown = lines.slice(0, 4).join("\n") + (lines.length > 4 ? `\n+ ${lines.length - 4} more` : "");
      get().toast({ kind: "success", title, body: `${note ? `${note}\n` : ""}${shown}`, action: { label: "Undo", run: () => void restoreEvents(before) }, ttl: 12_000 });
    };

    /** After a flexible task block was retimed by hand: push the tasks behind it out of its way and say what moved. */
    const ripple = async (was: CalendarEvent, is: CalendarEvent, before: CalendarEvent[], quiet = false, anyTime = false, keep: string[] = []) => {
      if (!flexibleBlock(is) || !get().settings.smartEnabled) return 0;
      const moves = planRipple(get().tasks, get().events, now(), get().slotSettings(), is.id, { start: is.startAt, end: is.endAt }, was.startAt, { anyTime, keep });
      for (const m of moves) {
        const e = get().events.find((x) => x.id === m.eventId);
        if (!e || !m.to) continue;
        const ts = now();
        const sched = e.sched ?? {};
        const history = [...(sched.history ?? []), { at: ts, from: [e.startAt, e.endAt] as [number, number], to: [m.to.start, m.to.end] as [number, number], reason: "pushed" as const }].slice(-20);
        await saveEvent({ ...e, startAt: m.to.start, endAt: m.to.end, sched: { ...sched, history, attention: null }, updatedAt: ts });
      }
      if (moves.length && !quiet) announce(`${moves.length} later task${moves.length === 1 ? "" : "s"} moved along`, before, `“${is.title}” changed, so what follows was pushed in the same order.`);
      return moves.length;
    };

    /** Put the stored events back exactly as they were in `before` (undo of a bulk change). */
    const restoreEvents = async (before: CalendarEvent[]) => {
      const was = new Map(before.map((e) => [e.id, e]));
      for (const e of get().events) {
        const old = was.get(e.id);
        if (old && (old.startAt !== e.startAt || old.endAt !== e.endAt || old.deletedAt !== e.deletedAt || old.title !== e.title)) await saveEvent({ ...old, updatedAt: now() });
      }
    };

    /**
     * Apply new times for tasks' blocks. Parts merged into the first block are
     * taken off the calendar; the time clocked on them and their planned
     * totals are added up, so nothing is lost or counted twice.
     */
    const applyUnits = async (plans: UnitPlan[], reason: "queue" | "merge") => {
      let changed = 0;
      for (const p of plans) {
        const task = get().tasks.find((t) => t.id === p.taskId);
        for (const [k, part] of p.parts.entries()) {
          const e = get().events.find((x) => x.id === part.eventId);
          if (!e || e.deletedAt) continue;
          const joining = k === 0 && p.merged.length > 0;
          if (!joining && part.to.start === e.startAt && part.to.end === e.endAt) continue;
          const ts = now();
          let sched = { ...(e.sched ?? {}) };
          let title = e.title;
          if (joining) {
            const all = [e, ...p.merged.map((id) => get().events.find((x) => x.id === id)).filter((x): x is CalendarEvent => !!x)];
            const worked = all.reduce((a, b) => a + (b.sched?.workedMs ?? 0), 0);
            if (worked > 0 || all.some((b) => b.sched?.targetMs != null)) {
              sched.workedMs = worked;
              sched.targetMs = all.reduce((a, b) => a + (b.sched?.targetMs ?? b.endAt - b.startAt), 0);
            }
            // "Report (1/2)" is "Report" again
            title = task?.title ?? e.title.replace(/\s*\(\d+\/\d+\)$/, "");
          }
          if (part.to.start !== e.startAt || part.to.end !== e.endAt) {
            const history = [...(sched.history ?? []), { at: ts, from: [e.startAt, e.endAt] as [number, number], to: [part.to.start, part.to.end] as [number, number], reason: reason === "queue" ? ("queue" as const) : ("bulk" as const) }].slice(-20);
            sched = { ...sched, history, attention: null, ...(reason === "queue" ? { origin: "user" as const, moves: 0 } : {}) };
          }
          await saveEvent({ ...e, title, startAt: part.to.start, endAt: part.to.end, sched, updatedAt: ts });
          changed++;
        }
        for (const id of p.merged) {
          const e = get().events.find((x) => x.id === id);
          if (e && !e.deletedAt) {
            await saveEvent({ ...e, deletedAt: now(), updatedAt: now(), sched: { ...(e.sched ?? {}), removed: "merged" } });
            changed++;
          }
        }
      }
      return changed;
    };

    /** A fixed appointment now occupies `fixed`'s time: flexible blocks there are moved away. */
    const makeRoomFor = async (fixed: CalendarEvent) => {
      const s = get().settings;
      if (!s.smartEnabled || !fixed.fixed) return;
      await applyMoves(planDisplaced(fixed, get().tasks, get().events, now(), get().slotSettings()));
    };

    const wh = () => {
      const s = get().settings;
      return workHours(s);
    };

    return {
      ready: false,
      error: null,
      tasks: [],
      categories: [],
      events: [],
      timers: [],
      focusSessions: [],
      settings: DEFAULT_SETTINGS,
      toasts: [],
      workSessions: [],
      activity: [],
      sleepCheck: null,

      async init() {
        try {
          const snap = await backend.load();
          apply(snap);
          set({ ready: true, error: null });
          const strays = await repairWork().catch(() => 0);
          if (strays) {
            get().log("clock_out", "Work clock corrected", `${strays} session${strays === 1 ? " was" : "s were"} left open by mistake and counting in the background; closed where the work really stopped`);
            get().toast({ kind: "info", title: "Work clock corrected", body: `${strays} work session${strays === 1 ? " was" : "s were"} left open and kept counting in the background. ${strays === 1 ? "It has" : "They have"} been closed where the work really stopped, so today's total is accurate again.`, ttl: 0 });
          }
          await reconcileWork((snap.settings as Record<string, unknown> | undefined)?.workHeartbeat).catch(() => {});
          await tidySchedule().catch(() => {});
        } catch (e) {
          // Not ready: nothing is shown as if it were the user's (empty) data, and nothing schedules or saves on top of it.
          set({ ready: false, error: e instanceof Error ? e.message : String(e) });
        }
      },

      async reload() {
        try {
          apply(await backend.load());
          // data that could not be loaded at start-up has arrived (for example after a recovery in another window)
          if (!get().ready || get().error) set({ ready: true, error: null });
          await repairWork().catch(() => {});
        } catch {
          /* keep current state */
        }
      },

      // ------------------------------------------------------------ tasks
      async addTask(input, opts) {
        const ts = now();
        const s = get().settings;
        const minOrder = get().tasks.reduce((m, t) => Math.min(m, t.sortOrder), 0);
        const t: Task = {
          id: id(),
          title: input.title.trim(),
          notes: input.notes ?? "",
          priority: input.priority ?? "medium",
          categoryId: input.categoryId ?? "work",
          status: input.status ?? "todo",
          dueAt: input.dueAt ?? null,
          dueTz: input.dueTz ?? s.homeZone,
          estimateMin: input.estimateMin ?? null,
          spentMs: input.spentMs ?? 0,
          sortOrder: input.sortOrder ?? minOrder - 1,
          recurrence: input.recurrence ?? null,
          reminders: input.reminders ?? (input.dueAt != null ? [...s.defaultReminders] : []),
          subtasks: input.subtasks ?? [],
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
          createdAt: ts,
          updatedAt: ts,
        };
        if (!t.title) throw new Error("A task needs a title");
        set({ tasks: [t, ...get().tasks] });
        try {
          await backend.upsertTask(t);
        } catch (e) {
          set({ tasks: get().tasks.filter((x) => x.id !== t.id) });
          fail(e, "add the task");
        }
        await syncTask(t);
        get().log("task_created", t.title, t.dueAt ? `Due ${formatWithZone(t.dueAt, t.dueTz ?? s.homeZone, s.hour12)}` : "", t.id);
        // Auto-placement: reserve time in the best free working slot(s).
        if ((opts?.autoPlace ?? true) && s.autoPlaceNewTasks && t.estimateMin && t.status !== "done") {
          const plan = get().autoPlan({ onlyTaskIds: [t.id] });
          if (plan.blocks.length) {
            const created = await get().applyPlan(plan.blocks);
            get().toast({
              kind: plan.lateTaskIds.length ? "warning" : "info",
              title: plan.lateTaskIds.length ? "Placed, but it ends after the deadline" : "Time reserved automatically",
              body: `${t.title}: ${plan.blocks.map((b) => formatWithZone(b.start, s.homeZone, s.hour12)).join(", ")}`,
              action: { label: "Undo", run: () => created.forEach((e) => void get().deleteEvent(e.id)) },
              ttl: 8000,
            });
          } else if (plan.unplaced.length) {
            get().toast({ kind: "warning", title: "No free time found", body: `Couldn't fit “${t.title}” into your working hours in the next 2 weeks.` });
          }
        }
        return t;
      },

      async updateTask(taskId, patch) {
        const cur = get().tasks.find((t) => t.id === taskId);
        if (!cur) return null;
        const next: Task = { ...cur, ...patch, id: cur.id, updatedAt: now() };
        await saveTask(next);
        if (patch.dueAt !== undefined && patch.dueAt !== cur.dueAt && next.dueAt != null) {
          get().log("task_rescheduled", next.title, `→ ${formatWithZone(next.dueAt, next.dueTz ?? get().settings.homeZone, get().settings.hour12)}`, next.id);
        }
        // A renamed task keeps one name everywhere: its calendar blocks are renamed with it.
        if (next.title !== cur.title) {
          for (const e of blocksOf(taskId)) {
            const title = e.title === cur.title ? next.title : e.title.startsWith(`${cur.title} (`) ? next.title + e.title.slice(cur.title.length) : null;
            if (title) await saveEvent({ ...e, title, updatedAt: now() });
          }
        }
        return next;
      },

      async setTaskDone(taskId, done) {
        const cur = get().tasks.find((t) => t.id === taskId);
        if (!cur) return;
        const ts = now();
        if (!done) {
          await saveTask({ ...cur, status: "todo", completedAt: null, updatedAt: ts });
          get().log("task_reopened", cur.title, "", cur.id);
          await restoreBlocks(taskId, "task-done");
          return;
        }
        if (cur.status === "done") return; // already completed: nothing to do twice
        const before = get().events;
        await saveTask({ ...cur, status: "done", completedAt: ts, updatedAt: ts });
        // Time still reserved for it is no longer needed. A block under way ends now; one that is over stays as a record.
        let savedMs = 0;
        let freedAt = Infinity;
        for (const e of blocksOf(taskId)) {
          if (e.deletedAt || e.recurrence) continue;
          if (e.startAt > ts) {
            await removeBlock(e, "task-done");
            if (flexibleBlock(e)) {
              savedMs += e.endAt - e.startAt;
              freedAt = Math.min(freedAt, e.startAt);
            }
          } else if (e.endAt > ts && flexibleBlock(e)) {
            // finished early: the block shows the time really used
            const end = Math.max(ts, e.startAt + 60_000);
            savedMs += e.endAt - end;
            freedAt = Math.min(freedAt, end);
            const history = [...(e.sched?.history ?? []), { at: ts, from: [e.startAt, e.endAt] as [number, number], to: [e.startAt, end] as [number, number], reason: "saved" as const }].slice(-20);
            await saveEvent({ ...e, endAt: end, sched: { ...(e.sched ?? {}), history, attention: null }, updatedAt: ts });
          }
        }
        // The time saved goes to what was next: the tasks that follow come forward, in the same order.
        if (savedMs >= 60_000 && get().settings.smartEnabled) {
          const moves = planPullForward(get().tasks, get().events, ts, get().slotSettings(), freedAt);
          for (const m of moves) {
            const e = get().events.find((x) => x.id === m.eventId);
            if (!e || !m.to) continue;
            const history = [...(e.sched?.history ?? []), { at: ts, from: [e.startAt, e.endAt] as [number, number], to: [m.to.start, m.to.end] as [number, number], reason: "saved" as const }].slice(-20);
            await saveEvent({ ...e, startAt: m.to.start, endAt: m.to.end, sched: { ...(e.sched ?? {}), history, attention: null }, updatedAt: ts });
          }
          if (moves.length) announce(`${humanDuration(savedMs)} saved`, before, `“${cur.title}” is done early, so what was next comes forward.`);
        }
        get().log(
          "task_completed",
          cur.title,
          [cur.dueAt != null ? (ts <= cur.dueAt ? "on time" : `${humanDuration(ts - cur.dueAt)} late`) : "", cur.spentMs ? `${humanDuration(cur.spentMs)} tracked` : ""].filter(Boolean).join(" · "),
          cur.id,
        );
        if (get().settings.activeTaskId === taskId) await get().setActiveTask(null);
        // Recurring task → spawn the next instance.
        await spawnNext(cur, ts);
      },

      async deleteTask(taskId, scope = "series") {
        const cur = get().tasks.find((t) => t.id === taskId);
        if (!cur) return;
        // Only this occurrence of a repeating task: the next one is scheduled before this one goes.
        if (scope === "occurrence") await spawnNext(cur, now());
        await saveTask({ ...cur, deletedAt: now(), updatedAt: now() });
        for (const e of blocksOf(taskId)) if (!e.deletedAt) await removeBlock(e, "task-deleted");
        get().log("task_deleted", cur.title, scope === "occurrence" && cur.recurrence ? "This occurrence only" : "", cur.id);
        if (get().settings.activeTaskId === taskId) await get().setActiveTask(null);
        get().toast({
          kind: "info",
          title: "Task moved to Trash",
          body: cur.title,
          action: { label: "Undo", run: () => void get().restoreTask(taskId) },
          ttl: 7000,
        });
      },

      async restoreTask(taskId) {
        const cur = get().tasks.find((t) => t.id === taskId);
        if (cur) {
          await saveTask({ ...cur, deletedAt: null, updatedAt: now() });
          get().log("task_restored", cur.title, "", cur.id);
          await restoreBlocks(taskId, "task-deleted");
        }
      },

      async purgeTask(taskId) {
        const blocks = blocksOf(taskId);
        set({ tasks: get().tasks.filter((t) => t.id !== taskId), events: get().events.filter((e) => e.taskId !== taskId) });
        await backend.deleteTask(taskId);
        for (const e of blocks) await backend.deleteEvent(e.id).catch(() => {});
      },

      async emptyTrash() {
        for (const t of get().tasks.filter((t) => t.deletedAt)) await get().purgeTask(t.id);
      },

      async archiveTask(taskId, archived) {
        const cur = get().tasks.find((t) => t.id === taskId);
        if (cur) await saveTask({ ...cur, archivedAt: archived ? now() : null, updatedAt: now() });
      },

      async archiveCompleted() {
        const done = get().tasks.filter((t) => t.status === "done" && !t.archivedAt && !t.deletedAt);
        for (const t of done) await saveTask({ ...t, archivedAt: now(), updatedAt: now() });
        return done.length;
      },

      async reorderTasks(ids) {
        const order = new Map(ids.map((tid, i) => [tid, i]));
        set({
          tasks: get()
            .tasks.map((t) => (order.has(t.id) ? { ...t, sortOrder: order.get(t.id)! } : t))
            .sort((a, b) => a.sortOrder - b.sortOrder),
        });
        await backend.reorderTasks(ids);
      },

      async setActiveTask(taskId) {
        await get().setSetting("activeTaskId", taskId);
        if (taskId) {
          const t = get().tasks.find((x) => x.id === taskId);
          if (t && t.status === "todo") await saveTask({ ...t, status: "in_progress", updatedAt: now() });
        }
      },

      // ------------------------------------------------------------ categories
      async saveCategory(c) {
        set({ categories: get().categories.some((x) => x.id === c.id) ? get().categories.map((x) => (x.id === c.id ? c : x)) : [...get().categories, c] });
        await backend.upsertCategory(c);
      },

      async deleteCategory(catId) {
        const fallback = "personal";
        await backend.deleteCategory(catId, fallback);
        set({
          categories: get().categories.filter((c) => c.id !== catId),
          tasks: get().tasks.map((t) => (t.categoryId === catId ? { ...t, categoryId: fallback } : t)),
        });
      },

      // ------------------------------------------------------------ events
      async addEvent(input) {
        const ts = now();
        const e: CalendarEvent = {
          id: id(),
          title: input.title.trim(),
          notes: input.notes ?? "",
          startAt: input.startAt,
          endAt: Math.max(input.endAt, input.startAt),
          tz: input.tz ?? get().settings.homeZone,
          taskId: input.taskId ?? null,
          recurrence: input.recurrence ?? null,
          important: input.important ?? false,
          reminders: input.reminders ?? [...get().settings.defaultReminders],
          color: input.color ?? null,
          // An appointment is fixed unless it is a block of time for a task.
          fixed: input.fixed ?? input.taskId == null,
          sched: input.sched ?? null,
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        };
        if (!e.title) throw new Error("An appointment needs a title");
        await saveEvent(e);
        get().log("event_created", e.title, formatWithZone(e.startAt, e.tz, get().settings.hour12), e.id);
        await makeRoomFor(e);
        return e;
      },

      async updateEvent(evId, patch) {
        const cur = get().events.find((e) => e.id === evId);
        if (!cur) return null;
        const before = get().events;
        const next = { ...cur, ...patch, id: cur.id, updatedAt: now() };
        const retimed = next.startAt !== cur.startAt || next.endAt !== cur.endAt;
        // The user chose this time: it is theirs again, and the automatic-move count starts over.
        if (retimed && cur.sched && patch.sched === undefined) next.sched = { ...cur.sched, origin: "user", moves: 0, attention: null };
        // Time already clocked on a task's block goes with it to its new time.
        if (retimed && patch.sched === undefined && cur.taskId && !cur.fixed && !cur.recurrence) {
          const c = blockClock(cur, get().workSessions, now());
          if (c.workedMs > 0) {
            const resized = next.endAt - next.startAt !== cur.endAt - cur.startAt;
            next.sched = { ...(next.sched ?? {}), workedMs: c.workedMs, targetMs: resized ? c.workedMs + (next.endAt - next.startAt) : c.targetMs, creditedTo: null };
          }
        }
        await saveEvent(next);
        if (patch.startAt !== undefined && patch.startAt !== cur.startAt) {
          get().log("event_moved", next.title, `→ ${formatWithZone(next.startAt, next.tz, get().settings.hour12)}`, next.id);
        }
        // Renaming a task's block renames the task (when they carried the same name).
        if (next.title !== cur.title && cur.taskId) {
          const task = get().tasks.find((t) => t.id === cur.taskId);
          if (task && task.title === cur.title) await saveTask({ ...task, title: next.title, updatedAt: now() });
        }
        if (retimed || (next.fixed && !cur.fixed)) await makeRoomFor(next);
        // A task that now takes longer, or starts later, pushes the tasks after it along.
        if (retimed) await ripple(cur, next, before);
        return next;
      },

      async deleteEvent(evId) {
        const cur = get().events.find((e) => e.id === evId);
        if (!cur) return;
        await saveEvent({ ...cur, deletedAt: now() });
        get().log("event_deleted", cur.title, "", cur.id);
        get().toast({
          kind: "info",
          title: "Appointment deleted",
          body: cur.title,
          action: { label: "Undo", run: () => void get().restoreEvent(evId) },
          ttl: 7000,
        });
      },

      async restoreEvent(evId) {
        const cur = get().events.find((e) => e.id === evId);
        if (cur) await saveEvent({ ...cur, deletedAt: null, updatedAt: now() });
      },

      async moveOccurrence(occ, newStart, newEnd, scope) {
        const ev = get().events.find((e) => e.id === occ.event.id);
        if (!ev) return;
        if (!ev.recurrence || scope === "series") {
          const shift = newStart - occ.start;
          const dur = newEnd - newStart;
          const before = get().events;
          const moved = { ...ev, startAt: ev.startAt + shift, endAt: ev.startAt + shift + dur, updatedAt: now() };
          await saveEvent(moved);
          await ripple(ev, moved, before);
          if (shift) get().log("event_moved", ev.title, `→ ${formatWithZone(newStart, ev.tz, get().settings.hour12)}`, ev.id);
          return;
        }
        // Detach this occurrence: exclude it from the series and create a standalone copy.
        await saveEvent({
          ...ev,
          recurrence: { ...ev.recurrence, exdates: [...(ev.recurrence.exdates ?? []), occ.seriesStart] },
          updatedAt: now(),
        });
        await get().addEvent({ ...ev, recurrence: null, startAt: newStart, endAt: newEnd, title: ev.title });
      },

      // ------------------------------------------------------------ timers
      async startTimer({ kind, minutes, taskId = null, label = "" }) {
        const s = get().settings;
        const ts = now();
        const task = taskId ? get().tasks.find((t) => t.id === taskId) : undefined;
        const mins = kind === "stopwatch" ? 0 : minutes ?? (kind === "pomodoro" ? s.pomodoroFocusMin : task?.estimateMin ?? 25);
        let t: Timer = {
          id: id(),
          kind,
          label: label || task?.title || (kind === "pomodoro" ? "Focus session" : kind === "stopwatch" ? "Stopwatch" : "Countdown"),
          taskId,
          durationMs: mins * 60_000,
          startedAt: null,
          accumulatedMs: 0,
          state: "idle",
          phase: kind === "pomodoro" ? "focus" : null,
          cycle: 0,
          createdAt: ts,
          updatedAt: ts,
        };
        t = cd.start(t, ts);
        await saveTimer(t);
        if (taskId) await get().setActiveTask(taskId);
        return t;
      },

      async pauseTimer(tid, at) {
        const t = get().timers.find((x) => x.id === tid);
        if (!t) return;
        const ts = Math.max(t.startedAt ?? 0, at ?? now());
        const elapsedThisSegment = t.startedAt != null ? ts - t.startedAt : 0;
        await saveTimer(cd.pause(t, ts));
        await logFocus(t, elapsedThisSegment);
      },

      async resumeTimer(tid) {
        const t = get().timers.find((x) => x.id === tid);
        if (t) await saveTimer(cd.start(t, now()));
      },

      async resetTimer(tid) {
        const t = get().timers.find((x) => x.id === tid);
        if (!t) return;
        const ts = now();
        if (t.state === "running" && t.startedAt != null) await logFocus(t, ts - t.startedAt);
        await saveTimer(cd.reset(t, ts));
      },

      async stopTimer(tid) {
        const t = get().timers.find((x) => x.id === tid);
        if (!t) return;
        const ts = now();
        if (t.state === "running" && t.startedAt != null) {
          const segment = ts - t.startedAt;
          const cap = t.kind === "stopwatch" ? segment : Math.max(0, t.durationMs - t.accumulatedMs);
          await logFocus(t, Math.min(segment, cap));
        }
        await get().removeTimer(tid);
      },

      async removeTimer(tid) {
        set({ timers: get().timers.filter((t) => t.id !== tid) });
        await backend.deleteTimer(tid);
        await backend.clearReminders("timer", tid).catch(() => {});
      },

      async skipPhase(tid) {
        const t = get().timers.find((x) => x.id === tid);
        if (!t || t.kind !== "pomodoro") return;
        const ts = now();
        if (t.state === "running" && t.startedAt != null) await logFocus(t, Math.min(ts - t.startedAt, Math.max(0, t.durationMs - t.accumulatedMs)));
        const s = get().settings;
        await saveTimer(
          cd.nextPomodoroPhase(t, { focusMin: s.pomodoroFocusMin, shortBreakMin: s.pomodoroShortBreakMin, longBreakMin: s.pomodoroLongBreakMin, longEvery: s.pomodoroLongEvery }, ts),
        );
      },

      async processTimers(at) {
        const ts = at ?? now();
        for (const t of get().timers) {
          if (!cd.isExpired(t, ts)) continue;
          // Credit exactly the remaining part of the segment (not the time asleep).
          const segment = t.startedAt != null ? t.durationMs - t.accumulatedMs : 0;
          if (t.kind === "pomodoro") {
            await logFocus(t, segment);
            const s = get().settings;
            const next = cd.nextPomodoroPhase(t, {
              focusMin: s.pomodoroFocusMin,
              shortBreakMin: s.pomodoroShortBreakMin,
              longBreakMin: s.pomodoroLongBreakMin,
              longEvery: s.pomodoroLongEvery,
            }, ts);
            await saveTimer(next);
            get().toast({
              kind: "success",
              title: next.phase === "focus" ? "Break over" : "Focus session complete",
              body: next.phase === "focus" ? "Ready for the next focus block?" : `Take a ${next.durationMs / 60_000}-minute break.`,
              action: { label: next.phase === "focus" ? "Start focus" : "Start break", run: () => void get().resumeTimer(next.id) },
              ttl: 15000,
            });
          } else {
            await logFocus(t, segment);
            await saveTimer(cd.finish(t, ts));
            get().toast({ kind: "success", title: "Countdown finished", body: t.label, ttl: 10000 });
          }
        }
      },

      activeTimer() {
        const ts = get().timers;
        return ts.find((t) => t.state === "running") ?? ts.find((t) => t.state === "paused") ?? ts.find((t) => t.state === "idle" && t.kind === "pomodoro") ?? null;
      },

      // ------------------------------------------------------------ settings
      async setSetting(key, value) {
        set({ settings: { ...get().settings, [key]: value } });
        await backend.setSetting(key, value);
        if (key === "hour12") await get().resyncAllReminders();
      },

      // ------------------------------------------------------------ reminders
      async resyncAllReminders() {
        for (const t of get().tasks) if (!t.deletedAt && t.status !== "done" && t.dueAt != null) await syncTask(t);
        for (const e of get().events) if (!e.deletedAt && e.reminders.length) await syncEvent(e);
        for (const t of get().timers) if (t.state === "running") await syncTimer(t);
      },

      async snoozeReminder(r, minutes) {
        const m = minutes ?? get().settings.snoozeMinutes;
        await backend.snoozeReminder(r.id, m);
        get().toast({ kind: "info", title: `Snoozed for ${m} min`, body: r.title, ttl: 3000 });
      },

      async dismissReminder(r) {
        await backend.dismissReminder(r.id);
      },

      // ------------------------------------------------------------ work clock
      clockIn() {
        return serial(async () => {
        if (activeSession(get().workSessions)) return;
        const ts = now();
        const w: WorkSession = { id: id(), startedAt: ts, endedAt: null, pauses: [], note: "", createdAt: ts, updatedAt: ts };
        await saveWork(w);
        get().log("clock_in", "Clocked in", "", w.id);
        // Clocking in by hand turns automatic tracking back on for today.
        if (get().settings.workAutoHoldDay) await get().setSetting("workAutoHoldDay", null);
        });
      },

      clockOut() {
        return serial(async () => {
        const w = activeSession(get().workSessions);
        if (!w) return;
        const ts = now();
        const pauses = w.pauses.map((p) => (p.end == null ? { ...p, end: ts } : p));
        const done = { ...w, pauses, endedAt: ts, updatedAt: ts };
        await saveWork(done);
        const { workedMs } = await import("@/lib/work");
        get().log("clock_out", "Clocked out", `${humanDuration(workedMs(done, ts))} worked`, w.id);
        // Otherwise automatic tracking would clock straight back in on the next key press.
        if (get().settings.workAuto) await get().setSetting("workAutoHoldDay", homeDay(ts));
        });
      },

      pauseWork() {
        return serial(async () => {
        const w = activeSession(get().workSessions);
        if (!w || openPause(w)) return;
        const ts = now();
        await saveWork({ ...w, pauses: [...w.pauses, { start: ts, end: null, reason: "manual" }], updatedAt: ts });
        get().log("paused", "Work paused", "", w.id);
        });
      },

      resumeWork() {
        return serial(async () => {
        const w = activeSession(get().workSessions);
        const p = openPause(w);
        if (!w || !p) return;
        const ts = now();
        await saveWork({ ...w, pauses: w.pauses.map((x) => (x === p ? { ...x, end: ts } : x)), updatedAt: ts });
        for (const tid of p.timerIds ?? []) {
          const t = get().timers.find((x) => x.id === tid);
          if (t && t.state === "paused") await get().resumeTimer(tid);
        }
        get().log("resumed", "Work resumed", `after ${humanDuration(ts - p.start)}`, w.id);
        });
      },

      handleIdle(idleSeconds) {
        return serial(async () => {
        if (!get().ready) return; // nothing is tracked or saved until the stored data is loaded
        const lastInput = now() - idleSeconds * 1000;
        const threshold = Math.max(1, get().settings.idleMinutes) * 60;
        if (idleSeconds >= threshold) {
          const long = idleSeconds * 1000 >= LONG_AWAY_MS;
          await goAway(lastInput, { timers: long, quiet: !long });
        } else if (idleSeconds < 30) {
          await comeBack(lastInput);
        }
        });
      },

      handleActivity(event) {
        const run = async () => {
          if (!get().ready) return; // nothing is tracked or saved until the stored data is loaded
          if (event.kind === "away") await goAway(event.since, { timers: event.reason !== "idle", quiet: true });
          else if (event.kind === "longIdle") await goAway(event.since, { timers: true, quiet: false });
          else await comeBack(event.at);
        };
        // One at a time: "away" and "back" can arrive together (after sleep) and must not interleave.
        return serial(run);
      },

      log(kind, title, detail = "", refId = null) {
        const entry: ActivityEntry = { id: id(), at: now(), kind, title, detail, refId };
        set({ activity: [entry, ...get().activity].slice(0, 5000) });
        void backend.addActivity(entry).catch(() => {});
      },

      // ------------------------------------------------------------ planning
      autoPlan(opts) {
        const s = get().settings;
        return planTasks(get().tasks, get().events, wh(), now(), { bufferMin: s.planBufferMin, chunkMaxMin: s.planChunkMaxMin, order: s.schedOrder, ...opts });
      },

      slotSettings() {
        const s = get().settings;
        return {
          homeZone: s.homeZone,
          workStartHour: s.workStartHour,
          workEndHour: s.workEndHour,
          workDays: s.workDays,
          plans: s.workPlans,
          week: s.workWeek,
          routine: s.routine,
          order: s.schedOrder,
          chunkMaxMin: s.planChunkMaxMin,
          bufferMin: s.planBufferMin,
          periods: s.smartPeriods,
          protectFixed: s.smartProtectFixed,
        };
      },

      async smartCreate(req, slot, durationMin, opts) {
        const title = req.title.trim();
        if (!title) throw new Error("Say what should be scheduled");
        const sched = { origin: "smart" as const, period: req.period, zone: req.zone, request: req.text };
        // The request as typed stays with the task for reference.
        const notes = `Requested: “${req.text.trim()}”`;
        if (req.fixed) {
          const event = await get().addEvent({ title, notes, startAt: slot.start, endAt: slot.end, tz: req.zone, fixed: true, sched });
          get().log("smart_scheduled", title, `Fixed appointment · ${formatWithZone(slot.start, req.zone, get().settings.hour12)}`, event.id);
          return { task: null, event };
        }
        // Flexible work: a To-Do task plus the time reserved for it on the calendar.
        // A task that is already in the list is given its time; it is not added a second time.
        const existing = opts?.existingTaskId ? get().tasks.find((t) => t.id === opts.existingTaskId && !t.deletedAt) : undefined;
        const task = existing ?? await get().addTask(
          { title, notes, estimateMin: durationMin, dueAt: req.deadline, dueTz: req.deadline != null ? req.zone : null, priority: req.priority ?? undefined, reminders: req.deadline != null ? undefined : [] },
          { autoPlace: false },
        );
        const event = await get().addEvent({ title: existing?.title ?? title, startAt: slot.start, endAt: slot.end, tz: req.zone, taskId: task.id, fixed: false, reminders: [5], color: "#22d3ee", sched });
        get().log("smart_scheduled", title, formatWithZone(slot.start, req.zone, get().settings.hour12), task.id);
        if (req.immediate) {
          // "now" / "in a minute": it keeps exactly that time, and what was there follows it in order
          const before = get().events.map((e) => (e.id === event.id ? { ...e } : e));
          await ripple(event, event, before, true, true);
          announce(`“${title}” starts ${slot.start - now() < 90_000 ? "now" : `at ${formatTime(slot.start, get().settings.homeZone, get().settings.hour12)}`}`, before, "Tasks that were in the way follow it in the same order.");
          if (slot.start - now() < 90_000) {
            await get().setActiveTask(task.id);
            await startClock();
          }
        }
        return { task, event: get().events.find((e) => e.id === event.id) ?? event };
      },

      async autoReschedule() {
        const s = get().settings;
        if (!s.smartEnabled || !s.smartAutoReschedule || rescheduling || !get().ready) return [];
        rescheduling = true;
        try {
          const moves = planUnfinished(get().tasks, get().events, now(), get().slotSettings(), get().workSessions);
          await applyMoves(moves);
          // room may have opened up for a task that had to be split
          await get().mergeSplitTasks();
          return moves;
        } finally {
          rescheduling = false;
        }
      },

      async adaptRoutine() {
        const s = get().settings;
        const w = activeSession(get().workSessions);
        if (!get().ready || !s.routine?.enabled || !s.routine.flexible || !w || openPause(w)) return null;
        const p = postponeSleep(now(), s.routine);
        if (!p) return null;
        await get().setSetting("routine", p.routine);
        const t = (ms: number) => formatTime(ms, s.homeZone, s.hour12);
        // one notice that is updated, not a new one every half hour
        set({ toasts: get().toasts.filter((x) => x.title !== SLEEP_MOVED) });
        get().toast({ kind: "info", title: SLEEP_MOVED, body: `You are still working, so sleep now starts at ${t(p.start)} and the day after begins at ${t(p.end)}. The full ${humanDuration(p.end - p.start)} is kept.`, ttl: 20_000 });
        // tomorrow's tasks that now sit in sleep or the morning routine move into the new day
        await get().rescheduleAll({ mode: "from", at: now(), strict: true }, { quiet: true, title: "Schedule adjusted to your new sleep time" });
        return p.start;
      },

      async answerSleepCheck(answer) {
        const check = get().sleepCheck;
        set({ sleepCheck: null });
        if (!check || answer === "no") return;
        const s = get().settings;
        const r = countAsSleep(s.routine, check.from, check.to, answer === "sleep+breakfast", now());
        await get().setSetting("routine", r.routine);
        const span = `${formatTime(check.from, s.homeZone, s.hour12)} – ${formatTime(check.to, s.homeZone, s.hour12)}`;
        get().log("resumed", r.kind === "night" ? "Counted as sleep" : "Deducted from the next sleep", `${span}${answer === "sleep+breakfast" ? ", breakfast included" : ""}`);
        await get().startDay(
          r.kind === "night"
            ? `${span} is counted as your sleep${answer === "sleep+breakfast" ? " and breakfast" : ""}. Your day starts now, with admin and planning first.`
            : `${humanDuration(check.to - check.from)} is deducted from your next sleep${answer === "sleep+breakfast" ? ", and breakfast is counted as done" : ""}.`,
        );
      },

      async startDay(note) {
        const s = get().settings;
        const before = get().events;
        const names = new Map(get().categories.map((c) => [c.id, c.name]));
        const order = sortedQueue(get().tasks, before, now(), s.schedOrder, (t) => isAdminTask(t, names.get(t.categoryId)));
        await applyUnits(planQueueOrder(get().tasks, before, now(), get().slotSettings(), order), "queue");
        // then everything is fitted into the day as it now looks (new wake-up, sleep and working time)
        // today's tasks follow one another from the first working moment; later days only move if they have to
        const night = nextSleep(now(), s.routine);
        await get().rescheduleAll({ mode: "from", at: now(), strict: true, packUntil: night?.start }, { quiet: true, title: "Your day is planned", note, since: before });
        if (!describeChanges(before).length && note) get().toast({ kind: "success", title: "Your day is planned", body: note, ttl: 9000 });
      },

      async rescheduleAll(target, opts) {
        const snapshot = opts?.since ?? get().events;
        const moves = planBulk(get().tasks, get().events, now(), get().slotSettings(), target);
        const s = get().settings;
        const before: CalendarEvent[] = [];
        let first: number | null = null;
        for (const m of moves) {
          const e = get().events.find((x) => x.id === m.eventId);
          if (!e || e.deletedAt || !m.to) continue;
          const ts = now();
          before.push(e);
          const sched = e.sched ?? {};
          const c = blockClock(e, get().workSessions, ts);
          const history = [...(sched.history ?? []), { at: ts, from: [e.startAt, e.endAt] as [number, number], to: [m.to.start, m.to.end] as [number, number], reason: "bulk" as const }].slice(-20);
          await saveEvent({
            ...e,
            startAt: m.to.start,
            endAt: m.to.end,
            sched: { ...sched, ...(c.workedMs > 0 ? { workedMs: c.workedMs, targetMs: c.targetMs, creditedTo: null } : {}), origin: "user", moves: 0, history, attention: null },
            updatedAt: ts,
          });
          first = first == null ? m.to.start : Math.min(first, m.to.start);
        }
        await get().mergeSplitTasks();
        const n = before.length;
        const stuck = moves.filter((m) => !m.to).length;
        if (n) {
          get().log("task_rescheduled", `Rescheduled ${n} task${n === 1 ? "" : "s"} at once`, `Now starting ${formatWithZone(first!, s.homeZone, s.hour12)}`);
          if (opts?.title) announce(opts.title, snapshot, opts.note ?? "");
          else get().toast({
            kind: "success",
            title: `${n} task${n === 1 ? "" : "s"} rescheduled`,
            body: `Now starting ${formatWithZone(first!, s.homeZone, s.hour12)}. Fixed appointments were not moved.${stuck ? ` ${stuck} could not be fitted in and stayed where ${stuck === 1 ? "it was" : "they were"}.` : ""}`,
            action: {
              label: "Undo",
              run: () => void restoreEvents(snapshot),
            },
            ttl: 15_000,
          });
        } else {
          if (opts?.title && describeChanges(snapshot).length) announce(opts.title, snapshot, opts.note ?? "");
          else if (!opts?.quiet) get().toast({ kind: "info", title: "Nothing to reschedule", body: stuck ? "No free time was found for the open tasks." : "There are no open tasks with reserved time to move.", ttl: 5000 });
        }
        return moves;
      },

      async moveInQueue(eventId, dir) {
        const e = get().events.find((x) => x.id === eventId);
        const order = queueUnits(get().tasks, get().events, now()).map((u) => u.taskId);
        const i = e?.taskId ? order.indexOf(e.taskId) : -1;
        const j = i + dir;
        if (i < 0 || j < 0 || j >= order.length) return false;
        [order[i], order[j]] = [order[j], order[i]];
        return get().reorderQueue(order);
      },

      async reorderQueue(taskIds) {
        const before = get().events;
        const plans = planQueueOrder(get().tasks, before, now(), get().slotSettings(), taskIds);
        const changed = await applyUnits(plans, "queue");
        if (!changed) return false;
        const s = get().settings;
        const merged = plans.filter((p) => p.merged.length).length;
        get().log("task_rescheduled", "Queue reordered", plans.map((p) => p.title).join(" → ").slice(0, 300));
        announce("Queue updated", before, `${plans[0].title} is now first, at ${formatWithZone(plans[0].parts[0].to.start, s.homeZone, s.hour12)}.${merged ? ` ${merged} split task${merged === 1 ? " was" : "s were"} joined into one block.` : ""}`);
        return true;
      },

      async shiftTask(eventId, byMs) {
        const e = get().events.find((x) => x.id === eventId);
        if (!e || !flexibleBlock(e) || !byMs) return false;
        const before = get().events;
        const ts = now();
        const s = get().settings;
        const dur = e.endAt - e.startAt;
        const want = Math.max(ts, e.startAt + byMs);
        // exactly that much later; only a fixed appointment or personal time in the way sends it further
        const queue = new Set(get().events.filter(flexibleBlock).map((x) => x.id));
        const to = freeFrom(get().events, ts, get().slotSettings(), want, dur, queue);
        const sched = e.sched ?? {};
        const history = [...(sched.history ?? []), { at: ts, from: [e.startAt, e.endAt] as [number, number], to: [to.start, to.end] as [number, number], reason: "queue" as const }].slice(-20);
        const moved = { ...e, startAt: to.start, endAt: to.end, sched: { ...sched, origin: "user" as const, moves: 0, history, attention: null }, updatedAt: ts };
        await saveEvent(moved);
        await ripple(e, moved, before, true);
        get().log("task_rescheduled", e.title, `${byMs > 0 ? "Pushed" : "Pulled"} ${humanDuration(Math.abs(byMs))}: ${formatWithZone(e.startAt, s.homeZone, s.hour12)} → ${formatWithZone(to.start, s.homeZone, s.hour12)}`, e.taskId);
        announce(`Moved ${humanDuration(Math.abs(byMs))} ${byMs > 0 ? "later" : "earlier"}`, before, to.start !== want ? "Something fixed was in the way, so it starts right after it." : "");
        return true;
      },

      async startTaskNow(taskId) {
        const ts = now();
        const task = get().tasks.find((t) => t.id === taskId && !t.deletedAt && t.status !== "done");
        if (!task) return false;
        const before = get().events;
        const cur = currentBlock(get().tasks, before, ts);
        if (cur && cur.task.id === taskId) {
          await startClock();
          return true; // already the task under way
        }
        const unit = queueUnits(get().tasks, before, ts).find((u) => u.taskId === taskId);
        // It starts in the next minute, exactly: no working hours, no "next free slot".
        const start = Math.ceil(ts / 60_000) * 60_000;
        const dur = unit?.durationMs ?? Math.max(15, task.estimateMin ?? 30) * 60_000;
        const to = { start, end: start + dur };
        let first: CalendarEvent;
        if (unit) {
          await applyUnits([{ taskId, title: unit.title, parts: [{ eventId: unit.blocks[0].id, from: { start: unit.blocks[0].startAt, end: unit.blocks[0].endAt }, to }], merged: unit.blocks.slice(1).map((b) => b.id) }], "queue");
          first = unit.blocks[0];
        } else {
          // a task with no time reserved yet gets its time now
          first = await get().addEvent({ title: task.title, startAt: to.start, endAt: to.end, taskId, tz: get().settings.homeZone, fixed: false, reminders: [], color: "#22d3ee", sched: { origin: "user" } });
        }
        let last = get().events.find((x) => x.id === first.id)!;
        // only fixed appointments are stepped over by what follows; the hour of the day does not matter
        const anyTime = { ...get().slotSettings(), routine: undefined };
        const queue = new Set(get().events.filter(flexibleBlock).map((x) => x.id));
        if (cur) {
          // what is left of the task that was under way follows straight after, with its clocked time kept
          const c = blockClock(cur.event, get().workSessions, ts);
          const rest = Math.max(15 * 60_000, Math.ceil(c.remainingMs / 300_000) * 300_000);
          const at = freeFrom(get().events, ts, anyTime, to.end, rest, queue);
          const sched = cur.event.sched ?? {};
          const history = [...(sched.history ?? []), { at: ts, from: [cur.event.startAt, cur.event.endAt] as [number, number], to: [at.start, at.end] as [number, number], reason: "queue" as const }].slice(-20);
          const parked = { ...cur.event, startAt: at.start, endAt: at.end, sched: { ...sched, workedMs: c.workedMs, targetMs: c.targetMs, creditedTo: null, history, attention: null }, updatedAt: ts };
          await saveEvent(parked);
          last = parked;
        }
        // everything that was in the way follows in the same order (first in, first out)
        await ripple({ ...last, startAt: to.start }, last, before, true, true, [first.id]);
        await get().setActiveTask(taskId);
        await startClock();
        get().log("task_rescheduled", task.title, cur ? `Started now in place of “${cur.task.title}”` : "Started now", taskId);
        announce(cur ? `Now working on “${task.title}”` : `“${task.title}” starts now`, before, cur ? `“${cur.task.title}” continues afterwards with the time it still needs.` : "The work clock is counting.");
        if (!describeChanges(before).length) get().toast({ kind: "success", title: `“${task.title}” starts now`, body: "The work clock is counting.", ttl: 5000 });
        return true;
      },

      async sortQueue(order) {
        const o = order ?? get().settings.schedOrder;
        const before = get().events;
        const plans = planQueueOrder(get().tasks, before, now(), get().slotSettings(), sortedQueue(get().tasks, before, now(), o));
        if (!(await applyUnits(plans, "queue"))) return false;
        const label = { fifo: "first in, first out", priority: "priority (critical first)", shortest: "shortest first", deadline: "nearest deadline first" }[o];
        get().log("task_rescheduled", "Queue reorganised", `Order: ${label}`);
        announce("Queue reorganised", before, `Order: ${label}.`);
        return true;
      },

      async mergeSplitTasks() {
        if (merging || !get().ready) return 0;
        merging = true;
        try {
          const plans = planMerges(get().tasks, get().events, now(), get().slotSettings());
          await applyUnits(plans, "merge");
          for (const p of plans) get().log("task_rescheduled", p.title, `Its ${p.merged.length + 1} parts were joined into one block (${humanDuration(p.parts[0].to.end - p.parts[0].to.start)})`, p.taskId);
          return plans.length;
        } finally {
          merging = false;
        }
      },

      async countAway(eventId) {
        const e = get().events.find((x) => x.id === eventId);
        if (!e || e.deletedAt) return 0;
        const ts = now();
        const from = e.startAt;
        const to = Math.min(ts, e.endAt);
        if (to <= from) return 0;
        let counted = 0;
        // Inactivity pauses inside the block are taken back, so the work clock counts that time too.
        for (const w of get().workSessions) {
          const kept: WorkSession["pauses"] = [];
          let changed = false;
          for (const p of w.pauses) {
            const end = p.end ?? (w.endedAt == null ? ts : w.endedAt);
            const a = Math.max(p.start, from);
            const b = Math.min(end, to);
            if (p.reason !== "idle" || b <= a) {
              kept.push(p);
              continue;
            }
            changed = true;
            counted += b - a;
            if (p.start < a) kept.push({ ...p, end: a });
            if (end > b) kept.push({ ...p, start: b, end: p.end == null ? null : end });
          }
          if (changed) await saveWork({ ...w, pauses: kept, updatedAt: ts });
        }
        // Time with no clock-in at all is credited to the task itself.
        const since = Math.max(from, e.sched?.creditedTo ?? from);
        const unclocked = unclockedMs(get().workSessions, since, to, ts);
        counted += unclocked;
        if (counted < 1000) return 0;
        const cur = get().events.find((x) => x.id === eventId) ?? e;
        await saveEvent({ ...cur, sched: { ...(cur.sched ?? {}), workedMs: (cur.sched?.workedMs ?? 0) + unclocked, creditedTo: to }, updatedAt: ts });
        set({ toasts: get().toasts.filter((x) => x.title !== AWAY_TOAST) });
        get().log("time_counted", cur.title, `${humanDuration(counted)} away from the computer counted as work`, cur.taskId ?? cur.id);
        get().toast({ kind: "success", title: "Counted as work", body: `${humanDuration(counted)} added to “${cur.title}”.`, ttl: 5000 });
        return counted;
      },

      async setWorkPlan(day, plan) {
        const s = get().settings;
        const next = { ...prunePlans(s.workPlans ?? {}, now(), s.homeZone) };
        if (plan) next[day] = plan;
        else delete next[day];
        await get().setSetting("workPlans", next);
        // Tasks left behind by the old hours are fitted into the new ones.
        if (day === dayKey(now(), s.homeZone)) void get().autoReschedule().catch(() => {});
      },

      async clearHistory() {
        set({ activity: [] });
        await backend.clearActivity();
      },

      async applyPlan(blocks) {
        const created: CalendarEvent[] = [];
        for (const b of blocks) {
          created.push(
            await get().addEvent({
              title: b.parts > 1 ? `${b.title} (${b.part}/${b.parts})` : b.title,
              startAt: b.start,
              endAt: b.end,
              taskId: b.taskId,
              tz: get().settings.homeZone,
              reminders: [5],
              color: "#22d3ee",
            }),
          );
        }
        if (blocks.length) {
          const tasks = new Set(blocks.map((b) => b.taskId)).size;
          get().log("auto_planned", `Auto-planned ${tasks} task${tasks === 1 ? "" : "s"}`, `${blocks.length} time block${blocks.length === 1 ? "" : "s"}`);
        }
        return created;
      },

      // ------------------------------------------------------------ toasts
      toast(t) {
        const tid = id();
        set({ toasts: [...get().toasts.slice(-4), { ...t, id: tid }] });
        if (t.ttl !== 0) {
          setTimeout(() => get().dismissToast(tid), t.ttl ?? 5000);
        }
        return tid;
      },

      dismissToast(tid) {
        set({ toasts: get().toasts.filter((t) => t.id !== tid) });
      },
    };
  });
  return store;
}

export type NexusStore = ReturnType<typeof createNexusStore>;

// ------------------------------------------------------------ selectors

export function visibleTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.deletedAt && !t.archivedAt);
}

export const PRIORITY_WEIGHT: Record<Priority, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export { KENYA_ZONE };
