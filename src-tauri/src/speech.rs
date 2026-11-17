//! Native speech recognition via Windows.Media.SpeechRecognition (WinRT).
//!
//! Listens for a single utterance only when the user presses the microphone
//! button or shortcut — NEXUS never records continuously. Free-form dictation
//! uses the Windows speech service; Windows requires "Online speech
//! recognition" to be enabled (Settings → Privacy & security → Speech), which
//! is the user's explicit OS-level consent. If it is unavailable, the UI falls
//! back to the WebView speech API (if present) or keyboard input.

use serde::Serialize;

use crate::state::CmdResult;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechAvailability {
    pub native: bool,
    pub platform: &'static str,
}

#[tauri::command]
pub fn speech_available() -> SpeechAvailability {
    SpeechAvailability { native: cfg!(windows), platform: std::env::consts::OS }
}

#[tauri::command]
pub async fn speech_listen(language: Option<String>, timeout_secs: Option<u64>) -> CmdResult<String> {
    let timeout = timeout_secs.unwrap_or(8).clamp(2, 30);
    tauri::async_runtime::spawn_blocking(move || listen_once(language, timeout))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn listen_once(language: Option<String>, timeout: u64) -> CmdResult<String> {
    use windows::core::HSTRING;
    use windows::Foundation::TimeSpan;
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{SpeechRecognitionResultStatus, SpeechRecognizer};
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    // SAFETY: initialising the WinRT apartment for this worker thread; an
    // "already initialised" result is fine and ignored.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let map = |e: windows::core::Error| -> String {
        let code = e.code().0 as u32;
        if code == 0x80045509 {
            "Windows speech privacy policy was not accepted. Turn on 'Online speech recognition' in Windows Settings → Privacy & security → Speech.".into()
        } else {
            format!("Speech recognition is unavailable ({}). You can type the command instead.", e.message())
        }
    };
    let recognizer = match language.filter(|l| !l.is_empty()) {
        Some(tag) => {
            let lang = Language::CreateLanguage(&HSTRING::from(tag)).map_err(map)?;
            SpeechRecognizer::Create(&lang).map_err(map)?
        }
        None => SpeechRecognizer::new().map_err(map)?,
    };
    if let Ok(t) = recognizer.Timeouts() {
        let ticks = |s: u64| TimeSpan { Duration: (s as i64) * 10_000_000 };
        let _ = t.SetInitialSilenceTimeout(ticks(timeout.min(6)));
        let _ = t.SetEndSilenceTimeout(TimeSpan { Duration: 9_000_000 });
        let _ = t.SetBabbleTimeout(ticks(timeout));
    }
    let compiled = recognizer.CompileConstraintsAsync().map_err(map)?.get().map_err(map)?;
    if compiled.Status().map_err(map)? != SpeechRecognitionResultStatus::Success {
        return Err("No speech language pack is installed. Add one in Windows Settings → Time & language → Speech.".into());
    }
    let result = recognizer.RecognizeAsync().map_err(map)?.get().map_err(map)?;
    let text = result.Text().map_err(map)?.to_string();
    if text.trim().is_empty() {
        return Err("I didn't catch that — try again or type the command.".into());
    }
    Ok(text)
}

#[cfg(not(windows))]
fn listen_once(_language: Option<String>, _timeout: u64) -> CmdResult<String> {
    Err("Native speech recognition is only available on Windows. Use the browser engine or type the command.".into())
}
