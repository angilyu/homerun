//! The platform-independent part of the Homerun shell (docs/design.md §5.1, §5.2). The Tauri
//! crate wires it to a window, the keychain and the sleep/wake observer; everything here runs
//! and tests on any OS with std alone.

pub mod allowlist;
pub mod keys;
pub mod logfile;
pub mod policy;
pub mod rpc;
pub mod runtime;
pub mod status;
pub mod token;

pub use policy::Timing;
pub use status::{BlockedReason, RuntimeStatus};
