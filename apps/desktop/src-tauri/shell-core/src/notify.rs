//! Local notifications on the shell's side (§8.2, §9.7). The runtime composes rows 1–8 of the
//! matrix (`notification.requested`); the shell adds the ones about the runtime itself (a crash
//! loop, a blocked start), posts each key at most once, and routes a click to its screen.

use crate::status::RuntimeStatus;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

/// `packages/core`'s `LOCAL_NOTIFICATION_*_MAX`.
pub const TITLE_MAX: usize = 80;
pub const BODY_MAX: usize = 160;

/// Where a click goes: a thread, or the Health screen. `None` just opens the window.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "screen", rename_all = "snake_case")]
pub enum Target {
    Thread { thread_id: String },
    Health,
    Home,
}

/// Whether macOS lets Homerun post, as Settings shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    NotDetermined,
    Denied,
    Allowed,
    /// Not a bundle (`tauri dev`), or not macOS.
    Unavailable,
}

impl Permission {
    /// `UNAuthorizationStatus`: 0 notDetermined, 1 denied, 2 authorized, 3 provisional,
    /// 4 ephemeral.
    pub fn from_raw(raw: isize) -> Permission {
        match raw {
            0 => Permission::NotDetermined,
            1 => Permission::Denied,
            2..=4 => Permission::Allowed,
            _ => Permission::Unavailable,
        }
    }
}

const HEALTH_THREAD: &str = "homerun.health";
const HOME_THREAD: &str = "homerun.shell";

impl Target {
    /// The notification's `threadIdentifier`: it groups notifications in Notification Center and
    /// carries the click's target, so nothing needs remembering between a post and its click.
    pub fn thread_identifier(&self) -> String {
        match self {
            Target::Thread { thread_id } => thread_id.clone(),
            Target::Health => HEALTH_THREAD.into(),
            Target::Home => HOME_THREAD.into(),
        }
    }

