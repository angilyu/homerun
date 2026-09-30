//! The macOS keychain, owned by the shell (§11, §18 row 7). homerund never touches it: the
//! shell reads secrets here and hands them over the launch-token connection (§5.2).
//!
//! The data-protection keychain needs the keychain-access-groups entitlement and a provisioning
//! profile (Developer ID builds, spike entry 7). An ad-hoc or unsigned build gets
//! errSecMissingEntitlement, and falls back to the legacy file keychain for the rest of the
//! session (§11). Every call runs on its own thread with a timeout, because the legacy
//! keychain can block on an "allow access" prompt; a timeout is reported as NeedsApproval.

use homerun_shell_core::keys::{KeyError, KeyStore};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::time::Duration;

static SERVICE: OnceLock<String> = OnceLock::new();

fn service() -> &'static str {
    SERVICE.get().map(String::as_str).unwrap_or("com.angilyu.homerun")
}

/// Update-test builds only (scripts/macos/update-test.sh): keep the test's key away from the
/// user's real item. Must run before the first keychain call.
pub fn use_test_service(name: &str) {
    let _ = SERVICE.set(name.to_string());
}
const TIMEOUT: Duration = Duration::from_secs(5);

const ERR_MISSING_ENTITLEMENT: i32 = -34018;
const ERR_ITEM_NOT_FOUND: i32 = -25300;
const ERR_INTERACTION_NOT_ALLOWED: i32 = -25308;
const ERR_AUTH_FAILED: i32 = -25293;
const ERR_USER_CANCELED: i32 = -128;

pub struct Keychain {
    legacy: Arc<AtomicBool>,
}

impl Keychain {
    pub fn new() -> Self {
        Keychain { legacy: Arc::new(AtomicBool::new(false)) }
    }

    /// Run `op` against the data-protection keychain, or the legacy one after a missing
    /// entitlement, off the calling thread.
    fn run<T: Send + 'static>(&self, op: impl Fn(bool) -> Result<T, i32> + Send + 'static) -> Result<T, KeyError> {
        let (tx, rx) = mpsc::channel();
        let legacy = self.legacy.clone();
        std::thread::spawn(move || {
            let mut r = op(legacy.load(Ordering::Relaxed));
            if matches!(r, Err(ERR_MISSING_ENTITLEMENT)) {
                legacy.store(true, Ordering::Relaxed);
                r = op(true);
            }
            let _ = tx.send(r);
        });
        match rx.recv_timeout(TIMEOUT) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(ERR_INTERACTION_NOT_ALLOWED | ERR_AUTH_FAILED | ERR_USER_CANCELED)) | Err(_) => Err(KeyError::NeedsApproval),
            Ok(Err(code)) => Err(KeyError::Other(format!("The keychain refused ({code})."))),
        }
    }
}

#[cfg(target_os = "macos")]
mod ops {
    use super::*;
    use security_framework::passwords::{delete_generic_password_options, generic_password, set_generic_password_options};
    use security_framework::passwords_options::PasswordOptions;

    fn opts(account: &str, legacy: bool) -> PasswordOptions {
        let mut o = PasswordOptions::new_generic_password(service(), account);
        if !legacy {
            o.use_protected_keychain();
        }
        o
    }

    pub fn get(account: &str, legacy: bool) -> Result<Option<String>, i32> {
        match generic_password(opts(account, legacy)) {
            Ok(v) => String::from_utf8(v).map(Some).map_err(|_| -1),
            Err(e) if e.code() == ERR_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(e.code()),
        }
    }

    pub fn delete(account: &str, legacy: bool) -> Result<(), i32> {
        match delete_generic_password_options(opts(account, legacy)) {
            Err(e) if e.code() != ERR_ITEM_NOT_FOUND => Err(e.code()),
            _ => Ok(()),
        }
    }

    pub fn set(account: &str, value: &str, legacy: bool) -> Result<(), i32> {
        set_generic_password_options(value.as_bytes(), opts(account, legacy)).map_err(|e| e.code())
    }
}

#[cfg(not(target_os = "macos"))]
mod ops {
    // Windows and Linux shells are a later milestone (§17 Q1); debug builds use the memory store.
    pub fn get(_: &str, _: bool) -> Result<Option<String>, i32> {
        Err(-4)
    }
    pub fn delete(_: &str, _: bool) -> Result<(), i32> {
        Err(-4)
    }
    pub fn set(_: &str, _: &str, _: bool) -> Result<(), i32> {
        Err(-4)
    }
}

impl KeyStore for Keychain {
    fn get(&self, name: &str) -> Result<Option<String>, KeyError> {
        let name = name.to_string();
        self.run(move |legacy| ops::get(&name, legacy))
    }
    fn set(&self, name: &str, value: &str) -> Result<(), KeyError> {
        let (name, value) = (name.to_string(), value.to_string());
        self.run(move |legacy| ops::set(&name, &value, legacy))
    }
    fn delete(&self, name: &str) -> Result<(), KeyError> {
        let name = name.to_string();
        self.run(move |legacy| ops::delete(&name, legacy))
    }
    fn kind(&self) -> &'static str {
        if self.legacy.load(Ordering::Relaxed) {
            "keychain (legacy)"
        } else {
            "keychain"
        }
    }
}
