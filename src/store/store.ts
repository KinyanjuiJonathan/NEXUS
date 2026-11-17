import { createStore } from "zustand/vanilla";
import type { Backend } from "@/data/backend";
import {
  DEFAULT_SHORTCUTS,
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

  init(): Promise<void>;
  reload(): Promise<void>;

  // tasks
  addTask(input: NewTask): Promise<Task>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task | null>;
  setTaskDone(id: string, done: boolean): Promise<void>;
  deleteTask(id: string): Promise<void>;
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
  pauseTimer(id: string): Promise<void>;
  resumeTimer(id: string): Promise<void>;
  resetTimer(id: string): Promise<void>;
  stopTimer(id: string): Promise<void>;
  removeTimer(id: string): Promise<void>;
  /** Called every second by the main window: finishes expired timers. */
  processTimers(now?: number): Promise<void>;
  activeTimer(): Timer | null;

  // settings
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;

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
  const s = { ...DEFAULT_SETTINGS, ...raw, shortcuts: { ...DEFAULT_SHORTCUTS, ...(raw.shortcuts ?? {}) } };
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
        events: snap.events,
        timers: snap.timers,
        focusSessions: snap.focusSessions,
        settings,
      });
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

      async init() {
        try {
          apply(await backend.load());
          set({ ready: true, error: null });
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
      async addTask(input) {
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
        return t;
      },

      async updateTask(taskId, patch) {
        const cur = get().tasks.find((t) => t.id === taskId);
        if (!cur) return null;
        const next: Task = { ...cur, ...patch, id: cur.id, updatedAt: now() };
        await saveTask(next);
        return next;
      },

      async setTaskDone(taskId, done) {
        const cur = get().tasks.find((t) => t.id === taskId);
        if (!cur) return;
        const ts = now();
        if (!done) {
          await saveTask({ ...cur, status: "todo", completedAt: null, updatedAt: ts });
          return;
        }
        await saveTask({ ...cur, status: "done", completedAt: ts, updatedAt: ts });
        if (get().settings.activeTaskId === taskId) await get().setActiveTask(null);
        // Recurring task → spawn the next instance.
        if (cur.recurrence && cur.dueAt != null) {
          const zone = cur.dueTz || get().settings.homeZone;
          const nextDue = nextOccurrence(cur.dueAt, zone, cur.recurrence, Math.max(cur.dueAt, ts));
          if (nextDue != null) {
            const remainingCount = cur.recurrence.count != null ? cur.recurrence.count - 1 : null;
            if (remainingCount == null || remainingCount > 0) {
              await get().addTask({
                ...cur,
                title: cur.title,
                status: "todo",
                dueAt: nextDue,
                spentMs: 0,
                subtasks: cur.subtasks.map((s) => ({ ...s, id: id(), done: false })),
                recurrence: { ...cur.recurrence, count: remainingCount },
                reminders: cur.reminders,
                sortOrder: cur.sortOrder,
              });
            }
          }
        }
      },

      async deleteTask(taskId) {
        const cur = get().tasks.find((t) => t.id === taskId);
        if (!cur) return;
        await saveTask({ ...cur, deletedAt: now(), updatedAt: now() });
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
        if (cur) await saveTask({ ...cur, deletedAt: null, updatedAt: now() });
      },

      async purgeTask(taskId) {
        set({ tasks: get().tasks.filter((t) => t.id !== taskId) });
        await backend.deleteTask(taskId);
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
          createdAt: ts,
          updatedAt: ts,
          deletedAt: null,
        };
        if (!e.title) throw new Error("An appointment needs a title");
        await saveEvent(e);
        return e;
      },

      async updateEvent(evId, patch) {
        const cur = get().events.find((e) => e.id === evId);
        if (!cur) return null;
        const next = { ...cur, ...patch, id: cur.id, updatedAt: now() };
        await saveEvent(next);
        return next;
      },

      async deleteEvent(evId) {
        const cur = get().events.find((e) => e.id === evId);
        if (!cur) return;
        await saveEvent({ ...cur, deletedAt: now() });
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

      async pauseTimer(tid) {
        const t = get().timers.find((x) => x.id === tid);
        if (!t) return;
        const ts = now();
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
