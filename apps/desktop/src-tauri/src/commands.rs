//! Everything the webview can ask of the shell (§5.1, §5.2). Runtime methods go through
//! `rpc_call`, which forwards only the webview allowlist on the webview-role connection; the
//! launch token, the socket and the keychain stay here. Blocking work runs off the main thread.

use crate::notifications::{self, Permission};
use crate::shell::Shell;
use crate::{lifecycle, login_item, updater};
use homerun_shell_core::allowlist::{forward, ShellError};
use homerun_shell_core::cli_tool::{self, Place, ToolStatus};
use homerun_shell_core::keys::{self, KeyError, KeyStatus, SetOutcome, ShellCalls};
use homerun_shell_core::login::LoginItem;
use homerun_shell_core::quit::Why;
use homerun_shell_core::update::UpdateState;
use homerun_shell_core::RuntimeStatus;
use serde_json::{json, Value};
#[cfg(not(windows))]
use std::process::Command;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

type Res<T> = Result<T, ShellError>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| ShellError::shell(e.to_string()))?
}

fn key_error(e: KeyError) -> ShellError {
    match e {
        KeyError::NeedsApproval => ShellError { kind: "keychain_approval", code: None, message: e.to_string(), data: None },
        KeyError::Other(m) => ShellError::shell(m),
    }
}

#[tauri::command]
pub async fn rpc_call(shell: State<'_, Arc<Shell>>, method: String, params: Option<Value>) -> Res<Value> {
    let s = shell.inner().clone();
    blocking(move || forward(s.rt.webview().as_deref(), &method, params.unwrap_or_else(|| json!({})))).await
}

#[tauri::command]
pub fn rpc_attach(shell: State<'_, Arc<Shell>>, channel: Channel<Value>) {
    shell.host.attach(channel);
}

#[tauri::command]
pub async fn key_status(shell: State<'_, Arc<Shell>>) -> Res<KeyStatus> {
    let s = shell.inner().clone();
    blocking(move || keys::status(s.host.keys_ref()).map_err(key_error)).await
}

/// Onboarding and Settings (§7.2): check with Anthropic, then store and hand over.
#[tauri::command]
pub async fn key_set(shell: State<'_, Arc<Shell>>, value: String) -> Res<SetOutcome> {
    let s = shell.inner().clone();
    blocking(move || {
        let conn = s.rt.shell();
        keys::set_key(s.host.keys_ref(), conn.as_deref().map(|c| c as &dyn ShellCalls), &value).map_err(ShellError::shell)
    })
    .await
}

#[tauri::command]
pub async fn key_clear(shell: State<'_, Arc<Shell>>) -> Res<()> {
    let s = shell.inner().clone();
    blocking(move || {
        let conn = s.rt.shell();
        keys::clear_key(s.host.keys_ref(), conn.as_deref().map(|c| c as &dyn ShellCalls)).map_err(ShellError::shell)
    })
    .await
}

#[tauri::command]
pub fn runtime_status(shell: State<'_, Arc<Shell>>) -> RuntimeStatus {
    shell.rt.status()
}

/// The banner's *Restart* (§5.1): also the way out of a crash loop or a blocked state.
#[tauri::command]
pub fn runtime_restart(shell: State<'_, Arc<Shell>>) {
    shell.rt.restart();
}

/// Links in messages open in the default browser, never in the webview (plan §4).
#[tauri::command]
pub fn open_external(url: String) -> Res<()> {
    if !external_ok(&url) {
        return Err(ShellError::shell("Homerun only opens web and email links."));
    }
    open(&url)
}

