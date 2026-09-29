//! Homerun's desktop shell (§4, §5.1): a small, privileged Tauri process. It spawns and
//! supervises `homerund`, owns the keychain, forwards the webview's calls on a webview-role
//! connection, and observes sleep and wake. Closing the window leaves the runtime running; the
//! Dock icon brings the window back. Quitting stops the runtime cleanly.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod keychain;
mod power;
mod shell;

use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindowBuilder};

/// The app's own pages only; anything else is refused (links go through `open_external`).
fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost") || (cfg!(debug_assertions) && url.host_str() == Some("localhost") && url.port() == Some(5178))
        }
        _ => false,
    }
}

/// Focus the window, or create it again after it was closed.
fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else { return };
    if let Ok(b) = WebviewWindowBuilder::from_config(app, &cfg) {
        let _ = b.on_navigation(navigation_allowed).build();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_window(app)))
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
        ])
        .setup(|app| {
            let shell = Arc::new(shell::start(&app.package_info().version.to_string()));
            app.manage(shell.clone());
            show_window(app.handle());
            power::observe(move |ev| {
                let shell = shell.clone();
                // Off the main thread. A missed notification is fine: the runtime also detects
                // sleep from gaps in its own ticks (§8.4).
                std::thread::spawn(move || {
                    if let Some(c) = shell.rt.shell() {
                        let _ = c.notify(ev.method(), ev.params());
                    }
                    if matches!(ev, power::PowerEvent::DidWake { .. }) {
                        shell.rt.woke();
                    }
                });
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the app");

    app.run(|app, ev| match ev {
        // The last window closed: keep running, so runs and schedules carry on (§5.1).
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => show_window(app),
        // Quit: close the runtime's stdin, then TERM, then KILL (§5.1).
        RunEvent::Exit => {
            if let Some(shell) = app.try_state::<Arc<shell::Shell>>() {
                shell.rt.stop(Duration::from_secs(16));
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_own_pages_load() {
        for ok in ["tauri://localhost/index.html", "http://tauri.localhost/"] {
            assert!(navigation_allowed(&Url::parse(ok).unwrap()), "{ok}");
        }
        for bad in ["https://example.com", "file:///etc/passwd", "tauri://evil", "http://localhost:9999/"] {
            assert!(!navigation_allowed(&Url::parse(bad).unwrap()), "{bad}");
        }
    }
}
