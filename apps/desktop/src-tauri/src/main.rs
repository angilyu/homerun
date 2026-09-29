// Homerun shell (design §5.1): a thin Tauri process that spawns and supervises
// the `homerund` runtime, hands it a per-launch token over stdin (§5.2), and
// forwards an allowlisted set of methods from the webview to the runtime socket.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod power;

const RUNTIME_METHODS: &[&str] = &["ping", "run.start", "run.list", "keychain.set", "keychain.get", "mcp.probe"];

#[derive(Default)]
struct Runtime {
    token: Mutex<String>,
    child: Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
    restarts: AtomicU32,
}

/// Named separately from the bundle id: a data folder ending like a bundle (`dev.homerun.app`)
/// was treated as one by macOS and writes were denied (spike entry 26).
const DATA_DIR_NAME: &str = "Homerun";

fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("HOMERUN_DATA_DIR") {
        return PathBuf::from(d);
    }
    dirs::data_dir().expect("no data dir").join(DATA_DIR_NAME)
}

fn log(file: &str, line: &str) {
    let dir = data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(dir.join(file)) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let _ = writeln!(f, "{ts} {line}");
    }
}

fn spawn_runtime(app: &AppHandle) {
    let rt = app.state::<Arc<Runtime>>().inner().clone();
    let token = hex::encode(rand::random::<[u8; 32]>());
    let cmd = app.shell().sidecar("homerund").expect("homerund sidecar missing").args(["serve"]);
    let (mut rx, mut child) = match cmd.spawn() {
        Ok(v) => v,
        Err(e) => {
            log("shell.log", &format!("spawn failed: {e}"));
            return;
        }
    };
    // The token travels over stdin only: never argv or env (§5.2).
    let _ = child.write(format!("{token}\n").as_bytes());
    log("shell.log", &format!("spawned homerund pid={} version={}", child.pid(), app.package_info().version));
    *rt.token.lock().unwrap() = token;
    *rt.child.lock().unwrap() = Some(child);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(l) | CommandEvent::Stderr(l) => log("homerund.log", String::from_utf8_lossy(&l).trim_end()),
                CommandEvent::Terminated(p) => {
                    log("shell.log", &format!("homerund exited code={:?} signal={:?}", p.code, p.signal));
                    let rt = app2.state::<Arc<Runtime>>().inner().clone();
                    rt.child.lock().unwrap().take();
                    if rt.shutting_down.load(Ordering::SeqCst) {
                        break;
                    }
                    // Supervisor: restart with exponential backoff (§5.1 "Runtime crash").
                    let n = rt.restarts.fetch_add(1, Ordering::SeqCst).min(5);
                    let delay = Duration::from_millis(500 * (1 << n));
                    log("shell.log", &format!("restarting homerund in {delay:?}"));
                    tokio_sleep(delay).await;
                    spawn_runtime(&app2);
                    break;
                }
                _ => {}
            }
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        std::thread::sleep(d);
        let _ = tx.send(());
    });
    let _ = tauri::async_runtime::spawn_blocking(move || rx.recv()).await;
}

/// Close the runtime's stdin (it checkpoints and exits), then wait briefly.
fn stop_runtime(rt: &Runtime) {
    rt.shutting_down.store(true, Ordering::SeqCst);
    if let Some(child) = rt.child.lock().unwrap().take() {
        let pid = child.pid();
        drop(child); // drops the stdin pipe → runtime sees EOF
        for _ in 0..50 {
            if unsafe { libc_kill(pid as i32, 0) } != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        log("shell.log", &format!("runtime {pid} stopped"));
    }
}

extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

fn call_runtime(token: &str, method: &str, params: Value) -> Result<Value, String> {
    let sock = data_dir().join("run").join("homerund.sock");
    let mut s = UnixStream::connect(&sock).map_err(|e| format!("connect {}: {e}", sock.display()))?;
    s.set_read_timeout(Some(Duration::from_secs(120))).ok();
    let mut r = BufReader::new(s.try_clone().map_err(|e| e.to_string())?);
    let mut send = |v: Value| writeln!(s, "{v}").map_err(|e| e.to_string());
    send(json!({"id": 0, "method": "hello", "params": {"token": token, "client": "shell", "protocol": 1}}))?;
    send(json!({"id": 1, "method": method, "params": params}))?;
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("runtime closed connection".into());
        }
        let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if v["id"] == 0 && v.get("error").is_some() {
            return Err(v["error"].to_string());
        }
        if v["id"] == 1 {
            return v.get("error").map_or(Ok(v["result"].clone()), |e| Err(e.to_string()));
        }
    }
}

