# NEXUS architecture

## Goals that shaped the design

1. **Never lose data**: every change is written to SQLite immediately; schema changes are backed up first.
2. **Accurate time**: all instants are UTC epoch milliseconds, and wall-clock meaning is preserved by storing the IANA zone alongside. Timers are derived from timestamps, never from tick counters.
3. **Reliable reminders**: delivered by a native background thread, not by a browser timer that can be throttled.
4. **Light footprint**: one process, two WebView2 windows, a single shared 1-second clock per window that stops when the window is hidden.
5. **Testable core**: time, scheduling, recurrence, parsing and persistence are plain modules with unit tests.

## Process & windows

| Piece | Tech | Responsibility |
|---|---|---|
| `main` window | React 19, TypeScript, Tailwind 4, Framer Motion | Full app UI. Also the only window that finishes expired timers (`processTimers`), so expiry is processed exactly once. |
| `overlay` window | Same bundle (`index.html?window=overlay`) | Transparent, undecorated, `alwaysOnTop`, `skipTaskbar`, `focus: false`. Renders `OverlayApp`. |
| Rust shell (`src-tauri/src`) | Tauri 2 | IPC commands, tray, global shortcuts, overlay state (pin / click-through via `set_ignore_cursor_events`), autostart, single instance, window-state persistence, reminder scheduler, AI proxy, WinRT speech. |
| `nexus-core` (`src-tauri/core`) | rusqlite (bundled SQLite) | Schema, migrations, repositories, reminder queue, backup/restore/export. No Tauri dependency, so it's unit-tested headless. |

Both windows hold their own copy of the app store. After every successful mutation the backend emits `nexus://data-changed` with the origin window label, and the *other* window reloads its snapshot. Personal data volumes (hundreds to low thousands of rows) make a full in-memory snapshot cheap.

### Module map (`src/`)

| Module | Purpose |
|---|---|
| `data/types.ts` | Domain model (mirrors `core/src/models.rs`) |
| `data/backend.ts` | `Backend` interface; Tauri IPC implementation and a localStorage/in-memory implementation (browser preview and tests) |
| `store/store.ts` | zustand store factory: tasks, events, timers, settings, toasts; every action persists and re-syncs reminders |
| `lib/time.ts` | IANA zones (Kenya, Texas Central, El Paso → `America/Denver`), clocks, conversion, DST-safe wall-time ⇄ UTC |
| `lib/countdown.ts` | Timestamp-based timers, Pomodoro phases, human labels, deadline urgency |
| `lib/recurrence.ts` | Zone-aware recurrence (daily / weekdays / weekly by day / monthly / yearly, interval, count, until, exdates) |
| `lib/schedule.ts` | Occurrence expansion, conflict detection, free-slot search, missed-work detection, Smart Reschedule options |
| `lib/reminders.ts` | Turns tasks/events/timers into concrete reminder instants |
| `lib/voice/parser.ts` | Offline NL parser → typed `Intent` (chrono-node for dates, explicit zone phrases) |
| `lib/voice/execute.ts` | Applies intents to the store; fuzzy target matching; confirmation descriptions |
| `lib/voice/engine.ts` | Speech capture: WinRT (desktop) → Web Speech → keyboard |
| `lib/assistant.ts` | Offline assistant heuristics + compact AI context |
| `lib/overlayGeometry.ts` | Mode sizes, opacity bounds, multi-monitor `ensureVisible` |
| `lib/ticker.ts` | Shared second-aligned clock; pauses when hidden, re-syncs on resume |

## Time handling

- Instants: UTC ms. Wall-clock inputs carry a zone (`dueTz`, `event.tz`), and the UI always shows the Kenya and Texas equivalents.
- Recurrence is evaluated **in the item's original zone**, so "every Friday 3 PM Texas time" stays 3 PM in Texas across DST, and moves by an hour in Kenya, which is correct.
- DST edges: a non-existent spring-forward time shifts forward; an ambiguous fall-back time resolves to the earlier instant (`wallTimeToUtc`).
- Countdowns: `elapsed = accumulatedMs + (running ? now − startedAt : 0)`. Nothing depends on a timer having fired, so sleep, restarts and throttled background windows cannot skew them.

## Reminder pipeline

```
UI change ─▶ store action ─▶ lib/reminders computes future instants
         ─▶ invoke reminders_sync(owner, items)  (replaces *pending* rows for that owner;
                                                   fired & snoozed rows are kept)
         ─▶ scheduler thread is woken (mpsc channel)

scheduler thread (own SQLite connection, WAL):
  loop:
    due = reminders WHERE fired_at IS NULL AND dismissed_at IS NULL AND fire_at <= now
    for each: stale > 12 h ? mark fired silently (one "missed" summary)
                           : Windows toast + emit nexus://reminder (in-app toast, chime, snooze) + mark fired
    sleep until min(next fire_at, 15 s) or until woken
```

Snooze sets `fire_at = now + m` and clears `fired_at`. Recurring events get two weeks of reminders, refreshed hourly and at startup.

## Database schema (SQLite, schema v2)

All timestamps are UTC epoch milliseconds (`INTEGER`). JSON columns are UTF-8 text.

