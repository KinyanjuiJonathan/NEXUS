//! Background reminder scheduler.
//!
//! Runs on its own thread inside the NEXUS process for as long as the app is
//! running — including when every window is hidden in the tray — so reminders
//! fire while the UI is minimized. It reads pending reminders from SQLite and
//! compares wall-clock time on every pass, which makes it robust to sleep /
//! hibernate: after resume, anything that became due fires on the next pass
//! (at most 15 s later). Reminders that are more than 12 hours stale (e.g. the
//! PC was off overnight) are marked as missed instead of spamming the user.

use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;

use nexus_core::{now_ms, Store};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::state::AppState;

const MAX_SLEEP_MS: i64 = 15_000;
const STALE_MS: i64 = 12 * 3600 * 1000;

pub fn start(app: AppHandle, db_path: PathBuf) {
    let (tx, rx) = channel::<()>();
    if let Ok(mut slot) = app.state::<AppState>().scheduler_wake.lock() {
        *slot = Some(tx);
    }
    std::thread::Builder::new()
        .name("nexus-reminders".into())
        .spawn(move || {
            let store = match Store::open(&db_path) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("reminder scheduler could not open the database: {e}");
                    return;
                }
            };
            loop {
                let now = now_ms();
                match store.due_reminders(now) {
                    Ok(due) => {
                        let mut missed = 0;
                        for r in due {
                            if now - r.fire_at > STALE_MS {
                                missed += 1;
                                let _ = store.mark_fired(&r.id, now);
                                continue;
                            }
                            let _ = app.notification().builder().title(&r.title).body(&r.body).show();
                            let _ = app.emit("nexus://reminder", &r);
                            let _ = store.mark_fired(&r.id, now);
                        }
                        if missed > 0 {
                            let _ = app
                                .notification()
                                .builder()
                                .title("NEXUS")
                                .body(format!("{missed} reminder(s) were missed while your PC was off. Open NEXUS to review overdue items."))
                                .show();
                        }
                    }
                    Err(e) => log::warn!("reminder query failed: {e}"),
                }
                if app.state::<AppState>().quitting.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let next = store.next_fire_at().ok().flatten();
                let wait = next.map(|n| (n - now_ms()).clamp(250, MAX_SLEEP_MS)).unwrap_or(MAX_SLEEP_MS);
                match rx.recv_timeout(Duration::from_millis(wait as u64)) {
                    Ok(()) | Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        })
        .expect("failed to spawn reminder thread");
}
