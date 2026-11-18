//! Auto Typer: replays a plan built by the UI as real keystrokes in whatever
//! window has focus, with a countdown, pause/resume and an optional lock that
//! keeps the typing in the text box it started in.
//!
//! The timing loop lives in `nexus_core::typer` (tested there); this module
//! supplies the Windows keyboard, focus tracking and progress events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use nexus_core::typer::PlanEvent;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::CmdResult;

pub const EVENT: &str = "nexus://typer";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TyperJob {
    events: Vec<PlanEvent>,
    /// Seconds to wait before the first key, so the user can click into the target.
    countdown: u32,
    /// Ignore mouse clicks while typing and pause if the target window changes.
    lock: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TyperStatus {
    /// "idle" | "countdown" | "waiting" | "typing" | "paused" | "done" | "stopped" | "error"
    pub state: String,
    pub seconds_left: Option<u32>,
    /// 0–1 share of planned keystrokes already sent.
    pub progress: f32,
    pub locked: bool,
    pub message: Option<String>,
}

pub struct TyperState {
    running: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    status: Arc<Mutex<TyperStatus>>,
}

impl TyperState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
            status: Arc::new(Mutex::new(TyperStatus { state: "idle".into(), ..Default::default() })),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Default for TyperState {
    fn default() -> Self {
        Self::new()
    }
}

/// Publishes status changes to every window and remembers the latest one.
#[cfg_attr(not(windows), allow(dead_code))]
struct Reporter {
    app: AppHandle,
    status: Arc<Mutex<TyperStatus>>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Reporter {
    fn set(&self, next: TyperStatus) {
        if let Ok(mut cur) = self.status.lock() {
            if *cur == next {
                return;
            }
            *cur = next.clone();
        }
        let _ = self.app.emit(EVENT, next);
    }
}

#[tauri::command]
pub fn typer_status(state: State<TyperState>) -> TyperStatus {
    state.status.lock().map(|s| s.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn typer_stop(state: State<TyperState>) {
    state.request_stop();
}

#[tauri::command]
pub fn typer_start(app: AppHandle, state: State<TyperState>, job: TyperJob) -> CmdResult<()> {
    if job.events.is_empty() {
        return Err("There is nothing to type.".into());
    }
    if job.events.len() > 2_000_000 {
        return Err("That text is too long to type in one go.".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (&app, &state, job.countdown, job.lock);
        Err("The Auto Typer sends keystrokes through Windows, so it only works in the Windows desktop app.".into())
    }
    #[cfg(windows)]
    {
        if state.running.swap(true, Ordering::SeqCst) {
            return Err("The Auto Typer is already running.".into());
        }
        state.stop.store(false, Ordering::SeqCst);
        let running = Arc::clone(&state.running);
        let stop = Arc::clone(&state.stop);
        let reporter = Reporter { app, status: Arc::clone(&state.status) };
        std::thread::Builder::new()
            .name("nexus-typer".into())
            .spawn(move || {
                win::run(job, stop, &reporter);
                running.store(false, Ordering::SeqCst);
            })
            .map_err(|e| {
                state.running.store(false, Ordering::SeqCst);
                format!("Could not start typing: {e}")
            })?;
        Ok(())
    }
}

/// Global shortcut: stop if typing, otherwise ask the main window to start.
pub fn toggle(app: &AppHandle) {
    let state = app.state::<TyperState>();
    if state.is_running() {
        state.request_stop();
    } else {
        let _ = app.emit_to("main", "nexus://typer-toggle", ());
    }
}

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use nexus_core::typer::{play, Host, Outcome};

    use super::{Reporter, TyperJob, TyperStatus};
    use crate::win_input::{escape_pressed, foreground, ClickBlocker, Keyboard};

    struct WinHost<'a> {
        keyboard: Keyboard,
        stop: Arc<AtomicBool>,
        reporter: &'a Reporter,
        started: Instant,
        lock: bool,
        /// The window typing is locked to (set once the user is in a window other than NEXUS).
        target: Option<isize>,
        blocker: Option<ClickBlocker>,
        focus: Option<(Instant, bool)>,
        progress: f32,
        reported: Instant,
    }

    impl WinHost<'_> {
        fn status(&self, state: &str, message: Option<&str>) {
            self.reporter.set(TyperStatus {
                state: state.into(),
                seconds_left: None,
                progress: self.progress,
                locked: self.blocker.is_some(),
                message: message.map(str::to_string),
            });
        }

        fn check_focus(&mut self) -> bool {
            let Some((hwnd, ours)) = foreground() else { return false };
            // Never type into NEXUS itself.
            if ours {
                return false;
            }
            if !self.lock {
                return true;
            }
            match self.target {
                Some(target) => target == hwnd,
                None => {
                    self.target = Some(hwnd);
                    self.blocker = ClickBlocker::start();
                    true
                }
            }
        }
    }

    impl Host for WinHost<'_> {
        fn key(&mut self, key: &str, down: bool) {
            self.keyboard.key(key, down);
        }

        fn can_type(&mut self) -> bool {
            // Asking Windows on every key would be wasteful; a tenth of a second is fresh enough.
            if let Some((at, ok)) = self.focus {
                if at.elapsed() < Duration::from_millis(100) {
                    return ok;
                }
            }
            let ok = self.check_focus();
            self.focus = Some((Instant::now(), ok));
            ok
        }

        fn stopped(&mut self) -> bool {
            self.stop.load(Ordering::SeqCst) || escape_pressed()
        }

        fn now(&mut self) -> f64 {
            self.started.elapsed().as_secs_f64()
        }

        fn sleep(&mut self, seconds: f64) {
            std::thread::sleep(Duration::from_secs_f64(seconds.max(0.0)));
        }

        fn paused(&mut self, paused: bool) {
            if !paused {
                self.status("typing", None);
            } else if self.lock && self.target.is_some() {
                self.status("paused", Some("Paused. Go back to the window you were typing in."));
            } else {
                self.status("waiting", Some("Click into the text box you want to type in."));
            }
        }

        fn progress(&mut self, done: usize, total: usize) {
            self.progress = if total == 0 { 1.0 } else { done as f32 / total as f32 };
            if self.reported.elapsed() >= Duration::from_millis(250) {
                self.reported = Instant::now();
                self.status("typing", None);
            }
        }
    }

    pub fn run(job: TyperJob, stop: Arc<AtomicBool>, reporter: &Reporter) {
        let halted = |stop: &AtomicBool| stop.load(Ordering::SeqCst) || escape_pressed();
        let idle = |state: &str, progress: f32, message: Option<&str>| {
            reporter.set(TyperStatus { state: state.into(), seconds_left: None, progress, locked: false, message: message.map(str::to_string) })
        };

        for left in (1..=job.countdown.min(600)).rev() {
            reporter.set(TyperStatus { state: "countdown".into(), seconds_left: Some(left), ..Default::default() });
            let until = Instant::now() + Duration::from_secs(1);
            while Instant::now() < until {
                if halted(&stop) {
                    return idle("stopped", 0.0, Some("Cancelled."));
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }

        let mut host = WinHost {
            keyboard: Keyboard::new(),
            stop,
            reporter,
            started: Instant::now(),
            lock: job.lock,
            target: None,
            blocker: None,
            focus: None,
            progress: 0.0,
            reported: Instant::now(),
        };
        host.status("typing", None);
        let outcome = play(&job.events, &mut host);
        let progress = host.progress;
        // Releases any key still held, restores Caps Lock and lets clicks through again.
        drop(host);
        match outcome {
            Outcome::Finished => idle("done", 1.0, Some("Done.")),
            Outcome::Stopped => idle("stopped", progress, Some("Stopped.")),
        }
    }
}