### `tasks`
| column | type | notes |
|---|---|---|
| id | TEXT PK | UUID |
| title | TEXT NOT NULL | |
| notes | TEXT | |
| priority | TEXT | CHECK in (`critical`,`high`,`medium`,`low`) |
| category_id | TEXT | references `categories.id` (soft) |
| status | TEXT | CHECK in (`todo`,`in_progress`,`done`) |
| due_at | INTEGER NULL | deadline instant |
| due_tz | TEXT NULL | IANA zone the deadline was entered in |
| estimate_min | INTEGER NULL | |
| spent_ms | INTEGER | tracked focus time |
| sort_order | REAL | manual order |
| recurrence | TEXT NULL | JSON `RecurrenceRule` |
| reminders | TEXT | JSON array of minute offsets |
| completed_at / archived_at / deleted_at | INTEGER NULL | history, archive, trash (purged after 30 days) |
| created_at / updated_at | INTEGER | |

Indexes: `due_at`; `(status, deleted_at, archived_at)`; `completed_at`.

### `subtasks`
`id` PK · `task_id` → `tasks.id` **ON DELETE CASCADE** · `title` · `done` (0/1) · `sort_order`

### `categories`
`id` PK · `name` · `color` · `icon` · `builtin` (0/1; built-ins `work`, `personal`, `projects`, `meetings` can't be deleted) · `sort_order`

### `events` (appointments & time blocks)
`id` PK · `title` · `notes` · `start_at` · `end_at` (CHECK `end_at >= start_at`) · `tz` (original IANA zone) · `task_id` (time block for a task, nullable) · `recurrence` (JSON incl. `exdates`) · `important` (0/1) · `reminders` (JSON) · `color` · `created_at` · `updated_at` · `deleted_at`

### `timers`
`id` PK · `kind` (`countdown`/`stopwatch`/`pomodoro`) · `label` · `task_id` · `duration_ms` · `started_at` (NULL unless running) · `accumulated_ms` · `state` (`idle`/`running`/`paused`/`finished`) · `phase` (`focus`/`short_break`/`long_break`) · `cycle` · `created_at` · `updated_at`

### `focus_sessions`
`id` PK · `task_id` · `kind` · `started_at` · `ended_at` · `duration_ms`. Feeds the focus statistics. Logged when a timer segment of 30 seconds or more ends.

### `reminders`
`id` PK · `owner_kind` (`task`/`event`/`timer`/`custom`) · `owner_id` · `title` · `body` · `fire_at` · `fired_at` · `snoozed_until` · `dismissed_at` · `created_at`. Indexes: `(fired_at, dismissed_at, fire_at)`, `(owner_kind, owner_id)`.

### `settings`
`key` TEXT PK · `value` TEXT (JSON) · `updated_at`. Holds preferences, time zones, overlay mode/opacity/per-mode sizes/visibility/pin/click-through, shortcuts, reminder defaults, the active task, and so on. Window **positions** are persisted by `tauri-plugin-window-state` (validated against connected monitors).

### `app_meta` (v2)
`key` PK · `value`: internal bookkeeping, e.g. `last_auto_backup`.

## Migration strategy

- Versioned with `PRAGMA user_version`; migrations are an append-only list in `core/src/migrations.rs`.
- **Before** migrating an existing database, `Store::open` writes `backups/nexus-pre-v{N}-{timestamp}.db` with `VACUUM INTO`, a consistent copy.
- Each migration runs in **its own transaction together with the version bump**, so a failure leaves the database at the previous version.
- A database whose version is **newer** than the build supports is refused (`NewerSchema`) rather than risk corruption.
- Never edit a released migration. Add a new one and a test in `core/tests/store.rs` (see `migration_from_older_schema_takes_a_backup_first`).

## Backup / restore

- `backup_to(path)`: `VACUUM INTO`, safe while the app is running.
- `restore_from(path, safety_copy)`: opens the file read-only, runs `PRAGMA integrity_check`, verifies it is a NEXUS database and not from a newer schema, writes a safety copy of the current data, then uses the SQLite online-backup API to replace the live database, and finally migrates.
- JSON export/import: schema-versioned `ExportBundle`; import is preceded by a safety backup.
- Daily rolling auto-backup (keep 7) at startup.

## Security & privacy

- Tauri capabilities (`src-tauri/capabilities/default.json`) allow only the window/notification/dialog/autostart/process permissions the UI needs. The CSP disallows remote scripts and connections.
- The AI key lives in the OS credential vault (`keyring`). The frontend can set or clear it and ask "is a key present?", but can never read it. AI calls are made by Rust, and only when settings `aiEnabled` and `aiConsent` are both true.
- The overlay uses standard top-most windows only. It does not hook other processes, inject into games, or bypass secure-desktop/protected-content boundaries.

## Performance notes

- Frontend views are code-split; the overlay bundle loads only what it renders.
- One shared, second-aligned ticker per window; it unsubscribes when no component listens and pauses while the document is hidden.
- The overlay uses no blur-heavy or continuous animations and renders at 1 Hz.
- Release builds use LTO and `opt-level = "s"`, with symbols stripped.
