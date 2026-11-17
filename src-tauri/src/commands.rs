//! IPC commands for persistence. Every mutation is written to SQLite
//! immediately (auto-save) and broadcast to the other windows.

use std::path::PathBuf;

use nexus_core::{now_ms, CalendarEvent, Category, ExportBundle, FocusSession, PlannedReminder, Reminder, Snapshot, Task, Timer};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};

use crate::state::{broadcast_change, friendly, AppState, CmdResult};

macro_rules! store {
    ($state:expr) => {
        $state.store.lock().map_err(|_| "the database is busy, please try again".to_string())?
    };
}

#[tauri::command]
pub fn load_snapshot(state: State<AppState>) -> CmdResult<Snapshot> {
    store!(state).load_snapshot().map_err(friendly)
}

#[tauri::command]
pub fn task_upsert(app: AppHandle, win: WebviewWindow, state: State<AppState>, task: Task) -> CmdResult<()> {
    store!(state).upsert_task(&task).map_err(friendly)?;
    broadcast_change(&app, win.label(), "tasks");
    Ok(())
}

#[tauri::command]
pub fn task_delete(app: AppHandle, win: WebviewWindow, state: State<AppState>, id: String) -> CmdResult<()> {
    store!(state).delete_task(&id).map_err(friendly)?;
    broadcast_change(&app, win.label(), "tasks");
    Ok(())
}

#[tauri::command]
pub fn tasks_reorder(app: AppHandle, win: WebviewWindow, state: State<AppState>, ids: Vec<String>) -> CmdResult<()> {
    store!(state).reorder_tasks(&ids).map_err(friendly)?;
    broadcast_change(&app, win.label(), "tasks");
    Ok(())
}

#[tauri::command]
pub fn category_upsert(app: AppHandle, win: WebviewWindow, state: State<AppState>, category: Category) -> CmdResult<()> {
    store!(state).upsert_category(&category).map_err(friendly)?;
    broadcast_change(&app, win.label(), "categories");
    Ok(())
}

#[tauri::command]
pub fn category_delete(app: AppHandle, win: WebviewWindow, state: State<AppState>, id: String, fallback: String) -> CmdResult<()> {
    store!(state).delete_category(&id, &fallback).map_err(friendly)?;
    broadcast_change(&app, win.label(), "categories");
    Ok(())
}

#[tauri::command]
pub fn event_upsert(app: AppHandle, win: WebviewWindow, state: State<AppState>, event: CalendarEvent) -> CmdResult<()> {
    store!(state).upsert_event(&event).map_err(friendly)?;
    broadcast_change(&app, win.label(), "events");
    Ok(())
}

#[tauri::command]
pub fn event_delete(app: AppHandle, win: WebviewWindow, state: State<AppState>, id: String) -> CmdResult<()> {
    store!(state).delete_event(&id).map_err(friendly)?;
    broadcast_change(&app, win.label(), "events");
    Ok(())
}

#[tauri::command]
pub fn timer_upsert(app: AppHandle, win: WebviewWindow, state: State<AppState>, timer: Timer) -> CmdResult<()> {
    store!(state).upsert_timer(&timer).map_err(friendly)?;
    broadcast_change(&app, win.label(), "timers");
    Ok(())
}

#[tauri::command]
pub fn timer_delete(app: AppHandle, win: WebviewWindow, state: State<AppState>, id: String) -> CmdResult<()> {
    store!(state).delete_timer(&id).map_err(friendly)?;
    broadcast_change(&app, win.label(), "timers");
    Ok(())
}

#[tauri::command]
pub fn focus_add(app: AppHandle, win: WebviewWindow, state: State<AppState>, session: FocusSession) -> CmdResult<()> {
    store!(state).add_focus_session(&session).map_err(friendly)?;
    broadcast_change(&app, win.label(), "focus");
    Ok(())
}

#[tauri::command]
pub fn setting_set(app: AppHandle, win: WebviewWindow, state: State<AppState>, key: String, value: Value) -> CmdResult<()> {
    store!(state).set_setting(&key, &value).map_err(friendly)?;
    broadcast_change(&app, win.label(), "settings");
    Ok(())
}

