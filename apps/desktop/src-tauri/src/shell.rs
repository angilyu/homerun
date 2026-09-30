//! The shell's side of the runtime (§5.1): start the supervisor, pick the key store, relay
//! runtime notifications and status to the webview through one ordered Tauri channel, post the
//! runtime's local notifications (§8.2), prompt for CLI access (§5.2) and keep the menu bar's
//! summary fresh.

use crate::cli_prompts::CliPrompts;
use crate::keychain::Keychain;
use crate::notifications;
use homerun_shell_core::keys::{KeyStore, MemoryKeyStore, Remembered, API_KEY};
use homerun_shell_core::notify::{Notices, Op};
use homerun_shell_core::prefs::{self, Prefs};
use homerun_shell_core::runtime::{Config, Host, Runtime};
use homerun_shell_core::summary::{self, Summary};
use homerun_shell_core::RuntimeStatus;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;

/// Shell events for the webview (`navigate`, `update`), queued until it attaches: a notification
/// click can launch the app before the page has loaded.
#[derive(Default)]
struct Events {
    ch: Option<Channel<Value>>,
    queue: Vec<Value>,
}

pub struct AppHost {
    keys: Box<dyn KeyStore>,
    channel: Mutex<Option<Channel<Value>>>,
    status: Mutex<RuntimeStatus>,
    events: Mutex<Events>,
    notices: Mutex<Notices>,
    cli: Arc<CliPrompts>,
    /// Something the menu bar shows may have changed.
    dirty: (Mutex<bool>, Condvar),
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

    pub fn attach_events(&self, ch: Channel<Value>) {
        let mut e = self.events.lock().unwrap();
        for v in e.queue.drain(..) {
            let _ = ch.send(v);
        }
        e.ch = Some(ch);
    }

    pub fn event(&self, v: Value) {
        let mut e = self.events.lock().unwrap();
        if let Some(ch) = &e.ch {
            if ch.send(v.clone()).is_ok() {
                return;
            }
        }
        // Only the latest few matter: the last navigation and the update state.
        if e.queue.len() >= 8 {
            e.queue.remove(0);
        }
        e.queue.push(v);
    }

    pub fn mark_dirty(&self) {
        let (m, cv) = &self.dirty;
        *m.lock().unwrap() = true;
        cv.notify_all();
    }

    /// Wait until something changed, or `timeout`; then take the flag.
    pub fn wait_dirty(&self, timeout: Duration) -> bool {
        let (m, cv) = &self.dirty;
        let mut g = cv.wait_timeout_while(m.lock().unwrap(), timeout, |d| !*d).unwrap().0;
        std::mem::take(&mut *g)
    }

    fn apply(&self, ops: Vec<Op>) {
        for op in ops {
            match op {
                Op::Post(p) => notifications::post(&p),
                Op::Withdraw(k) => notifications::withdraw(&k),
            }
        }
    }
}

impl Host for AppHost {
    fn status(&self, s: &RuntimeStatus) {
        if !matches!(s, RuntimeStatus::Ready { .. }) {
            self.cli.runtime_gone();
        }
        *self.status.lock().unwrap() = s.clone();
        self.emit(json!({"type": "status", "status": s}));
        let ops = self.notices.lock().unwrap().status(s);
        self.apply(ops);
        self.mark_dirty();
    }
    fn notification(&self, method: &str, params: Value) {
        self.emit(json!({"type": "notification", "method": method, "params": params}));
    }
    fn keys(&self) -> &dyn KeyStore {
        &*self.keys
    }
    fn shell_notification(&self, method: &str, params: Value) {
        match method {
            // The runtime sends these after the events behind them are committed, once per key
            // per life; `Notices` holds the shell to once per key per launch (§8.2).
            "notification.requested" | "notification.withdrawn" => {
                let ops = self.notices.lock().unwrap().runtime(method, &params);
                self.apply(ops);
            }
            "threads.changed" => self.mark_dirty(),
            "cli.access_requested" | "cli.access_withdrawn" => self.cli.notification(method, &params),
            _ => {}
        }
    }
}

pub struct Shell {
    pub rt: Runtime,
    pub host: Arc<AppHost>,
    pub data_dir: PathBuf,
    pub version: String,
    pub prefs: Mutex<Prefs>,
    /// What the menu bar and the quit confirmation show; None until the runtime is ready.
    pub summary: Mutex<Option<Summary>>,
}

