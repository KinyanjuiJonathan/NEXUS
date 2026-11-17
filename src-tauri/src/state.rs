use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Mutex;

use nexus_core::Store;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Shared application state managed by Tauri.
pub struct AppState {
    pub store: Mutex<Store>,
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    /// Wakes the reminder scheduler early after reminders change.
    pub scheduler_wake: Mutex<Option<Sender<()>>>,
    pub click_through: AtomicBool,
    pub quitting: AtomicBool,
}

impl AppState {
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
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
