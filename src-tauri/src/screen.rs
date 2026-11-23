//! Screen text for the Auto Typer's "mirror a region" mode: letting the user
//! mark a rectangle on the screen, and reading the text inside it.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::state::{friendly, CmdResult};

const PICKER: &str = "region";
pub const PICKED: &str = "nexus://region-picked";

/// A rectangle on the screen, in physical pixels of the virtual desktop.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// A rectangle inside the picker window, in CSS pixels.
#[derive(Deserialize)]
pub struct CssRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// The text currently shown in a region of the screen, one string per line.
#[tauri::command]
pub async fn screen_read(region: Region) -> CmdResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || read(region)).await.map_err(friendly)?
}

#[cfg(windows)]
fn read(r: Region) -> CmdResult<Vec<String>> {
    crate::win_screen::read_region(r.x, r.y, r.w, r.h)
}

#[cfg(not(windows))]
fn read(_r: Region) -> CmdResult<Vec<String>> {
    Err("Reading text from the screen uses Windows text recognition, so it only works in the Windows desktop app.".into())
}

/// Show the full-screen picker over the monitor NEXUS is on. NEXUS itself steps
/// aside so the user can see what they want to mark. The answer arrives as the
/// `nexus://region-picked` event.
#[tauri::command]
pub async fn region_pick(app: AppHandle) -> CmdResult<()> {
    let main = app.get_webview_window("main");
    let monitor = main
        .as_ref()
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No screen was found.")?;
    let pos = *monitor.position();
    let size = *monitor.size();
    if let Some(old) = app.get_webview_window(PICKER) {
        let _ = old.close();
    }
    if let Some(m) = &main {
        let _ = m.minimize();
    }
    let picker = WebviewWindowBuilder::new(&app, PICKER, WebviewUrl::App("index.html?window=region".into()))
        .title("NEXUS: select a region")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(friendly)?;
    let _ = picker.set_position(PhysicalPosition::new(pos.x, pos.y));
    let _ = picker.set_size(PhysicalSize::new(size.width, size.height));
    let _ = picker.show();
    let _ = picker.set_focus();
    Ok(())
}

/// The picker is finished: `rect` is what the user marked (None when cancelled).
#[tauri::command]
pub fn region_done(app: AppHandle, win: WebviewWindow, rect: Option<CssRect>) -> CmdResult<()> {
    let picked = rect.and_then(|r| {
        let scale = win.scale_factor().ok()?;
        let origin = win.outer_position().ok()?;
        let px = |v: f64| (v * scale).round() as i32;
        let region = Region { x: origin.x + px(r.x), y: origin.y + px(r.y), w: px(r.w), h: px(r.h) };
        (region.w >= 8 && region.h >= 8).then_some(region)
    });
    let _ = win.close();
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.unminimize();
        let _ = m.show();
        let _ = m.set_focus();
    }
    app.emit(PICKED, picked).map_err(friendly)
}
