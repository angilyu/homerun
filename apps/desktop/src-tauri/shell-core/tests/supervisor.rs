//! The supervisor against a real child process (`fake_homerund`): spawn with the token on
//! stdin, connect both roles, forward, crash and restart, block, and stop cleanly (§5.1, §5.2).

use homerun_shell_core::allowlist::forward;
use homerun_shell_core::keys::{KeyStore, MemoryKeyStore, API_KEY};
use homerun_shell_core::policy::Timing;
use homerun_shell_core::runtime::{Config, Host, Runtime};
use homerun_shell_core::{BlockedReason, RuntimeStatus};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct TestHost {
    keys: MemoryKeyStore,
    statuses: Mutex<Vec<RuntimeStatus>>,
    notes: Mutex<Vec<(String, Value)>>,
}

impl Host for TestHost {
    fn status(&self, s: &RuntimeStatus) {
        self.statuses.lock().unwrap().push(s.clone());
    }
    fn notification(&self, method: &str, params: Value) {
        self.notes.lock().unwrap().push((method.into(), params));
    }
    fn keys(&self) -> &dyn KeyStore {
        &self.keys
    }
}

struct Fixture {
    dir: PathBuf,
    host: Arc<TestHost>,
    rt: Runtime,
}

fn fast() -> Timing {
    Timing {
        ready_timeout: 3000,
        ping_every: 100,
        ping_misses: 3,
        backoff: vec![50, 100, 200],
        healthy_reset: 60_000,
        loop_window: 60_000,
        loop_count: 4,
        loop_retry: 60_000,
        stop_grace: 1500,
        term_grace: 500,
    }
}

/// Where the fake serves: a socket in `dir` (short, to fit in sun_path), or a pipe on Windows.
fn endpoint(dir: &std::path::Path, name: &str) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\hrs-{}-{name}", std::process::id())
    } else {
        dir.join("s").display().to_string()
    }
}

