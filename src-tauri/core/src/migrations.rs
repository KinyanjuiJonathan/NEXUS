//! Versioned schema migrations using `PRAGMA user_version`.
//!
//! Rules (see docs/ARCHITECTURE.md):
//! * Migrations are append-only. Never edit a released migration — add a new one.
//! * Each migration runs inside its own transaction together with the
//!   `user_version` bump, so a failure leaves the database at the previous version.
//! * Before migrating an existing database, `Store::open` writes a full copy to
//!   `backups/nexus-pre-v{N}-{timestamp}.db`.
//! * A database created by a *newer* NEXUS (user_version > LATEST) is refused
//!   rather than risk corrupting it.

use rusqlite::Connection;

use crate::Result;

pub const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    r#"
    CREATE TABLE categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL,
        icon        TEXT NOT NULL DEFAULT 'tag',
        builtin     INTEGER NOT NULL DEFAULT 0,
        sort_order  REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE tasks (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        notes         TEXT NOT NULL DEFAULT '',
        priority      TEXT NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('critical','high','medium','low')),
        category_id   TEXT NOT NULL DEFAULT 'work',
        status        TEXT NOT NULL DEFAULT 'todo'
                      CHECK (status IN ('todo','in_progress','done')),
        due_at        INTEGER,
        due_tz        TEXT,
        estimate_min  INTEGER,
        spent_ms      INTEGER NOT NULL DEFAULT 0,
        sort_order    REAL NOT NULL DEFAULT 0,
        recurrence    TEXT,
        reminders     TEXT NOT NULL DEFAULT '[]',
        completed_at  INTEGER,
        archived_at   INTEGER,
        deleted_at    INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_due      ON tasks(due_at);
    CREATE INDEX idx_tasks_status   ON tasks(status, deleted_at, archived_at);
    CREATE INDEX idx_tasks_complete ON tasks(completed_at);

    CREATE TABLE subtasks (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        done        INTEGER NOT NULL DEFAULT 0,
        sort_order  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_subtasks_task ON subtasks(task_id, sort_order);

    CREATE TABLE events (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        notes       TEXT NOT NULL DEFAULT '',
        start_at    INTEGER NOT NULL,
        end_at      INTEGER NOT NULL,
        tz          TEXT NOT NULL,
        task_id     TEXT,
        recurrence  TEXT,
        important   INTEGER NOT NULL DEFAULT 0,
        reminders   TEXT NOT NULL DEFAULT '[]',
        color       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        deleted_at  INTEGER,
        CHECK (end_at >= start_at)
    );
    CREATE INDEX idx_events_start ON events(start_at);

    CREATE TABLE timers (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK (kind IN ('countdown','stopwatch','pomodoro')),
        label           TEXT NOT NULL DEFAULT '',
        task_id         TEXT,
        duration_ms     INTEGER NOT NULL DEFAULT 0,
        started_at      INTEGER,
        accumulated_ms  INTEGER NOT NULL DEFAULT 0,
        state           TEXT NOT NULL DEFAULT 'idle',
        phase           TEXT,
        cycle           INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
    );

    CREATE TABLE focus_sessions (
        id           TEXT PRIMARY KEY,
        task_id      TEXT,
        kind         TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER NOT NULL,
        duration_ms  INTEGER NOT NULL
    );
    CREATE INDEX idx_focus_started ON focus_sessions(started_at);

    CREATE TABLE reminders (
        id             TEXT PRIMARY KEY,
        owner_kind     TEXT NOT NULL,
        owner_id       TEXT NOT NULL,
        title          TEXT NOT NULL,
        body           TEXT NOT NULL DEFAULT '',
        fire_at        INTEGER NOT NULL,
        fired_at       INTEGER,
        snoozed_until  INTEGER,
        dismissed_at   INTEGER,
        created_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_reminders_due   ON reminders(fired_at, dismissed_at, fire_at);
    CREATE INDEX idx_reminders_owner ON reminders(owner_kind, owner_id);

    CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
    );

    INSERT INTO categories (id, name, color, icon, builtin, sort_order) VALUES
        ('work',     'Work',     '#38bdf8', 'briefcase', 1, 0),
        ('personal', 'Personal', '#a78bfa', 'user',      1, 1),
        ('projects', 'Projects', '#22d3ee', 'folder',    1, 2),
        ('meetings', 'Meetings', '#f472b6', 'users',     1, 3);
    "#,
    // v2 — app metadata (last auto-backup etc.) kept separate from user settings
    r#"
    CREATE TABLE app_meta (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
    "#,
    // v3 — clock in/out work sessions and an activity history log.
    // Existing completed tasks and focus sessions are back-filled into the log.
    r#"
    CREATE TABLE work_sessions (
        id          TEXT PRIMARY KEY,
        started_at  INTEGER NOT NULL,
        ended_at    INTEGER,
        pauses      TEXT NOT NULL DEFAULT '[]',
        note        TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_work_started ON work_sessions(started_at);

    CREATE TABLE activity_log (
        id      TEXT PRIMARY KEY,
        at      INTEGER NOT NULL,
        kind    TEXT NOT NULL,
        title   TEXT NOT NULL,
        detail  TEXT NOT NULL DEFAULT '',
        ref_id  TEXT
    );
    CREATE INDEX idx_activity_at ON activity_log(at);

    INSERT INTO activity_log (id, at, kind, title, detail, ref_id)
        SELECT 'bf-task-' || id, completed_at, 'task_completed', title, '', id
        FROM tasks WHERE completed_at IS NOT NULL;
    INSERT INTO activity_log (id, at, kind, title, detail, ref_id)
        SELECT 'bf-focus-' || f.id, f.ended_at, 'focus', COALESCE(t.title, 'Focus session'),
               CAST(f.duration_ms / 60000 AS TEXT) || ' min', f.task_id
        FROM focus_sessions f LEFT JOIN tasks t ON t.id = f.task_id;
    "#,
    // v4 — fixed appointments vs flexible time blocks, and scheduling metadata.
    // Existing appointments (not linked to a task) become fixed, so the automatic
    // scheduler never moves them; time blocks reserved for a task stay flexible.
    r#"
    ALTER TABLE events ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE events ADD COLUMN sched TEXT;
    UPDATE events SET fixed = 1 WHERE task_id IS NULL;
    "#,
];

pub const LATEST: i64 = MIGRATIONS.len() as i64;

pub fn current_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Apply all pending migrations. Returns (from, to).
pub fn migrate(conn: &mut Connection) -> Result<(i64, i64)> {
    let from = current_version(conn)?;
    if from > LATEST {
        return Err(crate::Error::NewerSchema { found: from, supported: LATEST });
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(from as usize) {
        let version = i as i64 + 1;
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok((from, LATEST))
}
