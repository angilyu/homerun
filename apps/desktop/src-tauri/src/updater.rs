//! The signed updater (§11). `tauri-plugin-updater` fetches `latest.json` and checks the
//! minisign signature; `shell-core::update` gates the offer and holds the state. An update is
//! downloaded in the background, staged under the data directory and installed only when
//! Homerun quits or the user picks *Restart to Update*, after the runtime has stopped: runs
//! resume on the next launch like after any quit (§5.4).

use base64::Engine;
use homerun_shell_core::quit::Why;
use homerun_shell_core::update::{self, gate, pubkey_configured, Gate, Schedule, UpdateState};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

type LogFn = Box<dyn Fn(&str, Value) + Send + Sync>;

pub struct Hooks {
    pub changed: Box<dyn Fn(&UpdateState) + Send + Sync>,
    pub log: LogFn,
    /// The protocol the running runtime speaks, for the version gate.
    pub protocol: Box<dyn Fn() -> u64 + Send + Sync>,
}

pub struct Updater {
    app: AppHandle,
    pubkey: String,
    /// `dangerousInsecureTransportProtocol` is set only by `scripts/macos/update-test.sh`'s
    /// builds; it also unlocks that script's switches. Release builds never set it.
    test_build: bool,
    dir: PathBuf,
    auto: AtomicBool,
    state: Mutex<UpdateState>,
    staged: Mutex<Option<(Update, PathBuf)>>,
    wake: (Mutex<bool>, Condvar),
    hooks: Hooks,
}

fn plugin_config(app: &AppHandle) -> Value {
    app.config().plugins.0.get("updater").cloned().unwrap_or(Value::Null)
}

fn short(e: impl std::fmt::Display) -> String {
    homerun_shell_core::notify::clean(&e.to_string(), 200)
}

impl Updater {
    pub fn new(app: &AppHandle, data_dir: &std::path::Path, auto: bool, hooks: Hooks) -> Arc<Updater> {
        let cfg = plugin_config(app);
        let pubkey = cfg.get("pubkey").and_then(Value::as_str).unwrap_or("").to_string();
        let test_build = cfg.get("dangerousInsecureTransportProtocol").and_then(Value::as_bool).unwrap_or(false);
        let state = if cfg!(debug_assertions) {
            UpdateState::Unavailable { message: "Updates are off in development builds.".into() }
        } else if !pubkey_configured(&pubkey) {
            // Fail closed (§11): a build without the real key never installs anything.
            UpdateState::Unavailable { message: "This build has no update key, so it can't update itself.".into() }
        } else if !(cfg!(target_os = "macos") && cfg!(target_arch = "aarch64")) {
            UpdateState::Unavailable { message: "Updates are for Apple silicon Macs for now.".into() }
        } else {
            UpdateState::Idle
        };
        Arc::new(Updater {
            app: app.clone(),
            pubkey,
            test_build,
            dir: data_dir.join("updates"),
            auto: AtomicBool::new(auto),
            state: Mutex::new(state),
            staged: Mutex::new(None),
            wake: (Mutex::new(false), Condvar::new()),
            hooks,
        })
    }

    pub fn test_build(&self) -> bool {
        self.test_build
    }

    pub fn state(&self) -> UpdateState {
        self.state.lock().unwrap().clone()
    }

    fn set(&self, s: UpdateState) {
        *self.state.lock().unwrap() = s.clone();
        (self.hooks.log)("update.state", json!({"update": s}));
        (self.hooks.changed)(&s);
    }

    /// The user sees a plain sentence; the log gets the detail, which never holds a secret.
    fn fail(&self, message: String, detail: &str) {
        (self.hooks.log)("update.error", json!({"detail": detail}));
        self.set(UpdateState::Failed { message, checked_at: wall_ms() });
    }

    pub fn set_auto(&self, on: bool) {
        self.auto.store(on, Ordering::SeqCst);
        if on {
            self.poke();
        }
    }

    /// *Check for Updates…*, or the automatic schedule.
    pub fn poke(&self) {
        let (m, cv) = &self.wake;
        *m.lock().unwrap() = true;
        cv.notify_all();
    }

