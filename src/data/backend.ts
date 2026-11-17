import type {
  CalendarEvent,
  Category,
  FocusSession,
  ReminderItem,
  Snapshot,
  Task,
  Timer,
} from "./types";
import { BUILTIN_CATEGORIES } from "./types";
import type { PlannedReminder } from "@/lib/reminders";

/**
 * Persistence boundary. In the desktop app every call goes to the Rust
 * backend (SQLite). In a plain browser (UI development, screenshots, tests)
 * a localStorage/in-memory implementation with the same contract is used.
 */
export interface Backend {
  readonly native: boolean;
  readonly windowLabel: string;
  load(): Promise<Snapshot>;
  upsertTask(t: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;
  reorderTasks(ids: string[]): Promise<void>;
  upsertCategory(c: Category): Promise<void>;
  deleteCategory(id: string, fallback: string): Promise<void>;
  upsertEvent(e: CalendarEvent): Promise<void>;
  deleteEvent(id: string): Promise<void>;
  upsertTimer(t: Timer): Promise<void>;
  deleteTimer(id: string): Promise<void>;
  addFocus(s: FocusSession): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  syncReminders(kind: ReminderItem["ownerKind"], ownerId: string, items: PlannedReminder[]): Promise<void>;
  clearReminders(kind: ReminderItem["ownerKind"], ownerId: string): Promise<void>;
  snoozeReminder(id: string, minutes: number): Promise<void>;
  dismissReminder(id: string): Promise<void>;
  /** Persisted data changed in another window. */
  onDataChanged(cb: (entity: string) => void): () => void;
  /** A reminder fired (from the background scheduler). */
  onReminder(cb: (r: ReminderItem) => void): () => void;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// ---------------------------------------------------------------- Tauri

export async function createTauriBackend(): Promise<Backend> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = getCurrentWebviewWindow().label;
  const sub = <T,>(event: string, cb: (p: T) => void) => {
    let un: (() => void) | null = null;
    let cancelled = false;
    listen<T>(event, (e) => cb(e.payload)).then((u) => (cancelled ? u() : (un = u)));
    return () => {
      cancelled = true;
      un?.();
    };
  };
  return {
    native: true,
    windowLabel: label,
    load: () => invoke<Snapshot>("load_snapshot"),
    upsertTask: (task) => invoke("task_upsert", { task }),
    deleteTask: (id) => invoke("task_delete", { id }),
    reorderTasks: (ids) => invoke("tasks_reorder", { ids }),
    upsertCategory: (category) => invoke("category_upsert", { category }),
    deleteCategory: (id, fallback) => invoke("category_delete", { id, fallback }),
    upsertEvent: (event) => invoke("event_upsert", { event }),
    deleteEvent: (id) => invoke("event_delete", { id }),
    upsertTimer: (timer) => invoke("timer_upsert", { timer }),
    deleteTimer: (id) => invoke("timer_delete", { id }),
    addFocus: (session) => invoke("focus_add", { session }),
    setSetting: (key, value) => invoke("setting_set", { key, value }),
    syncReminders: (ownerKind, ownerId, items) => invoke("reminders_sync", { ownerKind, ownerId, items }),
    clearReminders: (ownerKind, ownerId) => invoke("reminders_clear", { ownerKind, ownerId }),
    snoozeReminder: (id, minutes) => invoke("reminder_snooze", { id, minutes }),
    dismissReminder: (id) => invoke("reminder_dismiss", { id }),
    onDataChanged: (cb) =>
      sub<{ origin: string; entity: string }>("nexus://data-changed", (p) => {
        if (p.origin !== label) cb(p.entity);
      }),
    onReminder: (cb) => sub<ReminderItem>("nexus://reminder", cb),
  };
}

// ---------------------------------------------------------------- browser / tests

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function memoryKV(): KV {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const KEY = "nexus.v1";

interface LocalDB extends Snapshot {
  reminders: ReminderItem[];
}

/**
 * Browser fallback with the same semantics as the SQLite backend (used for UI
 * development in a normal browser and for unit tests). Reminders fire via an
 * interval + the Web Notification API.
 */
export function createLocalBackend(kv: KV = memoryKV(), opts: { label?: string; tickMs?: number } = {}): Backend {
  const read = (): LocalDB => {
    try {
      const raw = kv.getItem(KEY);
      if (raw) return JSON.parse(raw) as LocalDB;
    } catch {
      /* corrupted → start fresh */
    }
    return { tasks: [], categories: [...BUILTIN_CATEGORIES], events: [], timers: [], focusSessions: [], settings: {}, reminders: [] };
  };
  let db = read();
  const write = () => kv.setItem(KEY, JSON.stringify(db));
  const upsert = <T extends { id: string }>(list: T[], item: T) => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = structuredClone(item);
    else list.push(structuredClone(item));
  };
  const reminderListeners = new Set<(r: ReminderItem) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const ensureTicker = () => {
    if (timer || !opts.tickMs) return;
    timer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const r of db.reminders) {
        if (r.firedAt == null && r.dismissedAt == null && r.fireAt <= now) {
          r.firedAt = now;
          changed = true;
          reminderListeners.forEach((cb) => cb({ ...r }));
          try {
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification(r.title, { body: r.body });
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (changed) write();
    }, opts.tickMs);
  };
  const ok = async () => {
    write();
  };
  return {
    native: false,
    windowLabel: opts.label ?? "main",
    async load() {
      db = read();
      ensureTicker();
      const { reminders: _r, ...snap } = db;
      void _r;
      return structuredClone({ ...snap, tasks: [...snap.tasks].sort((a, b) => a.sortOrder - b.sortOrder) });
    },
    async upsertTask(t) {
      if (!t.title.trim()) throw new Error("a task needs a title");
      upsert(db.tasks, t);
      return ok();
    },
    async deleteTask(id) {
      db.tasks = db.tasks.filter((t) => t.id !== id);
      db.reminders = db.reminders.filter((r) => !(r.ownerKind === "task" && r.ownerId === id));
      return ok();
    },
    async reorderTasks(ids) {
      ids.forEach((id, i) => {
        const t = db.tasks.find((x) => x.id === id);
        if (t) t.sortOrder = i;
      });
      return ok();
    },
    async upsertCategory(c) {
      upsert(db.categories, c);
      return ok();
    },
    async deleteCategory(id, fallback) {
      if (db.categories.find((c) => c.id === id)?.builtin) throw new Error("built-in categories cannot be deleted");
      db.tasks.forEach((t) => t.categoryId === id && (t.categoryId = fallback));
      db.categories = db.categories.filter((c) => c.id !== id);
      return ok();
    },
    async upsertEvent(e) {
      if (e.endAt < e.startAt) throw new Error("an appointment cannot end before it starts");
      upsert(db.events, e);
      return ok();
    },
    async deleteEvent(id) {
      db.events = db.events.filter((e) => e.id !== id);
      return ok();
    },
    async upsertTimer(t) {
      upsert(db.timers, t);
      return ok();
    },
    async deleteTimer(id) {
      db.timers = db.timers.filter((t) => t.id !== id);
      return ok();
    },
    async addFocus(s) {
      upsert(db.focusSessions, s);
      return ok();
    },
    async setSetting(key, value) {
      (db.settings as Record<string, unknown>)[key] = value;
      return ok();
    },
    async syncReminders(kind, ownerId, items) {
      db.reminders = db.reminders.filter(
        (r) => !(r.ownerKind === kind && r.ownerId === ownerId && r.firedAt == null && r.snoozedUntil == null && r.dismissedAt == null),
      );
      for (const it of items) {
        db.reminders.push({
          id: crypto.randomUUID(),
          ownerKind: kind,
          ownerId,
          title: it.title,
          body: it.body,
          fireAt: it.fireAt,
          firedAt: null,
          snoozedUntil: null,
          dismissedAt: null,
        });
      }
      return ok();
    },
    async clearReminders(kind, ownerId) {
      db.reminders = db.reminders.filter((r) => !(r.ownerKind === kind && r.ownerId === ownerId && r.firedAt == null));
      return ok();
    },
    async snoozeReminder(id, minutes) {
      const r = db.reminders.find((x) => x.id === id);
      if (r) {
        r.fireAt = Date.now() + minutes * 60_000;
        r.snoozedUntil = r.fireAt;
        r.firedAt = null;
      }
      return ok();
    },
    async dismissReminder(id) {
      const r = db.reminders.find((x) => x.id === id);
      if (r) r.dismissedAt = Date.now();
      return ok();
    },
    onDataChanged: () => () => {},
    onReminder: (cb) => {
      reminderListeners.add(cb);
      return () => reminderListeners.delete(cb);
    },
  };
}

/** Test/introspection helper for the local backend. */
export function readLocalReminders(kv: KV): ReminderItem[] {
  try {
    return (JSON.parse(kv.getItem(KEY) ?? "{}") as LocalDB).reminders ?? [];
  } catch {
    return [];
  }
}
