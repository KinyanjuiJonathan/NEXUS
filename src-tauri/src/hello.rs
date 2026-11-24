//! Signing in to the Accounts area with Windows Hello (fingerprint, face or PIN).

use tauri::WebviewWindow;

use crate::state::CmdResult;

/// Whether Windows Hello is set up on this PC.
#[tauri::command]
pub async fn hello_available() -> bool {
    tauri::async_runtime::spawn_blocking(available).await.unwrap_or(false)
}

/// Ask Windows to verify the user. Resolves to true when they were verified, false when they cancelled or failed.
#[tauri::command]
pub async fn hello_verify(win: WebviewWindow, message: String) -> CmdResult<bool> {
    let handle = window_handle(&win)?;
    tauri::async_runtime::spawn_blocking(move || verify(handle, &message)).await.map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn available() -> bool {
    crate::win_hello::available()
}

#[cfg(windows)]
fn verify(hwnd: isize, message: &str) -> CmdResult<bool> {
    crate::win_hello::verify(hwnd, message)
}

#[cfg(windows)]
fn window_handle(win: &WebviewWindow) -> CmdResult<isize> {
    win.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn available() -> bool {
    false
}

#[cfg(not(windows))]
fn verify(_hwnd: isize, _message: &str) -> CmdResult<bool> {
    Err("Windows Hello is only available in the Windows desktop app.".into())
}

#[cfg(not(windows))]
fn window_handle(_win: &WebviewWindow) -> CmdResult<isize> {
    Ok(0)
}
