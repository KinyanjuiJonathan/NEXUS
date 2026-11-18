//! NEXUS desktop shell: windows, tray, global shortcuts, reminders, persistence.

mod ai;
mod commands;
mod overlay;
mod perf;
mod scheduler;
mod shortcuts;
mod speech;
mod state;
mod typer;
#[cfg(windows)]
mod win_cpu;
#[cfg(windows)]
mod win_input;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use nexus_core::{now_ms, Store};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use state::AppState;

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn setting_bool(app: &AppHandle, key: &str, default: bool) -> bool {
    app.state::<AppState>()
        .store
        .lock()
        .ok()
        .and_then(|s| s.get_setting(key).ok().flatten())
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    // Let go of any key the Auto Typer is holding before the process ends.
    app.state::<typer::TyperState>().request_stop();
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    app.state::<AppState>().wake_scheduler();
    app.exit(0);
}

#[tauri::command]
fn main_ready(app: AppHandle) {
    // The UI calls this once it has rendered, avoiding a white flash on startup.
    let minimized = std::env::args().any(|a| a == "--minimized") && setting_bool(&app, "startMinimized", true);
    if !minimized {
        show_main(&app);
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open NEXUS", true, None::<&str>)?;
    let overlay_item = MenuItem::with_id(app, "overlay", "Show / hide overlay", true, None::<&str>)?;
    let click = CheckMenuItem::with_id(app, "click", "Overlay click-through", true, app.state::<AppState>().is_click_through(), None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick", "Quick add task…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NEXUS", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &overlay_item, &click, &quick, &sep, &quit])?;
    let click_handle = click.clone();

    let mut builder = TrayIconBuilder::with_id("nexus-tray")
        .tooltip("NEXUS")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "overlay" => {
                let _ = overlay::toggle(app);
            }
            "click" => {
                let _ = overlay::toggle_click_through(app);
                let _ = click_handle.set_checked(app.state::<AppState>().is_click_through());
            }
            "quick" => {
                show_main(app);
                let _ = app.emit_to("main", "nexus://quick-add", ());
            }
            "quit" => app_quit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the running instance instead of starting another.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        // Remember window position/size (validated against connected monitors).
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED)
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("nexus.db");
            let store = Store::open(&db_path).map_err(|e| format!("Could not open the NEXUS database: {e}"))?;
            let now = now_ms();
            let _ = store.purge_expired(now);
            if let Err(e) = store.auto_backup(data_dir.join("backups"), 7, now) {
                log::warn!("automatic backup failed: {e}");
            }
            app.manage(perf::PerfState::new());
            app.manage(typer::TyperState::new());
            app.manage(AppState {
                store: Mutex::new(store),
                data_dir: data_dir.clone(),
                db_path: db_path.clone(),
                scheduler_wake: Mutex::new(None),
                click_through: AtomicBool::new(false),
                quitting: AtomicBool::new(false),
            });

            let handle = app.handle().clone();
            build_tray(&handle)?;
            let sc = shortcuts::load(&handle);
            let failed = shortcuts::register(&handle, &sc);
            if !failed.is_empty() {
                log::warn!("some shortcuts are in use by other apps: {failed:?}");
            }
            scheduler::start(handle.clone(), db_path);
            overlay::restore(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<AppState>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                match window.label() {
                    "overlay" => {
                        api.prevent_close();
                        let _ = overlay::set_visible(app, false);
                    }
                    "main" if setting_bool(app, "closeToTray", true) => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    _ => {
                        app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            main_ready,
            app_quit,
            commands::load_snapshot,
            commands::task_upsert,
            commands::task_delete,
            commands::tasks_reorder,
            commands::category_upsert,
            commands::category_delete,
            commands::event_upsert,
            commands::event_delete,
            commands::timer_upsert,
            commands::timer_delete,
            commands::focus_add,
            commands::setting_set,
            commands::reminders_sync,
            commands::reminders_clear,
            commands::reminder_snooze,
            commands::reminder_dismiss,
            commands::reminders_upcoming,
            commands::data_info,
            commands::backup_create,
            commands::backup_restore,
            commands::export_json,
            commands::import_json,
            overlay::overlay_show,
            overlay::overlay_toggle,
            overlay::overlay_set_click_through,
            overlay::overlay_set_pinned,
            overlay::overlay_state,
            shortcuts::shortcuts_apply,
            shortcuts::typer_shortcut,
            ai::ai_set_key,
            ai::ai_clear_key,
            ai::ai_has_key,
            ai::ai_request,
            speech::speech_available,
            speech::speech_listen,
            perf::perf_snapshot,
            commands::work_upsert,
            commands::work_delete,
            commands::activity_add,
            commands::idle_seconds,
            perf::perf_stop,
            typer::typer_start,
            typer::typer_stop,
            typer::typer_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NEXUS");
}
