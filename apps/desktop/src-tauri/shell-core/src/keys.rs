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

    const KEY: &str = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-a1b2";

    #[test]
    fn a_valid_key_is_checked_then_stored_then_handed_over() {
        let s = MemoryKeyStore::default();
        let r = rt("valid");
        assert_eq!(set_key(&s, Some(&r), &format!("  {KEY}\n")), Ok(SetOutcome::Saved));
        assert_eq!(methods(&r), ["secrets.verify", "secrets.set"]);
        assert_eq!(s.get(API_KEY).unwrap().as_deref(), Some(KEY));
        assert_eq!(status(&s).unwrap(), KeyStatus { present: true, hint: Some("a1b2".into()), store: "memory" });
    }

    #[test]
    fn a_rejected_key_changes_nothing() {
        let s = MemoryKeyStore::default();
        s.set(API_KEY, "sk-ant-old-key-0000000000000").unwrap();
        let r = rt("invalid");
        assert!(matches!(set_key(&s, Some(&r), KEY), Ok(SetOutcome::Rejected { .. })));
        assert_eq!(methods(&r), ["secrets.verify"]);
        assert_eq!(s.get(API_KEY).unwrap().as_deref(), Some("sk-ant-old-key-0000000000000"));
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
