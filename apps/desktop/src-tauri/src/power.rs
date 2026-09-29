// Sleep and wake (design §8.1, §8.4): the shell observes NSWorkspace's will-sleep and did-wake
// notifications and forwards them to the runtime as `power.will_sleep` and `power.did_wake`, so
// fires missed while asleep are attributed to sleep with exact times. The runtime does not depend
// on them: it also detects sleep from gaps in its own ticks. Power assertions are held by the
// runtime itself (caffeinate), not here.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Where homerund listens: `<data>/run/homerund.sock`, or `$TMPDIR/hr-<uid>/` when that path is
/// too long for a unix socket (as `chooseRunDir` in @homerun/client decides).
pub fn socket_path(data_dir: &Path) -> PathBuf {
    const SUN_PATH_MAX: usize = 104;
    let primary = data_dir.join("run").join("homerund.sock");
    if primary.as_os_str().len() < SUN_PATH_MAX {
        return primary;
    }
    let tmp = std::env::var_os("TMPDIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    tmp.join(format!("hr-{}", unsafe { getuid() })).join("homerund.sock")
}

extern "C" {
    fn getuid() -> u32;
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Send one notification on a fresh shell connection, then a `ping`, so the runtime has handled
/// the notification when this returns.
pub fn notify(socket: &Path, token: &str, version: &str, method: &str, params: Value) -> Result<(), String> {
    let mut s = UnixStream::connect(socket).map_err(|e| format!("connect {}: {e}", socket.display()))?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut r = BufReader::new(s.try_clone().map_err(|e| e.to_string())?);
    let mut send = |v: Value| writeln!(s, "{v}").map_err(|e| e.to_string());
    let mut reply = |id: u64| -> Result<Value, String> {
        let mut line = String::new();
        loop {
            line.clear();
            if r.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                return Err("the runtime closed the connection".into());
            }
            let v: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if v["id"] == id {
                return v.get("error").map_or(Ok(v["result"].clone()), |e| Err(e.to_string()));
            }
        }
    };
    send(json!({"jsonrpc": "2.0", "id": 1, "method": "hello", "params": {
        "protocol": {"min": 1, "max": 1},
        "role": "shell",
        "auth": {"kind": "launch_token", "token": token},
        "client": {"name": "homerun-shell", "version": version},
        "capabilities": [],
    }}))?;
    reply(1)?;
    send(json!({"jsonrpc": "2.0", "method": method, "params": params}))?;
    send(json!({"jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}}))?;
    reply(2).map(|_| ())
}

pub enum PowerEvent {
    WillSleep { at: u64 },
    DidWake { at: u64, slept_at: Option<u64> },
}

impl PowerEvent {
    pub fn method(&self) -> &'static str {
        match self {
            PowerEvent::WillSleep { .. } => "power.will_sleep",
            PowerEvent::DidWake { .. } => "power.did_wake",
        }
    }
    pub fn params(&self) -> Value {
        match self {
            PowerEvent::WillSleep { at } => json!({ "at": at }),
            PowerEvent::DidWake { at, slept_at } => json!({ "at": at, "slept_at": slept_at }),
        }
    }
}

/// Call `on_event` for each sleep and wake, on the main thread. Must be called on the main thread
/// (from Tauri's `setup`); the observers live as long as the process.
#[cfg(target_os = "macos")]
pub fn observe(on_event: impl Fn(PowerEvent) + 'static) {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification};
    use objc2_foundation::NSNotification;
    use std::cell::Cell;
    use std::ptr::NonNull;
    use std::rc::Rc;

    let on_event = Rc::new(on_event);
    let slept_at = Rc::new(Cell::new(None::<u64>));
    let (f, s) = (on_event.clone(), slept_at.clone());
    let will = RcBlock::new(move |_: NonNull<NSNotification>| {
        let at = now_ms();
        s.set(Some(at));
        f(PowerEvent::WillSleep { at });
    });
    let did = RcBlock::new(move |_: NonNull<NSNotification>| {
        on_event(PowerEvent::DidWake { at: now_ms(), slept_at: slept_at.take() });
    });
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    unsafe {
        let a = center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceWillSleepNotification), None, None, &will);
        let b = center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceDidWakeNotification), None, None, &did);
        std::mem::forget((a, b));
    }
}

#[cfg(not(target_os = "macos"))]
pub fn observe(_on_event: impl Fn(PowerEvent) + 'static) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn socket_path_falls_back_when_too_long() {
        assert_eq!(socket_path(Path::new("/d")), PathBuf::from("/d/run/homerund.sock"));
        let long = PathBuf::from(format!("/{}", "x".repeat(120)));
        assert!(socket_path(&long).ends_with("homerund.sock"));
        assert!(!socket_path(&long).starts_with(&long));
    }

    #[test]
    fn notify_sends_hello_then_the_notification_then_ping() {
        let dir = std::env::temp_dir().join(format!("hr-power-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("s");
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut w = s.try_clone().unwrap();
            let mut got = vec![];
            for line in BufReader::new(s).lines() {
                let v: Value = serde_json::from_str(&line.unwrap()).unwrap();
                if !v["id"].is_null() {
                    writeln!(w, "{}", json!({"jsonrpc": "2.0", "id": v["id"], "result": {}})).unwrap();
                }
                let done = v["method"] == "ping";
                got.push(v);
                if done {
                    break;
                }
            }
            got
        });
        let ev = PowerEvent::DidWake { at: 2, slept_at: Some(1) };
        notify(&sock, &"a".repeat(64), "0.0.1", ev.method(), ev.params()).unwrap();
        let got = server.join().unwrap();
        assert_eq!(got[0]["params"]["auth"], json!({"kind": "launch_token", "token": "a".repeat(64)}));
        assert_eq!(got[1], json!({"jsonrpc": "2.0", "method": "power.did_wake", "params": {"at": 2, "slept_at": 1}}));
        assert!(got[1].get("id").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
