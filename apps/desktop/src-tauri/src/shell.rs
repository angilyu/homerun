//! The shell's side of the runtime (§5.1): start the supervisor, pick the key store, and relay
//! runtime notifications and status to the webview through one ordered Tauri channel.

use crate::keychain::Keychain;
use homerun_shell_core::keys::{KeyStore, MemoryKeyStore, API_KEY};
use homerun_shell_core::runtime::{Config, Host, Runtime};
use homerun_shell_core::RuntimeStatus;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

pub struct AppHost {
    keys: Box<dyn KeyStore>,
    channel: Mutex<Option<Channel<Value>>>,
    status: Mutex<RuntimeStatus>,
}

impl AppHost {
    /// The webview (re)attached, after a load or reload: it gets the current status first, then
    /// everything that follows, in order (§5.2 forwarded notifications).
    pub fn attach(&self, ch: Channel<Value>) {
        let mut slot = self.channel.lock().unwrap();
        let _ = ch.send(json!({"type": "status", "status": *self.status.lock().unwrap()}));
        *slot = Some(ch);
    }

    pub fn keys_ref(&self) -> &dyn KeyStore {
        &*self.keys
    }

    fn emit(&self, v: Value) {
        if let Some(ch) = self.channel.lock().unwrap().as_ref() {
            let _ = ch.send(v);
        }
    }
}

impl Host for AppHost {
    fn status(&self, s: &RuntimeStatus) {
        *self.status.lock().unwrap() = s.clone();
        self.emit(json!({"type": "status", "status": s}));
    }
    fn notification(&self, method: &str, params: Value) {
        self.emit(json!({"type": "notification", "method": method, "params": params}));
    }
    fn keys(&self) -> &dyn KeyStore {
        &*self.keys
    }
}

pub struct Shell {
    pub rt: Runtime,
    pub host: Arc<AppHost>,
    pub data_dir: PathBuf,
    pub version: String,
}

/// `HOMERUN_DATA_DIR`, or `~/Library/Application Support/Homerun`, as `@homerun/client`'s
/// `dataDir` resolves it, so the shell's log lands next to the runtime's data.
pub fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("HOMERUN_DATA_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Library").join("Application Support").join("Homerun")
}

/// `homerund` sits next to the shell's executable, in the bundle and in `tauri dev` alike
/// (Tauri copies `externalBin` there). Debug builds may point elsewhere with `HOMERUN_RUNTIME`.
fn runtime_program() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(p) = std::env::var_os("HOMERUN_RUNTIME") {
            return PathBuf::from(p);
        }
    }
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().map(|d| d.join("homerund")).unwrap_or_else(|| PathBuf::from("homerund"))
}

/// Release builds use the keychain. Debug builds default to memory, because every rebuild of an
/// unsigned shell is a new code identity and the legacy keychain would prompt each time; a key
/// in the shell's `ANTHROPIC_API_KEY` seeds it. `HOMERUN_KEYSTORE=keychain` opts in (plan §5).
fn key_store() -> Box<dyn KeyStore> {
    let memory = cfg!(debug_assertions) && std::env::var("HOMERUN_KEYSTORE").as_deref() != Ok("keychain");
    if !memory && cfg!(target_os = "macos") {
        return Box::new(Keychain::new());
    }
    let m = MemoryKeyStore::default();
    if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
        if let Ok(k) = homerun_shell_core::keys::check_format(&k) {
            let _ = m.set(API_KEY, &k);
        }
    }
    Box::new(m)
}

pub fn start(version: &str) -> Shell {
    let data_dir = data_dir();
    let mut cfg = Config::new(runtime_program(), data_dir.join("logs").join("homerund.log"), version);
    // Secrets travel over the launch-token connection only, never the environment (§5.2).
    cfg.env_remove = vec!["ANTHROPIC_API_KEY".into(), "ANTHROPIC_AUTH_TOKEN".into()];
    let host = Arc::new(AppHost { keys: key_store(), channel: Mutex::new(None), status: Mutex::new(RuntimeStatus::Starting) });
    let rt = Runtime::start(cfg, host.clone());
    Shell { rt, host, data_dir, version: version.into() }
}
