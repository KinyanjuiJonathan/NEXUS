//! Update check and opening links in the browser.
//!
//! The check asks GitHub for the latest published release of NEXUS and hands
//! its version and download page to the UI, which compares it with the running
//! version. The user can open the release page and run the installer by hand,
//! or let NEXUS do it: `update_install` downloads the published installer,
//! checks it against the checksum GitHub publishes for it, and runs it in
//! passive mode (a progress bar and nothing to click), after which NEXUS
//! starts again. Either way all data is kept: it lives in the user's profile,
//! not in the program folder.

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::state::CmdResult;

const LATEST: &str = "https://api.github.com/repos/KinyanjuiJonathan/NEXUS/releases/latest";
/// Installers are only ever taken from this project's own releases.
const DOWNLOADS: &str = "https://github.com/KinyanjuiJonathan/NEXUS/releases/download/";
const INSTALLER_SUFFIX: &str = "-setup.exe";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// The release tag, e.g. "v1.2.0".
    pub version: String,
    pub name: String,
    pub notes: String,
    pub url: String,
    pub published_at: String,
    /// The Windows installer of this release and its published SHA-256 (empty when the release has none).
    pub installer_url: String,
    pub installer_sha256: String,
    pub installer_size: u64,
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
    let installer = v["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.ends_with(INSTALLER_SUFFIX))));
    let asset = |k: &str| installer.and_then(|x| x[k].as_str()).unwrap_or_default().to_string();
    Ok(Some(Release {
        version,
        name: text("name"),
        notes: text("body"),
        url: text("html_url"),
        published_at: text("published_at"),
        installer_url: asset("browser_download_url"),
        installer_sha256: asset("digest").trim_start_matches("sha256:").to_ascii_lowercase(),
        installer_size: installer.and_then(|x| x["size"].as_u64()).unwrap_or(0),
    }))
}

/// Download this project's installer, check it against its published checksum, run it without
/// its wizard pages and close NEXUS so it can be replaced. The installer starts NEXUS again.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, url: String, sha256: String) -> CmdResult<()> {
    let plain = url.chars().all(|c| c.is_ascii_alphanumeric() || "/:._-".contains(c));
    if !url.starts_with(DOWNLOADS) || !url.ends_with(INSTALLER_SUFFIX) || url.contains("..") || !plain {
        return Err("That is not a NEXUS installer.".into());
    }
    let want = sha256.trim().to_ascii_lowercase();
    if want.len() != 64 || !want.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("This release has no published checksum, so it cannot be installed automatically. Use the download page instead.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("user-agent", "NEXUS-desktop")
        .send()
        .await
        .map_err(|e| format!("Could not download the update ({e})."))?;
    if !resp.status().is_success() {
        return Err(format!("The download failed ({}).", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("The download was interrupted ({e})."))?;
    let got = format!("{:x}", Sha256::digest(&bytes));
    if got != want {
        return Err("The downloaded file does not match its published checksum. Nothing was installed.".into());
    }
    let dir = std::env::temp_dir().join("nexus-update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not save the update ({e})."))?;
    let path = dir.join(url.rsplit('/').next().unwrap_or("NEXUS-setup.exe"));
    std::fs::write(&path, &bytes).map_err(|e| format!("Could not save the update ({e})."))?;
    run_installer(&path).map_err(|e| format!("Could not start the installer ({e})."))?;
    app.exit(0);
    Ok(())
}

/// /P: progress bar only, no pages. /R: start NEXUS again afterwards. /UPDATE: replace the installed version in place.
#[cfg(windows)]
fn run_installer(path: &std::path::Path) -> std::io::Result<()> {
    std::process::Command::new(path).args(["/P", "/R", "/UPDATE"]).spawn().map(|_| ())
}

#[cfg(not(windows))]
fn run_installer(_path: &std::path::Path) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "updates install themselves on Windows only"))
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
