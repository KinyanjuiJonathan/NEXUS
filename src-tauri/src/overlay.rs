//! Floating overlay window: always-on-top, click-through, show/hide.
//!
//! The overlay is a normal top-most (HWND_TOPMOST) window. It stays above
//! ordinary desktop windows but deliberately does not try to draw over
//! exclusive-fullscreen games, the secure desktop (UAC / lock screen) or
//! protected content — those are OS security boundaries.

use std::sync::atomic::Ordering;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{friendly, AppState, CmdResult};

pub const LABEL: &str = "overlay";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub visible: bool,
    pub click_through: bool,
    pub pinned: bool,
}

fn pinned(app: &AppHandle) -> bool {
    let st = app.state::<AppState>();
    let value = st
        .store
        .lock()
        .ok()
        .and_then(|s| s.get_setting("overlayPinned").ok().flatten())
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    value
}

fn emit_state(app: &AppHandle) {
    let st = app.state::<AppState>();
    let visible = app.get_webview_window(LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    let pinned = pinned(app);
    let _ = app.emit(
        "nexus://overlay-state",
        OverlayState { visible, click_through: st.is_click_through(), pinned },
    );
}

fn persist(app: &AppHandle, key: &str, value: serde_json::Value) {
    let st = app.state::<AppState>();
    if let Ok(s) = st.store.lock() {
        let _ = s.set_setting(key, &value);
    };
}

pub fn set_visible(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        if visible {
            w.show()?;
            // Re-assert top-most each time it is shown (other apps may have claimed it).
            w.set_always_on_top(pinned(app))?;
        } else {
            w.hide()?;
        }
    }
    persist(app, "overlayVisible", json!(visible));
    emit_state(app);
    Ok(())
}

pub fn toggle(app: &AppHandle) -> tauri::Result<()> {
    let visible = app.get_webview_window(LABEL).and_then(|w| w.is_visible().ok()).unwrap_or(false);
    set_visible(app, !visible)
}

pub fn set_click_through(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    let st = app.state::<AppState>();
    st.click_through.store(enabled, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(LABEL) {
        w.set_ignore_cursor_events(enabled)?;
    }
    persist(app, "overlayClickThrough", json!(enabled));
    emit_state(app);
    Ok(())
}

pub fn toggle_click_through(app: &AppHandle) -> tauri::Result<()> {
    let enabled = !app.state::<AppState>().is_click_through();
    set_click_through(app, enabled)
}

#[tauri::command]
pub fn overlay_show(app: AppHandle, visible: bool) -> CmdResult<()> {
    set_visible(&app, visible).map_err(friendly)
}

#[tauri::command]
pub fn overlay_toggle(app: AppHandle) -> CmdResult<()> {
    toggle(&app).map_err(friendly)
}

#[tauri::command]
pub fn overlay_set_click_through(app: AppHandle, enabled: bool) -> CmdResult<()> {
    set_click_through(&app, enabled).map_err(friendly)
}

#[tauri::command]
pub fn overlay_set_pinned(app: AppHandle, pinned: bool) -> CmdResult<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.set_always_on_top(pinned).map_err(friendly)?;
    }
    persist(&app, "overlayPinned", json!(pinned));
    emit_state(&app);
    Ok(())
}

#[tauri::command]
pub fn overlay_state(app: AppHandle, state: State<AppState>) -> CmdResult<OverlayState> {
    let w = app.get_webview_window(LABEL);
    Ok(OverlayState {
        visible: w.and_then(|w| w.is_visible().ok()).unwrap_or(false),
        click_through: state.is_click_through(),
        pinned: pinned(&app),
    })
}

/// Restore overlay visibility / click-through / pin from the last session.
pub fn restore(app: &AppHandle) {
    let st = app.state::<AppState>();
    let (visible, click, pinned, on_startup) = match st.store.lock() {
        Ok(s) => {
            let b = |k: &str, d: bool| s.get_setting(k).ok().flatten().and_then(|v| v.as_bool()).unwrap_or(d);
            (b("overlayVisible", false), b("overlayClickThrough", false), b("overlayPinned", true), b("overlayOnStartup", false))
        }
        Err(_) => (false, false, true, false),
    };
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_always_on_top(pinned);
    }
    // Never come back click-through while hidden; it would be confusing.
    let _ = set_click_through(app, click && (visible || on_startup));
    if visible || on_startup {
        let _ = set_visible(app, true);
    }
}
