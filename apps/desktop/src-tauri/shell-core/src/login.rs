//! Open at login (§5.1, §11): `SMAppService.mainApp`'s status as Settings shows it. The system
//! is the source of truth; the user can turn the item off in System Settings at any time.
//!
//! On Windows the item is a per-user `HKCU\…\CurrentVersion\Run` value that starts the app
//! with `--autostart`; Task Manager's Startup tab (or Settings → Apps → Startup) can turn it off
//! through `…\Explorer\StartupApproved\Run`, which Homerun honours and reports as
//! `NeedsApproval` rather than overriding (§18 row @login).

use serde::Serialize;
use std::path::Path;

/// The argument the Windows Run value passes, so a launch at login can be told apart.
pub const AUTOSTART_ARG: &str = "--autostart";
/// The value's name under `Run` and `StartupApproved\Run`.
pub const RUN_VALUE: &str = "Homerun";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginItem {
    Enabled,
    Off,
    /// Registered, but turned off in System Settings → General → Login Items.
    NeedsApproval,
    /// Not a bundle (e.g. `tauri dev`), or not macOS.
    Unavailable,
}

impl LoginItem {
    /// `SMAppServiceStatus`: 0 notRegistered, 1 enabled, 2 requiresApproval, 3 notFound.
    pub fn from_raw(raw: isize) -> LoginItem {
        match raw {
            0 => LoginItem::Off,
            1 => LoginItem::Enabled,
            2 => LoginItem::NeedsApproval,
            _ => LoginItem::Unavailable,
        }
    }

    /// Windows: the `Run` value (if any) and the `StartupApproved\Run` value's bytes (if any).
    /// A `Run` value for another copy of Homerun is `Off` here: turning it on points it here.
    /// StartupApproved's first byte is even when the item is allowed, odd when it was turned off.
    pub fn from_windows(run: Option<&str>, exe: &Path, approved: Option<&[u8]>) -> LoginItem {
        let Some(run) = run else { return LoginItem::Off };
        if !runs_exe(run, exe) {
            return LoginItem::Off;
        }
        match approved.and_then(|b| b.first()) {
            Some(b) if b & 1 == 1 => LoginItem::NeedsApproval,
            _ => LoginItem::Enabled,
        }
    }
}

/// The `Run` value for `exe`: quoted, so a path with spaces is one argument.
pub fn run_command(exe: &Path) -> String {
    format!("\"{}\" {AUTOSTART_ARG}", exe.display())
}

/// Whether a `Run` value starts `exe`, ignoring case as Windows paths do.
fn runs_exe(run: &str, exe: &Path) -> bool {
    let run = run.trim();
    let program = match run.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(""),
        None => run.split(' ').next().unwrap_or(""),
    };
    !program.is_empty() && program.eq_ignore_ascii_case(&exe.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_status() {
        assert_eq!(
            [0, 1, 2, 3, 99].map(LoginItem::from_raw),
            [LoginItem::Off, LoginItem::Enabled, LoginItem::NeedsApproval, LoginItem::Unavailable, LoginItem::Unavailable]
        );
        assert_eq!(serde_json::to_value(LoginItem::NeedsApproval).unwrap(), "needs_approval");
    }

    #[test]
    fn a_windows_run_value_is_read_with_task_managers_switch() {
        let exe = Path::new(r"C:\Users\a b\AppData\Local\Homerun\homerun.exe");
        let cmd = run_command(exe);
        assert_eq!(cmd, r#""C:\Users\a b\AppData\Local\Homerun\homerun.exe" --autostart"#);
        assert_eq!(LoginItem::from_windows(None, exe, None), LoginItem::Off);
        assert_eq!(LoginItem::from_windows(Some(&cmd), exe, None), LoginItem::Enabled);
        assert_eq!(LoginItem::from_windows(Some(&cmd.to_uppercase()), exe, None), LoginItem::Enabled);
        assert_eq!(LoginItem::from_windows(Some(&cmd), exe, Some(&[2, 0, 0, 0])), LoginItem::Enabled);
        assert_eq!(LoginItem::from_windows(Some(&cmd), exe, Some(&[6])), LoginItem::Enabled);
        assert_eq!(LoginItem::from_windows(Some(&cmd), exe, Some(&[3, 0, 0, 0, 9, 9])), LoginItem::NeedsApproval);
        assert_eq!(LoginItem::from_windows(Some(&cmd), exe, Some(&[])), LoginItem::Enabled);
        // Another copy's entry, or something that only starts with our path.
        assert_eq!(LoginItem::from_windows(Some(r#""C:\Other\homerun.exe" --autostart"#), exe, None), LoginItem::Off);
        assert_eq!(LoginItem::from_windows(Some(r#""C:\Users\a b\AppData\Local\Homerun\homerun.exe.bak""#), exe, None), LoginItem::Off);
        assert_eq!(LoginItem::from_windows(Some(""), exe, None), LoginItem::Off);
    }
}