    /// The background loop: every six hours of wall-clock time while automatic updates are on,
    /// plus whenever the user asks. A wait is at most a minute, so a check missed while the Mac
    /// slept runs soon after it wakes (§8.4).
    pub fn spawn(self: &Arc<Self>) {
        if matches!(self.state(), UpdateState::Unavailable { .. }) {
            return;
        }
        // Whatever an earlier launch staged is either installed or stale.
        let _ = std::fs::remove_dir_all(&self.dir);
        let me = self.clone();
        std::thread::Builder::new()
            .name("updater".into())
            .spawn(move || {
                let mut sched = Schedule::new(wall_ms());
                let mut asked = me.test_build && std::env::var_os("HOMERUN_UPDATE_CHECK_NOW").is_some();
                loop {
                    let now = wall_ms();
                    if asked || (me.auto.load(Ordering::SeqCst) && sched.due(now)) {
                        me.check();
                        sched.checked(wall_ms());
                    }
                    let (m, cv) = &me.wake;
                    let wait = Duration::from_millis(sched.next().saturating_sub(wall_ms()).clamp(1_000, 60_000));
                    let mut g = cv.wait_timeout_while(m.lock().unwrap(), wait, |p| !*p).unwrap().0;
                    asked = std::mem::take(&mut *g);
                }
            })
            .expect("updater thread");
    }

    fn check(&self) {
        let st = self.state();
        // A staged update stays until it's installed; nothing to gain from fetching it again.
        if st.busy() || matches!(st, UpdateState::Ready { .. } | UpdateState::Unavailable { .. }) {
            return;
        }
        self.set(UpdateState::Checking);
        let result = tauri::async_runtime::block_on(async {
            let u = self.app.updater_builder().timeout(Duration::from_secs(120)).build()?;
            u.check().await
        });
        let up = match result {
            Ok(Some(up)) => up,
            Ok(None) => return self.set(UpdateState::UpToDate { checked_at: wall_ms() }),
            Err(e) => return self.fail("Couldn't check for updates. Homerun will try again later.".into(), &short(e)),
        };
        let current = self.app.package_info().version.to_string();
        match gate(&current, (self.hooks.protocol)(), &up.version, &up.raw_json) {
            Gate::Ignore => self.set(UpdateState::UpToDate { checked_at: wall_ms() }),
            Gate::Manual { reason } => self.set(UpdateState::Manual { version: up.version.clone(), reason }),
            Gate::Install { note } => {
                self.set(UpdateState::Downloading { version: up.version.clone() });
                match self.download(&up) {
                    Ok(path) => {
                        *self.staged.lock().unwrap() = Some((up.clone(), path));
                        self.set(UpdateState::Ready { version: up.version.clone(), note });
                    }
                    Err(e) => self.fail(format!("Couldn't download Homerun {}. Homerun will try again later.", up.version), &e),
                }
            }
        }
    }

    /// Download (the plugin verifies the signature and the signed version) and stage it.
    fn download(&self, up: &Update) -> Result<PathBuf, String> {
        if !update::safe_version(&up.version) {
            return Err("unsafe version".into());
        }
        let bytes = tauri::async_runtime::block_on(up.download(|_, _| {}, || {})).map_err(short)?;
        std::fs::create_dir_all(&self.dir).map_err(short)?;
        let path = self.dir.join(format!("Homerun-{}.app.tar.gz", up.version));
        let tmp = path.with_extension("partial");
        std::fs::write(&tmp, &bytes).map_err(short)?;
        std::fs::rename(&tmp, &path).map_err(short)?;
        Ok(path)
    }

    /// Install the staged update, if quitting for `why` should (§11). Runs after the runtime has
    /// stopped and before the process exits. Off the main thread: on a permission error the
    /// plugin asks for an administrator password through the main thread.
    pub fn install_if_ready(&self, why: Why) -> bool {
        if !update::install_on_exit(&self.state(), why) {
            return false;
        }
        let Some((up, path)) = self.staged.lock().unwrap().take() else { return false };
        let r = std::fs::read(&path).map_err(short).and_then(|bytes| {
            // The staged file sat on disk: check it again rather than trust it.
            verify(&self.pubkey, &up.signature, &bytes)?;
            up.install(&bytes).map_err(short)
        });
        let _ = std::fs::remove_file(&path);
        match r {
            Ok(()) => {
                (self.hooks.log)("update.installed", json!({"version": up.version}));
                true
            }
            Err(e) => {
                self.fail(format!("Couldn't install Homerun {}.", up.version), &e);
                false
            }
        }
    }
}

/// minisign, as the plugin checks it: `pubkey` and `signature` are base64 of minisign's text
/// formats.
pub fn verify(pubkey: &str, signature: &str, data: &[u8]) -> Result<(), String> {
    let b64 = |s: &str| {
        base64::engine::general_purpose::STANDARD.decode(s.trim()).ok().and_then(|b| String::from_utf8(b).ok()).ok_or_else(|| "bad base64".to_string())
    };
    let pk = minisign_verify::PublicKey::decode(&b64(pubkey)?).map_err(short)?;
    let sig = minisign_verify::Signature::decode(&b64(signature)?).map_err(short)?;
    pk.verify(data, &sig, true).map_err(short)
}

pub fn get(app: &AppHandle) -> Option<Arc<Updater>> {
    app.try_state::<Arc<Updater>>().map(|s| s.inner().clone())
}
