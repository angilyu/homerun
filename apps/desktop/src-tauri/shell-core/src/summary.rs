//! What the menu-bar item and the quit confirmation know about the runtime (§5.1): pending input,
//! active runs and monitors, read on the shell's own connection. Also *Pause All Monitors*, which
//! needs no protocol of its own (§8.2).

use crate::keys::ShellCalls;
use crate::prefs::Prefs;
use crate::rpc::CallError;
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PendingKind {
    Approval { tool: String },
    Question,
    Ambiguous { tool: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    /// None when the run's thread isn't among the recent ones; the item then opens the window.
    pub thread_id: Option<String>,
    pub title: String,
    pub kind: PendingKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Running {
    pub thread_id: String,
    pub title: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Summary {
    pub pending: Vec<Pending>,
    /// Threads with an active run that isn't waiting for input (those are in `pending`).
    pub running: Vec<Running>,
    /// Every thread with an active run, waiting for input or not (§5.1 quit confirmation).
    pub active_runs: usize,
    pub monitors_on: usize,
    /// Still paused by *Pause All Monitors*, i.e. what *Resume Monitors* would turn back on.
    pub paused_by_shell: usize,
}

impl Summary {
    pub fn approvals(&self) -> usize {
        self.pending.iter().filter(|p| !matches!(p.kind, PendingKind::Question)).count()
    }
    pub fn questions(&self) -> usize {
        self.pending.len() - self.approvals()
    }
}

const THREADS: u64 = 200;

fn title(t: &Value) -> String {
    match t.get("title").and_then(Value::as_str).map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => "Untitled chat".into(),
    }
}

/// Built from `threads.list`, `input.list_pending` and `schedules.list` results. A request is
/// matched to its thread through the thread's `active_run`: a run waiting for input is active.
pub fn from_values(threads: &Value, pending: &Value, schedules: &Value, paused_by_pause_all: &[String]) -> Summary {
    let threads: &[Value] = threads.get("threads").and_then(Value::as_array).map_or(&[], |v| v);
    let by_run = |run: &str| threads.iter().find(|t| t.pointer("/active_run/run_id").and_then(Value::as_str) == Some(run));
    let mut s = Summary::default();
    for r in pending.get("requests").and_then(Value::as_array).map_or(&[][..], |v| v) {
        if r.get("state").and_then(Value::as_str).is_some_and(|st| st != "pending") {
            continue;
        }
        let p = r.get("prompt").cloned().unwrap_or(Value::Null);
        let tool = || p.get("tool").and_then(Value::as_str).unwrap_or("a tool").to_string();
        let kind = match p.get("type").and_then(Value::as_str) {
            Some("approval") => PendingKind::Approval { tool: tool() },
            Some("question") => PendingKind::Question,
            Some("ambiguous_tool_call") => PendingKind::Ambiguous { tool: tool() },
            _ => continue,
        };
        let t = r.get("run_id").and_then(Value::as_str).and_then(by_run);
        s.pending.push(Pending {
            thread_id: t.and_then(|t| t.get("thread_id")).and_then(Value::as_str).map(str::to_string),
            title: t.map_or_else(|| "Homerun".into(), title),
            kind,
        });
    }
    for t in threads {
        if t.get("active_run").is_some_and(|r| !r.is_null()) {
            s.active_runs += 1;
            let waiting = t.get("input_pending").and_then(Value::as_bool).unwrap_or(false)
                || t.pointer("/active_run/state").and_then(Value::as_str) == Some("waiting_input");
            if !waiting {
                if let Some(id) = t.get("thread_id").and_then(Value::as_str) {
                    s.running.push(Running { thread_id: id.into(), title: title(t) });
                }
            }
        }
    }
    for sc in schedules.get("schedules").and_then(Value::as_array).map_or(&[][..], |v| v) {
        if sc.get("enabled").and_then(Value::as_bool) == Some(true) {
            s.monitors_on += 1;
        } else if paused_by_user(sc) && sc.get("schedule_id").and_then(Value::as_str).is_some_and(|id| paused_by_pause_all.iter().any(|p| p == id)) {
            s.paused_by_shell += 1;
        }
    }
    s
}

fn paused_by_user(sc: &Value) -> bool {
    sc.get("enabled").and_then(Value::as_bool) == Some(false) && sc.get("paused_reason").and_then(Value::as_str) == Some("user")
}

pub fn fetch(c: &dyn ShellCalls, paused_by_pause_all: &[String]) -> Result<Summary, CallError> {
    let threads = c.call("threads.list", json!({"limit": THREADS}))?;
    let pending = c.call("input.list_pending", json!({}))?;
    let schedules = c.call("schedules.list", json!({}))?;
    Ok(from_values(&threads, &pending, &schedules, paused_by_pause_all))
}

/// *Pause All Monitors*: pause every enabled schedule and remember which, so *Resume* leaves
/// alone what was paused before, or paused later for failures or a budget cap. Each id is
/// recorded as soon as its pause succeeds, so a failure part-way still resumes what it paused.
pub fn pause_all(c: &dyn ShellCalls, prefs: &mut Prefs) -> Result<usize, CallError> {
    let list = c.call("schedules.list", json!({}))?;
    let mut n = 0;
    for sc in list.get("schedules").and_then(Value::as_array).map_or(&[][..], |v| v) {
        let Some(id) = sc.get("schedule_id").and_then(Value::as_str) else { continue };
        if sc.get("enabled").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        c.call("schedules.set_enabled", json!({"schedule_id": id, "enabled": false}))?;
        if !prefs.paused_by_pause_all.iter().any(|p| p == id) {
            prefs.paused_by_pause_all.push(id.into());
        }
        n += 1;
    }
    Ok(n)
}

/// *Resume Monitors*: turn back on only what *Pause All* paused and is still paused by hand.
pub fn resume_all(c: &dyn ShellCalls, prefs: &mut Prefs) -> Result<usize, CallError> {
    let list = c.call("schedules.list", json!({}))?;
    let mut n = 0;
    for sc in list.get("schedules").and_then(Value::as_array).map_or(&[][..], |v| v) {
        let Some(id) = sc.get("schedule_id").and_then(Value::as_str) else { continue };
        if paused_by_user(sc) && prefs.paused_by_pause_all.iter().any(|p| p == id) {
            c.call("schedules.set_enabled", json!({"schedule_id": id, "enabled": true}))?;
            n += 1;
        }
    }
    prefs.paused_by_pause_all.clear();
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn thread(id: &str, title: Option<&str>, run: Option<(&str, &str)>, pending: bool) -> Value {
        json!({"thread_id": id, "title": title, "input_pending": pending,
               "active_run": run.map(|(r, s)| json!({"run_id": r, "state": s}))})
    }

    #[test]
    fn pending_is_matched_to_threads_and_running_excludes_waiting() {
        let threads = json!({"threads": [
            thread("t1", Some("Deploy site"), Some(("r1", "waiting_input")), true),
            thread("t2", Some("  "), Some(("r2", "running")), false),
            thread("t3", Some("Idle"), None, false),
            thread("t4", Some("Weekly report"), Some(("r4", "waiting_input")), true),
        ], "has_more": false});
        let pending = json!({"requests": [
            {"run_id": "r1", "state": "pending", "prompt": {"type": "approval", "tool": "Bash", "class": "destructive"}},
            {"run_id": "r4", "state": "pending", "prompt": {"type": "question", "questions": []}},
            {"run_id": "gone", "state": "pending", "prompt": {"type": "ambiguous_tool_call", "tool": "Write"}},
            {"run_id": "r1", "state": "answered", "prompt": {"type": "approval", "tool": "Bash"}},
        ]});
        let schedules = json!({"schedules": [
            {"schedule_id": "s1", "enabled": true, "paused_reason": null},
            {"schedule_id": "s2", "enabled": false, "paused_reason": "user"},
            {"schedule_id": "s3", "enabled": false, "paused_reason": "failures"},
        ]});
        let s = from_values(&threads, &pending, &schedules, &["s2".into(), "s3".into()]);
        assert_eq!(s.pending.len(), 3);
        assert_eq!(s.pending[0], Pending { thread_id: Some("t1".into()), title: "Deploy site".into(), kind: PendingKind::Approval { tool: "Bash".into() } });
        assert_eq!(s.pending[1].kind, PendingKind::Question);
        assert_eq!(s.pending[2], Pending { thread_id: None, title: "Homerun".into(), kind: PendingKind::Ambiguous { tool: "Write".into() } });
        assert_eq!((s.approvals(), s.questions()), (2, 1));
        assert_eq!(s.running, vec![Running { thread_id: "t2".into(), title: "Untitled chat".into() }]);
        assert_eq!(s.active_runs, 3);
        assert_eq!((s.monitors_on, s.paused_by_shell), (1, 1), "s3 paused for failures isn't ours to resume");
        assert_eq!(from_values(&Value::Null, &Value::Null, &Value::Null, &[]), Summary::default());
    }

    struct Fake {
        schedules: RefCell<Vec<(String, bool, Option<String>)>>,
        calls: RefCell<Vec<String>>,
        fail_on: Option<String>,
    }
    impl ShellCalls for Fake {
        fn call(&self, method: &str, p: Value) -> Result<Value, CallError> {
            match method {
                "schedules.list" => Ok(json!({"schedules": self.schedules.borrow().iter()
                    .map(|(id, en, r)| json!({"schedule_id": id, "enabled": en, "paused_reason": r})).collect::<Vec<_>>()})),
                "schedules.set_enabled" => {
                    let id = p["schedule_id"].as_str().unwrap().to_string();
                    if self.fail_on.as_deref() == Some(id.as_str()) {
                        return Err(CallError::Closed);
                    }
                    let en = p["enabled"].as_bool().unwrap();
                    self.calls.borrow_mut().push(format!("{id}={en}"));
                    for s in self.schedules.borrow_mut().iter_mut().filter(|s| s.0 == id) {
                        s.1 = en;
                        s.2 = if en { None } else { Some("user".into()) };
                    }
                    Ok(json!({}))
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn resume_restores_only_what_pause_all_paused() {
        let f = Fake {
            schedules: RefCell::new(vec![
                ("a".into(), true, None),
                ("b".into(), true, None),
                ("byhand".into(), false, Some("user".into())),
                ("budget".into(), false, Some("budget_cap".into())),
            ]),
            calls: RefCell::default(),
            fail_on: None,
        };
        let mut prefs = Prefs::default();
        assert_eq!(pause_all(&f, &mut prefs).unwrap(), 2);
        assert_eq!(prefs.paused_by_pause_all, vec!["a", "b"]);
        // Meanwhile "b" is paused for failures by the runtime: it stays paused on resume.
        f.schedules.borrow_mut()[1].2 = Some("failures".into());
        assert_eq!(resume_all(&f, &mut prefs).unwrap(), 1);
        assert_eq!(*f.calls.borrow(), vec!["a=false", "b=false", "a=true"]);
        assert!(prefs.paused_by_pause_all.is_empty());
        let s = f.schedules.borrow();
        assert!(s[0].1 && !s[1].1 && !s[2].1 && !s[3].1);
    }

    #[test]
    fn a_failure_part_way_still_remembers_what_was_paused() {
        let f =
            Fake { schedules: RefCell::new(vec![("a".into(), true, None), ("b".into(), true, None)]), calls: RefCell::default(), fail_on: Some("b".into()) };
        let mut prefs = Prefs::default();
        assert!(pause_all(&f, &mut prefs).is_err());
        assert_eq!(prefs.paused_by_pause_all, vec!["a"]);
    }
}
