# NEXUS — AI Productivity & Time Command Center

NEXUS is a Windows 10/11 desktop app that combines tasks, scheduling, Kenya ⇄ Texas dual clocks, live countdowns, focus timers, reliable reminders, voice commands, and an **always-on-top floating overlay** that stays visible while you work in other apps.

It is a real application: data is stored in a local SQLite database, reminders are delivered by a background scheduler (even with every window closed to the tray), and the optional AI assistant runs through the Rust backend so your API key never touches the UI.

![Dashboard](docs/screenshots/dashboard.png)

| Floating overlay — Standard | Expanded | Mini |
|---|---|---|
| ![Overlay standard](docs/screenshots/overlay-standard.png) | ![Overlay expanded](docs/screenshots/overlay-expanded.png) | ![Overlay mini](docs/screenshots/overlay-mini.png) |

More screens: [Calendar](docs/screenshots/calendar.png) · [Tasks](docs/screenshots/tasks.png) · [Focus](docs/screenshots/focus.png) · [World clocks](docs/screenshots/clocks.png) · [Voice/command preview](docs/screenshots/command.png) · [Light mode](docs/screenshots/dashboard-light.png)

---

## Contents

- [Features](#features)
- [Install (Windows)](#install-windows)
- [First five minutes](#first-five-minutes)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Voice commands](#voice-commands)
- [The floating overlay](#the-floating-overlay)
- [Reminders & background behaviour](#reminders--background-behaviour)
- [AI assistant (optional)](#ai-assistant-optional)
- [Data, backup & privacy](#data-backup--privacy)
- [Development setup](#development-setup)
- [Build & test commands](#build--test-commands)
- [Architecture](#architecture) (full details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md))
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

## Features

**Smart to-do list**: add, edit, delete (with Undo and a 30-day Trash) and complete tasks · priorities Critical/High/Medium/Low · deadlines with an explicit time zone · estimated duration · subtasks/checklists · notes · Work/Personal/Projects/Meetings plus custom categories · search and filters · drag to reorder (mouse or keyboard) · archive completed work · recurring tasks (the next instance is created when you complete one) · views: Today, Upcoming, This Week, Overdue, All, Completed, Archive, Trash, plus Calendar.

**Dual clocks, Kenya and Texas**: Kenya uses `Africa/Nairobi` (EAT, UTC+3, no DST). Texas uses `America/Chicago` (CST/CDT, DST handled automatically), switchable to El Paso/West Texas Mountain time. Clocks show time, seconds, date and weekday, in 12- or 24-hour format. There is also a converter, plus a 24-hour Kenya ⇄ Texas planner that highlights shared working hours.

> **El Paso note:** the IANA database has no `America/El_Paso` zone. El Paso is covered by **`America/Denver`** (MST/MDT), which NEXUS uses. `America/El_Paso` is accepted as an alias and automatically mapped.

**Countdowns and time tracking**: "Starts in 45 min", "Deadline in 2 h", "Overdue by 3 h", "In progress · 18 min left", with progress bars, deadline warnings and overdue badges · countdown, stopwatch and Pomodoro (focus / short break / long break), with start/pause/resume/reset/skip · time spent vs. estimate per task. All timers are computed from **persisted timestamps**, so they stay exact across sleep, hibernate, restarts and closing the app.

**Scheduling**: Day, Week and Month calendar · drag blocks to move them and drag the bottom edge to resize · drag appointments or task deadlines between days in Month view · click an empty slot to create · reserve time blocks for tasks · recurring appointments (move or delete one occurrence or the whole series) · double-booking detection with warnings · every appointment shown in Kenya and Texas time and **saved in its original time zone** · switch the calendar's display zone between Local, Kenya and Texas.

**Smart Reschedule**: for missed tasks and unfinished time blocks, NEXUS offers free future slots based on your working hours and existing calendar. It **never moves anything automatically**, and important appointments always need explicit confirmation.

**Reminders**: at time, 5/15/30/60 minutes before, or custom offsets · Windows toast notifications plus an optional chime · snooze for 5/10/30 minutes · delivered while minimized to the tray.

**Dashboard**: tasks today, completed, pending and overdue · next appointment with countdown · active timer · focus time today · progress ring · 7-day completion and focus-minute charts · a timeline of today's appointments and deadlines · up-next list · missed items.

**Voice and natural language**: a microphone button and global shortcut capture **one command at a time** (never continuous recording), with keyboard input always available. Commands become structured actions. Destructive or ambiguous actions, and anything created by voice, show the recognized text and a preview first.

**AI assistant (optional)**: a summary of your day, what to do next, free slots, conflicts, project breakdown into subtasks, realistic time estimates, and reorganizing overdue work. All of this **works offline** with local heuristics; Claude can enhance it if you add an API key.

**Floating overlay**: always-on-top, draggable, resizable, adjustable opacity, pin/unpin, Mini/Standard/Expanded modes, click-through with a global shortcut to disable it, and it remembers its position and size per mode across monitors. See [below](#the-floating-overlay).

## Install (Windows)

1. Download the latest **`NEXUS_x.y.z_x64-setup.exe`** (NSIS, recommended) or **`.msi`** from the repository's GitHub **Releases** page, or from the **Actions → CI & Windows installer → Artifacts** of any build.
2. Run it. The NSIS installer installs per-user (no admin prompt). It bootstraps Microsoft Edge WebView2 if it's missing (it's preinstalled on Windows 10 21H2+ and Windows 11).
3. Start **NEXUS** from the Start menu.

The installers are currently **unsigned**, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**. Code signing can be added later (see Troubleshooting).

## First five minutes

1. Open NEXUS. Kenya and Texas time are live at the top of the dashboard and in the title bar.
2. Press **N** to add a task. Give it a deadline; the picker shows the equivalent Kenya and Texas time.
3. Schedule it: in the task editor, use **Schedule time block**, or press **E** for an appointment.
4. Press **▶** on the task to make it active, then start a focus session (dashboard or **Focus & Timers**).
5. Press **Ctrl+Shift+Space** to show the floating overlay, then keep working in any other app.
6. If you miss it, use **Reschedule** (Smart Reschedule) on the dashboard or the task.
7. Close the window. NEXUS keeps running in the tray, and everything is already saved.

A "Getting started" checklist on the dashboard tracks these steps for you.

## Keyboard shortcuts

**Global** (work anywhere in Windows; configurable in *Settings → Global keyboard shortcuts*):

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` | Show / hide the floating overlay |
| `Ctrl+Shift+X` | Toggle overlay click-through (use this to get the mouse back) |
| `Ctrl+Shift+N` | Quick add task |
| `Ctrl+Shift+V` | Voice command |
| `Ctrl+Shift+H` | Show the NEXUS window |

**In the app:**

| Key | Action |
|---|---|
| `Ctrl+K` | Command center (type or speak) |
| `N` / `Ctrl+N` | New task |
| `E` | New appointment |
| `V` | Voice command |
| `/` | Search tasks |
| `1`–`6` | Dashboard, Tasks, Calendar, Focus, Clocks, Assistant |
| `,` | Settings |
| `Esc` | Close dialog |
| Calendar: `←` / `→`, `T`, `D` / `W` / `M` | Previous/next, today, day/week/month |
| Task list: focus the drag handle, `Space`, arrow keys | Reorder by keyboard |

## Voice commands

Speak (microphone button, `V`, or `Ctrl+Shift+V`) or type in the command center (`Ctrl+K`). Examples:

- "Add a task to finish my report tomorrow at 9 AM"
- "Remind me to attend the meeting at 4 PM Kenya time"
- "Move my meeting to Friday at 3 PM Texas time" (for a recurring meeting, only the next occurrence moves)
- "What tasks do I have today?" · "Show my upcoming appointments" · "What's overdue?"
- "Start a 25-minute focus session" · "Start a timer for 10 minutes" · "Pause the timer" · "How much time is left?"
- "Mark my current task as complete" · "Delete the grocery task" (always confirmed, and restorable)
- "Schedule a call with Amina on Thursday from 2 to 3 PM Kenya time"
- "Show the overlay" · "What should I work on next?" · "Summarize my day"

**Time zones you can say:** *Kenya time, Nairobi time, EAT* · *Texas time, Central time, CST/CDT* · *El Paso time, Mountain time, MST/MDT* · *my time / local time*. Without one, your home zone (*Settings → Time zones*) is used.

**Speech engines** (*Settings → Voice input*): **Windows speech recognition**, the native WinRT recognizer, needs *Settings → Privacy & security → Speech → Online speech recognition* turned on. That Windows switch is your consent for Microsoft's speech service. A **WebView speech API** option is used if the runtime provides one. **Keyboard only** is always available.

## The floating overlay

Toggle it with `Ctrl+Shift+Space`, the title-bar button, or the tray menu.

- **Modes**: *Mini* shows the active task and countdown. *Standard* adds both clocks, progress, the next event, and voice/add buttons. *Expanded* adds quick add, a compact task list you can tick off, voice commands, and your schedule. Double-click the header, or use the expand button, to cycle modes.
- **Move** it by dragging the header. **Resize** it with the bottom-right grip. Size is remembered **per mode** and position across restarts.
- **Pin** keeps it on top; unpin to let other windows cover it. Set **opacity** in Settings.
- **Click-through** lets mouse clicks pass to the app underneath. Press **`Ctrl+Shift+X`** (configurable) to turn it off again; the tray menu also has a toggle.
- **Multi-monitor**: if the monitor it was on is disconnected, or the resolution changes, the overlay is moved back onto a visible screen (top-right of the primary monitor).
- **Performance**: it renders once per second and stops completely while hidden. Animations are minimal, with no video or polling, to avoid affecting games, calls or remote desktop.
- **Limits** (by design): it won't draw over **exclusive-fullscreen** games (use borderless/windowed mode), the lock screen, UAC prompts, or DRM-protected content. NEXUS deliberately doesn't try to bypass these OS security boundaries.

## Reminders & background behaviour

- Reminders are scheduled into SQLite and delivered by a **background thread in the NEXUS process**. It keeps running while all windows are hidden in the tray, which is why closing the window minimizes to the tray by default.
- To keep reminders working after a reboot, enable **Settings → Startup → Launch NEXUS when Windows starts**. It registers a per-user startup entry and starts NEXUS in the tray (`--minimized`).
- **Sleep and resume**: the scheduler compares wall-clock time against stored fire times, so anything that came due during sleep fires within about 15 seconds of waking. Reminders more than 12 hours stale (e.g. the PC was off overnight) produce a single "missed" summary instead of a burst of notifications.
- Recurring appointments always have reminders queued for the next two weeks, refreshed hourly and after every change.
- Snooze from the in-app toast (5/10/30 minutes) or use the default snooze length from Settings.

## AI assistant (optional)

NEXUS is fully functional without AI. To enable Claude:

1. *Settings → AI assistant* → turn on **Enable** and **Consent**.
2. Paste an Anthropic API key and press **Save key**. It's stored in **Windows Credential Manager** (via the Rust `keyring` crate) and can't be read back by the UI.
3. Use the Assistant page, **Break down** in the task editor, or "Ask Claude to interpret" for unrecognized commands.

Only task/appointment titles, times, priorities and working hours are sent, and only when you trigger an AI action. Notes are not sent. Requests use model `claude-opus-5-5` by default (changeable in Settings), with structured JSON output for subtask breakdowns. AI suggestions are never applied without your click.

## Data, backup & privacy

- **Where:** `%APPDATA%\com.nexus.productivity\nexus.db` (SQLite, WAL mode). Settings show the exact path.
- **Automatic backups:** a daily rolling backup (newest 7 kept) in `…\backups\`, plus a full copy **before every schema migration, restore and import**.
- **Manual:** *Settings → Data*: **Back up database…** (`.db`), **Export JSON…** (portable, human-readable), **Restore backup…**, **Import JSON…**. Restore and import first save your current data, so they can be undone.
- **Never in Git:** `.gitignore` excludes `*.db`, WAL/SHM files, backups, `.env` files and keys. No personal data, credentials or secrets belong in the repository.
- Nothing leaves your PC except optional AI requests you trigger, and Windows' own speech service if you use native dictation.

## Development setup

Prerequisites:

- **Node.js 22+** and npm
- **Rust (stable)** via [rustup](https://rustup.rs)
- **Windows:** Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (preinstalled on Windows 11). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- **Linux (for development/CI only):** `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev libxdo-dev`

```bash
git clone <your-repo-url> nexus
```

```bash
cd nexus
```

```bash
npm install
```

```bash
npm run app:dev
```

`npm run app:dev` starts Vite on port 1420 and opens the desktop app with hot reload. `npm run dev` alone serves the UI in a normal browser for fast UI work. In that mode data lives in `localStorage` and native features (overlay, tray, SQLite, global shortcuts) are stubbed. Add `?window=overlay` to the URL to preview the overlay.

## Build & test commands

| Command | What it does |
|---|---|
| `npm test` | Vitest unit/integration tests (time zones & DST, countdowns, recurrence, conflicts, Smart Reschedule, reminders, voice parsing, store CRUD/persistence, overlay geometry) |
| `npm run test:rust` | Rust tests for the persistence core (migrations, CRUD, reopen-from-disk, reminders queue, backup/restore, import/export) |
| `npm run typecheck` | TypeScript strict type check |
| `npm run test:all` | All of the above |
| `npm run build` | Production web build into `dist/` |
| `npm run app:build` | **Windows installer**: `src-tauri/target/release/bundle/nsis/*.exe` and `bundle/msi/*.msi` (run on Windows) |

**Reproducible installer builds:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the tests on Ubuntu, then builds the NSIS and MSI installers on `windows-latest` and uploads them as artifacts. Push a tag like `v1.0.0` and the installers are attached to a **draft GitHub Release** as well.

## Architecture

```
┌──────────────────────── NEXUS.exe (one process) ────────────────────────┐
│  WebView2 "main" window          WebView2 "overlay" window (transparent,│
│  React + TS + Tailwind           always-on-top, click-through capable)  │
│        │  invoke / events                │                              │
│  ──────┴─────────────── Tauri 2 IPC ─────┴───────────────────────────── │
│  Rust shell (src-tauri/src): commands · tray · global shortcuts ·       │
│  overlay control · autostart · single-instance · window-state ·         │
│  reminder scheduler thread → Windows toasts · AI proxy (keyring) ·      │
│  WinRT speech                                                           │
│        │                                                                │
│  nexus-core crate (src-tauri/core): SQLite schema, migrations,          │
│  repositories, reminder queue, backup/restore/export                    │
└─────────────────────────────── %APPDATA%\…\nexus.db ────────────────────┘
```

Time-zone math, recurrence, countdowns, scheduling, voice parsing and assistant heuristics are pure TypeScript modules in `src/lib/`, covered by unit tests. See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the module map, data flow, **database schema** and **migration strategy**.

```
src/
  data/        types (domain model) + backends (Tauri IPC / localStorage)
  store/       zustand app store (all mutations auto-save) + UI state
  lib/         time, countdown, recurrence, schedule, reminders, assistant,
               stats, overlayGeometry, voice/{parser,execute,engine}, platform
  components/  UI kit, editors, command center, charts, shell
  views/       Dashboard, Tasks, Calendar, Focus, Clocks, Assistant, Settings
  overlay/     floating overlay app
src-tauri/
  core/        nexus-core: SQLite persistence (+ tests in core/tests)
  src/         Tauri shell: commands, overlay, shortcuts, scheduler, ai, speech
```

## Troubleshooting

| Problem | Fix |
|---|---|
| **No notifications** | Windows Settings → System → Notifications: make sure notifications are on for NEXUS and Focus Assist / Do Not Disturb isn't hiding them. Use *Settings → Send test notification*. |
| **Reminders stop after restart** | Enable *Launch NEXUS when Windows starts*. Reminders need NEXUS running (in the tray is fine). |
| **Overlay is invisible over a game** | The game is in exclusive fullscreen. Switch it to borderless/windowed fullscreen. |
| **Can't click through to my app / can't click the overlay** | Press `Ctrl+Shift+X` (or use the tray menu → *Overlay click-through*). |
| **Overlay is off-screen** | Press `Ctrl+Shift+Space` twice. It's moved back onto a connected monitor when shown. |
| **A global shortcut does nothing** | Another app owns that combination. Settings flags it; pick a different one. |
| **Voice: "privacy policy was not accepted"** | Windows Settings → Privacy & security → Speech → turn on *Online speech recognition*. Or type the command. |
| **Voice: "no speech language pack"** | Windows Settings → Time & language → Speech → add a language (e.g. English (United States)). |
| **Microphone blocked** | Windows Settings → Privacy & security → Microphone → allow desktop apps. |
| **SmartScreen warning when installing** | The installer isn't code-signed yet: *More info → Run anyway*. To sign, add a certificate per [Tauri's Windows signing guide](https://v2.tauri.app/distribute/sign/windows/). |
| **"Created by a newer version of NEXUS"** | You opened a newer database with an older build. Update NEXUS; your data was not modified. |
| **Something went wrong after a restore/import** | The previous data was saved as `backups\nexus-before-restore-*.db` / `nexus-before-import-*.db`. Restore that file. |
| **App won't start / blank window** | Make sure WebView2 is installed ([download](https://developer.microsoft.com/microsoft-edge/webview2/)). Your data is untouched. |
| **AI requests fail** | Check the key in *Settings → AI*, consent is on, and you're online. Everything else keeps working offline. |

## Known limitations

- Native speech uses Windows' online dictation service. Fully offline speech-to-text (e.g. a bundled Whisper model) isn't included yet; the engine abstraction in `src/lib/voice/engine.ts` and `src-tauri/src/speech.rs` is the place to add one.
- Snooze buttons are on the in-app toast; Windows toast action buttons aren't used.
- The overlay intentionally doesn't draw over exclusive-fullscreen apps, the secure desktop, or protected content.