impl Shell {
    pub fn update_prefs(&self, f: impl FnOnce(&mut Prefs)) {
        let mut p = self.prefs.lock().unwrap();
        f(&mut p);
        if let Err(e) = prefs::save(&prefs::path(&self.data_dir), &p) {
            self.rt.log_event("prefs.save_failed", json!({"error": e.to_string()}));
        }
    }

    /// Ask the runtime for a fresh summary, waiting at most `timeout` (the quit dialog can't
    /// hang on a busy runtime); the last one otherwise.
    pub fn refresh_summary(self: &Arc<Self>, timeout: Duration) -> Option<Summary> {
        if !matches!(self.rt.status(), RuntimeStatus::Ready { .. }) {
            *self.summary.lock().unwrap() = None;
            return None;
        }
        let (tx, rx) = mpsc::channel();
        let me = self.clone();
        std::thread::spawn(move || {
            let paused = me.prefs.lock().unwrap().paused_by_pause_all.clone();
            let r = me.rt.shell().and_then(|c| summary::fetch(&*c, &paused).ok());
            if let Some(s) = &r {
                *me.summary.lock().unwrap() = Some(s.clone());
            }
            let _ = tx.send(r);
        });
        match rx.recv_timeout(timeout) {
            Ok(Some(s)) => Some(s),
            _ => self.summary.lock().unwrap().clone(),
        }
    }
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
///
/// Update-test builds (`test`, see updater.rs) also take `HOMERUN_KEYSTORE=memory`, or
/// `HOMERUN_TEST_KEYCHAIN_SERVICE`: a keychain item of its own, seeded once from
/// `ANTHROPIC_API_KEY`, so the test proves an updated shell reads it without a prompt (§11).
fn key_store(test: bool) -> Box<dyn KeyStore> {
    let env = std::env::var("HOMERUN_KEYSTORE");
    let memory = if cfg!(debug_assertions) { env.as_deref() != Ok("keychain") } else { test && env.as_deref() == Ok("memory") };
    if !memory && cfg!(target_os = "macos") {
        let kc = Keychain::new();
        if let (true, Some(svc)) = (test, std::env::var_os("HOMERUN_TEST_KEYCHAIN_SERVICE")) {
            crate::keychain::use_test_service(&svc.to_string_lossy());
            if let (Ok(None), Ok(k)) = (kc.get(API_KEY), std::env::var("ANTHROPIC_API_KEY")) {
                if let Ok(k) = homerun_shell_core::keys::check_format(&k) {
                    // The error names the keychain call only, never the value.
                    if let Err(e) = kc.set(API_KEY, &k) {
                        eprintln!("homerun: test keychain seed failed: {e}");
                    }
                }
            }
        }
        return Box::new(Remembered::new(kc));
    }
    let m = MemoryKeyStore::default();
    if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
        if let Ok(k) = homerun_shell_core::keys::check_format(&k) {
            let _ = m.set(API_KEY, &k);
        }
    }
    Box::new(m)
}

pub fn start(version: &str, test: bool, app: AppHandle) -> Shell {
    let data_dir = data_dir();
    let mut cfg = Config::new(runtime_program(), data_dir.join("logs").join("homerund.log"), version);
    // Secrets travel over the launch-token connection only, never the environment (§5.2). The
    // runtime is a compiled Bun program, and Bun reads its own options from the environment
    // (a preload, or running as `bun`): none reach the process the release CLI trusts.
    cfg.env_remove = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "BUN_OPTIONS", "BUN_BE_BUN", "NODE_OPTIONS"].map(String::from).to_vec();
    let host = Arc::new(AppHost {
        keys: key_store(test),
        channel: Mutex::new(None),
        status: Mutex::new(RuntimeStatus::Starting),
        events: Mutex::new(Events::default()),
        notices: Mutex::new(Notices::default()),
        cli: CliPrompts::new(app),
        dirty: (Mutex::new(false), Condvar::new()),
    });
    let prefs = prefs::load(&prefs::path(&data_dir));
    let rt = Runtime::start(cfg, host.clone());
    Shell { rt, host, data_dir, version: version.into(), prefs: Mutex::new(prefs), summary: Mutex::new(None) }
}
