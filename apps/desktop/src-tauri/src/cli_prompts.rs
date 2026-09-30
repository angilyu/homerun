//! The CLI access prompt's driver (§5.2): `cli.access_requested` and `cli.access_withdrawn` from
//! the shell connection feed shell-core's queue; each prompt runs on the main thread, and its
//! answer goes back on the shell connection from a thread of its own, so neither the runtime's
//! reader thread nor the main thread waits on the other.

use crate::macos;
use crate::shell::Shell;
use homerun_shell_core::cli_access::{answer_call, answer_failed, Answer, Prompt, Queue, Request};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub struct CliPrompts {
    app: AppHandle,
    queue: Mutex<Queue>,
    /// The prompt on screen, and the flag that closes it with no answer.
    closing: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

impl CliPrompts {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(CliPrompts { app, queue: Mutex::new(Queue::default()), closing: Mutex::new(None) })
    }

    fn log(&self, msg: &str, fields: Value) {
        if let Some(s) = self.app.try_state::<Arc<Shell>>() {
            s.rt.log_event(msg, fields);
        }
    }

    /// From the runtime's reader thread: never blocks on the prompt.
    pub fn notification(self: &Arc<Self>, method: &str, params: &Value) {
        match method {
            "cli.access_requested" => {
                let Some(r) = Request::parse(params) else { return self.log("cli.access_malformed", json!({})) };
                let next = self.queue.lock().unwrap().requested(r, now_ms());
                if let Some(p) = next {
                    self.show(p);
                }
            }
            "cli.access_withdrawn" => {
                let Some(id) = params["request_id"].as_str() else { return };
                if self.queue.lock().unwrap().withdrawn(id) {
                    self.close(id);
                }
            }
            _ => {}
        }
    }

    /// The runtime stopped or restarted: its requests went with it.
    pub fn runtime_gone(&self) {
        if let Some(id) = self.queue.lock().unwrap().reset() {
            self.close(&id);
        }
    }

    fn close(&self, id: &str) {
        if let Some((showing, flag)) = self.closing.lock().unwrap().as_ref() {
            if showing == id {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    fn show(self: &Arc<Self>, p: Prompt) {
        let flag = Arc::new(AtomicBool::new(false));
        *self.closing.lock().unwrap() = Some((p.request_id.clone(), flag.clone()));
        self.log("cli.access_prompt", json!({"request_id": p.request_id}));
        let me = self.clone();
        let r = self.app.run_on_main_thread(move || {
            let deadline = p.deadline_ms;
            let answer = macos::ask_cli_access(&p, Box::new(move || flag.load(Ordering::SeqCst) || now_ms() >= deadline));
            me.answered(p.request_id, answer);
        });
        if r.is_err() {
            self.log("cli.access_prompt_failed", json!({}));
        }
    }

    /// Main thread, after the prompt closed.
    fn answered(self: &Arc<Self>, id: String, answer: Answer) {
        self.log("cli.access_answered", json!({"request_id": id, "answer": format!("{answer:?}")}));
        if let Some((method, params)) = answer_call(&id, answer) {
            let app = self.app.clone();
            std::thread::spawn(move || {
                let Some(shell) = app.try_state::<Arc<Shell>>() else { return };
                let r = match shell.rt.shell() {
                    Some(c) => c.call(method, params, Duration::from_secs(10)).map(|_| ()),
                    None => Err(homerun_shell_core::rpc::CallError::Closed),
                };
                if let Err(e) = r {
                    if answer_failed(&e) {
                        shell.rt.log_event("cli.access_answer_failed", json!({"method": method, "error": e.to_string()}));
                    }
                }
            });
        }
        *self.closing.lock().unwrap() = None;
        let next = self.queue.lock().unwrap().closed(&id, now_ms());
        if let Some(p) = next {
            self.show(p);
        }
    }
}
