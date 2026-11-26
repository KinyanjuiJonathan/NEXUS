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

/// One line of text read off the screen, with its box inside the region (physical pixels).
#[cfg(windows)]
pub type ScreenLine = crate::win_screen::Line;

#[cfg(not(windows))]
#[derive(Clone, Debug, Serialize)]
pub struct ScreenLine {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// The text currently shown in a region of the screen, one entry per line, with where each line sits.
#[tauri::command]
pub async fn screen_read(region: Region) -> CmdResult<Vec<ScreenLine>> {
    tauri::async_runtime::spawn_blocking(move || read(region)).await.map_err(friendly)?
}

#[cfg(windows)]
fn read(r: Region) -> CmdResult<Vec<ScreenLine>> {
    crate::win_screen::read_region(r.x, r.y, r.w, r.h)
}

#[cfg(not(windows))]
fn read(_r: Region) -> CmdResult<Vec<ScreenLine>> {
    Err("Reading text from the screen uses Windows text recognition, so it only works in the Windows desktop app.".into())
}

const FRAME: &str = "frame";
pub const FRAME_NOTE: &str = "nexus://frame";
/// The outline is drawn in a margin around the region, never over it, so it is not read as text.
const FRAME_MARGIN: f64 = 6.0;
const FRAME_LABEL: f64 = 26.0;

/// Show an outline around the region being read (or hide it with `None`). The outline is a
/// see-through window that lets every click through, so it never gets in the way of scrolling.
/// `note` is passed to it: "reading", "found" (new text was just taken) or "paused".
#[tauri::command]
pub async fn region_frame(app: AppHandle, region: Option<Region>, note: Option<String>) -> CmdResult<()> {
    let Some(r) = region else {
        if let Some(w) = app.get_webview_window(FRAME) {
            let _ = w.close();
        }
        return Ok(());
    };
    let frame = match app.get_webview_window(FRAME) {
        Some(w) => w,
        None => {
            let w = WebviewWindowBuilder::new(&app, FRAME, WebviewUrl::App("index.html?window=frame".into()))
                .title("NEXUS: reading this area")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .shadow(false)
                .focused(false)
                .visible(false)
                .build()
                .map_err(friendly)?;
            let _ = w.set_ignore_cursor_events(true);
            w
        }
    };
    // onto the region's monitor first, so the margin is measured at that monitor's scale
    let _ = frame.set_position(PhysicalPosition::new(r.x, r.y));
    let scale = frame.scale_factor().unwrap_or(1.0);
    let margin = (FRAME_MARGIN * scale).round() as i32;
    let label = (FRAME_LABEL * scale).round() as i32;
    let _ = frame.set_size(PhysicalSize::new((r.w + 2 * margin).max(1) as u32, (r.h + 2 * margin + label).max(1) as u32));
    let _ = frame.set_position(PhysicalPosition::new(r.x - margin, r.y - margin - label));
    let _ = frame.set_ignore_cursor_events(true);
    let _ = frame.show();
    if let Some(note) = note {
        let _ = app.emit(FRAME_NOTE, note);
    }
    Ok(())
}

fn pickers(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(label, _)| label.starts_with(PICKER)).map(|(_, w)| w).collect()
}

/// Show a see-through picker over every monitor (each has its own, so mixed
/// display scaling is handled per screen). NEXUS itself steps aside so the
/// user can see what they want to mark. The answer arrives as the
/// `nexus://region-picked` event.
#[tauri::command]
pub async fn region_pick(app: AppHandle) -> CmdResult<()> {
    let main = app.get_webview_window("main");
    let mut monitors = app.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        monitors.extend(app.primary_monitor().ok().flatten());
    }
    if monitors.is_empty() {
        return Err("No screen was found.".into());
    }
    for old in pickers(&app) {
        let _ = old.close();
    }
    if let Some(m) = &main {
        let _ = m.minimize();
    }
    let mut opened = 0;
    for (i, monitor) in monitors.iter().enumerate() {
        let pos = *monitor.position();
        let size = *monitor.size();
        let built = WebviewWindowBuilder::new(&app, format!("{PICKER}-{i}"), WebviewUrl::App("index.html?window=region".into()))
            .title("NEXUS: select a region")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .build();
        let Ok(picker) = built else { continue };
        // onto its monitor first, so the size is applied at that monitor's scale
        let _ = picker.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = picker.set_size(PhysicalSize::new(size.width, size.height));
        let _ = picker.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = picker.show();
        opened += 1;
    }
    if opened == 0 {
        if let Some(m) = &main {
            let _ = m.unminimize();
        }
        return Err("The selection window could not be opened.".into());
    }
    // keyboard focus on the screen the pointer is most likely on: the one NEXUS was on
    if let Some(first) = pickers(&app).into_iter().next() {
        let _ = first.set_focus();
    }
    Ok(())
}

/// A picker is finished: `rect` is what the user marked in that window (None when cancelled).
/// Every picker closes, NEXUS comes back, and the region is announced.
#[tauri::command]
pub fn region_done(app: AppHandle, win: WebviewWindow, rect: Option<CssRect>) -> CmdResult<()> {
    let picked = rect.and_then(|r| {
        let scale = win.scale_factor().ok()?;
        let origin = win.outer_position().ok()?;
        let px = |v: f64| (v * scale).round() as i32;
        let region = Region { x: origin.x + px(r.x), y: origin.y + px(r.y), w: px(r.w), h: px(r.h) };
        (region.w >= 8 && region.h >= 8).then_some(region)
    });
    for w in pickers(&app) {
        let _ = w.close();
    }
    if let Some(m) = app.get_webview_window("main") {
        let _ = m.unminimize();
        let _ = m.show();
        let _ = m.set_focus();
    }
    app.emit(PICKED, picked).map_err(friendly)
}
