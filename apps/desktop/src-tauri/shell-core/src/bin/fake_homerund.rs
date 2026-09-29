//! A stand-in for `homerund serve`, for the supervisor's integration tests only. It speaks
//! just enough of §5.2: the launch token on stdin, the `ready` line on stderr, `hello` and `ping`
//! on a Unix socket, and a clean exit on stdin EOF. `FAKE_MODE` picks a misbehaviour.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::Arc;

fn log(level: &str, msg: &str, extra: Value) {
    let mut v = json!({"t": "x", "level": level, "msg": msg});
    v.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
    eprintln!("{v}");
}

fn record(line: &str) {
    if let Ok(p) = std::env::var("FAKE_RECORD") {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(p).unwrap();
        writeln!(f, "{line}").unwrap();
    }
}

fn main() {
    let mode = std::env::var("FAKE_MODE").unwrap_or_default();
    let sock = std::env::var("FAKE_SOCK").expect("FAKE_SOCK");
    record(&format!("start pid={} env_key={}", std::process::id(), std::env::var("ANTHROPIC_API_KEY").is_ok()));
    // Crash the first N starts, counted in a file.
    if let Ok(n) = std::env::var("FAKE_CRASH_FIRST").map(|v| v.parse::<u32>().unwrap()) {
        let counter = format!("{sock}.starts");
        let starts = std::fs::read_to_string(&counter).ok().and_then(|s| s.trim().parse::<u32>().ok()).unwrap_or(0) + 1;
        std::fs::write(&counter, starts.to_string()).unwrap();
        if starts <= n {
            log("error", "startup failed", json!({"err": {"message": format!("boom {starts}")}}));
            std::process::exit(1);
        }
    }
    let mut stdin = std::io::stdin().lock();
    let mut token = String::new();
    if stdin.read_line(&mut token).unwrap_or(0) == 0 {
        std::process::exit(2);
    }
    let token = Arc::new(token.trim().to_string());
    record(&format!("token len={}", token.len()));
    if let Some(code) = mode.strip_prefix("exit:") {
        if code == "too_new" {
            log("error", "database is too new", json!({"err": {"message": "schema 99"}}));
            std::process::exit(1);
        }
        std::process::exit(code.parse().unwrap());
    }
    if mode != "never_ready" {
        let _ = std::fs::remove_file(&sock);
        let l = UnixListener::bind(&sock).unwrap();
        let mode2 = mode.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let (t, m) = (token.clone(), mode2.clone());
                std::thread::spawn(move || serve(s, &t, &m));
            }
        });
        log("info", "ready", json!({"socket": sock, "version": "fake"}));
    }
    // Serve until stdin closes, as homerund does (§5.1).
    let mut sink = Vec::new();
    let _ = stdin.read_to_end(&mut sink);
    record("stdin closed");
    if mode == "ignore_eof" {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
    log("info", "shutting down", json!({"why": "stdin EOF"}));
    std::process::exit(0);
}

fn serve(s: UnixStream, token: &str, mode: &str) {
    let mut w = s.try_clone().unwrap();
    let mut role = String::new();
    for line in BufReader::new(s).lines() {
        let Ok(line) = line else { return };
        let v: Value = serde_json::from_str(&line).unwrap();
        let id = v["id"].clone();
        let m = v["method"].as_str().unwrap_or("");
        let reply = match m {
            "hello" if mode == "incompatible" => json!({"error": {"code": -32003, "message": "No protocol version in common"}}),
            "hello" if v["params"]["auth"]["token"] != token => json!({"error": {"code": -32001, "message": "Invalid launch token."}}),
            "hello" => {
                role = v["params"]["role"].as_str().unwrap_or("").to_string();
                record(&format!("hello role={role}"));
                json!({"result": {"protocol": 1, "runtime_version": "fake", "device_id": "dev-1", "role": role, "capabilities": []}})
            }
            "ping" if mode == "no_pong" => continue,
            "ping" => json!({"result": {"pong": true, "runtime_version": "fake", "protocol": 1}}),
            "secrets.set" => {
                record(&format!("secrets.set {}={}", v["params"]["name"].as_str().unwrap(), v["params"]["value"].as_str().unwrap()));
                json!({"result": {"ok": true}})
            }
            "threads.list" if role == "webview" => {
                writeln!(w, "{}", json!({"jsonrpc": "2.0", "method": "threads.changed", "params": {"n": 1}})).unwrap();
                json!({"result": {"threads": [], "has_more": false}})
            }
            _ if id.is_null() => {
                record(&format!("note {m}"));
                continue;
            }
            _ => json!({"error": {"code": -32002, "message": "forbidden"}}),
        };
        let mut r = reply;
        r["jsonrpc"] = json!("2.0");
        r["id"] = id;
        if writeln!(w, "{r}").is_err() {
            return;
        }
    }
}
