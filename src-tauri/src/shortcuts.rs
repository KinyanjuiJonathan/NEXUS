//! System-wide keyboard shortcuts (work even when NEXUS is not focused).

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::state::{friendly, AppState, CmdResult};
use crate::{overlay, show_main};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    pub toggle_overlay: String,
    pub toggle_click_through: String,
    pub quick_add: String,
    pub voice: String,
    pub show_main: String,
    /// Added later than the others: older saved shortcut sets don't have it.
    #[serde(default = "default_toggle_typer")]
    pub toggle_typer: String,
}

fn default_toggle_typer() -> String {
    "F6".into()
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle_overlay: "CommandOrControl+Shift+Space".into(),
            toggle_click_through: "CommandOrControl+Shift+X".into(),
            quick_add: "CommandOrControl+Shift+N".into(),
            voice: "CommandOrControl+Shift+V".into(),
            show_main: "CommandOrControl+Shift+H".into(),
            toggle_typer: default_toggle_typer(),
        }
    }
}

/// The Auto Typer shortcut is a bare function key by default, so it is only
/// claimed while the Auto Typer screen is open; other apps keep the key the rest of the time.
static TYPER_SHORTCUT_ON: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy)]
enum Action {
    ToggleOverlay,
    ToggleClickThrough,
    QuickAdd,
    Voice,
    ShowMain,
    ToggleTyper,
}

fn run(app: &AppHandle, action: Action) {
    match action {
        Action::ToggleOverlay => {
            let _ = overlay::toggle(app);
        }
        Action::ToggleClickThrough => {
            let _ = overlay::toggle_click_through(app);
        }
        Action::QuickAdd => {
            show_main(app);
            let _ = app.emit_to("main", "nexus://quick-add", ());
        }
        Action::Voice => {
            // Prefer the overlay when it is visible and interactive, otherwise the main window.
            let overlay_visible = app.get_webview_window(overlay::LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(false);
            if overlay_visible && !app.state::<AppState>().is_click_through() {
                let _ = app.emit_to(overlay::LABEL, "nexus://voice", ());
            } else {
                show_main(app);
                let _ = app.emit_to("main", "nexus://voice", ());
            }
        }
        Action::ShowMain => show_main(app),
        Action::ToggleTyper => crate::typer::toggle(app),
    }
}

pub fn load(app: &AppHandle) -> Shortcuts {
    app.state::<AppState>()
        .store()
        .ok()
        .and_then(|s| s.get_setting("shortcuts").ok().flatten())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// (Re)register all shortcuts. Returns the ones that failed (e.g. taken by another app).
pub fn register(app: &AppHandle, sc: &Shortcuts) -> Vec<String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut failed = vec![];
    let pairs = [
        (&sc.toggle_overlay, Action::ToggleOverlay),
        (&sc.toggle_click_through, Action::ToggleClickThrough),
        (&sc.quick_add, Action::QuickAdd),
        (&sc.voice, Action::Voice),
        (&sc.show_main, Action::ShowMain),
        (&sc.toggle_typer, Action::ToggleTyper),
    ];
    for (accel, action) in pairs {
        if accel.trim().is_empty() {
            continue;
        }
        if matches!(action, Action::ToggleTyper) && !TYPER_SHORTCUT_ON.load(Ordering::SeqCst) {
            continue;
        }
        let res = gs.on_shortcut(accel.as_str(), move |app, _sc, ev| {
            if ev.state == ShortcutState::Pressed {
                run(app, action);
            }
        });
        if let Err(e) = res {
            log::warn!("shortcut {accel} could not be registered: {e}");
            failed.push(accel.clone());
        }
    }
    failed
}

/// Save new shortcuts and apply them. Returns accelerators that could not be registered.
#[tauri::command]
pub fn shortcuts_apply(app: AppHandle, shortcuts: Shortcuts) -> CmdResult<Vec<String>> {
    {
        let st = app.state::<AppState>();
        let s = st.store()?;
        s.set_setting("shortcuts", &serde_json::to_value(&shortcuts).map_err(friendly)?).map_err(friendly)?;
    }
    Ok(register(&app, &shortcuts))
}

/// Claim or give back the Auto Typer shortcut (the UI calls this as its screen opens and closes).
#[tauri::command]
pub fn typer_shortcut(app: AppHandle, enabled: bool) -> Vec<String> {
    TYPER_SHORTCUT_ON.store(enabled, Ordering::SeqCst);
    register(&app, &load(&app))
}
