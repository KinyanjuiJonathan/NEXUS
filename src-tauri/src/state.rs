use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard, OnceLock};

use nexus_core::recovery::Problem;
use nexus_core::Store;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Commands answer with this while the database is still being opened; the UI waits and asks again.
pub const STARTING: &str = "NEXUS_STARTING: the database is still being opened";
/// Prefix of the answer when the database could not be opened; the UI shows the recovery screen.
pub const UNAVAILABLE: &str = "NEXUS_DATA_UNAVAILABLE";

/// The open database.
pub struct Db {
    pub store: Mutex<Store>,
}

/// Why start-up could not open the database.
#[derive(Clone)]
pub struct Failure {
    pub problem: Option<Problem>,
    pub message: String,
}

/// Shared application state managed by Tauri.
///
/// It is registered before any window exists, so a command can never find it
/// missing. The database itself arrives a moment later (`set_ready`); until
/// then, and if opening fails, commands get a clear answer instead of a crash.
pub struct AppState {
    db: OnceLock<Db>,
    /// Where the data lives, known as soon as start-up begins (even if the database cannot be opened).
    paths: OnceLock<(PathBuf, PathBuf)>,
    failure: Mutex<Option<Failure>>,
    /// Wakes the reminder scheduler early after reminders change.
    pub scheduler_wake: Mutex<Option<Sender<()>>>,
    pub click_through: AtomicBool,
    pub quitting: AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            db: OnceLock::new(),
            paths: OnceLock::new(),
            failure: Mutex::new(None),
            scheduler_wake: Mutex::new(None),
            click_through: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
        }
    }

    pub fn set_paths(&self, data_dir: PathBuf, db_path: PathBuf) {
        let _ = self.paths.set((data_dir, db_path));
    }

    /// The database is open: everything can use it from now on. Returns false if one was already set.
    pub fn set_ready(&self, store: Store) -> bool {
        if self.paths.get().is_none() {
            return false;
        }
        let ok = self.db.set(Db { store: Mutex::new(store) }).is_ok();
        if let Ok(mut f) = self.failure.lock() {
            *f = None;
        }
        ok
    }

    pub fn set_failed(&self, failure: Failure) {
        if let Ok(mut f) = self.failure.lock() {
            *f = Some(failure);
        }
    }

    pub fn failure(&self) -> Option<Failure> {
        self.failure.lock().ok().and_then(|f| f.clone())
    }

    pub fn is_ready(&self) -> bool {
        self.db.get().is_some()
    }

    /// The database, or why it cannot be used right now.
    pub fn db(&self) -> Result<&Db, String> {
        if let Some(db) = self.db.get() {
            return Ok(db);
        }
        match self.failure() {
            Some(f) => Err(format!("{UNAVAILABLE}: {}", f.message)),
            None => Err(STARTING.to_string()),
        }
    }

    /// Lock the store for one operation.
    pub fn store(&self) -> Result<MutexGuard<'_, Store>, String> {
        self.db()?.store.lock().map_err(|_| "the database is busy, please try again".to_string())
    }

    pub fn data_dir(&self) -> Option<&Path> {
        self.paths.get().map(|p| p.0.as_path())
    }

    pub fn db_path(&self) -> Option<&Path> {
        self.paths.get().map(|p| p.1.as_path())
    }

    pub fn backups_dir(&self) -> Option<PathBuf> {
        self.data_dir().map(|d| d.join("backups"))
    }

    pub fn wake_scheduler(&self) {
        if let Ok(guard) = self.scheduler_wake.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(());
            }
        }
    }

    pub fn is_click_through(&self) -> bool {
        self.click_through.load(Ordering::SeqCst)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataChanged {
    /// Label of the window that made the change (receivers ignore their own).
    pub origin: String,
    pub entity: String,
}

/// Notify every window that persisted data changed.
pub fn broadcast_change(app: &AppHandle, origin: &str, entity: &str) {
    let _ = app.emit("nexus://data-changed", DataChanged { origin: origin.into(), entity: entity.into() });
}

/// Errors cross the IPC boundary as friendly strings.
pub type CmdResult<T> = Result<T, String>;

pub fn friendly<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}
