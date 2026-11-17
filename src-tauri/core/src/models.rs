//! Domain models — mirror `src/data/types.ts` (camelCase JSON on the wire).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subtask {
    pub id: String,
    pub title: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    pub priority: String,
    pub category_id: String,
    pub status: String,
    pub due_at: Option<i64>,
    pub due_tz: Option<String>,
    pub estimate_min: Option<i64>,
    #[serde(default)]
    pub spent_ms: i64,
    #[serde(default)]
    pub sort_order: f64,
    /// RecurrenceRule as JSON (opaque to the backend).
    pub recurrence: Option<Value>,
    #[serde(default)]
    pub reminders: Vec<i64>,
    #[serde(default)]
    pub subtasks: Vec<Subtask>,
    pub completed_at: Option<i64>,
    pub archived_at: Option<i64>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub sort_order: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    pub start_at: i64,
    pub end_at: i64,
    pub tz: String,
    pub task_id: Option<String>,
    pub recurrence: Option<Value>,
    #[serde(default)]
    pub important: bool,
    #[serde(default)]
    pub reminders: Vec<i64>,
    pub color: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub label: String,
    pub task_id: Option<String>,
    pub duration_ms: i64,
    pub started_at: Option<i64>,
    pub accumulated_ms: i64,
    pub state: String,
    pub phase: Option<String>,
    #[serde(default)]
    pub cycle: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    pub id: String,
    pub task_id: Option<String>,
    pub kind: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub owner_kind: String,
    pub owner_id: String,
    pub title: String,
    pub body: String,
    pub fire_at: i64,
    pub fired_at: Option<i64>,
    pub snoozed_until: Option<i64>,
    pub dismissed_at: Option<i64>,
}

/// A reminder the frontend wants scheduled (ids are assigned by the backend).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedReminder {
    pub fire_at: i64,
    pub title: String,
    pub body: String,
}

/// Everything the UI needs at startup, in one round-trip.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub tasks: Vec<Task>,
    pub categories: Vec<Category>,
    pub events: Vec<CalendarEvent>,
    pub timers: Vec<Timer>,
    pub focus_sessions: Vec<FocusSession>,
    pub settings: BTreeMap<String, Value>,
}

/// Portable JSON export (schema-versioned).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundle {
    pub app: String,
    pub schema_version: i64,
    pub exported_at: i64,
    #[serde(flatten)]
    pub data: Snapshot,
    #[serde(default)]
    pub reminders: Vec<Reminder>,
}
