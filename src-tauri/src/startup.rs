//! Opening the database at start-up, and the recovery commands for when that fails.
//!
//! Order of events:
//! 1. `AppState` is registered on the builder, before any window exists, so no
//!    command can ever find the state missing (that was the cause of
//!    "state not managed for field 'state' on command 'load_snapshot'").
//! 2. `init` opens the database first thing in setup. Until it has, commands
//!    answer "still starting" and the UI waits and asks again.
//! 3. If the database cannot be opened, nothing is created or overwritten: the
//!    failure is kept, the app still starts, and the UI shows the recovery
//!    screen (try again, restore a backup, open the folder, or start fresh).

use std::path::Path;

use nexus_core::recovery::{self, BackupInfo, Problem};
use nexus_core::{now_ms, Store};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::state::{broadcast_change, friendly, AppState, CmdResult, Failure};
use crate::{overlay, scheduler, shortcuts};

/// Daily backups kept, and the more frequent ones.
const KEEP_DAILY: usize = 14;
const KEEP_RECENT: usize = 8;

fn housekeeping(store: &Store, data_dir: &Path) {
    let now = now_ms();
    let _ = store.purge_expired(now);
    let dir = data_dir.join("backups");
    if let Err(e) = store.auto_backup(&dir, KEEP_DAILY, now) {
        log::warn!("automatic backup failed: {e}");
    }
    if let Err(e) = store.recent_backup(&dir, KEEP_RECENT, now) {
        log::warn!("recent backup failed: {e}");
    }
}

/// Everything that needs the database: reminders, shortcuts, the overlay's saved state.
fn after_open(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(db_path) = state.db_path().map(Path::to_path_buf) else {
        return;
    };
    let sc = shortcuts::load(app);
    let failed = shortcuts::register(app, &sc);
    if !failed.is_empty() {
        log::warn!("some shortcuts are in use by other apps: {failed:?}");
    }
    scheduler::start(app.clone(), db_path);
    overlay::restore(app);
}

/// Open the database. Called first thing in setup; never fails the app.
pub fn init(app: &AppHandle) {
    let state = app.state::<AppState>();
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            state.set_failed(Failure { problem: None, message: format!("The folder for NEXUS data could not be found: {e}") });
            return;
        }
    };
    let db_path = data_dir.join("nexus.db");
    state.set_paths(data_dir.clone(), db_path.clone());
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        state.set_failed(Failure { problem: None, message: format!("The data folder {} could not be created: {e}", data_dir.display()) });
        return;
    }
    match recovery::open_checked(&db_path, &data_dir.join("backups")) {
        Ok(store) => {
            housekeeping(&store, &data_dir);
            state.set_ready(store);
            after_open(app);
        }
        Err(f) => {
            log::error!("the database could not be opened: {}", f.message);
            state.set_failed(Failure { problem: Some(f.problem), message: f.message });
        }
    }
}

/// Backups every few hours while NEXUS stays open (it can run for days in the tray).
pub fn start_backup_timer(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("nexus-backups".into()).spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30 * 60));
        let state = app.state::<AppState>();
        let Some(dir) = state.data_dir().map(Path::to_path_buf) else {
            continue;
        };
        if let Ok(store) = state.store() {
            housekeeping(&store, &dir);
        };
    });
    if let Err(e) = spawned {
        log::warn!("the backup timer could not start: {e}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupStatus {
    /// "starting", "ready" or "failed".
    pub state: &'static str,
    pub problem: Option<Problem>,
    pub message: String,
    pub data_dir: String,
    pub db_path: String,
    pub db_exists: bool,
    pub db_bytes: u64,
    pub backups: Vec<BackupInfo>,
}

/// What start-up found: used by the recovery screen.
#[tauri::command]
pub fn startup_status(state: State<AppState>) -> StartupStatus {
    let failure = state.failure();
    let db_path = state.db_path().map(Path::to_path_buf);
    let bytes = db_path.as_deref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()).unwrap_or(0);
    StartupStatus {
        state: if state.is_ready() { "ready" } else if failure.is_some() { "failed" } else { "starting" },
        problem: failure.as_ref().and_then(|f| f.problem),
        message: failure.map(|f| f.message).unwrap_or_default(),
        data_dir: state.data_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        db_path: db_path.as_deref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        db_exists: bytes > 0,
        db_bytes: bytes,
        backups: state.backups_dir().map(|d| recovery::list_backups(&d)).unwrap_or_default(),
    }
}

fn paths(state: &AppState) -> CmdResult<(std::path::PathBuf, std::path::PathBuf)> {
    match (state.db_path(), state.backups_dir()) {
        (Some(db), Some(backups)) => Ok((db.to_path_buf(), backups)),
        _ => Err("The NEXUS data folder is not known yet.".into()),
    }
}

fn finish(app: &AppHandle, win: &WebviewWindow, store: Store) -> CmdResult<()> {
    let state = app.state::<AppState>();
    if let Some(dir) = state.data_dir() {
        housekeeping(&store, dir);
    }
    if !state.set_ready(store) {
        return Err("The database is already open.".into());
    }
    after_open(app);
    broadcast_change(app, win.label(), "all");
    Ok(())
}

/// Try opening the database again, exactly as at start-up. Nothing is changed if it still fails.
#[tauri::command]
pub fn startup_retry(app: AppHandle, win: WebviewWindow, state: State<AppState>) -> CmdResult<()> {
    if state.is_ready() {
        return Ok(());
    }
    let (db, backups) = paths(&state)?;
    match recovery::open_checked(&db, &backups) {
        Ok(store) => finish(&app, &win, store),
        Err(f) => {
            state.set_failed(Failure { problem: Some(f.problem), message: f.message.clone() });
            Err(f.message)
        }
    }
}

/// Put a backup in place of the database that cannot be used. The current file
/// is copied into the backups folder first. Returns where it was kept.
#[tauri::command]
pub fn startup_restore(app: AppHandle, win: WebviewWindow, state: State<AppState>, path: String) -> CmdResult<Option<String>> {
    if state.is_ready() {
        return Err("The database is open. Restore a backup from Settings → Data instead.".into());
    }
    let (db, backups) = paths(&state)?;
    let (store, aside) = recovery::restore_into(&db, Path::new(&path), &backups, now_ms()).map_err(friendly)?;
    finish(&app, &win, store)?;
    Ok(aside.map(|p| p.to_string_lossy().to_string()))
}

/// Start with an empty database, on the user's explicit request. Whatever is
/// there now is copied into the backups folder first.
#[tauri::command]
pub fn startup_fresh(app: AppHandle, win: WebviewWindow, state: State<AppState>) -> CmdResult<Option<String>> {
    if state.is_ready() {
        return Err("The database is open; there is nothing to reset.".into());
    }
    let (db, backups) = paths(&state)?;
    let (store, aside) = recovery::start_fresh(&db, &backups, now_ms()).map_err(friendly)?;
    finish(&app, &win, store)?;
    Ok(aside.map(|p| p.to_string_lossy().to_string()))
}

/// Show the data folder in the file manager.
#[tauri::command]
pub fn open_data_folder(state: State<AppState>) -> CmdResult<()> {
    let dir = state.data_dir().ok_or("The NEXUS data folder is not known yet.")?;
    let program = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(program).arg(dir).spawn().map(|_| ()).map_err(|e| format!("Could not open the folder ({e})."))
}
