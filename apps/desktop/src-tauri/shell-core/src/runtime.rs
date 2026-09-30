//! The supervisor with real processes (§5.1): executes `policy` effects with `std::process`,
//! the runtime's endpoint (`transport`) and a timer loop on its own thread. What differs by OS,
//! process groups or a job object, is in `proc`.

use crate::keys;
use crate::logfile::LogFile;
use crate::policy::{Effect, Event, Exit, Hello, Now, Policy, Timing};
use crate::proc::{self, Tree};
use crate::rpc::{codes, CallError, Connection, Handler, RpcError};
use crate::status::RuntimeStatus;
use crate::token::launch_token;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub struct Config {
    /// `homerund`, next to the shell's executable in the bundle.
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Removed from the runtime's environment, e.g. `ANTHROPIC_API_KEY` (§5.2: secrets travel
    /// over the connection only).
    pub env_remove: Vec<String>,
    /// `logs/homerund.log`.
    pub log: PathBuf,
    pub log_max: u64,
    pub client_version: String,
    pub timing: Timing,
    pub hello_timeout: Duration,
    pub ping_timeout: Duration,
}

impl Config {
    pub fn new(program: PathBuf, log: PathBuf, client_version: &str) -> Self {
        Config {
            program,
            args: vec!["serve".into()],
            env: vec![],
            env_remove: vec![],
            log,
            log_max: 10 * 1024 * 1024,
            client_version: client_version.into(),
            timing: Timing::default(),
            hello_timeout: Duration::from_secs(10),
            ping_timeout: Duration::from_secs(5),
        }
    }
}

/// What the app does with the runtime's state and messages.
pub trait Host: Send + Sync + 'static {
    fn status(&self, status: &RuntimeStatus);
    /// A notification on the webview connection (`thread.event`, `threads.changed`, …), for the UI.
    fn notification(&self, method: &str, params: Value);
    /// Where secrets live; handed to every new runtime before the UI connects (§5.2).
    fn keys(&self) -> &dyn keys::KeyStore;
    /// A notification for the shell itself (`cli.access_requested`, milestone 8).
    fn shell_notification(&self, _method: &str, _params: Value) {}
}

struct Conns {
    gen: u64,
    shell: Arc<Connection>,
    webview: Arc<Connection>,
}

struct Shared {
    status: Mutex<RuntimeStatus>,
    conns: Mutex<Option<Conns>>,
    gen: AtomicU64,
    stopped: (Mutex<bool>, Condvar),
    tail: Mutex<VecDeque<String>>,
    log: Mutex<LogFile>,
}

impl Shared {
    fn log(&self, line: &str) {
        self.log.lock().unwrap().line(line);
    }
    fn shell_log(&self, msg: &str, fields: Value) {
        let mut rec = json!({"t": wall_ms(), "level": "info", "src": "shell", "msg": msg});
        if let (Some(r), Some(f)) = (rec.as_object_mut(), fields.as_object()) {
            r.extend(f.clone());
        }
        self.log(&rec.to_string());
    }
}

/// A handle on the supervised runtime. Cheap to clone.
#[derive(Clone)]
pub struct Runtime {
    tx: Sender<Event>,
    shared: Arc<Shared>,
}

const TAIL: usize = 50;

fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Runtime {
    /// Start supervising: spawns `homerund` at once.
    pub fn start(config: Config, host: Arc<dyn Host>) -> Runtime {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            status: Mutex::new(RuntimeStatus::Starting),
            conns: Mutex::new(None),
            gen: AtomicU64::new(0),
            stopped: (Mutex::new(false), Condvar::new()),
            tail: Mutex::new(VecDeque::new()),
            log: Mutex::new(LogFile::new(config.log.clone(), config.log_max)),
        });
        let rt = Runtime { tx: tx.clone(), shared: shared.clone() };
        std::thread::Builder::new()
            .name("homerun-supervisor".into())
            .spawn(move || Driver { config, host, shared, tx, child: None }.run(rx))
            .expect("supervisor thread");
        rt
    }

    pub fn status(&self) -> RuntimeStatus {
        self.shared.status.lock().unwrap().clone()
    }

    /// The webview-role connection, while the runtime is ready.
    pub fn webview(&self) -> Option<Arc<Connection>> {
        self.conn(|c| c.webview.clone())
    }

    /// The shell-role connection, while the runtime is ready.
    pub fn shell(&self) -> Option<Arc<Connection>> {
        self.conn(|c| c.shell.clone())
    }

    fn conn(&self, f: impl Fn(&Conns) -> Arc<Connection>) -> Option<Arc<Connection>> {
        let g = self.shared.gen.load(Ordering::SeqCst);
        self.shared.conns.lock().unwrap().as_ref().filter(|c| c.gen == g).map(f).filter(|c| !c.is_closed())
    }

    /// The last lines the runtime wrote, for the crash-loop banner and bug reports.
    pub fn recent_log(&self) -> Vec<String> {
        self.shared.tail.lock().unwrap().iter().cloned().collect()
    }

    /// A shell event (quit, update, login item) in the same log as the runtime's, so one file
    /// tells the whole story. Never pass secrets.
    pub fn log_event(&self, msg: &str, fields: Value) {
        self.shared.shell_log(msg, fields);
    }

    pub fn log_path(&self) -> PathBuf {
        self.shared.log.lock().unwrap().path().to_path_buf()
    }

    pub fn restart(&self) {
        let _ = self.tx.send(Event::Restart);
    }

    /// The Mac woke (§8.4): forgive the pings that couldn't be answered.
    pub fn woke(&self) {
        let _ = self.tx.send(Event::Woke);
    }

    /// Stop the runtime cleanly (§5.1) and wait until it has exited, up to `timeout`.
    pub fn stop(&self, timeout: Duration) -> bool {
        let _ = self.tx.send(Event::Stop);
        let (m, cv) = &self.shared.stopped;
        let g = cv.wait_timeout_while(m.lock().unwrap(), timeout, |stopped| !*stopped).unwrap();
        *g.0
    }
}

struct Child {
    gen: u64,
    tree: Arc<Tree>,
    stdin: Option<ChildStdin>,
    token: String,
}

struct Driver {
    config: Config,
    host: Arc<dyn Host>,
    shared: Arc<Shared>,
    tx: Sender<Event>,
    child: Option<Child>,
}

struct ShellHandler {
    host: Arc<dyn Host>,
}

impl Handler for ShellHandler {
    fn notification(&self, method: &str, params: Value) {
        self.host.shell_notification(method, params);
    }
    fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "secrets.persist" => keys::persist(self.host.keys(), &params),
            _ => Err(RpcError::new(codes::METHOD_NOT_FOUND, format!("the shell doesn't handle {method}"))),
        }
    }
}

struct WebviewHandler {
    host: Arc<dyn Host>,
}

impl Handler for WebviewHandler {
    fn notification(&self, method: &str, params: Value) {
        self.host.notification(method, params);
    }
}

impl Driver {
    fn run(mut self, rx: mpsc::Receiver<Event>) {
        let base = Instant::now();
        let now = || Now { mono: base.elapsed().as_millis() as u64, wall: wall_ms() };
        let mut policy = Policy::new(self.config.timing.clone());
        let fx = policy.handle(now(), Event::Start);
        self.apply(fx);
        loop {
            let ev = match policy.deadline() {
                Some(d) => match rx.recv_timeout(Duration::from_millis(d.saturating_sub(now().mono))) {
                    Ok(ev) => ev,
                    Err(RecvTimeoutError::Timeout) => Event::Tick,
                    Err(RecvTimeoutError::Disconnected) => Event::Stop,
                },
                None => rx.recv().unwrap_or(Event::Stop),
            };
            let fx = policy.handle(now(), ev);
            self.apply(fx);
            if policy.is_stopped() {
                let (m, cv) = &self.shared.stopped;
                *m.lock().unwrap() = true;
                cv.notify_all();
                return;
            }
        }
    }

