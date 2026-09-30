//! The API key flow (§7.2, §11). The shell owns the keychain; the runtime holds secrets in
//! memory only. Onboarding checks a key with the provider (`secrets.verify`) before storing it,
//! and every new runtime gets the stored secrets over the shell connection (`secrets.set`).

use crate::rpc::{codes, CallError, Connection, RpcError};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

pub const API_KEY: &str = "anthropic_api_key";
/// Keychain items the shell holds for the runtime (core `SecretName`).
pub const SECRET_NAMES: &[&str] = &["anthropic_api_key", "device_static_key", "refresh_token"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyError {
    /// The keychain is waiting for the user to allow access, or it timed out (§11).
    NeedsApproval,
    Other(String),
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyError::NeedsApproval => write!(f, "Keychain access needs your approval."),
            KeyError::Other(e) => write!(f, "{e}"),
        }
    }
}

pub trait KeyStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, KeyError>;
    fn set(&self, name: &str, value: &str) -> Result<(), KeyError>;
    fn delete(&self, name: &str) -> Result<(), KeyError>;
    /// "keychain", "keychain (legacy)" or "memory", for Settings.
    fn kind(&self) -> &'static str;
}

/// Development builds and tests: nothing touches the real keychain.
#[derive(Default)]
pub struct MemoryKeyStore(Mutex<HashMap<String, String>>);

impl KeyStore for MemoryKeyStore {
    fn get(&self, name: &str) -> Result<Option<String>, KeyError> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), KeyError> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), KeyError> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
    fn kind(&self) -> &'static str {
        "memory"
    }
}

/// The keychain, plus what the shell has already read or written through it. The keychain stays
/// the source of truth whenever it answers. When a read fails, the last value is used instead:
/// the item is readable only while the Mac is unlocked (secd: errSecInteractionNotAllowed), and a
/// runtime restarted overnight on a locked Mac must still get its key, or every monitor fails
/// until morning (§8.2, §11). The runtime already holds the same secrets in memory (§5.1).
pub struct Remembered<S> {
    inner: S,
    seen: Mutex<HashMap<String, Option<String>>>,
}

impl<S: KeyStore> Remembered<S> {
    pub fn new(inner: S) -> Self {
        Remembered { inner, seen: Mutex::new(HashMap::new()) }
    }
}

