//! A JSON-RPC 2.0 connection to `homerund`, one frame per line (§5.2). The shell holds two: its
//! own (`role: "shell"`) and the one it forwards webview calls on (`role: "webview"`). Ids are
//! the connection's own, so the webview never chooses them; frames are capped at `MAX_FRAME`.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The largest frame either side sends (§5.2). Blob contents go through `blobs.get` in pieces.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;

pub mod codes {
    pub const INVALID_PARAMS: i64 = -32602;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INTERNAL_ERROR: i64 = -32603;
    pub const FORBIDDEN: i64 = -32002;
    pub const INCOMPATIBLE_PROTOCOL: i64 = -32003;
}

#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError { code, message: message.into(), data: None }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CallError {
    Rpc(RpcError),
    /// The connection closed before the answer.
    Closed,
    Timeout,
    Io(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Rpc(e) => write!(f, "{} ({})", e.message, e.code),
            CallError::Closed => write!(f, "the runtime closed the connection"),
            CallError::Timeout => write!(f, "the runtime didn't answer in time"),
            CallError::Io(e) => write!(f, "{e}"),
        }
    }
}

/// What the runtime sends that isn't an answer.
pub trait Handler: Send + Sync {
    fn notification(&self, method: &str, params: Value);
    /// A runtime → shell request (`secrets.persist`, §5.2).
    fn request(&self, method: &str, _params: Value) -> Result<Value, RpcError> {
        Err(RpcError::new(codes::METHOD_NOT_FOUND, format!("the shell doesn't handle {method}")))
    }
}

type Reply = mpsc::Sender<Result<Value, CallError>>;

pub struct Connection {
    writer: Mutex<UnixStream>,
    pending: Mutex<Option<HashMap<u64, Reply>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HelloInfo {
    pub device_id: String,
    pub runtime_version: String,
    pub protocol: u64,
}

impl Connection {
    pub fn connect(path: &Path, handler: Arc<dyn Handler>) -> std::io::Result<Arc<Connection>> {
        let stream = UnixStream::connect(path)?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;
        let reader = stream.try_clone()?;
        let conn = Arc::new(Connection {
            writer: Mutex::new(stream),
            pending: Mutex::new(Some(HashMap::new())),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });
        let c = conn.clone();
        std::thread::Builder::new().name("homerun-rpc-read".into()).spawn(move || c.read_loop(reader, handler))?;
        Ok(conn)
    }

    /// Authenticate with the launch token (§5.2).
    pub fn hello(&self, role: &str, token: &str, client_version: &str, timeout: Duration) -> Result<HelloInfo, CallError> {
        let r = self.call(
            "hello",
            json!({
                "protocol": {"min": 1, "max": 1},
                "role": role,
                "auth": {"kind": "launch_token", "token": token},
                "client": {"name": "homerun-desktop", "version": client_version},
                "capabilities": [],
            }),
            timeout,
        )?;
        let s = |k: &str| r.get(k).and_then(Value::as_str).map(String::from);
        match (s("device_id"), s("runtime_version"), r.get("protocol").and_then(Value::as_u64)) {
            (Some(device_id), Some(runtime_version), Some(protocol)) => Ok(HelloInfo { device_id, runtime_version, protocol }),
            _ => Err(CallError::Io(format!("unexpected hello result: {r}"))),
        }
    }