pub fn external_ok(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && url.len() <= 8192
        && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Settings → *Show logs*: the runtime's log in Finder (Explorer on Windows).
#[tauri::command]
pub fn reveal_logs(shell: State<'_, Arc<Shell>>) -> Res<()> {
    let p = shell.rt.log_path();
    let p = if p.exists() { p } else { shell.data_dir.join("logs") };
    reveal(&p)
}

fn couldnt(e: impl std::fmt::Display) -> ShellError {
    ShellError::shell(format!("Couldn't open it: {e}"))
}

/// A link or a settings page in its default handler.
#[cfg(not(windows))]
fn open(target: &str) -> Res<()> {
    let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(program).arg(target).spawn().map(|_| ()).map_err(couldnt)
}

#[cfg(windows)]
fn open(target: &str) -> Res<()> {
    crate::win::shell_open(target).map_err(couldnt)
}

#[cfg(not(windows))]
fn reveal(p: &std::path::Path) -> Res<()> {
    let p = p.display().to_string();
    let args: &[&str] = if cfg!(target_os = "macos") { &["-R", &p] } else { &[&p] };
    let program = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(program).args(args).spawn().map(|_| ()).map_err(couldnt)
}

#[cfg(windows)]
fn reveal(p: &std::path::Path) -> Res<()> {
    crate::win::reveal(p).map_err(couldnt)
}

#[tauri::command]
pub fn app_info(shell: State<'_, Arc<Shell>>) -> Value {
    json!({
        "version": shell.version,
        "build": if cfg!(debug_assertions) { "debug" } else { "release" },
        "platform": std::env::consts::OS,
        "data_dir": shell.data_dir,
        "log_path": shell.rt.log_path(),
        "key_store": shell.host.keys_ref().kind(),
    })
}

/// Notification clicks and menu rows (`navigate`) and the updater (`update`), in order (§5.1).
#[tauri::command]
pub fn shell_events_attach(shell: State<'_, Arc<Shell>>, channel: Channel<Value>) {
    shell.host.attach_events(channel);
}

#[tauri::command]
pub fn shell_prefs(shell: State<'_, Arc<Shell>>) -> Value {
    let p = shell.prefs.lock().unwrap();
    json!({"keep_running_asked": p.keep_running_asked, "auto_download_updates": p.auto_download_updates})
}

/// Onboarding's *Keep Homerun running* step was shown (plan Q2): it isn't shown again.
#[tauri::command]
pub fn keep_running_done(shell: State<'_, Arc<Shell>>) {
    shell.update_prefs(|p| p.keep_running_asked = true);
}

#[tauri::command]
pub async fn login_item_status() -> Res<LoginItem> {
    blocking(|| Ok(login_item::status())).await
}

#[tauri::command]
pub async fn login_item_set(shell: State<'_, Arc<Shell>>, on: bool) -> Res<LoginItem> {
    let s = shell.inner().clone();
    blocking(move || {
        let r = login_item::set(on);
        s.rt.log_event("login_item.set", json!({"on": on, "ok": r.is_ok()}));
        r.map_err(ShellError::shell)
    })
    .await
}

#[tauri::command]
pub fn open_login_items() {
    login_item::open_settings();
}

#[tauri::command]
pub async fn notifications_status() -> Res<Permission> {
    blocking(|| Ok(notifications::status())).await
}

/// The system asks once; after that this only reports, and Settings links to System Settings.
#[tauri::command]
pub async fn notifications_request() -> Res<Permission> {
    blocking(|| Ok(notifications::request())).await
}

#[tauri::command]
pub fn open_notification_settings() -> Res<()> {
    open(notifications::SETTINGS_URL)
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateState {
    updater::get(&app).map(|u| u.state()).unwrap_or(UpdateState::Unavailable { message: "Updates aren't set up.".into() })
}

#[tauri::command]
pub fn update_check(app: AppHandle) {
    if let Some(u) = updater::get(&app) {
        u.poke();
    }
}

/// The banner's *Restart Now*: the same confirmation as quitting, then the update (§11).
#[tauri::command]
pub fn update_restart(app: AppHandle) {
    lifecycle::request_quit(&app, Why::Update);
}

#[tauri::command]
pub fn update_set_auto(app: AppHandle, shell: State<'_, Arc<Shell>>, on: bool) {
    shell.update_prefs(|p| p.auto_download_updates = on);
    if let Some(u) = updater::get(&app) {
        u.set_auto(on);
    }
}

/// Where the app runs from, for *Install command-line tool* (§5.2).
fn cli_place() -> Res<Place> {
    let home = homerun_shell_core::dirs::home(cfg!(windows), |k| std::env::var_os(k)).ok_or_else(|| ShellError::shell("HOME isn't set."))?;
    let exe = std::env::current_exe().map_err(|e| ShellError::shell(e.to_string()))?;
    Ok(Place { home, exe })
}

#[tauri::command]
pub async fn cli_tool_status() -> Res<ToolStatus> {
    blocking(|| Ok(cli_tool::status(&cli_place()?))).await
}

#[tauri::command]
pub async fn cli_tool_install(shell: State<'_, Arc<Shell>>) -> Res<ToolStatus> {
    let s = shell.inner().clone();
    blocking(move || {
        let r = cli_tool::install(&cli_place()?);
        s.rt.log_event("cli_tool.install", json!({"ok": r.is_ok()}));
        r.map_err(|e| ShellError::shell(e.0))
    })
    .await
}

#[tauri::command]
pub async fn cli_tool_remove(shell: State<'_, Arc<Shell>>) -> Res<ToolStatus> {
    let s = shell.inner().clone();
    blocking(move || {
        let r = cli_tool::remove(&cli_place()?);
        s.rt.log_event("cli_tool.remove", json!({"ok": r.is_ok()}));
        r.map_err(|e| ShellError::shell(e.0))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_webview_gets_no_updater_or_shell_plugin_permissions() {
        // §11, §13: the page asks the shell (update_*), which decides; it never drives the plugin.
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let perms: Vec<&str> = caps["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        assert!(perms.iter().all(|p| !p.starts_with("updater:") && !p.starts_with("shell:")), "{perms:?}");
        for c in [
            "allow-update-restart",
            "allow-login-item-set",
            "allow-notifications-request",
            "allow-cli-tool-status",
            "allow-cli-tool-install",
            "allow-cli-tool-remove",
        ] {
            assert!(perms.contains(&c), "{c}");
        }
    }

    #[test]
    fn only_web_and_mail_links_open() {
        for ok in ["https://example.com/a?b=c", "http://localhost:3000", "mailto:a@b.c", "HTTPS://X.COM"] {
            assert!(external_ok(ok), "{ok}");
        }
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "https://a b",
            "https://a\nb",
            "-R",
            "/Applications/Calculator.app",
            "x-apple.systempreferences:",
        ] {
            assert!(!external_ok(bad), "{bad}");
        }
    }
}
