//! Optional AI assistant (Claude API), proxied through the Rust backend.
//!
//! * The API key is stored in the OS credential vault (Windows Credential
//!   Manager) via `keyring`. It is never returned to, or stored in, the web UI.
//! * Calls are only made after the user enabled AI *and* gave consent in
//!   Settings (checked here, server-side of the IPC boundary).
//! * Everything in NEXUS works without AI; the frontend falls back to local heuristics.

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Manager, State};

use crate::state::{AppState, CmdResult};

const SERVICE: &str = "NEXUS";
const ACCOUNT: &str = "anthropic-api-key";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
const DEFAULT_MODEL: &str = "claude-opus-5-5";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("credential store unavailable: {e}"))
}

fn read_key() -> Option<String> {
    entry().ok()?.get_password().ok().filter(|k| !k.trim().is_empty())
}

#[tauri::command]
pub fn ai_set_key(key: String) -> CmdResult<()> {
    let key = key.trim();
    if !key.starts_with("sk-ant-") || key.len() < 20 {
        return Err("That doesn't look like an Anthropic API key (it should start with sk-ant-).".into());
    }
    entry()?.set_password(key).map_err(|e| format!("could not save the key: {e}"))
}

#[tauri::command]
pub fn ai_clear_key() -> CmdResult<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not remove the key: {e}")),
    }
}

#[tauri::command]
pub fn ai_has_key() -> bool {
    read_key().is_some()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    /// "breakdown" | "plan" | "interpret"
    pub kind: String,
    /// User-visible request text.
    pub prompt: String,
    /// Compact JSON context built by the UI (tasks, events, time zones…).
    #[serde(default)]
    pub context: Value,
}

fn system_prompt(kind: &str) -> &'static str {
    match kind {
        "breakdown" => "You are NEXUS, a productivity assistant. Break the user's project into 3-8 concrete, \
            actionable subtasks in a sensible order. Give each a short imperative title (max 70 characters) and a \
            realistic estimate in minutes (5-480). Use the context (existing notes, estimate, deadline) when helpful.",
        "interpret" => "You are NEXUS, a productivity assistant. Convert the user's request into one structured \
            task. Resolve dates relative to the 'now' and zone given in the context and output the due time as an \
            ISO-8601 local date-time (no offset) together with the IANA zone it is in. Use Africa/Nairobi for Kenya \
            time, America/Chicago for Texas/Central time and America/Denver for El Paso/Mountain time. Use null when \
            something was not stated.",
        _ => "You are NEXUS, a calm, concise productivity coach. Using only the JSON context provided (tasks, \
            appointments, focus history, working hours and time zones), answer the user's request. Be specific: \
            reference task titles and times (in the zones the user cares about: Kenya EAT and Texas). Prefer short \
            bullet points, at most ~180 words. Never invent tasks or appointments that are not in the context. \
            Do not move or change anything yourself — only recommend; the user applies changes.",
    }
}

fn output_schema(kind: &str) -> Option<Value> {
    match kind {
        "breakdown" => Some(json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["subtasks"],
            "properties": {
                "subtasks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["title", "estimateMin"],
                        "properties": {
                            "title": { "type": "string" },
                            "estimateMin": { "type": "integer" }
                        }
                    }
                }
            }
        })),
        "interpret" => Some(json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["title", "dueLocal", "zone", "priority", "estimateMin", "category"],
            "properties": {
                "title": { "type": "string" },
                "dueLocal": { "type": ["string", "null"] },
                "zone": { "type": ["string", "null"] },
                "priority": { "type": ["string", "null"], "enum": ["critical", "high", "medium", "low", null] },
                "estimateMin": { "type": ["integer", "null"] },
                "category": { "type": ["string", "null"], "enum": ["work", "personal", "projects", "meetings", null] }
            }
        })),
        _ => None,
    }
}

/// Run one AI request. Returns `{ text }` for plan, or the parsed JSON object for structured kinds.
#[tauri::command]
pub async fn ai_request(app: tauri::AppHandle, req: AiRequest) -> CmdResult<Value> {
    let (enabled, consent, model) = {
        let st: State<AppState> = app.state();
        let s = st.store()?;
        let b = |k: &str| s.get_setting(k).ok().flatten().and_then(|v| v.as_bool()).unwrap_or(false);
        let model = s
            .get_setting("aiModel")
            .ok()
            .flatten()
            .and_then(|v| v.as_str().map(String::from))
            .filter(|m| m.starts_with("claude-"))
            .unwrap_or_else(|| DEFAULT_MODEL.into());
        (b("aiEnabled"), b("aiConsent"), model)
    };
    if !enabled || !consent {
        return Err("The AI assistant is turned off. Enable it and give consent in Settings → AI.".into());
    }
    let key = read_key().ok_or("No API key saved. Add your Anthropic API key in Settings → AI.")?;
    if req.prompt.len() > 8_000 {
        return Err("That request is too long.".into());
    }

    let user = format!("Request: {}\n\nContext (JSON):\n{}", req.prompt.trim(), req.context);
    let mut body = json!({
        "model": model,
        "max_tokens": 16000,
        "system": system_prompt(&req.kind),
        "messages": [{ "role": "user", "content": user }],
        "output_config": { "effort": "low" },
        "fallbacks": "default"
    });
    if let Some(schema) = output_schema(&req.kind) {
        body["output_config"]["format"] = json!({ "type": "json_schema", "schema": schema });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(API_URL)
        .header("x-api-key", key)
        .header("anthropic-version", API_VERSION)
        .header("anthropic-beta", "server-side-fallback-2026-07-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach the AI service ({e}). NEXUS keeps working offline."))?;

    let status = resp.status();
    let payload: Value = resp.json().await.map_err(|e| format!("Unexpected AI response: {e}"))?;
    if !status.is_success() {
        let msg = payload["error"]["message"].as_str().unwrap_or("unknown error");
        return Err(match status.as_u16() {
            401 => "The API key was rejected. Check it in Settings → AI.".into(),
            429 => "The AI service is rate-limiting requests. Try again in a minute.".into(),
            500..=599 => "The AI service is temporarily unavailable. Try again shortly.".into(),
            _ => format!("AI request failed: {msg}"),
        });
    }
    match payload["stop_reason"].as_str() {
        Some("refusal") => return Err("The assistant declined this request.".into()),
        Some("max_tokens") => return Err("The answer was too long; try a narrower request.".into()),
        _ => {}
    }
    let text: String = payload["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if output_schema(&req.kind).is_some() {
        serde_json::from_str(&text).map_err(|_| "The assistant returned an unexpected format.".into())
    } else {
        Ok(json!({ "text": text }))
    }
}
