//! NEXUS persistence layer.
//!
//! A single SQLite file (WAL mode) holds all user data. The Tauri app wraps a
//! [`Store`] in a mutex for UI commands; the reminder scheduler opens its own
//! [`Store`] on the same file (WAL allows concurrent readers/writer).

pub mod activity;
pub mod migrations;
pub mod models;
pub mod perf;
pub mod recovery;
pub mod typer;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

pub use models::*;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("data format error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
    #[error("this database was created by a newer version of NEXUS (schema v{found}, this build supports v{supported}). Please update NEXUS.")]
    NewerSchema { found: i64, supported: i64 },
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const TRASH_RETENTION_MS: i64 = 30 * 24 * 3600 * 1000;

pub struct Store {
    conn: Connection,
    path: Option<PathBuf>,
}

fn json_vec(s: String) -> Vec<i64> {
    serde_json::from_str(&s).unwrap_or_default()
}

fn json_opt(s: Option<String>) -> Option<Value> {
    s.and_then(|v| serde_json::from_str(&v).ok()).filter(|v: &Value| !v.is_null())
}

fn opt_json_string(v: &Option<Value>) -> Option<String> {
    v.as_ref().filter(|v| !v.is_null()).map(|v| v.to_string())
}

fn validate_priority(p: &str) -> Result<()> {
    match p {
        "critical" | "high" | "medium" | "low" => Ok(()),
        _ => Err(Error::Invalid(format!("unknown priority '{p}'"))),
    }
}

impl Store {
    /// Open (or create) the database file, back it up if a migration is
    /// pending, then migrate.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let existed = path.exists() && std::fs::metadata(&path)?.len() > 0;
        let mut conn = Connection::open(&path)?;
        Self::configure(&conn)?;
        let version = migrations::current_version(&conn)?;
        if version > migrations::LATEST {
            return Err(Error::NewerSchema { found: version, supported: migrations::LATEST });
        }
        if existed && version > 0 && version < migrations::LATEST {
            let dir = path.parent().map(|p| p.join("backups")).unwrap_or_else(|| PathBuf::from("backups"));
            std::fs::create_dir_all(&dir)?;
            let target = dir.join(format!("nexus-pre-v{}-{}.db", migrations::LATEST, now_ms()));
            vacuum_into(&conn, &target)?;
        }
        migrations::migrate(&mut conn)?;
        Ok(Self { conn, path: Some(path) })
    }

    /// In-memory database (tests).
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        Self::configure(&conn)?;
        migrations::migrate(&mut conn)?;
        Ok(Self { conn, path: None })
    }

    fn configure(conn: &Connection) -> Result<()> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// True when the database passes SQLite's quick integrity check.
    pub fn quick_check(&self) -> Result<bool> {
        let r: String = self.conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        Ok(r == "ok")
    }

    /// Write everything still in the write-ahead log into the database file itself.
    pub fn checkpoint(&self) -> Result<()> {
        self.conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }

    pub fn schema_version(&self) -> Result<i64> {
        migrations::current_version(&self.conn)
    }

    // ------------------------------------------------------------ snapshot

    pub fn load_snapshot(&self) -> Result<Snapshot> {
        let focus_since = now_ms() - 400 * 24 * 3600 * 1000;
        Ok(Snapshot {
            tasks: self.list_tasks()?,
            categories: self.list_categories()?,
            events: self.list_events()?,
            timers: self.list_timers()?,
            focus_sessions: self.list_focus_sessions(focus_since)?,
            settings: self.all_settings()?,
            work_sessions: self.list_work_sessions(focus_since)?,
            activity: self.list_activity(now_ms() - 400 * 24 * 3600 * 1000, 5000)?,
        })
    }

    // ------------------------------------------------------------ work sessions & history

    pub fn list_work_sessions(&self, since: i64) -> Result<Vec<WorkSession>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, started_at, ended_at, pauses, note, created_at, updated_at FROM work_sessions WHERE started_at >= ?1 OR ended_at IS NULL ORDER BY started_at",
        )?;
        let rows = stmt.query_map([since], |r| {
            Ok(WorkSession {
                id: r.get(0)?,
                started_at: r.get(1)?,
                ended_at: r.get(2)?,
                pauses: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Array(vec![])),
                note: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn upsert_work_session(&self, w: &WorkSession) -> Result<()> {
        if let Some(end) = w.ended_at {
            if end < w.started_at {
                return Err(Error::Invalid("a work session cannot end before it starts".into()));
            }
        }
        if !w.pauses.is_array() {
            return Err(Error::Invalid("pauses must be a list".into()));
        }
        self.conn.execute(
            r#"INSERT INTO work_sessions (id, started_at, ended_at, pauses, note, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
               ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at, ended_at=excluded.ended_at, pauses=excluded.pauses,
                 note=excluded.note, updated_at=excluded.updated_at"#,
            params![w.id, w.started_at, w.ended_at, w.pauses.to_string(), w.note, w.created_at, w.updated_at],
        )?;
        Ok(())
    }

    pub fn delete_work_session(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM work_sessions WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn add_activity(&self, a: &ActivityEntry) -> Result<()> {
        if a.title.trim().is_empty() || a.kind.trim().is_empty() {
            return Err(Error::Invalid("activity entries need a kind and a title".into()));
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO activity_log (id, at, kind, title, detail, ref_id) VALUES (?1,?2,?3,?4,?5,?6)",
            params![a.id, a.at, a.kind, a.title, a.detail, a.ref_id],
        )?;
        Ok(())
    }

    /// Empty the history log. Nothing else is touched.
    pub fn clear_activity(&self) -> Result<()> {
        self.conn.execute("DELETE FROM activity_log", [])?;
        Ok(())
    }

    /// Newest-first history since `since`, at most `limit` entries.
    pub fn list_activity(&self, since: i64, limit: i64) -> Result<Vec<ActivityEntry>> {
        let mut stmt = self.conn.prepare("SELECT id, at, kind, title, detail, ref_id FROM activity_log WHERE at >= ?1 ORDER BY at DESC LIMIT ?2")?;
        let rows = stmt.query_map(params![since, limit], |r| {
            Ok(ActivityEntry { id: r.get(0)?, at: r.get(1)?, kind: r.get(2)?, title: r.get(3)?, detail: r.get(4)?, ref_id: r.get(5)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Permanently remove items that sat in the trash longer than 30 days and
    /// fired reminders older than 30 days.
    pub fn purge_expired(&self, now: i64) -> Result<usize> {
        let cutoff = now - TRASH_RETENTION_MS;
        let mut n = self.conn.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ?1", [cutoff])?;
        n += self.conn.execute("DELETE FROM events WHERE deleted_at IS NOT NULL AND deleted_at < ?1", [cutoff])?;
        n += self.conn.execute(
            "DELETE FROM reminders WHERE (fired_at IS NOT NULL OR dismissed_at IS NOT NULL) AND fire_at < ?1",
            [cutoff],
        )?;
        Ok(n)
    }

    // ------------------------------------------------------------ tasks

    fn row_to_task(r: &Row) -> rusqlite::Result<Task> {
        Ok(Task {
            id: r.get("id")?,
            title: r.get("title")?,
            notes: r.get("notes")?,
            priority: r.get("priority")?,
            category_id: r.get("category_id")?,
            status: r.get("status")?,
            due_at: r.get("due_at")?,
            due_tz: r.get("due_tz")?,
            estimate_min: r.get("estimate_min")?,
            spent_ms: r.get("spent_ms")?,
            sort_order: r.get("sort_order")?,
            recurrence: json_opt(r.get("recurrence")?),
            reminders: json_vec(r.get("reminders")?),
            subtasks: vec![],
            completed_at: r.get("completed_at")?,
            archived_at: r.get("archived_at")?,
            deleted_at: r.get("deleted_at")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    }

    pub fn list_tasks(&self) -> Result<Vec<Task>> {
        let mut stmt = self.conn.prepare("SELECT * FROM tasks ORDER BY sort_order, created_at")?;
        let mut tasks: Vec<Task> = stmt.query_map([], Self::row_to_task)?.collect::<rusqlite::Result<_>>()?;
        let mut sub = self.conn.prepare("SELECT id, task_id, title, done FROM subtasks ORDER BY sort_order")?;
        let mut by_task: BTreeMap<String, Vec<Subtask>> = BTreeMap::new();
        for row in sub.query_map([], |r| {
            Ok((r.get::<_, String>(1)?, Subtask { id: r.get(0)?, title: r.get(2)?, done: r.get::<_, i64>(3)? != 0 }))
        })? {
            let (tid, s) = row?;
            by_task.entry(tid).or_default().push(s);
        }
        for t in &mut tasks {
            if let Some(s) = by_task.remove(&t.id) {
                t.subtasks = s;
            }
        }
        Ok(tasks)
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>> {
        let t = self.conn.query_row("SELECT * FROM tasks WHERE id = ?1", [id], Self::row_to_task).optional()?;
        Ok(match t {
            Some(mut t) => {
                let mut stmt = self.conn.prepare("SELECT id, title, done FROM subtasks WHERE task_id = ?1 ORDER BY sort_order")?;
                t.subtasks = stmt
                    .query_map([id], |r| Ok(Subtask { id: r.get(0)?, title: r.get(1)?, done: r.get::<_, i64>(2)? != 0 }))?
                    .collect::<rusqlite::Result<_>>()?;
                Some(t)
            }
            None => None,
        })
    }

    /// Insert or fully replace a task (and its subtasks) atomically.
    pub fn upsert_task(&mut self, t: &Task) -> Result<()> {
        if t.title.trim().is_empty() {
            return Err(Error::Invalid("a task needs a title".into()));
        }
        validate_priority(&t.priority)?;
        let tx = self.conn.transaction()?;
        tx.execute(
            r#"INSERT INTO tasks (id, title, notes, priority, category_id, status, due_at, due_tz, estimate_min,
                 spent_ms, sort_order, recurrence, reminders, completed_at, archived_at, deleted_at, created_at, updated_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, notes=excluded.notes, priority=excluded.priority,
                 category_id=excluded.category_id, status=excluded.status, due_at=excluded.due_at,
                 due_tz=excluded.due_tz, estimate_min=excluded.estimate_min, spent_ms=excluded.spent_ms,
                 sort_order=excluded.sort_order, recurrence=excluded.recurrence, reminders=excluded.reminders,
                 completed_at=excluded.completed_at, archived_at=excluded.archived_at,
                 deleted_at=excluded.deleted_at, updated_at=excluded.updated_at"#,
            params![
                t.id, t.title.trim(), t.notes, t.priority, t.category_id, t.status, t.due_at, t.due_tz,
                t.estimate_min, t.spent_ms, t.sort_order, opt_json_string(&t.recurrence),
                serde_json::to_string(&t.reminders)?, t.completed_at, t.archived_at, t.deleted_at,
                t.created_at, t.updated_at
            ],
        )?;
        tx.execute("DELETE FROM subtasks WHERE task_id = ?1", [&t.id])?;
        for (i, s) in t.subtasks.iter().enumerate() {
            tx.execute(
                "INSERT INTO subtasks (id, task_id, title, done, sort_order) VALUES (?1,?2,?3,?4,?5)",
                params![s.id, t.id, s.title, s.done as i64, i as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Permanent delete (the UI normally soft-deletes via `deleted_at`).
    pub fn delete_task(&mut self, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
        tx.execute("UPDATE events SET task_id = NULL WHERE task_id = ?1", [id])?;
        tx.execute("DELETE FROM reminders WHERE owner_kind = 'task' AND owner_id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Persist a manual drag-and-drop order.
    pub fn reorder_tasks(&mut self, ids: &[String]) -> Result<()> {
        let tx = self.conn.transaction()?;
        let now = now_ms();
        for (i, id) in ids.iter().enumerate() {
            tx.execute("UPDATE tasks SET sort_order = ?1, updated_at = ?2 WHERE id = ?3", params![i as f64, now, id])?;
        }
        tx.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------ categories

    pub fn list_categories(&self) -> Result<Vec<Category>> {
        let mut stmt = self.conn.prepare("SELECT id, name, color, icon, builtin, sort_order FROM categories ORDER BY sort_order")?;
        let rows = stmt.query_map([], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                icon: r.get(3)?,
                builtin: r.get::<_, i64>(4)? != 0,
                sort_order: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn upsert_category(&self, c: &Category) -> Result<()> {
        if c.name.trim().is_empty() {
            return Err(Error::Invalid("a category needs a name".into()));
        }
        self.conn.execute(
            r#"INSERT INTO categories (id, name, color, icon, builtin, sort_order) VALUES (?1,?2,?3,?4,?5,?6)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, icon=excluded.icon, sort_order=excluded.sort_order"#,
            params![c.id, c.name.trim(), c.color, c.icon, c.builtin as i64, c.sort_order],
        )?;
        Ok(())
    }

    /// Delete a custom category; its tasks move to `fallback`.
    pub fn delete_category(&mut self, id: &str, fallback: &str) -> Result<()> {
        let builtin: Option<i64> = self.conn.query_row("SELECT builtin FROM categories WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        if builtin == Some(1) {
            return Err(Error::Invalid("built-in categories cannot be deleted".into()));
        }
        let tx = self.conn.transaction()?;
        tx.execute("UPDATE tasks SET category_id = ?1 WHERE category_id = ?2", params![fallback, id])?;
        tx.execute("DELETE FROM categories WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------ events

    fn row_to_event(r: &Row) -> rusqlite::Result<CalendarEvent> {
        Ok(CalendarEvent {
            id: r.get("id")?,
            title: r.get("title")?,
            notes: r.get("notes")?,
            start_at: r.get("start_at")?,
            end_at: r.get("end_at")?,
            tz: r.get("tz")?,
            task_id: r.get("task_id")?,
            recurrence: json_opt(r.get("recurrence")?),
            important: r.get::<_, i64>("important")? != 0,
            reminders: json_vec(r.get("reminders")?),
            color: r.get("color")?,
            fixed: Some(r.get::<_, i64>("fixed")? != 0),
            sched: json_opt(r.get("sched")?),
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
            deleted_at: r.get("deleted_at")?,
        })
    }

    pub fn list_events(&self) -> Result<Vec<CalendarEvent>> {
        let mut stmt = self.conn.prepare("SELECT * FROM events ORDER BY start_at")?;
        let rows = stmt.query_map([], Self::row_to_event)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn upsert_event(&self, e: &CalendarEvent) -> Result<()> {
        if e.title.trim().is_empty() {
            return Err(Error::Invalid("an appointment needs a title".into()));
        }
        if e.end_at < e.start_at {
            return Err(Error::Invalid("an appointment cannot end before it starts".into()));
        }
        if e.tz.trim().is_empty() {
            return Err(Error::Invalid("an appointment needs a time zone".into()));
        }
        self.conn.execute(
            r#"INSERT INTO events (id, title, notes, start_at, end_at, tz, task_id, recurrence, important, reminders,
                 color, created_at, updated_at, deleted_at, fixed, sched)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, notes=excluded.notes, start_at=excluded.start_at, end_at=excluded.end_at,
                 tz=excluded.tz, task_id=excluded.task_id, recurrence=excluded.recurrence,
                 important=excluded.important, reminders=excluded.reminders, color=excluded.color,
                 updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
                 fixed=excluded.fixed, sched=excluded.sched"#,
            params![
                e.id, e.title.trim(), e.notes, e.start_at, e.end_at, e.tz, e.task_id,
                opt_json_string(&e.recurrence), e.important as i64, serde_json::to_string(&e.reminders)?,
                e.color, e.created_at, e.updated_at, e.deleted_at,
                // Data from before fixed appointments existed: an appointment without a task is fixed.
                e.fixed.unwrap_or(e.task_id.is_none()) as i64, opt_json_string(&e.sched)
            ],
        )?;
        Ok(())
    }

    pub fn delete_event(&mut self, id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM events WHERE id = ?1", [id])?;
        tx.execute("DELETE FROM reminders WHERE owner_kind = 'event' AND owner_id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------ timers & focus

    pub fn list_timers(&self) -> Result<Vec<Timer>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, label, task_id, duration_ms, started_at, accumulated_ms, state, phase, cycle, created_at, updated_at FROM timers ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Timer {
                id: r.get(0)?,
                kind: r.get(1)?,
                label: r.get(2)?,
                task_id: r.get(3)?,
                duration_ms: r.get(4)?,
                started_at: r.get(5)?,
                accumulated_ms: r.get(6)?,
                state: r.get(7)?,
                phase: r.get(8)?,
                cycle: r.get(9)?,
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn upsert_timer(&self, t: &Timer) -> Result<()> {
        self.conn.execute(
            r#"INSERT INTO timers (id, kind, label, task_id, duration_ms, started_at, accumulated_ms, state, phase, cycle, created_at, updated_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
               ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, label=excluded.label, task_id=excluded.task_id,
                 duration_ms=excluded.duration_ms, started_at=excluded.started_at, accumulated_ms=excluded.accumulated_ms,
                 state=excluded.state, phase=excluded.phase, cycle=excluded.cycle, updated_at=excluded.updated_at"#,
            params![
                t.id, t.kind, t.label, t.task_id, t.duration_ms, t.started_at, t.accumulated_ms, t.state, t.phase,
                t.cycle, t.created_at, t.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn delete_timer(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM timers WHERE id = ?1", [id])?;
        self.conn.execute("DELETE FROM reminders WHERE owner_kind = 'timer' AND owner_id = ?1", [id])?;
        Ok(())
    }

    pub fn add_focus_session(&self, s: &FocusSession) -> Result<()> {
        if s.ended_at < s.started_at || s.duration_ms < 0 {
            return Err(Error::Invalid("invalid focus session".into()));
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO focus_sessions (id, task_id, kind, started_at, ended_at, duration_ms) VALUES (?1,?2,?3,?4,?5,?6)",
            params![s.id, s.task_id, s.kind, s.started_at, s.ended_at, s.duration_ms],
        )?;
        Ok(())
    }

    pub fn list_focus_sessions(&self, since: i64) -> Result<Vec<FocusSession>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, task_id, kind, started_at, ended_at, duration_ms FROM focus_sessions WHERE started_at >= ?1 ORDER BY started_at",
        )?;
        let rows = stmt.query_map([since], |r| {
            Ok(FocusSession {
                id: r.get(0)?,
                task_id: r.get(1)?,
                kind: r.get(2)?,
                started_at: r.get(3)?,
                ended_at: r.get(4)?,
                duration_ms: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ------------------------------------------------------------ settings

    pub fn all_settings(&self) -> Result<BTreeMap<String, Value>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings")?;
        let mut out = BTreeMap::new();
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (k, v) = row?;
            if let Ok(v) = serde_json::from_str(&v) {
                out.insert(k, v);
            }
        }
        Ok(out)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<Value>> {
        let v: Option<String> = self.conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?;
        Ok(v.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![key, value.to_string(), now_ms()],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM app_meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------ reminders

    /// Replace the *pending* reminders of an owner (fired & snoozed ones are kept).
    pub fn sync_reminders(&mut self, owner_kind: &str, owner_id: &str, items: &[PlannedReminder]) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM reminders WHERE owner_kind = ?1 AND owner_id = ?2 AND fired_at IS NULL AND snoozed_until IS NULL AND dismissed_at IS NULL",
            params![owner_kind, owner_id],
        )?;
        let now = now_ms();
        for it in items {
            tx.execute(
                "INSERT INTO reminders (id, owner_kind, owner_id, title, body, fire_at, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![new_id(), owner_kind, owner_id, it.title, it.body, it.fire_at, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Remove every pending reminder of an owner (e.g. task completed/deleted).
    pub fn clear_reminders(&self, owner_kind: &str, owner_id: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM reminders WHERE owner_kind = ?1 AND owner_id = ?2 AND fired_at IS NULL",
            params![owner_kind, owner_id],
        )?;
        Ok(())
    }

    fn row_to_reminder(r: &Row) -> rusqlite::Result<Reminder> {
        Ok(Reminder {
            id: r.get("id")?,
            owner_kind: r.get("owner_kind")?,
            owner_id: r.get("owner_id")?,
            title: r.get("title")?,
            body: r.get("body")?,
            fire_at: r.get("fire_at")?,
            fired_at: r.get("fired_at")?,
            snoozed_until: r.get("snoozed_until")?,
            dismissed_at: r.get("dismissed_at")?,
        })
    }

    /// Reminders that should fire now.
    pub fn due_reminders(&self, now: i64) -> Result<Vec<Reminder>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM reminders WHERE fired_at IS NULL AND dismissed_at IS NULL AND fire_at <= ?1 ORDER BY fire_at LIMIT 50",
        )?;
        let rows = stmt.query_map([now], Self::row_to_reminder)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn upcoming_reminders(&self, now: i64, limit: i64) -> Result<Vec<Reminder>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM reminders WHERE fired_at IS NULL AND dismissed_at IS NULL AND fire_at > ?1 ORDER BY fire_at LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![now, limit], Self::row_to_reminder)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Earliest pending fire time (lets the scheduler sleep precisely).
    pub fn next_fire_at(&self) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row("SELECT MIN(fire_at) FROM reminders WHERE fired_at IS NULL AND dismissed_at IS NULL", [], |r| r.get(0))?)
    }

    pub fn mark_fired(&self, id: &str, at: i64) -> Result<()> {
        self.conn.execute("UPDATE reminders SET fired_at = ?1 WHERE id = ?2", params![at, id])?;
        Ok(())
    }

    pub fn snooze_reminder(&self, id: &str, minutes: i64, now: i64) -> Result<Option<Reminder>> {
        let until = now + minutes.clamp(1, 24 * 60) * 60_000;
        let n = self.conn.execute(
            "UPDATE reminders SET fire_at = ?1, snoozed_until = ?1, fired_at = NULL, dismissed_at = NULL WHERE id = ?2",
            params![until, id],
        )?;
        if n == 0 {
            return Ok(None);
        }
        Ok(self.conn.query_row("SELECT * FROM reminders WHERE id = ?1", [id], Self::row_to_reminder).optional()?)
    }

    pub fn dismiss_reminder(&self, id: &str, now: i64) -> Result<()> {
        self.conn.execute("UPDATE reminders SET dismissed_at = ?1 WHERE id = ?2", params![now, id])?;
        Ok(())
    }

    // ------------------------------------------------------------ backup / restore / export

    /// Consistent full copy of the database (safe while the app is running).
    pub fn backup_to(&self, target: impl AsRef<Path>) -> Result<()> {
        let target = target.as_ref();
        if target.exists() {
            std::fs::remove_file(target)?;
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        vacuum_into(&self.conn, target)
    }

    /// Restore from a NEXUS `.db` backup. The current data is first saved to
    /// `safety_copy` so a bad restore can be undone.
    pub fn restore_from(&mut self, source: impl AsRef<Path>, safety_copy: impl AsRef<Path>) -> Result<()> {
        let source = source.as_ref();
        let src = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| Error::Invalid("that file is not a readable NEXUS backup".into()))?;
        let ok: String = src
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|_| Error::Invalid("that file is not a valid SQLite database".into()))?;
        if ok != "ok" {
            return Err(Error::Invalid(format!("backup failed its integrity check: {ok}")));
        }
        let has_tasks: i64 = src.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('tasks','events','settings')",
            [],
            |r| r.get(0),
        )?;
        if has_tasks < 3 {
            return Err(Error::Invalid("that database is not a NEXUS backup".into()));
        }
        let v = migrations::current_version(&src)?;
        if v > migrations::LATEST {
            return Err(Error::NewerSchema { found: v, supported: migrations::LATEST });
        }
        self.backup_to(safety_copy)?;
        {
            let backup = rusqlite::backup::Backup::new(&src, &mut self.conn)?;
            backup.run_to_completion(256, std::time::Duration::from_millis(0), None)?;
        }
        migrations::migrate(&mut self.conn)?;
        Ok(())
    }

    pub fn export_bundle(&self) -> Result<ExportBundle> {
        let mut stmt = self.conn.prepare("SELECT * FROM reminders WHERE fired_at IS NULL AND dismissed_at IS NULL")?;
        let reminders = stmt.query_map([], Self::row_to_reminder)?.collect::<rusqlite::Result<_>>()?;
        Ok(ExportBundle {
            app: "NEXUS".into(),
            schema_version: self.schema_version()?,
            exported_at: now_ms(),
            data: Snapshot {
                tasks: self.list_tasks()?,
                categories: self.list_categories()?,
                events: self.list_events()?,
                timers: self.list_timers()?,
                focus_sessions: self.list_focus_sessions(0)?,
                settings: self.all_settings()?,
                work_sessions: self.list_work_sessions(0)?,
                activity: self.list_activity(0, i64::MAX)?,
            },
            reminders,
        })
    }

    /// Replace all data with an export bundle, atomically.
    pub fn import_bundle(&mut self, b: &ExportBundle) -> Result<()> {
        if b.app != "NEXUS" {
            return Err(Error::Invalid("that file is not a NEXUS export".into()));
        }
        let tx = self.conn.transaction()?;
        for table in ["subtasks", "tasks", "events", "timers", "focus_sessions", "reminders", "settings", "work_sessions", "activity_log"] {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.execute("DELETE FROM categories WHERE builtin = 0", [])?;
        tx.commit()?;
        for c in &b.data.categories {
            self.upsert_category(c)?;
        }
        for t in &b.data.tasks {
            self.upsert_task(t)?;
        }
        for e in &b.data.events {
            self.upsert_event(e)?;
        }
        for t in &b.data.timers {
            self.upsert_timer(t)?;
        }
        for s in &b.data.focus_sessions {
            self.add_focus_session(s)?;
        }
        for (k, v) in &b.data.settings {
            self.set_setting(k, v)?;
        }
        for w in &b.data.work_sessions {
            self.upsert_work_session(w)?;
        }
        for a in &b.data.activity {
            self.add_activity(a)?;
        }
        for r in &b.reminders {
            self.conn.execute(
                "INSERT INTO reminders (id, owner_kind, owner_id, title, body, fire_at, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![r.id, r.owner_kind, r.owner_id, r.title, r.body, r.fire_at, now_ms()],
            )?;
        }
        Ok(())
    }

    /// Daily rolling backup in `dir`, keeping the newest `keep` files.
    /// Returns the path written, or None if one was already taken in the last 20 hours.
    pub fn auto_backup(&self, dir: impl AsRef<Path>, keep: usize, now: i64) -> Result<Option<PathBuf>> {
        self.rolling_backup(dir, "nexus-auto-", "last_auto_backup", 20 * 3600 * 1000, keep, now)
    }

    /// A second, more frequent set of backups (every few hours while NEXUS runs),
    /// so a bad day loses hours of work at most, not the whole day.
    pub fn recent_backup(&self, dir: impl AsRef<Path>, keep: usize, now: i64) -> Result<Option<PathBuf>> {
        self.rolling_backup(dir, "nexus-recent-", "last_recent_backup", 3 * 3600 * 1000, keep, now)
    }

    /// One rolling set of backups: at most one per `min_gap_ms`, the newest `keep` are kept.
    /// Only files of this set (same prefix) are ever removed.
    fn rolling_backup(&self, dir: impl AsRef<Path>, prefix: &str, meta_key: &str, min_gap_ms: i64, keep: usize, now: i64) -> Result<Option<PathBuf>> {
        let last: i64 = self.get_meta(meta_key)?.and_then(|s| s.parse().ok()).unwrap_or(0);
        if now - last < min_gap_ms {
            return Ok(None);
        }
        let dir = dir.as_ref();
        std::fs::create_dir_all(dir)?;
        let target = dir.join(format!("{prefix}{now:015}.db"));
        self.backup_to(&target)?;
        self.set_meta(meta_key, &now.to_string())?;
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(prefix) && n.ends_with(".db")))
            .collect();
        files.sort();
        while files.len() > keep.max(1) {
            let old = files.remove(0);
            let _ = std::fs::remove_file(old);
        }
        Ok(Some(target))
    }
}

fn vacuum_into(conn: &Connection, target: &Path) -> Result<()> {
    let p = target.to_string_lossy().to_string();
    conn.execute("VACUUM INTO ?1", [p])?;
    Ok(())
}