fn start(name: &str, env: &[(&str, &str)], key: Option<&str>) -> Fixture {
    let dir = std::env::temp_dir().join(format!("hrs-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = Config::new(PathBuf::from(env!("CARGO_BIN_EXE_fake_homerund")), dir.join("logs/homerund.log"), "0.0.1");
    cfg.timing = fast();
    cfg.hello_timeout = Duration::from_secs(2);
    cfg.ping_timeout = Duration::from_millis(100);
    cfg.env = vec![
        ("FAKE_SOCK".into(), endpoint(&dir, name)),
        ("FAKE_RECORD".into(), dir.join("record").display().to_string()),
        ("ANTHROPIC_API_KEY".into(), "leak".into()),
    ];
    cfg.env.extend(env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    cfg.env_remove = vec!["ANTHROPIC_API_KEY".into()];
    let host = Arc::new(TestHost { keys: MemoryKeyStore::default(), statuses: Mutex::new(vec![]), notes: Mutex::new(vec![]) });
    if let Some(k) = key {
        host.keys.set(API_KEY, k).unwrap();
    }
    let rt = Runtime::start(cfg, host.clone());
    Fixture { dir, host, rt }
}

impl Fixture {
    fn wait(&self, what: &str, f: impl Fn(&RuntimeStatus) -> bool) -> RuntimeStatus {
        let t0 = Instant::now();
        loop {
            let s = self.rt.status();
            if f(&s) {
                return s;
            }
            assert!(t0.elapsed() < Duration::from_secs(10), "waiting for {what}; status {s:?}; statuses {:?}", self.host.statuses.lock().unwrap());
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn record(&self) -> String {
        std::fs::read_to_string(self.dir.join("record")).unwrap_or_default()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.rt.stop(Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn ready(s: &RuntimeStatus) -> bool {
    matches!(s, RuntimeStatus::Ready { .. })
}

#[test]
fn spawns_with_the_token_on_stdin_hands_over_the_key_and_forwards() {
    let f = start("ok", &[], Some("sk-ant-TEST-not-a-real-key"));
    let s = f.wait("ready", ready);
    assert_eq!(s, RuntimeStatus::Ready { connection: 1, device_id: "dev-1".into(), runtime_version: "fake".into(), protocol: 1 });
    let rec = f.record();
    assert!(rec.contains("env_key=false"), "ANTHROPIC_API_KEY is removed from the runtime's env: {rec}");
    assert!(rec.contains("token len=64"));
    // The key reaches the runtime on the shell connection before the webview connects.
    let (shell_at, key_at, webview_at) =
        (rec.find("hello role=shell").unwrap(), rec.find("secrets.set anthropic_api_key=sk-ant-TEST").unwrap(), rec.find("hello role=webview").unwrap());
    assert!(shell_at < key_at && key_at < webview_at, "{rec}");

    let r = forward(f.rt.webview().as_deref(), "threads.list", json!({})).unwrap();
    assert_eq!(r, json!({"threads": [], "has_more": false}));
    for _ in 0..100 {
        if !f.host.notes.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(f.host.notes.lock().unwrap()[0].0, "threads.changed");
    assert_eq!(forward(f.rt.webview().as_deref(), "secrets.set", json!({})).unwrap_err().code, Some(-32002));

    // Shell notifications go on the persistent shell connection (§8.4).
    f.rt.shell().unwrap().notify("power.did_wake", json!({"at": 2, "slept_at": 1})).unwrap();
    f.rt.woke();
    std::thread::sleep(Duration::from_millis(100));
    assert!(f.record().contains("note power.did_wake"));
    let log = std::fs::read_to_string(f.dir.join("logs/homerund.log")).unwrap();
    assert!(log.contains("\"msg\":\"ready\"") && log.contains("\"src\":\"shell\""));
    assert!(!log.contains("sk-ant-TEST"), "the shell never logs a secret");
}

#[test]
fn a_clean_stop_closes_stdin_and_waits_for_the_exit() {
    let f = start("stop", &[], None);
    f.wait("ready", ready);
    let t0 = Instant::now();
    assert!(f.rt.stop(Duration::from_secs(5)));
    assert!(t0.elapsed() < Duration::from_secs(1), "exited on stdin EOF, no signal needed");
    assert!(f.record().contains("stdin closed"));
    assert_eq!(f.rt.status(), RuntimeStatus::Stopping);
    assert!(f.rt.webview().is_none());
}

#[test]
fn a_runtime_that_ignores_eof_is_terminated() {
    let f = start("term", &[("FAKE_MODE", "ignore_eof")], None);
    f.wait("ready", ready);
    let t0 = Instant::now();
    assert!(f.rt.stop(Duration::from_secs(5)));
    let took = t0.elapsed();
    assert!(took >= Duration::from_millis(1400) && took < Duration::from_secs(4), "{took:?}");
    let log = std::fs::read_to_string(f.dir.join("logs/homerund.log")).unwrap();
    // Windows has no SIGTERM: the job is terminated (§5.1).
    assert!(log.contains(if cfg!(windows) { "TerminateJobObject" } else { "SIGTERM" }), "{log}");
}

#[test]
fn crashes_restart_with_backoff_and_reconnect() {
    let f = start("crash", &[("FAKE_CRASH_FIRST", "2")], Some("sk-ant-TEST-not-a-real-key"));
    let s = f.wait("ready", ready);
    assert!(matches!(s, RuntimeStatus::Ready { connection: 1, .. }));
    let seen = f.host.statuses.lock().unwrap().clone();
    let restarts: Vec<_> = seen.iter().filter_map(|s| if let RuntimeStatus::Restarting { last_error, .. } = s { last_error.clone() } else { None }).collect();
    assert_eq!(restarts.len(), 2, "{seen:?}");
    assert!(restarts[0].contains("exit 1") && restarts[0].contains("startup failed: boom 1"), "{restarts:?}");
}

#[test]
fn a_crash_loop_stops_fast_restarts() {
    let f = start("loop", &[("FAKE_CRASH_FIRST", "100")], None);
    let s = f.wait("crash loop", |s| matches!(s, RuntimeStatus::CrashLoop { .. }));
    let RuntimeStatus::CrashLoop { last_error: Some(e), .. } = s else { panic!() };
    assert!(e.contains("boom 4"), "{e}");
    let starts = f.record().matches("start pid").count();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(f.record().matches("start pid").count(), starts, "no more fast restarts");
    assert!(f.rt.recent_log().iter().any(|l| l.contains("boom 4")));
}

#[test]
fn exit_codes_that_block() {
    for (mode, reason) in [
        ("exit:3", BlockedReason::OtherRuntime),
        ("exit:64", BlockedReason::Failed),
        ("exit:too_new", BlockedReason::DatabaseTooNew),
        ("incompatible", BlockedReason::Incompatible),
    ] {
        let f = start(&mode.replace(':', "-"), &[("FAKE_MODE", mode)], None);
        let s = f.wait(mode, |s| matches!(s, RuntimeStatus::Blocked { .. }));
        assert!(matches!(s, RuntimeStatus::Blocked { reason: r, .. } if r == reason), "{mode}: {s:?}");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(f.record().matches("start pid").count(), 1, "{mode}: no restart");
        // The user can try again.
        f.rt.restart();
        f.wait("second start", |_| f.record().matches("start pid").count() == 2);
    }
}

#[test]
fn a_hung_runtime_is_restarted() {
    let f = start("hang", &[("FAKE_MODE", "no_pong")], None);
    f.wait("ready", ready);
    let s = f.wait("restart", |s| matches!(s, RuntimeStatus::Restarting { .. }));
    let RuntimeStatus::Restarting { last_error: Some(e), .. } = s else { panic!() };
    assert_eq!(e, "The runtime stopped responding.");
    f.wait("ready again", |s| matches!(s, RuntimeStatus::Ready { connection: 2, .. }));
}

#[test]
fn never_ready_is_killed_after_the_timeout() {
    let f = start("slow", &[("FAKE_MODE", "never_ready")], None);
    let s = f.wait("restart", |s| matches!(s, RuntimeStatus::Restarting { .. }));
    let RuntimeStatus::Restarting { last_error: Some(e), .. } = s else { panic!() };
    assert_eq!(e, "The runtime didn't start within a minute.");
}

#[test]
fn a_missing_binary_is_reported() {
    let dir = std::env::temp_dir().join(format!("hrs-{}-missing", std::process::id()));
    let mut cfg = Config::new(dir.join("nope"), dir.join("log"), "0.0.1");
    cfg.timing = fast();
    let host = Arc::new(TestHost { keys: MemoryKeyStore::default(), statuses: Mutex::new(vec![]), notes: Mutex::new(vec![]) });
    let rt = Runtime::start(cfg, host);
    let t0 = Instant::now();
    loop {
        if let RuntimeStatus::Restarting { last_error: Some(e), .. } = rt.status() {
            assert!(e.contains("Couldn't start"), "{e}");
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(rt.stop(Duration::from_secs(2)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_user_restart_reconnects_with_a_new_connection_number() {
    let f = start("restart", &[], None);
    f.wait("ready", ready);
    f.rt.restart();
    f.wait("ready 2", |s| matches!(s, RuntimeStatus::Ready { connection: 2, .. }));
    assert_eq!(f.record().matches("stdin closed").count(), 1);
}

/// The fake's grandchildren, from its record, each held open so its pid can't be reused; None
/// for one that has already ended.
#[cfg(windows)]
fn grandchildren(f: &Fixture) -> Vec<(u32, Option<win::Process>)> {
    f.record()
        .lines()
        .filter_map(|l| l.strip_prefix("grandchild pid="))
        .map(|l| {
            let pid: u32 = l.split(' ').next().unwrap().parse().unwrap();
            (pid, win::Process::open(pid))
        })
        .collect()
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    pub struct Process(HANDLE);
    impl Process {
        pub fn open(pid: u32) -> Option<Process> {
            let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            (!h.is_null()).then_some(Process(h))
        }
        /// Whether it ends within `ms`.
        pub fn ends_within(&self, ms: u32) -> bool {
            unsafe { WaitForSingleObject(self.0, ms) == WAIT_OBJECT_0 }
        }
    }
    impl Drop for Process {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// §5.1 on Windows: `homerund` is in a job, so whatever it started ends with it, whether it
/// exits on stdin EOF or has to be terminated.
#[cfg(windows)]
#[test]
fn the_runtimes_whole_tree_ends_with_it() {
    for (name, mode) in [("tree-eof", ""), ("tree-term", "ignore_eof")] {
        let f = start(name, &[("FAKE_GRANDCHILD", "1"), ("FAKE_MODE", mode)], None);
        f.wait("ready", ready);
        let kids = grandchildren(&f);
        assert_eq!(kids.len(), 1, "{mode}: {}", f.record());
        let (pid, kid) = &kids[0];
        let kid = kid.as_ref().expect("the grandchild runs while the runtime does");
        assert!(!kid.ends_within(0), "{mode}: the grandchild runs while the runtime does");
        assert!(f.rt.stop(Duration::from_secs(5)), "{mode}");
        assert!(kid.ends_within(5000), "{mode}: grandchild {pid} outlived the runtime");
    }
}

/// §5.2 on Windows: the shell checks the pipe's server before it writes. A runtime whose
/// announced pipe is served by another process is treated as failing to start, and that
/// process hears nothing, so never the launch token.
#[cfg(windows)]
#[test]
fn a_pipe_served_by_another_process_never_hears_the_token() {
    let f = start("impostor", &[("FAKE_MODE", "impostor")], Some("sk-ant-TEST-not-a-real-key"));
    let s = f.wait("refused", |s| matches!(s, RuntimeStatus::Restarting { .. }));
    let RuntimeStatus::Restarting { last_error: Some(e), .. } = s else { panic!("{s:?}") };
    assert!(e.contains("Couldn't connect to the runtime") && e.contains("not the runtime the shell started"), "{e}");
    let impostors = grandchildren(&f);
    assert!(!impostors.is_empty(), "{}", f.record());
    // The first impostor ended with its runtime's tree (it was in the job).
    assert!(impostors[0].1.as_ref().is_none_or(|p| p.ends_within(5000)), "impostor {} outlived its runtime", impostors[0].0);
    let rec = f.record();
    assert!(!rec.contains("impostor heard") && !rec.contains("hello role"), "{rec}");
}
