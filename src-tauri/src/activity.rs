//! Background activity monitor.
//!
//! Once a second this samples system-wide keyboard/mouse idle time and the
//! lock state, feeds `nexus_core::activity::Tracker`, and broadcasts its
//! away / back events (with exact timestamps) as `nexus://activity`. The work
//! clock in the UI is driven by those events, so it stays accurate while the
//! NEXUS window is minimised or hidden and across lock, sleep and resume.
//!
//! It also records a heartbeat, so time while NEXUS was not running at all
//! (closed, crashed, PC switched off) is never counted as work.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use nexus_core::activity::{Sample, Tracker};
use nexus_core::now_ms;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;

pub const EVENT: &str = "nexus://activity";
pub const HEARTBEAT_KEY: &str = "workHeartbeat";
const DEFAULT_THRESHOLD_MS: u64 = 60_000;
/// Idle time after which running focus timers are paused too.
const LONG_IDLE_MS: u64 = 5 * 60_000;
const HEARTBEAT_EVERY: u32 = 30;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    /// False where system-wide activity can't be read (anything but Windows).
    pub supported: bool,
    pub away: bool,
    /// When the user went away (epoch ms), while away.
    pub since: Option<i64>,
    pub idle_seconds: Option<u64>,
    pub locked: bool,
}

pub struct ActivityState {
    threshold_ms: AtomicU64,
    snapshot: Mutex<ActivitySnapshot>,
}

impl ActivityState {
    pub fn new() -> Self {
        Self { threshold_ms: AtomicU64::new(DEFAULT_THRESHOLD_MS), snapshot: Mutex::new(ActivitySnapshot::default()) }
    }
}

impl Default for ActivityState {
    fn default() -> Self {
        Self::new()
    }
}

/// (milliseconds since the last input, session locked)
#[cfg(windows)]
fn sample(check_lock: bool, was_locked: bool) -> Option<(u64, bool)> {
    let idle = crate::win_session::idle_ms()?;
    // The lock query is a call into the session service: every other second is plenty.
    let locked = if check_lock { crate::win_session::session_locked() } else { was_locked };
    Some((idle, locked))
}

#[cfg(not(windows))]
fn sample(_check_lock: bool, _was_locked: bool) -> Option<(u64, bool)> {
    None
}

/// Remember that NEXUS was running and watching at this moment.
pub fn beat(app: &AppHandle) {
    if let Ok(store) = app.state::<AppState>().store.lock() {
        let _ = store.set_setting(HEARTBEAT_KEY, &json!(now_ms()));
    };
}

pub fn start(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("nexus-activity".into()).spawn(move || {
        let started = Instant::now();
        let mut tracker = Tracker::new(DEFAULT_THRESHOLD_MS, LONG_IDLE_MS);
        let mut locked = false;
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                break;
            }
            tick = tick.wrapping_add(1);
            let state = app.state::<ActivityState>();
            if let Some((idle_ms, now_locked)) = sample(tick.is_multiple_of(2), locked) {
                locked = now_locked;
                tracker.set_threshold(state.threshold_ms.load(Ordering::Relaxed));
                let events = tracker.feed(Sample { now_ms: now_ms(), mono_ms: started.elapsed().as_millis() as u64, idle_ms, locked });
                if let Ok(mut snap) = state.snapshot.lock() {
                    *snap = ActivitySnapshot {
                        supported: true,
                        away: tracker.away_since().is_some(),
                        since: tracker.away_since(),
                        idle_seconds: Some(idle_ms / 1000),
                        locked,
                    };
                }
                for event in events {
                    let _ = app.emit(EVENT, event);
                }
            }
            if tick.is_multiple_of(HEARTBEAT_EVERY) {
                beat(&app);
            }
        }
    });
    if let Err(e) = spawned {
        log::warn!("activity monitor could not start: {e}");
    }
}

#[tauri::command]
pub fn activity_state(state: State<ActivityState>) -> ActivitySnapshot {
    state.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Set how long without input counts as away (the work clock's idle limit).
#[tauri::command]
pub fn activity_configure(state: State<ActivityState>, idle_seconds: u64) {
    state.threshold_ms.store(idle_seconds.clamp(5, 24 * 3600) * 1000, Ordering::Relaxed);
}