#[tauri::command(async)]
fn rt_call(rt: State<'_, Arc<Runtime>>, method: String, params: Option<Value>) -> Result<Value, String> {
    if !RUNTIME_METHODS.contains(&method.as_str()) {
        return Err(format!("method not allowed: {method}"));
    }
    let token = rt.token.lock().unwrap().clone();
    call_runtime(&token, &method, params.unwrap_or(json!({})))
}

#[tauri::command(async)]
fn login_item(action: String) -> Result<Value, String> {
    login_item_impl(&action)
}

#[cfg(target_os = "macos")]
fn login_item_impl(action: &str) -> Result<Value, String> {
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    let svc = unsafe { SMAppService::mainAppService() };
    let res = match action {
        "register" => unsafe { svc.registerAndReturnError() }.map_err(|e| e.localizedDescription().to_string()),
        "unregister" => unsafe { svc.unregisterAndReturnError() }.map_err(|e| e.localizedDescription().to_string()),
        _ => Ok(()),
    };
    let status = unsafe { svc.status() };
    let name = match status {
        SMAppServiceStatus::NotRegistered => "notRegistered",
        SMAppServiceStatus::Enabled => "enabled",
        SMAppServiceStatus::RequiresApproval => "requiresApproval",
        SMAppServiceStatus::NotFound => "notFound",
        _ => "unknown",
    };
    let out = json!({"action": action, "status": name, "error": res.err()});
    log("shell.log", &format!("login_item {out}"));
    Ok(out)
}

#[cfg(not(target_os = "macos"))]
fn login_item_impl(_action: &str) -> Result<Value, String> {
    Err("macOS only in milestone 0".into())
}

/// Data-protection keychain, owned by the shell (design §11). `group` None = the default access group
/// (the first `keychain-access-groups` entry). Needs the entitlement + embedded profile (sign.sh TEAM_ID).
#[cfg(target_os = "macos")]
fn shell_keychain(op: &str, account: &str, value: Option<&[u8]>, group: Option<&str>) -> Value {
    use security_framework::passwords::{delete_generic_password_options, generic_password, set_generic_password_options};
    use security_framework::passwords_options::PasswordOptions;
    let opts = || {
        let mut o = PasswordOptions::new_generic_password("com.angilyu.homerun", account);
        o.use_protected_keychain();
        if let Some(g) = group {
            o.set_access_group(g);
        }
        o
    };
    let t0 = Instant::now();
    let (r, len) = match op {
        "set" => (set_generic_password_options(value.unwrap_or_default(), opts()), None),
        "get" => match generic_password(opts()) {
            Ok(v) => (Ok(()), Some(v.len())),
            Err(e) => (Err(e), None),
        },
        _ => (delete_generic_password_options(opts()), None),
    };
    let status = r.as_ref().err().map_or(0, |e| e.code());
    let name = match status {
        0 => "errSecSuccess",
        -34018 => "errSecMissingEntitlement",
        -25300 => "errSecItemNotFound",
        -25299 => "errSecDuplicateItem",
        -25308 => "errSecInteractionNotAllowed",
        _ => "other",
    };
    let out = json!({"op": op, "account": account, "group": group, "status": status, "name": name,
                     "length": len, "ms": t0.elapsed().as_millis() as u64, "dataProtection": true});
    log("shell.log", &format!("shell keychain {out}"));
    out
}