    fn apply(&mut self, fx: Vec<Effect>) {
        for e in fx {
            match e {
                Effect::Spawn { gen } => self.spawn(gen),
                Effect::Connect { gen, socket } => self.connect(gen, socket),
                Effect::Disconnect => {
                    if let Some(c) = self.shared.conns.lock().unwrap().take() {
                        c.shell.close();
                        c.webview.close();
                    }
                }
                Effect::Ping { gen } => {
                    let conn = self.shared.conns.lock().unwrap().as_ref().filter(|c| c.gen == gen).map(|c| c.shell.clone());
                    let (tx, timeout) = (self.tx.clone(), self.config.ping_timeout);
                    std::thread::spawn(move || {
                        let ok = conn.is_some_and(|c| c.call("ping", json!({}), timeout).is_ok());
                        let _ = tx.send(Event::Ping { gen, ok });
                    });
                }
                Effect::CloseStdin => {
                    if let Some(c) = self.child.as_mut() {
                        c.stdin.take();
                    }
                }
                Effect::Signal(s) => {
                    if let Some(c) = &self.child {
                        let name = c.tree.signal(s);
                        self.shared.shell_log("signal", json!({"pid": c.tree.pid(), "signal": name}));
                    }
                }
                Effect::Status(s) => {
                    self.shared.shell_log("status", json!({"status": s}));
                    *self.shared.status.lock().unwrap() = s.clone();
                    self.host.status(&s);
                }
                Effect::Stopped => self.shared.shell_log("stopped", json!({})),
            }
        }
    }

    fn spawn(&mut self, gen: u64) {
        self.child = None;
        self.shared.gen.store(gen, Ordering::SeqCst);
        let token = match launch_token() {
            Ok(t) => t,
            Err(e) => {
                let _ = self.tx.send(Event::SpawnFailed { gen, error: format!("No launch token: {e}") });
                return;
            }
        };
        let mut cmd = Command::new(&self.config.program);
        cmd.args(&self.config.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (k, v) in &self.config.env {
            cmd.env(k, v);
        }
        for k in &self.config.env_remove {
            cmd.env_remove(k);
        }
        // Its own process group (on Windows, a console group and no console window), so a
        // terminal's Ctrl-C to the shell doesn't reach it (§5.1).
        proc::prepare(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let error = format!("Couldn't start {}: {e}", self.config.program.display());
                self.shared.shell_log("spawn failed", json!({"error": error}));
                let _ = self.tx.send(Event::SpawnFailed { gen, error });
                return;
            }
        };
        let shared = self.shared.clone();
        let tree = Arc::new(proc::adopt(&child, |w| shared.shell_log("process tree", json!({"warning": w}))));
        let pid = tree.pid();
        self.shared.shell_log("spawned", json!({"pid": pid, "gen": gen}));
        let mut stdin = child.stdin.take();
        // The token goes on stdin line 1, never argv or env (§5.2). A failed write means the
        // child already exited, which its exit event reports.
        if let Some(s) = stdin.as_mut() {
            let _ = s.write_all(format!("{token}\n").as_bytes()).and_then(|_| s.flush());
        }
        let last_error = Arc::new(Mutex::new(None::<String>));
        let (done_tx, done_rx) = mpsc::channel::<()>();
        if let Some(err) = child.stderr.take() {
            let (shared, tx, last) = (self.shared.clone(), self.tx.clone(), last_error.clone());
            std::thread::spawn(move || {
                read_lines(err, |line| {
                    shared.log(line);
                    {
                        let mut t = shared.tail.lock().unwrap();
                        if t.len() == TAIL {
                            t.pop_front();
                        }
                        t.push_back(line.to_string());
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        let msg = v.get("msg").and_then(Value::as_str).unwrap_or("");
                        if msg == "ready" {
                            if let Some(socket) = v.get("socket").and_then(Value::as_str) {
                                let _ = tx.send(Event::ReadyLine { gen, socket: socket.into() });
                            }
                        }
                        if v.get("level").and_then(Value::as_str) == Some("error") {
                            let detail = v.pointer("/err/message").and_then(Value::as_str);
                            *last.lock().unwrap() = Some(match detail {
                                Some(d) if !d.is_empty() => format!("{msg}: {d}"),
                                _ => msg.to_string(),
                            });
                        }
                    }
                });
                let _ = done_tx.send(());
            });
        }
        if let Some(out) = child.stdout.take() {
            let shared = self.shared.clone();
            std::thread::spawn(move || read_lines(out, |line| shared.log(line)));
        }
        let (shared, tx, reap) = (self.shared.clone(), self.tx.clone(), tree.clone());
        std::thread::spawn(move || {
            let st = child.wait();
            // Whatever it started and left running goes with it (§5.1; a no-op on POSIX).
            reap.reap();
            // Let stderr drain so the last error is known; a grandchild holding it open can't
            // delay the exit for long.
            let _ = done_rx.recv_timeout(Duration::from_secs(1));
            let (code, signal) = match st {
                Ok(s) => proc::exit_parts(&s),
                Err(_) => (None, None),
            };
            shared.shell_log("exited", json!({"pid": pid, "code": code, "signal": signal}));
            let last_error = last_error.lock().unwrap().take();
            let _ = tx.send(Event::Exited { gen, exit: Exit { code, signal, last_error } });
        });
        self.child = Some(Child { gen, tree, stdin, token });
    }