    pub fn call(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, CallError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        match self.pending.lock().unwrap().as_mut() {
            Some(p) => p.insert(id, tx),
            None => return Err(CallError::Closed),
        };
        if let Err(e) = self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})) {
            self.forget(id);
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.forget(id);
                Err(CallError::Timeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(CallError::Closed),
        }
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), CallError> {
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Close the socket; pending calls fail with `Closed`.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(w) = self.writer.lock() {
            let _ = w.shutdown(Shutdown::Both);
        }
        self.fail_all();
    }

    fn forget(&self, id: u64) {
        if let Some(p) = self.pending.lock().unwrap().as_mut() {
            p.remove(&id);
        }
    }

    fn fail_all(&self) {
        if let Some(p) = self.pending.lock().unwrap().take() {
            for (_, tx) in p {
                let _ = tx.send(Err(CallError::Closed));
            }
        }
    }

    fn send(&self, v: &Value) -> Result<(), CallError> {
        let mut line = serde_json::to_string(v).map_err(|e| CallError::Io(e.to_string()))?;
        if line.len() > MAX_FRAME {
            return Err(CallError::Rpc(RpcError::new(codes::INVALID_PARAMS, "The request is too large.")));
        }
        if self.is_closed() {
            return Err(CallError::Closed);
        }
        line.push('\n');
        let mut w = self.writer.lock().unwrap();
        w.write_all(line.as_bytes()).map_err(|e| CallError::Io(e.to_string()))
    }

    fn read_loop(self: Arc<Self>, stream: UnixStream, handler: Arc<dyn Handler>) {
        let mut r = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match (&mut r).take(MAX_FRAME as u64 + 1).read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) if buf.last() != Some(&b'\n') => break, // over the cap, or EOF mid-frame
                Ok(_) => {}
            }
            let Ok(msg) = serde_json::from_slice::<Value>(&buf) else { continue };
            let method = msg.get("method").and_then(Value::as_str);
            let id = msg.get("id").filter(|v| !v.is_null());
            match (method, id) {
                (Some(m), Some(id)) => {
                    let reply = match handler.request(m, msg.get("params").cloned().unwrap_or(Value::Null)) {
                        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": e.code, "message": e.message}}),
                    };
                    let _ = self.send(&reply);
                }
                (Some(m), None) => handler.notification(m, msg.get("params").cloned().unwrap_or(Value::Null)),
                (None, Some(id)) => {
                    let Some(id) = id.as_u64() else { continue };
                    let tx = self.pending.lock().unwrap().as_mut().and_then(|p| p.remove(&id));
                    if let Some(tx) = tx {
                        let r = match msg.get("error") {
                            Some(e) => Err(CallError::Rpc(RpcError {
                                code: e.get("code").and_then(Value::as_i64).unwrap_or(codes::INTERNAL_ERROR),
                                message: e.get("message").and_then(Value::as_str).unwrap_or("error").to_string(),
                                data: e.get("data").cloned(),
                            })),
                            None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(r);
                    }
                }
                (None, None) => {}
            }
        }
        self.closed.store(true, Ordering::SeqCst);
        self.fail_all();
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;

    pub struct Recorder(pub Mutex<Vec<(String, Value)>>);
    impl Handler for Recorder {
        fn notification(&self, method: &str, params: Value) {
            self.0.lock().unwrap().push((method.into(), params));
        }
        fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
            if method == "secrets.persist" {
                Ok(json!({"stored": true, "echo": params}))
            } else {
                Err(RpcError::new(codes::METHOD_NOT_FOUND, "no"))
            }
        }
    }

    pub fn sock(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hr-rpc-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("s");
        let _ = std::fs::remove_file(&p);
        p
    }

    /// A server that answers with `f(request)` and can push frames of its own.
    pub fn serve(path: &Path, f: impl Fn(&Value, &mut UnixStream) + Send + 'static) {
        let l = UnixListener::bind(path).unwrap();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(s) = s else { return };
                let mut w = s.try_clone().unwrap();
                for line in BufReader::new(s).lines() {
                    let Ok(line) = line else { break };
                    let v: Value = serde_json::from_str(&line).unwrap();
                    f(&v, &mut w);
                }
            }
        });
    }

    fn answer(w: &mut UnixStream, v: Value) {
        writeln!(w, "{v}").unwrap();
    }

    #[test]
    fn calls_are_matched_by_id_and_errors_are_typed() {
        let p = sock("ids");
        serve(&p, |v, w| {
            let id = v["id"].clone();
            match v["method"].as_str().unwrap() {
                "echo" => answer(w, json!({"jsonrpc": "2.0", "id": id, "result": v["params"]})),
                "fail" => answer(w, json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32004, "message": "Not found", "data": {"x": 1}}})),
                _ => {}
            }
        });
        let c = Connection::connect(&p, Arc::new(Recorder(Mutex::new(vec![])))).unwrap();
        let t = Duration::from_secs(5);
        assert_eq!(c.call("echo", json!({"a": 1}), t).unwrap(), json!({"a": 1}));
        assert_eq!(c.call("fail", json!({}), t), Err(CallError::Rpc(RpcError { code: -32004, message: "Not found".into(), data: Some(json!({"x": 1})) })));
        assert_eq!(c.call("silent", json!({}), Duration::from_millis(50)), Err(CallError::Timeout));
        // Concurrent calls from several threads all get their own answers.
        let hs: Vec<_> = (0..8)
            .map(|i| {
                let c = c.clone();
                std::thread::spawn(move || c.call("echo", json!({"i": i}), Duration::from_secs(5)).unwrap())
            })
            .collect();
        for (i, h) in hs.into_iter().enumerate() {
            assert_eq!(h.join().unwrap(), json!({"i": i}));
        }
    }

    #[test]
    fn notifications_and_runtime_requests_reach_the_handler() {
        let p = sock("notes");
        serve(&p, |v, w| {
            if v["method"] == "go" {
                answer(w, json!({"jsonrpc": "2.0", "method": "thread.event", "params": {"n": 1}}));
                answer(w, json!({"jsonrpc": "2.0", "id": "r1", "method": "secrets.persist", "params": {"name": "refresh_token"}}));
                answer(w, json!({"jsonrpc": "2.0", "id": v["id"], "result": {}}));
            } else if v["id"] == "r1" {
                // The shell's reply to the runtime's request comes back here; send it on as a note.
                answer(w, json!({"jsonrpc": "2.0", "method": "reply", "params": v}));
            }
        });
        let rec = Arc::new(Recorder(Mutex::new(vec![])));
        let c = Connection::connect(&p, rec.clone()).unwrap();
        c.call("go", json!({}), Duration::from_secs(5)).unwrap();
        for _ in 0..100 {
            if rec.0.lock().unwrap().len() == 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let got = rec.0.lock().unwrap().clone();
        assert_eq!(got[0], ("thread.event".to_string(), json!({"n": 1})));
        assert_eq!(got[1].1["result"], json!({"stored": true, "echo": {"name": "refresh_token"}}));
    }

    #[test]
    fn a_close_fails_pending_calls() {
        let p = sock("close");
        serve(&p, |_, w| {
            let _ = w.shutdown(Shutdown::Both);
        });
        let c = Connection::connect(&p, Arc::new(Recorder(Mutex::new(vec![])))).unwrap();
        assert_eq!(c.call("x", json!({}), Duration::from_secs(5)), Err(CallError::Closed));
        assert!(c.is_closed());
        assert_eq!(c.call("x", json!({}), Duration::from_secs(5)), Err(CallError::Closed));
    }

    #[test]
    fn oversized_frames_are_refused_both_ways() {
        let p = sock("big");
        serve(&p, |v, w| {
            if v["method"] == "big" {
                let s = "x".repeat(MAX_FRAME + 10);
                answer(w, json!({"jsonrpc": "2.0", "id": v["id"], "result": s}));
            }
        });
        let c = Connection::connect(&p, Arc::new(Recorder(Mutex::new(vec![])))).unwrap();
        let big = json!({"s": "x".repeat(MAX_FRAME)});
        assert!(matches!(c.call("echo", big, Duration::from_secs(5)), Err(CallError::Rpc(RpcError { code: codes::INVALID_PARAMS, .. }))));
        assert_eq!(c.call("big", json!({}), Duration::from_secs(5)), Err(CallError::Closed));
    }

    #[test]
    fn hello_sends_the_launch_token_and_role() {
        let p = sock("hello");
        let seen = Arc::new(Mutex::new(Value::Null));
        let s2 = seen.clone();
        serve(&p, move |v, w| {
            *s2.lock().unwrap() = v.clone();
            answer(
                w,
                json!({"jsonrpc": "2.0", "id": v["id"], "result": {"protocol": 1, "runtime_version": "0.2.0", "device_id": "dev", "role": "webview", "capabilities": []}}),
            );
        });
        let c = Connection::connect(&p, Arc::new(Recorder(Mutex::new(vec![])))).unwrap();
        let h = c.hello("webview", &"a".repeat(64), "0.1.0", Duration::from_secs(5)).unwrap();
        assert_eq!(h, HelloInfo { device_id: "dev".into(), runtime_version: "0.2.0".into(), protocol: 1 });
        let v = seen.lock().unwrap().clone();
        assert_eq!(v["params"]["role"], "webview");
        assert_eq!(v["params"]["auth"], json!({"kind": "launch_token", "token": "a".repeat(64)}));
    }
}
