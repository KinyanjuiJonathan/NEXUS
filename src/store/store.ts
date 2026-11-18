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
import { planDisplaced, planUnfinished, type Move, type RescheduleSettings } from "@/lib/smart/reschedule";
import type { ScheduleRequest } from "@/lib/smart/parse";
import type { Interval } from "@/lib/schedule";
import { planTasks, type PlanBlock, type PlanOptions, type PlanResult } from "@/lib/planner";
import { humanDuration } from "@/lib/countdown";
import { formatWithZone } from "@/lib/time";

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  hour12: true,
  texasZone: TEXAS_CENTRAL,
  homeZone: localZone(),
  workStartHour: 9,
  workEndHour: 17,
  workDays: [1, 2, 3, 4, 5],
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
  smartCreate(req: ScheduleRequest, slot: Interval, durationMin: number): Promise<{ task: Task | null; event: CalendarEvent }>;
  /**
   * Move flexible blocks whose time passed while their task is still open to
   * the next suitable free time. Never completes a task and never touches a
   * fixed appointment. Returns what it decided.
   */
  autoReschedule(): Promise<Move[]>;

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

    /** In automatic mode, start a work session if none is running (unless the user clocked out today). */
    const ensureAutoWork = async (at: number) => {
      const s = get().settings;
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
          get().toast({ kind: "success", title: "Welcome back", body: `${humanDuration(away)} of inactivity wasn't counted.`, ttl: 6000 });
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
          await saveEvent({ ...e, startAt: m.to.start, endAt: m.to.end, sched: { ...sched, origin: "auto", moves: (sched.moves ?? 0) + 1, history, attention: null }, updatedAt: ts });
          const why = m.reason === "unfinished" ? "Not completed in its time" : "A fixed appointment took its time";
          get().log("auto_rescheduled", m.title, `${why}: ${when(m.from.start)} → ${when(m.to.start)}`, e.taskId ?? e.id);
          if (s.smartNotify) {
            get().toast({
              kind: "info",
              title: m.reason === "unfinished" ? "Rescheduled automatically" : "Moved to make room",
              body: `${m.title}: ${why.toLowerCase()}. New time ${when(m.to.start)}.`,
              // Putting it back leaves it for the user to decide, so it is not moved again straight away.
              action: { label: "Undo", run: () => void saveEvent({ ...e, sched: { ...sched, attention: "kept" }, updatedAt: now() }) },
              ttl: 12_000,
            });
          }
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

    /** A fixed appointment now occupies `fixed`'s time: flexible blocks there are moved away. */
    const makeRoomFor = async (fixed: CalendarEvent) => {
      const s = get().settings;
      if (!s.smartEnabled || !fixed.fixed) return;
      await applyMoves(planDisplaced(fixed, get().tasks, get().events, now(), get().slotSettings()));
    };

    const wh = () => {
      const s = get().settings;
      return { zone: s.homeZone, startHour: s.workStartHour, endHour: s.workEndHour, days: s.workDays };
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

      async init() {
        try {
          const snap = await backend.load();
          apply(snap);
          set({ ready: true, error: null });
          await reconcileWork((snap.settings as Record<string, unknown> | undefined)?.workHeartbeat).catch(() => {});
          await tidySchedule().catch(() => {});
        } catch (e) {
          set({ ready: true, error: e instanceof Error ? e.message : String(e) });
        }
      },

      async reload() {
        try {
          apply(await backend.load());
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
        await saveTask({ ...cur, status: "done", completedAt: ts, updatedAt: ts });
        // Time still reserved for it is no longer needed. A block already under way or over stays as a record.
        for (const e of blocksOf(taskId)) if (!e.deletedAt && !e.recurrence && e.startAt > ts) await removeBlock(e, "task-done");
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
        const next = { ...cur, ...patch, id: cur.id, updatedAt: now() };
        const retimed = next.startAt !== cur.startAt || next.endAt !== cur.endAt;
        // The user chose this time: it is theirs again, and the automatic-move count starts over.
        if (retimed && cur.sched && patch.sched === undefined) next.sched = { ...cur.sched, origin: "user", moves: 0, attention: null };
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
          await saveEvent({ ...ev, startAt: ev.startAt + shift, endAt: ev.startAt + shift + dur, updatedAt: now() });
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
      async clockIn() {
        if (activeSession(get().workSessions)) return;
        const ts = now();
        const w: WorkSession = { id: id(), startedAt: ts, endedAt: null, pauses: [], note: "", createdAt: ts, updatedAt: ts };
        await saveWork(w);
        get().log("clock_in", "Clocked in", "", w.id);
        // Clocking in by hand turns automatic tracking back on for today.
        if (get().settings.workAutoHoldDay) await get().setSetting("workAutoHoldDay", null);
      },

      async clockOut() {
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
      },

      async pauseWork() {
        const w = activeSession(get().workSessions);
        if (!w || openPause(w)) return;
        const ts = now();
        await saveWork({ ...w, pauses: [...w.pauses, { start: ts, end: null, reason: "manual" }], updatedAt: ts });
        get().log("paused", "Work paused", "", w.id);
      },

      async resumeWork() {
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
      },

      async handleIdle(idleSeconds) {
        const lastInput = now() - idleSeconds * 1000;
        const threshold = Math.max(1, get().settings.idleMinutes) * 60;
        if (idleSeconds >= threshold) {
          const long = idleSeconds * 1000 >= LONG_AWAY_MS;
          await goAway(lastInput, { timers: long, quiet: !long });
        } else if (idleSeconds < 30) {
          await comeBack(lastInput);
        }
      },

      handleActivity(event) {
        const run = async () => {
          if (event.kind === "away") await goAway(event.since, { timers: event.reason !== "idle", quiet: true });
          else if (event.kind === "longIdle") await goAway(event.since, { timers: true, quiet: false });
          else await comeBack(event.at);
        };
        // One at a time: "away" and "back" can arrive together (after sleep) and must not interleave.
        activityQueue = activityQueue.then(run, run);
        return activityQueue;
      },

      log(kind, title, detail = "", refId = null) {
        const entry: ActivityEntry = { id: id(), at: now(), kind, title, detail, refId };
        set({ activity: [entry, ...get().activity].slice(0, 5000) });
        void backend.addActivity(entry).catch(() => {});
      },

      // ------------------------------------------------------------ planning
      autoPlan(opts) {
        const s = get().settings;
        return planTasks(get().tasks, get().events, wh(), now(), { bufferMin: s.planBufferMin, chunkMaxMin: s.planChunkMaxMin, ...opts });
      },

      slotSettings() {
        const s = get().settings;
        return {
          homeZone: s.homeZone,
          workStartHour: s.workStartHour,
          workEndHour: s.workEndHour,
          workDays: s.workDays,
          bufferMin: s.planBufferMin,
          periods: s.smartPeriods,
          protectFixed: s.smartProtectFixed,
        };
      },

      async smartCreate(req, slot, durationMin) {
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
        const task = await get().addTask(
          { title, notes, estimateMin: durationMin, dueAt: req.deadline, dueTz: req.deadline != null ? req.zone : null, priority: req.priority ?? undefined, reminders: req.deadline != null ? undefined : [] },
          { autoPlace: false },
        );
        const event = await get().addEvent({ title, startAt: slot.start, endAt: slot.end, tz: req.zone, taskId: task.id, fixed: false, reminders: [5], color: "#22d3ee", sched });
        get().log("smart_scheduled", title, formatWithZone(slot.start, req.zone, get().settings.hour12), task.id);
        return { task, event };
      },

      async autoReschedule() {
        const s = get().settings;
        if (!s.smartEnabled || !s.smartAutoReschedule || rescheduling || !get().ready) return [];
        rescheduling = true;
        try {
          const moves = planUnfinished(get().tasks, get().events, now(), get().slotSettings());
          await applyMoves(moves);
          return moves;
        } finally {
          rescheduling = false;
        }
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