#[cfg(not(target_os = "macos"))]
fn shell_keychain(_op: &str, _account: &str, _value: Option<&[u8]>, _group: Option<&str>) -> Value {
    json!({"error": "macOS only in milestone 0"})
}

fn keychain_group() -> String {
    std::env::var("HOMERUN_KEYCHAIN_GROUP").unwrap_or_else(|_| "NMJBY8WL8T.com.angilyu.homerun.shared".into())
}

#[tauri::command]
async fn update_now(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;
    let current = app.package_info().version.to_string();
    let upd = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(u) = upd else {
        log("shell.log", &format!("update: none (current {current})"));
        return Ok(format!("no update (current {current})"));
    };
    log("shell.log", &format!("update: {current} -> {}", u.version));
    let bytes = u.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    // Checkpoint the runtime before swapping the bundle (§5.1 Tier 2 update).
    let rt = app.state::<Arc<Runtime>>().inner().clone();
    stop_runtime(&rt);
    u.install(bytes).map_err(|e| e.to_string())?;
    log("shell.log", "update: installed, restarting");
    app.restart();
}

fn rt(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let token = app.state::<Arc<Runtime>>().token.lock().unwrap().clone();
    let r = call_runtime(&token, method, params);
    log("shell.log", &format!("autotest rt {method} -> {}", match &r { Ok(v) => v.to_string(), Err(e) => format!("ERR {e}") }));
    r
}

