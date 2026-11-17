//! System-wide keyboard shortcuts (work even when NEXUS is not focused).

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
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle_overlay: "CommandOrControl+Shift+Space".into(),
            toggle_click_through: "CommandOrControl+Shift+X".into(),
            quick_add: "CommandOrControl+Shift+N".into(),
            voice: "CommandOrControl+Shift+V".into(),
            show_main: "CommandOrControl+Shift+H".into(),
        }
    }
}

#[derive(Clone, Copy)]
enum Action {
    ToggleOverlay,
    ToggleClickThrough,
    QuickAdd,
    Voice,
    ShowMain,
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
    }
}

pub fn load(app: &AppHandle) -> Shortcuts {
    app.state::<AppState>()
        .store
        .lock()
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
    ];
    for (accel, action) in pairs {
        if accel.trim().is_empty() {
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
        let s = st.store.lock().map_err(|_| "database busy".to_string())?;
        s.set_setting("shortcuts", &serde_json::to_value(&shortcuts).map_err(friendly)?).map_err(friendly)?;
    }
    Ok(register(&app, &shortcuts))
}