// ------------------------------------------------------------------ reminders

#[tauri::command]
pub fn reminders_sync(
    state: State<AppState>,
    owner_kind: String,
    owner_id: String,
    items: Vec<PlannedReminder>,
) -> CmdResult<()> {
    store!(state).sync_reminders(&owner_kind, &owner_id, &items).map_err(friendly)?;
    state.wake_scheduler();
    Ok(())
}

#[tauri::command]
pub fn reminders_clear(state: State<AppState>, owner_kind: String, owner_id: String) -> CmdResult<()> {
    store!(state).clear_reminders(&owner_kind, &owner_id).map_err(friendly)?;
    state.wake_scheduler();
    Ok(())
}

#[tauri::command]
pub fn reminder_snooze(state: State<AppState>, id: String, minutes: i64) -> CmdResult<Option<Reminder>> {
    let r = store!(state).snooze_reminder(&id, minutes, now_ms()).map_err(friendly)?;
    state.wake_scheduler();
    Ok(r)
}

#[tauri::command]
pub fn reminder_dismiss(state: State<AppState>, id: String) -> CmdResult<()> {
    store!(state).dismiss_reminder(&id, now_ms()).map_err(friendly)
}

#[tauri::command]
pub fn reminders_upcoming(state: State<AppState>, limit: Option<i64>) -> CmdResult<Vec<Reminder>> {
    store!(state).upcoming_reminders(now_ms(), limit.unwrap_or(20)).map_err(friendly)
}

// ------------------------------------------------------------------ backup / export

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    db_path: String,
    data_dir: String,
    backups_dir: String,
    schema_version: i64,
    backups: Vec<String>,
}

#[tauri::command]
pub fn data_info(state: State<AppState>) -> CmdResult<DataInfo> {
    let version = store!(state).schema_version().map_err(friendly)?;
    let dir = state.backups_dir();
    let mut backups: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path().to_string_lossy().to_string())).collect())
        .unwrap_or_default();
    backups.sort();
    backups.reverse();
    Ok(DataInfo {
        db_path: state.db_path.to_string_lossy().into(),
        data_dir: state.data_dir.to_string_lossy().into(),
        backups_dir: dir.to_string_lossy().into(),
        schema_version: version,
        backups,
    })
}

/// Write a full database backup. With no path, writes into the backups folder.
#[tauri::command]
pub fn backup_create(state: State<AppState>, path: Option<String>) -> CmdResult<String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => state.backups_dir().join(format!("nexus-manual-{:015}.db", now_ms())),
    };
    store!(state).backup_to(&target).map_err(friendly)?;
    Ok(target.to_string_lossy().into())
}

#[tauri::command]
pub fn backup_restore(app: AppHandle, win: WebviewWindow, state: State<AppState>, path: String) -> CmdResult<String> {
    let safety = state.backups_dir().join(format!("nexus-before-restore-{:015}.db", now_ms()));
    store!(state).restore_from(&path, &safety).map_err(friendly)?;
    state.wake_scheduler();
    broadcast_change(&app, win.label(), "all");
    Ok(safety.to_string_lossy().into())
}

#[tauri::command]
pub fn export_json(state: State<AppState>, path: String) -> CmdResult<()> {
    let bundle = store!(state).export_bundle().map_err(friendly)?;
    let text = serde_json::to_string_pretty(&bundle).map_err(friendly)?;
    std::fs::write(&path, text).map_err(|e| format!("could not write the export file: {e}"))
}

#[tauri::command]
pub fn import_json(app: AppHandle, win: WebviewWindow, state: State<AppState>, path: String) -> CmdResult<String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("could not read the file: {e}"))?;
    let bundle: ExportBundle = serde_json::from_str(&text).map_err(|_| "that file is not a NEXUS JSON export".to_string())?;
    let safety = state.backups_dir().join(format!("nexus-before-import-{:015}.db", now_ms()));
    {
        let mut s = store!(state);
        s.backup_to(&safety).map_err(friendly)?;
        s.import_bundle(&bundle).map_err(friendly)?;
    }
    state.wake_scheduler();
    broadcast_change(&app, win.label(), "all");
    Ok(safety.to_string_lossy().into())
}
