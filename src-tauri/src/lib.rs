//! NEXUS desktop shell: windows, tray, global shortcuts, reminders, persistence.

mod activity;
mod ai;
mod commands;
mod overlay;
mod perf;
mod scheduler;
mod shortcuts;
mod speech;
mod startup;
mod state;
mod typer;
mod updates;
#[cfg(windows)]
mod win_cpu;
#[cfg(windows)]
mod win_input;
#[cfg(windows)]
mod win_session;
mod screen;
#[cfg(windows)]
mod win_screen;
#[cfg(windows)]
mod win_dictation;

use std::sync::atomic::Ordering;
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
        .store()
        .ok()
        .and_then(|s| s.get_setting(key).ok().flatten())
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    // Let go of any key the Auto Typer is holding before the process ends.
    app.state::<typer::TyperState>().request_stop();
    // So the time until the next launch is never counted as work.
    activity::beat(&app);
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
        // Every piece of shared state is registered here, before any window exists.
        // Registering it inside `setup` left a gap in which a window that loaded
        // quickly (for example right after Windows starts) could ask for its data
        // and be told the state did not exist.
        .manage(AppState::new())
        .manage(perf::PerfState::new())
        .manage(typer::TyperState::new())
        .manage(activity::ActivityState::new())
        .manage(speech::DictationState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            // The database first; reminders, shortcuts and the overlay follow once it is open.
            // A failure here never stops the app: the window shows the recovery screen instead.
            startup::init(&handle);
            if let Err(e) = build_tray(&handle) {
                log::warn!("the tray icon could not be created: {e}");
            }
            activity::start(handle.clone());
            startup::start_backup_timer(handle);
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
                    // Helper windows (the screen-region picker) come and go; closing one must never quit NEXUS.
                    label if label != "main" => {}
                    _ => {
                        activity::beat(app);
                        app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            main_ready,
            app_quit,
            startup::startup_status,
            startup::startup_retry,
            startup::startup_restore,
            startup::startup_fresh,
            startup::open_data_folder,
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
            screen::screen_read,
            screen::region_pick,
            screen::region_done,
            updates::update_check,
            updates::open_external,
            speech::speech_available,
            speech::speech_listen,
            speech::dictation_start,
            speech::dictation_stop,
            perf::perf_snapshot,
            commands::work_upsert,
            commands::work_delete,
            commands::activity_add,
            commands::activity_clear,
            commands::idle_seconds,
            perf::perf_stop,
            typer::typer_start,
            typer::typer_stop,
            typer::typer_status,
            activity::activity_state,
            activity::activity_configure,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NEXUS");
}
