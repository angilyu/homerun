//! The process model (§5.1): the window comes and goes while Homerun keeps running in the menu
//! bar; quitting is confirmed when it would interrupt something; the menu bar and the Dock follow.

use crate::shell::Shell;
use crate::{macos, notifications, tray, updater};
use homerun_shell_core::notify::Target;
use homerun_shell_core::quit::{self, Decision, Why};
use homerun_shell_core::summary;
use homerun_shell_core::tray::Action;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{AppHandle, Manager, Url, WebviewWindowBuilder};

/// The app's own pages only; anything else is refused (links go through `open_external`).
pub fn navigation_allowed(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost") || (cfg!(debug_assertions) && url.host_str() == Some("localhost") && url.port() == Some(5178))
        }
        _ => false,
    }
}

pub fn shell(app: &AppHandle) -> Option<Arc<Shell>> {
    app.try_state::<Arc<Shell>>().map(|s| s.inner().clone())
}

/// Focus the window, or create it again after it was closed. The Dock icon comes back with it
/// and goes when it closes (§5.1, plan Q1).
pub fn show_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else { return };
    if let Ok(b) = WebviewWindowBuilder::from_config(app, &cfg) {
        if let Ok(w) = b.on_navigation(navigation_allowed).build() {
            let _ = w.set_focus();
        }
    }
}

pub fn window_closed(app: &AppHandle) {
    notifications::set_focused(false);
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// A notification click or a menu row: open the window at that screen.
pub fn navigate(app: &AppHandle, target: Target) {
    show_window(app);
    if let Some(s) = shell(app) {
        s.host.event(json!({"type": "navigate", "target": target}));
    }
}

pub fn on_action(app: &AppHandle, a: Action) {
    let Some(s) = shell(app) else { return };
    match a {
        Action::Open => show_window(app),
        Action::Thread(id) => navigate(app, Target::from_thread_identifier(&id)),
        Action::RestartRuntime => s.rt.restart(),
        Action::PauseAll | Action::ResumeAll => {
            std::thread::spawn(move || {
                let Some(c) = s.rt.shell() else { return };
                let mut p = s.prefs.lock().unwrap().clone();
                let r = if a == Action::PauseAll { summary::pause_all(&*c, &mut p) } else { summary::resume_all(&*c, &mut p) };
                // Whatever succeeded is recorded, even if a later call failed.
                s.update_prefs(|q| q.paused_by_pause_all = p.paused_by_pause_all);
                s.rt.log_event("monitors.pause_all", json!({"action": a.id(), "ok": r.is_ok()}));
                s.host.mark_dirty();
            });
        }
        Action::CheckUpdates => {
            if let Some(u) = updater::get(app) {
                u.poke();
            }
        }
        Action::RestartToUpdate => request_quit(app, Why::Update),
        Action::DownloadPage => {
            let _ = crate::commands::open_external(DOWNLOAD_PAGE.into());
        }
        Action::Quit => request_quit(app, Why::User),
    }
}

pub const DOWNLOAD_PAGE: &str = "https://github.com/angilyu/homerun/releases/latest";

/// The menu bar follows the runtime, the summary and the updater. One thread renders it, a
/// moment after the last change, and at least every minute (schedules change without a
/// `threads.changed`).
pub fn spawn_refresher(app: &AppHandle, s: Arc<Shell>) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("menu-bar".into())
        .spawn(move || loop {
            s.host.wait_dirty(Duration::from_secs(60));
            std::thread::sleep(Duration::from_millis(300));
            s.host.wait_dirty(Duration::ZERO);
            let summary = s.refresh_summary(Duration::from_secs(5));
            let update = updater::get(&app).map(|u| u.state()).unwrap_or(homerun_shell_core::update::UpdateState::Idle);
            let menu = homerun_shell_core::tray::build(&s.rt.status(), summary.as_ref(), &update);
            let _ = tray::render(&app, &menu);
        })
        .expect("menu-bar thread");
}

/// Set once quitting is decided; the next `terminate:` goes straight through.
static QUIT_OK: AtomicBool = AtomicBool::new(false);
static QUITTING: AtomicBool = AtomicBool::new(false);

/// `applicationShouldTerminate:`: ⌘Q, Dock → Quit and AppleScript all come here. Logout,
/// restart and shutdown are never held up (§5.1): the runtime is stopped in `RunEvent::Exit`,
/// runs resume on the next launch, and a staged update waits for the next quit.
pub fn should_terminate(app: &AppHandle) -> bool {
    if QUIT_OK.load(Ordering::SeqCst) {
        return true;
    }
    if macos::powering_off() {
        if let Some(s) = shell(app) {
            s.rt.log_event("quit", json!({"why": "power_off"}));
        }
        return true;
    }
    request_quit(app, Why::User);
    false
}

/// If the quit hook can't be installed (a future tao with its own `applicationShouldTerminate:`),
/// ⌘Q at least goes through the confirmation: the app menu's Quit becomes our item. Dock → Quit
/// and AppleScript then quit without asking, which the log records. Windows has no app menu:
/// there the tray's Quit is the only way to quit, and it always asks.
#[cfg(not(windows))]
pub fn fallback_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let quit = MenuItem::with_id(app, Action::Quit.id(), "Quit Homerun", true, Some("CmdOrCtrl+Q"))?;
    let homerun = Submenu::with_items(
        app,
        "Homerun",
        true,
        &[
            &P::about(app, None, None)?,
            &P::separator(app)?,
            &P::hide(app, None)?,
            &P::hide_others(app, None)?,
            &P::show_all(app, None)?,
            &P::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &P::undo(app, None)?,
            &P::redo(app, None)?,
            &P::separator(app)?,
            &P::cut(app, None)?,
            &P::copy(app, None)?,
            &P::paste(app, None)?,
            &P::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(app, "Window", true, &[&P::minimize(app, None)?, &P::close_window(app, None)?])?;
    Menu::with_items(app, &[&homerun, &edit, &window])
}

fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv().ok()
}

/// Confirm if runs or input would be interrupted, then stop the runtime, install a staged
/// update, and exit (or restart into the update).
pub fn request_quit(app: &AppHandle, why: Why) {
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(s) = shell(&app) else {
            QUIT_OK.store(true, Ordering::SeqCst);
            return app.exit(0);
        };
        let summary = s.refresh_summary(Duration::from_secs(1));
        let decision = quit::decide(summary.as_ref(), why);
        let asked = matches!(decision, Decision::Confirm(_));
        let go = match decision {
            Decision::Now => true,
            Decision::Confirm(d) => {
                let auto = updater::get(&app).is_some_and(|u| u.test_build()) && std::env::var_os("HOMERUN_TEST_CONFIRM_QUIT").is_some();
                auto || on_main(&app, move || macos::confirm(&d)).unwrap_or(false)
            }
        };
        s.rt.log_event("quit", json!({"why": format!("{why:?}").to_lowercase(), "asked": asked, "confirmed": go}));
        if !go {
            QUITTING.store(false, Ordering::SeqCst);
            return;
        }
        s.rt.stop(Duration::from_secs(16));
        if let Some(u) = updater::get(&app) {
            u.install_if_ready(why);
        }
        QUIT_OK.store(true, Ordering::SeqCst);
        if why == Why::Update {
            app.request_restart();
        } else {
            app.exit(0);
        }
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
