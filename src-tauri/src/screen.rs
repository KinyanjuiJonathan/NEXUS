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
/// Sent to the frame: what just happened ("ready", "found:3", "none").
pub const FRAME_NOTE: &str = "nexus://frame";
/// Sent to NEXUS: the user right-clicked inside the region (payload: the region to read).
pub const CAPTURE: &str = "nexus://region-capture";
/// Sent to NEXUS: the region was moved or resized (payload: the new region).
pub const CHANGED: &str = "nexus://region-changed";
/// Sent to NEXUS: the region was closed.
pub const CLOSED: &str = "nexus://region-closed";
/// The frame's border and handles sit in a margin around the region, and its bar above it,
/// never over the region itself, so they are not read as text. CSS pixels.
const FRAME_MARGIN: f64 = 8.0;
const FRAME_BAR: f64 = 28.0;

/// The region as it is now (the inside of the frame). None while no region is open.
static CURRENT: std::sync::Mutex<Option<Region>> = std::sync::Mutex::new(None);

fn current() -> Option<Region> {
    CURRENT.lock().ok().and_then(|g| *g)
}

fn set_current(r: Option<Region>) {
    if let Ok(mut g) = CURRENT.lock() {
        *g = r;
    }
}

/// Margin and bar height in physical pixels at the frame's scale.
fn chrome(frame: &WebviewWindow) -> (i32, i32) {
    let scale = frame.scale_factor().unwrap_or(1.0);
    ((FRAME_MARGIN * scale).round() as i32, (FRAME_BAR * scale).round() as i32)
}

/// The inside of the frame window: the part of the screen that is read.
fn inside_of(frame: &WebviewWindow) -> Option<Region> {
    let pos = frame.outer_position().ok()?;
    let size = frame.outer_size().ok()?;
    let (margin, bar) = chrome(frame);
    let region = Region { x: pos.x + margin, y: pos.y + margin + bar, w: size.width as i32 - 2 * margin, h: size.height as i32 - 2 * margin - bar };
    (region.w >= 8 && region.h >= 8).then_some(region)
}

/// Open the reading region: a see-through frame the user can drag by its bar and resize by its
/// edges and corners. Nothing is read until the user right-clicks inside it; that is announced as
/// `nexus://region-capture`. Inside the region the mouse reaches the app underneath as usual.
#[tauri::command]
pub async fn region_open(app: AppHandle, region: Region) -> CmdResult<()> {
    let frame = match app.get_webview_window(FRAME) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, FRAME, WebviewUrl::App("index.html?window=frame".into()))
            .title("NEXUS reading region")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .shadow(false)
            .focused(false)
            .visible(false)
            .min_inner_size(160.0, 110.0)
            .build()
            .map_err(friendly)?,
    };
    // onto the region's monitor first, so the margin is measured at that monitor's scale
    let _ = frame.set_position(PhysicalPosition::new(region.x, region.y));
    let (margin, bar) = chrome(&frame);
    let _ = frame.set_size(PhysicalSize::new((region.w + 2 * margin).max(1) as u32, (region.h + 2 * margin + bar).max(1) as u32));
    let _ = frame.set_position(PhysicalPosition::new(region.x - margin, region.y - margin - bar));
    let _ = frame.set_ignore_cursor_events(false);
    let _ = frame.show();
    let inside = inside_of(&frame).unwrap_or(region);
    set_current(Some(inside));
    watch(&app, inside);
    let _ = app.emit(CHANGED, inside);
    Ok(())
}

/// Close the reading region: the frame disappears, the mouse watcher stops, nothing more can be captured.
#[tauri::command]
pub fn region_close(app: AppHandle) -> CmdResult<()> {
    shut(&app);
    if let Some(w) = app.get_webview_window(FRAME) {
        let _ = w.close();
    }
    Ok(())
}

/// Tell the frame what the last capture did, so it can show it for a moment.
#[tauri::command]
pub fn region_note(app: AppHandle, note: String) -> CmdResult<()> {
    app.emit(FRAME_NOTE, note).map_err(friendly)
}

/// Everything that must end with the region, whichever way it was closed.
fn shut(app: &AppHandle) {
    unwatch();
    if current().is_some() {
        set_current(None);
        let _ = app.emit(CLOSED, ());
    }
}

/// The frame was moved, resized or closed.
pub fn frame_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != FRAME {
        return;
    }
    let app = window.app_handle();
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            if current().is_none() {
                return;
            }
            let Some(frame) = app.get_webview_window(FRAME) else { return };
            if let Some(inside) = inside_of(&frame) {
                set_current(Some(inside));
                rewatch(inside);
                let _ = app.emit(CHANGED, inside);
            }
        }
        tauri::WindowEvent::Destroyed => shut(app),
        _ => {}
    }
}

#[cfg(windows)]
fn watch(app: &AppHandle, r: Region) {
    let app = app.clone();
    crate::win_region::start(r.x, r.y, r.w, r.h, move |signal| match signal {
        // inside the region the frame lets the mouse through; on its border and bar it takes it
        crate::win_region::Signal::Inside(inside) => {
            if let Some(frame) = app.get_webview_window(FRAME) {
                let _ = frame.set_ignore_cursor_events(inside);
            }
        }
        crate::win_region::Signal::Capture => {
            if let Some(region) = current() {
                let _ = app.emit(CAPTURE, region);
            }
        }
    });
}

#[cfg(windows)]
fn rewatch(r: Region) {
    crate::win_region::set_region(r.x, r.y, r.w, r.h);
}

#[cfg(windows)]
fn unwatch() {
    crate::win_region::stop();
}

#[cfg(not(windows))]
fn watch(_app: &AppHandle, _r: Region) {}

#[cfg(not(windows))]
fn rewatch(_r: Region) {}

#[cfg(not(windows))]
fn unwatch() {}

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