    fn connect(&self, gen: u64, socket: String) {
        let Some(child) = self.child.as_ref().filter(|c| c.gen == gen) else { return };
        let (token, pid) = (child.token.clone(), child.tree.pid());
        let (host, shared, tx) = (self.host.clone(), self.shared.clone(), self.tx.clone());
        let (version, timeout) = (self.config.client_version.clone(), self.config.hello_timeout);
        std::thread::spawn(move || {
            let r = (|| -> Result<(Conns, Hello), (String, bool)> {
                let io = |e: std::io::Error| (format!("Couldn't connect to the runtime: {e}"), false);
                let hello_err = |e: CallError| {
                    let incompatible = matches!(&e, CallError::Rpc(r) if r.code == codes::INCOMPATIBLE_PROTOCOL);
                    let msg = if incompatible {
                        format!("This runtime speaks a different protocol version. {e}")
                    } else {
                        format!("The runtime refused the connection: {e}")
                    };
                    (msg, incompatible)
                };
                let path = Path::new(&socket);
                // On Windows the pipe must be served by the child just spawned (`transport`).
                let shell = Connection::connect(path, Some(pid), Arc::new(ShellHandler { host: host.clone() })).map_err(io)?;
                shell.hello("shell", &token, &version, timeout).map_err(hello_err)?;
                // Secrets before the UI connects, so its first chat has the key (§5.2).
                match keys::hand_over(host.keys(), shell.as_ref()) {
                    Ok(names) => shared.shell_log("secrets handed over", json!({"names": names})),
                    Err(e) => shared.shell_log("secrets not handed over", json!({"error": e})),
                }
                let webview = Connection::connect(path, Some(pid), Arc::new(WebviewHandler { host: host.clone() })).map_err(|e| {
                    shell.close();
                    io(e)
                })?;
                let h = webview.hello("webview", &token, &version, timeout).map_err(|e| {
                    shell.close();
                    webview.close();
                    hello_err(e)
                })?;
                Ok((Conns { gen, shell, webview }, Hello { device_id: h.device_id, runtime_version: h.runtime_version, protocol: h.protocol }))
            })();
            match r {
                Ok((conns, hello)) => {
                    if shared.gen.load(Ordering::SeqCst) == gen {
                        *shared.conns.lock().unwrap() = Some(conns);
                    } else {
                        conns.shell.close();
                        conns.webview.close();
                    }
                    let _ = tx.send(Event::Connected { gen, hello });
                }
                Err((error, incompatible)) => {
                    shared.shell_log("connect failed", json!({"error": error}));
                    let _ = tx.send(Event::ConnectFailed { gen, error, incompatible });
                }
            }
        });
    }
}

fn read_lines(r: impl Read, mut f: impl FnMut(&str)) {
    let mut r = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        // A runaway line is cut at 64 KiB rather than held in memory.
        match (&mut r).take(64 * 1024).read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => f(String::from_utf8_lossy(&buf).trim_end()),
        }
    }
}