    /// Back from a clicked notification. Anything unexpected just opens the window.
    pub fn from_thread_identifier(s: &str) -> Target {
        match s {
            HEALTH_THREAD => Target::Health,
            t if id_ok(t) => Target::Thread { thread_id: t.into() },
            _ => Target::Home,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Post {
    /// The notification's identifier: a newer post with the same key replaces the older one.
    pub key: String,
    /// Groups notifications by thread in Notification Center.
    pub group: Option<String>,
    pub title: String,
    pub body: String,
    pub target: Target,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Op {
    Post(Post),
    Withdraw(String),
}

fn key_ok(k: &str) -> bool {
    let Some((a, b)) = k.split_once(':') else { return false };
    !a.is_empty()
        && a.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
        && (1..=120).contains(&b.len())
        && b.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || matches!(c, b'_' | b':' | b'-'))
}

fn id_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// The runtime already cleans the text; the shell clips and strips again rather than trust it.
pub fn clean(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max - 1).collect();
    out = out.trim_end().to_string();
    out.push('…');
    out
}

/// A `notification.requested` from the runtime, or None if it doesn't hold up.
pub fn from_runtime(params: &Value) -> Option<Post> {
    let key = params.get("key")?.as_str().filter(|k| key_ok(k))?.to_string();
    let title = clean(params.get("title")?.as_str()?, TITLE_MAX);
    let body = clean(params.get("body").and_then(Value::as_str).unwrap_or(""), BODY_MAX);
    if title.is_empty() {
        return None;
    }
    let target = match params.pointer("/target/screen").and_then(Value::as_str)? {
        "thread" => Target::Thread { thread_id: params.pointer("/target/thread_id")?.as_str().filter(|t| id_ok(t))?.to_string() },
        "health" => Target::Health,
        _ => return None,
    };
    let group = params.get("thread_id").and_then(Value::as_str).filter(|t| id_ok(t)).map(str::to_string);
    Some(Post { key, group, title, body, target })
}

pub const CRASH_LOOP_KEY: &str = "shell:crash_loop";
pub const BLOCKED_KEY: &str = "shell:blocked";

/// Everything posted this launch, so a key goes out once even when a restarted runtime replays
/// what is still pending.
#[derive(Debug, Default)]
pub struct Notices {
    shown: HashSet<String>,
}

impl Notices {
    pub fn runtime(&mut self, method: &str, params: &Value) -> Vec<Op> {
        match method {
            "notification.requested" => match from_runtime(params) {
                Some(p) if self.shown.insert(p.key.clone()) => vec![Op::Post(p)],
                _ => vec![],
            },
            "notification.withdrawn" => match params.get("key").and_then(Value::as_str) {
                Some(k) if self.shown.contains(k) => vec![Op::Withdraw(k.into())],
                _ => vec![],
            },
            _ => vec![],
        }
    }

    /// Rows 9 and 10: once per episode, withdrawn when the runtime is back.
    pub fn status(&mut self, s: &RuntimeStatus) -> Vec<Op> {
        let mut ops = vec![];
        let mut post = |shown: &mut HashSet<String>, key: &str, title: &str, body: &str| {
            if shown.insert(key.into()) {
                ops.push(Op::Post(Post { key: key.into(), group: None, title: title.into(), body: clean(body, BODY_MAX), target: Target::Home }));
            }
        };
        match s {
            RuntimeStatus::CrashLoop { .. } => {
                post(&mut self.shown, CRASH_LOOP_KEY, "Homerun's runtime keeps stopping", "Monitors aren't running. Homerun retries every 10 minutes.")
            }
            RuntimeStatus::Blocked { message, .. } => post(&mut self.shown, BLOCKED_KEY, "Homerun can't start its runtime", message),
            RuntimeStatus::Ready { .. } => {
                for k in [CRASH_LOOP_KEY, BLOCKED_KEY] {
                    if self.shown.remove(k) {
                        ops.push(Op::Withdraw(k.into()));
                    }
                }
            }
            _ => {}
        }
        ops
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::BlockedReason;
    use serde_json::json;

    const T: &str = "0192f5e4-7c1a-7b3e-9d2a-3f4e5d6c7b8a";

    fn req(key: &str) -> Value {
        json!({"key": key, "kind": "approval", "target": {"screen": "thread", "thread_id": T}, "thread_id": T,
               "title": "Deploy\u{7} site", "body": "Approval needed: Bash (destructive)", "created_at": 1})
    }

    #[test]
    fn validates_and_cleans_what_the_runtime_sends() {
        let p = from_runtime(&req("input:abc")).unwrap();
        assert_eq!(
            p,
            Post {
                key: "input:abc".into(),
                group: Some(T.into()),
                title: "Deploy site".into(),
                body: "Approval needed: Bash (destructive)".into(),
                target: Target::Thread { thread_id: T.into() }
            }
        );
        for k in ["", "input", "Input:x", "input:", "input:A", "input:a b", "../x:y", &format!("a:{}", "x".repeat(121))] {
            assert!(from_runtime(&req(k)).is_none(), "{k:?}");
        }
        let mut long = req("k:1");
        long["title"] = json!("x".repeat(200));
        long["body"] = json!("y\n".repeat(200));
        let p = from_runtime(&long).unwrap();
        assert_eq!(p.title.chars().count(), TITLE_MAX);
        assert!(p.title.ends_with('…') && p.body.chars().count() <= BODY_MAX && !p.body.contains('\n'));
        let mut bad = req("k:1");
        bad["target"] = json!({"screen": "thread", "thread_id": "../../etc"});
        assert!(from_runtime(&bad).is_none());
        bad["target"] = json!({"screen": "settings"});
        assert!(from_runtime(&bad).is_none());
        bad["target"] = json!({"screen": "health"});
        assert_eq!(from_runtime(&bad).unwrap().target, Target::Health);
    }

    #[test]
    fn once_per_key_and_withdraw_only_what_was_shown() {
        let mut n = Notices::default();
        assert_eq!(n.runtime("notification.requested", &req("input:a")).len(), 1);
        assert!(n.runtime("notification.requested", &req("input:a")).is_empty(), "a restarted runtime replays it");
        assert!(n.runtime("notification.withdrawn", &json!({"key": "input:zz"})).is_empty());
        assert_eq!(n.runtime("notification.withdrawn", &json!({"key": "input:a"})), vec![Op::Withdraw("input:a".into())]);
        assert!(n.runtime("threads.changed", &json!({})).is_empty());
    }

    #[test]
    fn crash_loop_once_per_episode() {
        let mut n = Notices::default();
        let cl = RuntimeStatus::CrashLoop { retry_at: None, last_error: None };
        let ready = RuntimeStatus::Ready { connection: 1, device_id: "d".into(), runtime_version: "v".into(), protocol: 1 };
        assert_eq!(n.status(&cl).len(), 1);
        assert!(n.status(&RuntimeStatus::Restarting { retry_at: None, last_error: None }).is_empty());
        assert!(n.status(&cl).is_empty(), "same episode");
        assert_eq!(n.status(&ready), vec![Op::Withdraw(CRASH_LOOP_KEY.into())]);
        assert!(n.status(&ready).is_empty());
        assert_eq!(n.status(&cl).len(), 1, "a new episode");
        let b = RuntimeStatus::Blocked { reason: BlockedReason::DatabaseTooNew, message: "The database is newer.".into() };
        match &n.status(&b)[..] {
            [Op::Post(p)] => assert_eq!((p.key.as_str(), p.body.as_str(), &p.target), (BLOCKED_KEY, "The database is newer.", &Target::Home)),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn permission_from_the_system() {
        assert_eq!(
            [0, 1, 2, 3, 4, 9].map(Permission::from_raw),
            [Permission::NotDetermined, Permission::Denied, Permission::Allowed, Permission::Allowed, Permission::Allowed, Permission::Unavailable]
        );
        assert_eq!(serde_json::to_value(Permission::NotDetermined).unwrap(), "not_determined");
    }

    #[test]
    fn a_click_finds_its_way_back() {
        for t in [Target::Thread { thread_id: "th_01H-x".into() }, Target::Health, Target::Home] {
            assert_eq!(Target::from_thread_identifier(&t.thread_identifier()), t);
        }
        for junk in ["", "../x", "a b", "homerun.shell", &"x".repeat(65)] {
            assert_eq!(Target::from_thread_identifier(junk), Target::Home, "{junk}");
        }
    }
}