impl<S: KeyStore> KeyStore for Remembered<S> {
    fn get(&self, name: &str) -> Result<Option<String>, KeyError> {
        match self.inner.get(name) {
            Ok(v) => {
                self.seen.lock().unwrap().insert(name.into(), v.clone());
                Ok(v)
            }
            Err(e) => match self.seen.lock().unwrap().get(name) {
                Some(v) => Ok(v.clone()),
                None => Err(e),
            },
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<(), KeyError> {
        self.inner.set(name, value)?;
        self.seen.lock().unwrap().insert(name.into(), Some(value.into()));
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), KeyError> {
        self.inner.delete(name)?;
        self.seen.lock().unwrap().insert(name.into(), None);
        Ok(())
    }
    fn kind(&self) -> &'static str {
        self.inner.kind()
    }
}

/// Calls on the shell connection. A trait so the flows test without a runtime.
pub trait ShellCalls {
    fn call(&self, method: &str, params: Value) -> Result<Value, CallError>;
}

impl ShellCalls for Connection {
    fn call(&self, method: &str, params: Value) -> Result<Value, CallError> {
        // Verification waits on the provider; the runtime bounds that itself.
        Connection::call(self, method, params, Duration::from_secs(30))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct KeyStatus {
    pub present: bool,
    /// The last four characters, to recognise the key ("…a1b2").
    pub hint: Option<String>,
    pub store: &'static str,
}

pub fn status(store: &dyn KeyStore) -> Result<KeyStatus, KeyError> {
    let v = store.get(API_KEY)?;
    let hint = v.as_deref().map(|k| k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect());
    Ok(KeyStatus { present: v.is_some(), hint, store: store.kind() })
}

/// Trim and sanity-check a pasted key; the provider has the final word.
pub fn check_format(value: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err("Paste your API key.".into());
    }
    if v.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("An API key has no spaces or line breaks.".into());
    }
    if v.len() < 20 || v.len() > 16_384 {
        return Err("That doesn't look like an API key.".into());
    }
    Ok(v.to_string())
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SetOutcome {
    /// Verified with Anthropic, stored and handed to the runtime.
    Saved,
    /// Stored without a check (offline, or the runtime isn't running). `detail` says why.
    SavedUnverified { detail: String },
    /// Anthropic refused it; nothing changed.
    Rejected { detail: String },
}

/// Onboarding and Settings → *Replace key* (§7.2).
pub fn set_key(store: &dyn KeyStore, rpc: Option<&dyn ShellCalls>, value: &str) -> Result<SetOutcome, String> {
    let key = check_format(value)?;
    let Some(rpc) = rpc else {
        store.set(API_KEY, &key).map_err(|e| e.to_string())?;
        return Ok(SetOutcome::SavedUnverified { detail: "Homerun's runtime isn't running, so the key wasn't checked yet.".into() });
    };
    let v = rpc.call("secrets.verify", json!({"name": API_KEY, "value": key})).map_err(|e| format!("Couldn't check the key: {e}"))?;
    let detail = v.get("detail").and_then(Value::as_str).map(String::from);
    let outcome = match v.get("outcome").and_then(Value::as_str) {
        Some("valid") => SetOutcome::Saved,
        Some("invalid") => return Ok(SetOutcome::Rejected { detail: detail.unwrap_or_else(|| "Anthropic didn't accept this key.".into()) }),
        _ => SetOutcome::SavedUnverified { detail: detail.unwrap_or_else(|| "Anthropic couldn't be reached, so the key wasn't checked.".into()) },
    };
    store.set(API_KEY, &key).map_err(|e| e.to_string())?;
    rpc.call("secrets.set", json!({"name": API_KEY, "value": key})).map_err(|e| format!("Saved, but the runtime didn't take the key: {e}"))?;
    Ok(outcome)
}

/// Settings → *Remove key*.
pub fn clear_key(store: &dyn KeyStore, rpc: Option<&dyn ShellCalls>) -> Result<(), String> {
    if let Some(rpc) = rpc {
        rpc.call("secrets.clear", json!({"name": API_KEY})).map_err(|e| e.to_string())?;
    }
    store.delete(API_KEY).map_err(|e| e.to_string())
}

/// Give a new runtime every stored secret (§5.2). Returns the names handed over.
pub fn hand_over(store: &dyn KeyStore, rpc: &dyn ShellCalls) -> Result<Vec<&'static str>, String> {
    let mut sent = vec![];
    for &name in SECRET_NAMES {
        if let Some(v) = store.get(name).map_err(|e| e.to_string())? {
            rpc.call("secrets.set", json!({"name": name, "value": v})).map_err(|e| format!("secrets.set {name}: {e}"))?;
            sent.push(name);
        }
    }
    Ok(sent)
}

/// `secrets.persist` from the runtime: store a secret it created (§5.2).
pub fn persist(store: &dyn KeyStore, params: &Value) -> Result<Value, RpcError> {
    let name = params.get("name").and_then(Value::as_str).filter(|n| SECRET_NAMES.contains(n));
    let value = params.get("value").and_then(Value::as_str).filter(|v| !v.is_empty());
    let (Some(name), Some(value)) = (name, value) else {
        return Err(RpcError::new(codes::INVALID_PARAMS, "secrets.persist needs a known name and a value"));
    };
    store.set(name, value).map_err(|e| RpcError::new(codes::INTERNAL_ERROR, e.to_string()))?;
    Ok(json!({"stored": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// A keychain that refuses every call while "locked", as secd does for a locked Mac.
    #[derive(Default)]
    struct Lockable {
        store: MemoryKeyStore,
        locked: AtomicBool,
    }

    impl KeyStore for Lockable {
        fn get(&self, name: &str) -> Result<Option<String>, KeyError> {
            if self.locked.load(Ordering::Relaxed) {
                return Err(KeyError::Other("keychain is locked".into()));
            }
            self.store.get(name)
        }
        fn set(&self, name: &str, value: &str) -> Result<(), KeyError> {
            if self.locked.load(Ordering::Relaxed) {
                return Err(KeyError::Other("keychain is locked".into()));
            }
            self.store.set(name, value)
        }
        fn delete(&self, name: &str) -> Result<(), KeyError> {
            if self.locked.load(Ordering::Relaxed) {
                return Err(KeyError::Other("keychain is locked".into()));
            }
            self.store.delete(name)
        }
        fn kind(&self) -> &'static str {
            "keychain"
        }
    }

    #[test]
    fn a_runtime_restarted_while_the_mac_is_locked_still_gets_the_key() {
        let kc = Lockable::default();
        kc.store.set(API_KEY, KEY).unwrap();
        let r = Remembered::new(kc);
        let rt = FakeRuntime { verify: "ok", calls: Mutex::new(vec![]) };
        assert_eq!(hand_over(&r, &rt).unwrap(), [API_KEY], "read while unlocked");
        r.inner.locked.store(true, Ordering::Relaxed);
        assert_eq!(hand_over(&r, &rt).unwrap(), [API_KEY], "locked: the value already read");
        assert_eq!(r.kind(), "keychain");
    }

    #[test]
    fn the_keychain_stays_the_source_of_truth_when_it_answers() {
        let r = Remembered::new(Lockable::default());
        r.inner.locked.store(true, Ordering::Relaxed);
        assert!(r.get(API_KEY).is_err(), "nothing read yet: the error stands");
        r.inner.locked.store(false, Ordering::Relaxed);
        r.set(API_KEY, KEY).unwrap();
        r.inner.store.delete(API_KEY).unwrap();
        assert_eq!(r.get(API_KEY).unwrap(), None, "unlocked: the keychain wins");
        r.inner.store.set(API_KEY, "sk-ant-other").unwrap();
        assert_eq!(r.get(API_KEY).unwrap().as_deref(), Some("sk-ant-other"));
        r.delete(API_KEY).unwrap();
        r.inner.locked.store(true, Ordering::Relaxed);
        assert_eq!(r.get(API_KEY).unwrap(), None, "a removed key isn't remembered");
        assert!(r.set(API_KEY, KEY).is_err(), "a failed write isn't remembered");
        assert_eq!(r.get(API_KEY).unwrap(), None);
    }

    struct FakeRuntime {
        verify: &'static str,
        calls: Mutex<Vec<(String, Value)>>,
    }

    impl ShellCalls for FakeRuntime {
        fn call(&self, method: &str, params: Value) -> Result<Value, CallError> {
            self.calls.lock().unwrap().push((method.into(), params));
            match method {
                "secrets.verify" => Ok(json!({"outcome": self.verify})),
                _ => Ok(json!({"ok": true})),
            }
        }
    }

    fn rt(verify: &'static str) -> FakeRuntime {
        FakeRuntime { verify, calls: Mutex::new(vec![]) }
    }

    fn methods(r: &FakeRuntime) -> Vec<String> {
        r.calls.lock().unwrap().iter().map(|c| c.0.clone()).collect()
    }

    const KEY: &str = "sk-ant-TEST-not-a-real-key";

    #[test]
    fn a_valid_key_is_checked_then_stored_then_handed_over() {
        let s = MemoryKeyStore::default();
        let r = rt("valid");
        assert_eq!(set_key(&s, Some(&r), &format!("  {KEY}\n")), Ok(SetOutcome::Saved));
        assert_eq!(methods(&r), ["secrets.verify", "secrets.set"]);
        assert_eq!(s.get(API_KEY).unwrap().as_deref(), Some(KEY));
        assert_eq!(status(&s).unwrap(), KeyStatus { present: true, hint: Some("-key".into()), store: "memory" });
    }

    #[test]
    fn a_rejected_key_changes_nothing() {
        let s = MemoryKeyStore::default();
        s.set(API_KEY, "sk-ant-mock-not-a-key").unwrap();
        let r = rt("invalid");
        assert!(matches!(set_key(&s, Some(&r), KEY), Ok(SetOutcome::Rejected { .. })));
        assert_eq!(methods(&r), ["secrets.verify"]);
        assert_eq!(s.get(API_KEY).unwrap().as_deref(), Some("sk-ant-mock-not-a-key"));
    }

    #[test]
    fn offline_stores_with_a_warning() {
        let s = MemoryKeyStore::default();
        let r = rt("unreachable");
        assert!(matches!(set_key(&s, Some(&r), KEY), Ok(SetOutcome::SavedUnverified { .. })));
        assert_eq!(methods(&r), ["secrets.verify", "secrets.set"]);
        assert!(matches!(set_key(&s, None, KEY), Ok(SetOutcome::SavedUnverified { .. })));
    }

    #[test]
    fn format_is_checked_first() {
        let s = MemoryKeyStore::default();
        let r = rt("valid");
        assert!(set_key(&s, Some(&r), "  ").is_err());
        assert!(set_key(&s, Some(&r), "sk-ant with space 000000000").is_err());
        assert!(set_key(&s, Some(&r), "short").is_err());
        assert!(methods(&r).is_empty());
    }

    #[test]
    fn hand_over_clear_and_persist() {
        let s = MemoryKeyStore::default();
        let r = rt("valid");
        assert_eq!(hand_over(&s, &r).unwrap(), Vec::<&str>::new());
        s.set(API_KEY, KEY).unwrap();
        assert_eq!(persist(&s, &json!({"name": "refresh_token", "value": "rt"})).unwrap(), json!({"stored": true}));
        assert!(persist(&s, &json!({"name": "other", "value": "x"})).is_err());
        assert_eq!(hand_over(&s, &r).unwrap(), vec![API_KEY, "refresh_token"]);
        clear_key(&s, Some(&r)).unwrap();
        assert_eq!(s.get(API_KEY).unwrap(), None);
        assert_eq!(methods(&r).last().unwrap(), "secrets.clear");
    }
}
