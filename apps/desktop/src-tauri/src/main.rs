//! Homerun's desktop shell (§4, §5.1): a small, privileged Tauri process. It spawns and
//! supervises `homerund`, owns the keychain, forwards the webview's calls on a webview-role
//! connection, and observes sleep and wake. Closing the window leaves Homerun running in the menu
//! bar; quitting asks first when it would interrupt something, then stops the runtime cleanly.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli_prompts;
mod commands;
mod keychain;
mod lifecycle;
mod login_item;
mod macos;
mod notifications;
mod power;
mod shell;
mod tray;
mod updater;

use homerun_shell_core::keys;
use homerun_shell_core::tray::Action;
use lifecycle::{on_action, show_window};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_window(app)))
        // Installs only through `updater.rs`; the webview has no updater permission (§11, §13).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, ev| {
            if let Some(a) = Action::parse(ev.id().as_ref()) {
                on_action(app, a);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::rpc_call,
            commands::rpc_attach,
            commands::key_status,
            commands::key_set,
            commands::key_clear,
            commands::runtime_status,
            commands::runtime_restart,
            commands::open_external,
            commands::reveal_logs,
            commands::app_info,
            commands::shell_events_attach,
            commands::shell_prefs,
            commands::keep_running_done,
            commands::login_item_status,
            commands::login_item_set,
            commands::open_login_items,
            commands::notifications_status,
            commands::notifications_request,
            commands::open_notification_settings,
            commands::update_status,
            commands::update_check,
            commands::update_restart,
            commands::update_set_auto,
            commands::cli_tool_status,
            commands::cli_tool_install,
            commands::cli_tool_remove,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Read before anything else runs: the launch's Apple Event is current only now.
            let at_login = macos::launched_at_login();
            let test = updater::is_test_build(&handle);
            let shell = Arc::new(shell::start(&app.package_info().version.to_string(), test, handle.clone()));
            app.manage(shell.clone());

            let (s1, s2, s3) = (shell.clone(), shell.clone(), shell.clone());
            let restart_when_ready = test && std::env::var_os("HOMERUN_TEST_RESTART_WHEN_READY").is_some();
            let h1 = handle.clone();
            let auto = shell.prefs.lock().unwrap().auto_download_updates;
            let up = updater::Updater::new(
                &handle,
                &shell.data_dir,
                auto,
                updater::Hooks {
                    changed: Box::new(move |st| {
                        s1.host.event(json!({"type": "update", "state": st}));
                        s1.host.mark_dirty();
                        // update-test.sh: the same path as Restart now.
                        if restart_when_ready && matches!(st, homerun_shell_core::update::UpdateState::Ready { .. }) {
                            lifecycle::request_quit(&h1, homerun_shell_core::quit::Why::Update);
                        }
                    }),
                    log: Box::new(move |m, f| s2.rt.log_event(m, f)),
                    protocol: Box::new(move || match s3.rt.status() {
                        homerun_shell_core::RuntimeStatus::Ready { protocol, .. } => protocol,
                        _ => 1,
                    }),
                },
            );
            app.manage(up.clone());
            up.spawn();

            let nav = handle.clone();
            notifications::init(move |t| {
                let app = nav.clone();
                let _ = nav.run_on_main_thread(move || lifecycle::navigate(&app, t));
            });

            let hook = handle.clone();
            if !macos::install_quit_hook(move || lifecycle::should_terminate(&hook)) {
                shell.rt.log_event("quit.hook_unavailable", json!({}));
                app.set_menu(lifecycle::fallback_menu(&handle)?)?;
            }
            macos::observe_power_off();

            tray::create(&handle)?;
            lifecycle::spawn_refresher(&handle, shell.clone());

            // At login Homerun starts in the menu bar with no window and no Dock icon (§5.1),
            // unless onboarding isn't finished.
            let onboarded = keys::status(shell.host.keys_ref()).is_ok_and(|k| k.present);
            shell.rt.log_event("launch", json!({"version": app.package_info().version.to_string(), "at_login": at_login, "onboarded": onboarded}));
            if at_login && onboarded {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            } else {
                show_window(&handle);
            }

            power::observe(move |ev| {
                let shell = shell.clone();
                // Off the main thread. A missed notification is fine: the runtime also detects
                // sleep from gaps in its own ticks (§8.4).
                std::thread::spawn(move || {
                    if let Some(c) = shell.rt.shell() {
                        let _ = c.notify(ev.method(), ev.params());
                    }
                    if matches!(ev, power::PowerEvent::DidWake { .. }) {
                        // The updater's schedule is wall-clock: a check missed asleep runs within
                        // a minute.
                        shell.rt.woke();
                    }
                });
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the app");

    app.run(|app, ev| match ev {
        // The last window closed: keep running in the menu bar, so runs and schedules carry on
        // (§5.1).
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::WindowEvent { label, event, .. } if label == "main" => match event {
            WindowEvent::Focused(f) => notifications::set_focused(f),
            WindowEvent::Destroyed => lifecycle::window_closed(app),
            _ => {}
        },
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => show_window(app),
        // Quit, logout, or restart: close the runtime's stdin, then TERM, then KILL (§5.1). A
        // no-op when the quit confirmation already stopped it.
        RunEvent::Exit => {
            if let Some(shell) = app.try_state::<Arc<shell::Shell>>() {
                shell.rt.stop(Duration::from_secs(16));
            }
        }
        _ => {}
    });
}
