//! Opening the database safely, and getting it back when that fails.
//!
//! The rules:
//! * A database that exists is never replaced by an empty one. If it cannot be
//!   opened, or fails its integrity check, opening fails and the file is left
//!   exactly as it was.
//! * If the database file is missing but backups exist, opening also fails:
//!   quietly starting empty would look like everything was lost.
//! * Recovery never deletes. Before a backup is put in place, or before
//!   starting fresh, the current file (with its `-wal` / `-shm` companions) is
//!   copied into the backups folder under a `nexus-set-aside-…` name.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::{migrations, Error, Result, Store};

/// Why the database could not be opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Problem {
    /// No database file, although backups of earlier data exist.
    Missing,
    /// The file is there but cannot be opened or read.
    Unreadable,
    /// The file opens but its contents are damaged.
    Corrupt,
    /// It was written by a newer NEXUS than this one.
    Newer,
}

#[derive(Debug)]
pub struct OpenFailure {
    pub problem: Problem,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub modified_ms: i64,
    /// Tasks and calendar entries in it (None when it cannot be read).
    pub tasks: Option<i64>,
    pub events: Option<i64>,
    /// Whether it passed its integrity check.
    pub valid: bool,
}

fn is_db(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("db")
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn companions(db: &Path) -> [PathBuf; 2] {
    let s = db.to_string_lossy();
    [PathBuf::from(format!("{s}-wal")), PathBuf::from(format!("{s}-shm"))]
}

/// Read-only look at a database file: (integrity ok, tasks, events).
pub fn inspect(path: &Path) -> (bool, Option<i64>, Option<i64>) {
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return (false, None, None);
    };
    let ok = conn.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)).map(|s| s == "ok").unwrap_or(false);
    let count = |table: &str| conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).ok();
    (ok, count("tasks"), count("events"))
}

/// Every `.db` file in the backups folder, newest first.
pub fn list_backups(dir: &Path) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = std::fs::read_dir(dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| is_db(p) && file_len(p) > 0).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let modified_ms = std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let (valid, tasks, events) = inspect(&p);
            BackupInfo {
                name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                bytes: file_len(&p),
                path: p.to_string_lossy().to_string(),
                modified_ms,
                tasks,
                events,
                valid,
            }
        })
        .collect();
    // newest first; the timestamp in the file name breaks ties between files written in the same instant
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| b.name.cmp(&a.name)));
    out
}

/// Open the database for normal use, refusing rather than risking the data.
pub fn open_checked(db_path: &Path, backups_dir: &Path) -> std::result::Result<Store, OpenFailure> {
    let exists = db_path.exists() && file_len(db_path) > 0;
    if !exists {
        let backups = list_backups(backups_dir);
        if !backups.is_empty() {
            return Err(OpenFailure {
                problem: Problem::Missing,
                message: format!(
                    "The NEXUS database is not where it should be ({}), but {} backup{} of earlier data exist.",
                    db_path.display(),
                    backups.len(),
                    if backups.len() == 1 { "" } else { "s" }
                ),
            });
        }
    }
    let store = Store::open(db_path).map_err(|e| OpenFailure {
        problem: if matches!(e, Error::NewerSchema { .. }) { Problem::Newer } else { Problem::Unreadable },
        message: e.to_string(),
    })?;
    if exists {
        match store.quick_check() {
            Ok(true) => {}
            Ok(false) => return Err(OpenFailure { problem: Problem::Corrupt, message: "The database failed its integrity check.".into() }),
            Err(e) => return Err(OpenFailure { problem: Problem::Corrupt, message: format!("The database could not be checked: {e}") }),
        }
    }
    Ok(store)
}

/// Copy the current database (and its `-wal` / `-shm` files) into the backups
/// folder, untouched. Returns the copy's path, or None when there was nothing to copy.
pub fn set_aside(db_path: &Path, backups_dir: &Path, now: i64) -> Result<Option<PathBuf>> {
    if !db_path.exists() {
        return Ok(None);
    }
    std::fs::create_dir_all(backups_dir)?;
    let target = backups_dir.join(format!("nexus-set-aside-{now:015}.db"));
    let copied = std::fs::copy(db_path, &target)?;
    if copied != file_len(db_path) {
        return Err(Error::Invalid("the safety copy of the current database is incomplete; nothing was changed".into()));
    }
    for (from, to) in companions(db_path).iter().zip(companions(&target).iter()) {
        if from.exists() {
            std::fs::copy(from, to)?;
        }
    }
    Ok(Some(target))
}

fn remove_current(db_path: &Path) -> Result<()> {
    for p in std::iter::once(db_path.to_path_buf()).chain(companions(db_path)) {
        if p.exists() {
            std::fs::remove_file(&p)?;
        }
    }
    Ok(())
}

/// A file is a usable NEXUS backup: it opens, passes its integrity check, has
/// the NEXUS tables and is not from a newer version.
pub fn validate_backup(backup: &Path) -> Result<()> {
    let src = Connection::open_with_flags(backup, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| Error::Invalid("that file is not a readable NEXUS backup".into()))?;
    let ok: String = src
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|_| Error::Invalid("that file is not a valid SQLite database".into()))?;
    if ok != "ok" {
        return Err(Error::Invalid(format!("that backup failed its integrity check: {ok}")));
    }
    let tables: i64 = src.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('tasks','events','settings')",
        [],
        |r| r.get(0),
    )?;
    if tables < 3 {
        return Err(Error::Invalid("that database is not a NEXUS backup".into()));
    }
    let v = migrations::current_version(&src)?;
    if v > migrations::LATEST {
        return Err(Error::NewerSchema { found: v, supported: migrations::LATEST });
    }
    Ok(())
}

/// Put a backup in place of a database that cannot be used. The backup is
/// checked first; the current file is copied aside before anything changes.
/// Returns the opened store and where the previous file was kept.
pub fn restore_into(db_path: &Path, backup: &Path, backups_dir: &Path, now: i64) -> Result<(Store, Option<PathBuf>)> {
    validate_backup(backup)?;
    let aside = set_aside(db_path, backups_dir, now)?;
    remove_current(db_path)?;
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::copy(backup, db_path)?;
    let store = Store::open(db_path)?;
    if !store.quick_check()? {
        return Err(Error::Invalid("the restored database failed its integrity check".into()));
    }
    Ok((store, aside))
}

/// Start with an empty database on purpose. Whatever was there is kept in the backups folder.
pub fn start_fresh(db_path: &Path, backups_dir: &Path, now: i64) -> Result<(Store, Option<PathBuf>)> {
    let aside = set_aside(db_path, backups_dir, now)?;
    remove_current(db_path)?;
    Ok((Store::open(db_path)?, aside))
}
