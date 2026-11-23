//! Update check and opening links in the browser.
//!
//! The check asks GitHub for the latest published release of NEXUS and hands
//! its version and download page to the UI, which compares it with the running
//! version. Nothing is downloaded or installed here: the user opens the release
//! page and runs the installer, which keeps all data (it lives in the user's
//! profile, not in the program folder).

use serde::Serialize;
use serde_json::Value;

use crate::state::CmdResult;

const LATEST: &str = "https://api.github.com/repos/KinyanjuiJonathan/NEXUS/releases/latest";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// The release tag, e.g. "v1.2.0".
    pub version: String,
    pub name: String,
    pub notes: String,
    pub url: String,
    pub published_at: String,
}

/// The latest published release, or None when nothing has been published yet.
#[tauri::command]
pub async fn update_check() -> CmdResult<Option<Release>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(LATEST)
        .header("user-agent", "NEXUS-desktop")
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach the update server ({e})."))?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("The update server answered with an error ({}).", status.as_u16()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("Unexpected answer from the update server: {e}"))?;
    let text = |k: &str| v[k].as_str().unwrap_or_default().to_string();
    let version = text("tag_name");
    if version.is_empty() {
        return Ok(None);
    }
    Ok(Some(Release { version, name: text("name"), notes: text("body"), url: text("html_url"), published_at: text("published_at") }))
}

/// Windows settings pages NEXUS may open: sound devices, and the microphone and speech privacy switches.
const SETTINGS_PAGES: [&str; 3] = ["ms-settings:sound", "ms-settings:privacy-microphone", "ms-settings:privacy-speech"];

/// Open a link in the default browser (or mail program). Only GitHub pages of this project, mailto links and a few Windows settings pages are allowed.
#[tauri::command]
pub fn open_external(url: String) -> CmdResult<()> {
    let allowed = url.starts_with("https://github.com/KinyanjuiJonathan/") || url.starts_with("mailto:") || SETTINGS_PAGES.contains(&url.as_str());
    if !allowed || url.contains('"') || url.chars().any(|c| c.is_control()) {
        return Err("That link cannot be opened from here.".into());
    }
    open(&url).map_err(|e| format!("Could not open the link ({e})."))
}

#[cfg(windows)]
fn open(url: &str) -> std::io::Result<()> {
    // rundll32 hands the URL to the default handler without a shell in between
    std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn().map(|_| ())
}

#[cfg(not(windows))]
fn open(url: &str) -> std::io::Result<()> {
    std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" }).arg(url).spawn().map(|_| ())
}
