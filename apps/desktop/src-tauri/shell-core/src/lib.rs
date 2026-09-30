//! The platform-independent part of the Homerun shell (docs/design.md §5.1, §5.2, §11). The
//! Tauri crate wires it to a window, the keychain, the sleep/wake observer, the menu-bar item,
//! notifications and the updater; every decision lives here and tests on any OS with std alone.

pub mod allowlist;
pub mod browser;
pub mod cli_access;
/// Putting `homerun` on PATH is a macOS feature for now (a symlink into `/usr/local/bin`).
pub mod cli_tool;
pub mod dirs;
pub mod keys;
pub mod link_prompt;
pub mod logfile;
pub mod login;
pub mod notify;
pub mod policy;
pub mod prefs;
pub mod proc;
pub mod quit;
pub mod rpc;
pub mod runtime;
pub mod status;
pub mod summary;
pub mod token;
pub mod transport;
pub mod tray;
pub mod update;
#[cfg(windows)]
pub mod win;

pub use policy::Timing;
pub use status::{BlockedReason, RuntimeStatus};