/// Non-interactive drivers for the §16.1 packaging checks (see spikes/packaging/).
fn autotest(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    let Some(i) = args.iter().position(|a| a == "--autotest") else { return };
    let what = args.get(i + 1).cloned().unwrap_or_default();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(3)).await;
        log("shell.log", &format!("autotest {what}"));
        match what.as_str() {
            // Item 6/7/10 from inside the signed bundle.
            "selftest" => {
                let _ = rt(&app, "ping", json!({}));
                let _ = rt(&app, "helpers.check", json!({}));
                let _ = rt(&app, "keychain.set", json!({"account": "selftest", "value": "from-bundle"}));
                let _ = rt(&app, "keychain.get", json!({"account": "selftest"}));
                if let Ok(pkg) = std::env::var("HOMERUN_SELFTEST_NPX_PKG") {
                    let (pkg, bin) = pkg.split_once('#').map(|(a, b)| (a.to_string(), Some(b.to_string()))).unwrap_or((pkg, None));
                    let _ = rt(&app, "mcp.probe", json!({"runner": "npx", "pkg": pkg, "bin": bin, "tool": "sqlite_version"}));
                }
                let _ = rt(&app, "mcp.probe", json!({"runner": "uvx", "pkg": "mcp-server-time==2026.8.18", "tool": "get_current_time", "toolArgs": {"timezone": "UTC"}}));
                log("shell.log", "autotest selftest done: app.exit(0)");
                app.exit(0);
            }
            // Item 8: store the API key + canary, start a long run, update mid-run.
            "update-flow" => {
                let already = rt(&app, "run.list", json!({})).ok().and_then(|v| v.as_array().map(|a| !a.is_empty())).unwrap_or(false);
                if !already {
                    // Only the pre-update build writes the item, so the post-update read is a real test.
                    if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
                        let _ = rt(&app, "keychain.set", json!({"account": "anthropic-api-key", "value": k}));
                        if std::env::var("HOMERUN_KEYCHAIN_GROUP").is_ok() {
                            let g = keychain_group();
                            let _ = shell_keychain("delete", "anthropic-api-key", None, Some(&g));
                            shell_keychain("set", "anthropic-api-key", Some(k.as_bytes()), Some(&g));
                        }
                    }
                    let prompt = std::env::var("HOMERUN_UPDATE_PROMPT").unwrap_or_else(|_| {
                        "Use the Bash tool to run exactly: sleep 25 && echo step1 >> progress.log . When it finishes, run: echo step2 >> progress.log . Then reply DONE.".into()
                    });
                    let cwd = std::env::var("HOMERUN_UPDATE_CWD").unwrap_or_else(|_| data_dir().to_string_lossy().into());
                    let _ = rt(&app, "run.start", json!({"prompt": prompt, "cwd": cwd}));
                    tokio_sleep(Duration::from_secs(12)).await;
                    let _ = rt(&app, "run.list", json!({}));
                    let r = update_now(app.clone()).await;
                    log("shell.log", &format!("autotest update -> {r:?}"));
                } else {
                    log("shell.log", "autotest update-flow: post-update launch, waiting for resumed run");
                    if std::env::var("HOMERUN_KEYCHAIN_GROUP").is_ok() {
                        shell_keychain("get", "anthropic-api-key", None, Some(&keychain_group()));
                    }
                }
            }
            "update" => {
                let r = update_now(app.clone()).await;
                log("shell.log", &format!("autotest update -> {r:?}"));
            }
            // Item 7: the shell reads and writes the shared access group in the data-protection keychain.
            "keychain-dp" => {
                let g = keychain_group();
                let acct = "selftest-dp";
                let _ = shell_keychain("delete", acct, None, Some(&g));
                shell_keychain("set", acct, Some(b"from-shell"), Some(&g));
                shell_keychain("get", acct, None, Some(&g));
                shell_keychain("get", acct, None, None); // default group = first entitled group
                shell_keychain("delete", acct, None, Some(&g));
                shell_keychain("get", acct, None, Some(&g)); // expect errSecItemNotFound
                // Negative control: a group outside our entitlement must be refused.
                shell_keychain("set", acct, Some(b"x"), Some(&g.replace(".shared", ".not-entitled")));
                log("shell.log", "autotest keychain-dp done: app.exit(0)");
                app.exit(0);
            }
            "login-register" | "login-unregister" | "login-status" => {
                let _ = login_item_impl(what.trim_start_matches("login-"));
            }
            "quit" => app.exit(0),
            _ => {}
        }
    });
}

fn main() {
    std::panic::set_hook(Box::new(|p| log("shell.log", &format!("panic: {p}"))));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(Runtime::default()))
        .invoke_handler(tauri::generate_handler![rt_call, login_item, update_now])
        .setup(|app| {
            log("shell.log", &format!("shell start version={} exe={:?}", app.package_info().version, std::env::current_exe().ok()));
            spawn_runtime(app.handle());
            let handle = app.handle().clone();
            power::observe(move |ev| {
                let rt = handle.state::<Arc<Runtime>>().inner().clone();
                let version = handle.package_info().version.to_string();
                // Off the main thread; the runtime also detects sleep from its own ticks (§8.4).
                std::thread::spawn(move || {
                    let token = rt.token.lock().unwrap().clone();
                    if let Err(e) = power::notify(&power::socket_path(&data_dir()), &token, &version, ev.method(), ev.params()) {
                        log("shell.log", &format!("{} not delivered: {e}", ev.method()));
                    }
                });
            });
            autotest(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build app");

    app.run(|app, ev| match ev {
        // Diagnostics for the clean-VM early-exit finding (spike-results item 10).
        RunEvent::ExitRequested { code, .. } => log("shell.log", &format!("exit requested code={code:?}")),
        RunEvent::WindowEvent { label, event: e @ (tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed), .. } => {
            log("shell.log", &format!("window {label} {e:?}"))
        }
        RunEvent::Exit => {
            log("shell.log", "run loop exit");
            let rt = app.state::<Arc<Runtime>>().inner().clone();
            stop_runtime(&rt);
        }
        _ => {}
    });
}
