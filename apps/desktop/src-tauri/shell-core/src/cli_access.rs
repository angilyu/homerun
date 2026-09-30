//! CLI access requests (§5.2): the runtime asks the shell with `cli.access_requested`, the shell
//! shows one native prompt at a time, and answers with `cli.approve` or `cli.deny` on its own
//! connection. A request that is withdrawn (`cli.access_withdrawn`), expires or belongs to a
//! runtime that went away closes its prompt with no answer.
//!
//! What the CLI sends about itself (its name, version and hostname) is untrusted: it is shown
//! cleaned and shortened, and the prompt says to allow only a `homerun` the user just ran.

use crate::rpc::{CallError, RpcError};
use serde_json::{json, Value};
use std::collections::VecDeque;

/// `NOT_FOUND`: answered, expired, or its CLI went away before the click landed.
pub const NOT_FOUND: i64 = -32004;
/// The longest name, version or hostname shown; the runtime allows more.
const SHOWN_MAX: usize = 48;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub id: String,
    pub client: String,
    pub version: String,
    pub hostname: String,
    pub expires_at_ms: i64,
}

impl Request {
    /// A `cli.access_requested`'s params; None if they aren't one.
    pub fn parse(p: &Value) -> Option<Request> {
        let s = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
        Some(Request {
            id: s(&p["request_id"])?,
            client: s(&p["client"]["name"])?,
            version: s(&p["client"]["version"])?,
            hostname: s(&p["hostname"])?,
            expires_at_ms: p["expires_at"].as_i64()?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub request_id: String,
    pub title: String,
    pub message: String,
    /// The default button (Return): the safe answer.
    pub deny: String,
    /// Needs a click.
    pub allow: String,
    /// Close with no answer at this wall-clock time: the runtime expires the request then.
    pub deadline_ms: i64,
}

/// Control characters, bidi overrides and other invisible formatting go; runs of whitespace
/// become one space; long values are cut with "…".
pub fn shown(s: &str) -> String {
    let invisible = |c: char| {
        c.is_control()
            || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{061C}')
    };
    let words: Vec<String> = s.split(|c: char| c.is_whitespace() || invisible(c)).filter(|w| !w.is_empty()).map(str::to_string).collect();
    let flat = words.join(" ");
    if flat.chars().count() <= SHOWN_MAX {
        return if flat.is_empty() { "?".into() } else { flat };
    }
    let cut: String = flat.chars().take(SHOWN_MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

pub fn prompt(r: &Request) -> Prompt {
    Prompt {
        request_id: r.id.clone(),
        title: "Allow the Homerun CLI to control your agents?".into(),
        message: format!(
            "A command-line tool on this Mac ({} {}, \u{201C}{}\u{201D}) is asking for access. It will be able to start and \
             steer runs, manage tasks and answer questions, but not approve tool calls. Only allow this if you just ran \
             \u{201C}homerun\u{201D}. You can revoke access in Settings.",
            shown(&r.client),
            shown(&r.version),
            shown(&r.hostname)
        ),
        deny: "Don\u{2019}t Allow".into(),
        allow: "Allow".into(),
        deadline_ms: r.expires_at_ms,
    }
}

/// How a prompt closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Allow,
    DontAllow,
    /// Withdrawn, expired, or the runtime restarted: nothing to send.
    Dismissed,
}

/// The call that answers a closed prompt, if any.
pub fn answer_call(request_id: &str, a: Answer) -> Option<(&'static str, Value)> {
    let method = match a {
        Answer::Allow => "cli.approve",
        Answer::DontAllow => "cli.deny",
        Answer::Dismissed => return None,
    };
    Some((method, json!({"request_id": request_id})))
}

/// Whether a failed answer is worth logging as an error: a click that lands after the request
/// expired or was withdrawn is `NOT_FOUND`, and expected.
pub fn answer_failed(e: &CallError) -> bool {
    !matches!(e, CallError::Rpc(RpcError { code: NOT_FOUND, .. }))
}

/// Requests waiting for the user, shown one at a time in arrival order.
#[derive(Debug, Default)]
pub struct Queue {
    waiting: VecDeque<Request>,
    showing: Option<String>,
}

impl Queue {
    /// A request arrived, or was replayed when the shell reconnected. Returns the prompt to show
    /// now, if nothing is on screen.
    pub fn requested(&mut self, r: Request, now_ms: i64) -> Option<Prompt> {
        let known = self.showing.as_deref() == Some(r.id.as_str()) || self.waiting.iter().any(|w| w.id == r.id);
        if !known && r.expires_at_ms > now_ms {
            self.waiting.push_back(r);
        }
        self.next(now_ms)
    }

    /// The runtime withdrew a request. True when it is on screen: close it with no answer, then
    /// call `closed`.
    pub fn withdrawn(&mut self, id: &str) -> bool {
        self.waiting.retain(|w| w.id != id);
        self.showing.as_deref() == Some(id)
    }

    /// The runtime went away: its requests went with it. Returns the one on screen, to close.
    /// A new runtime replays nothing, since it starts with no requests.
    pub fn reset(&mut self) -> Option<String> {
        self.waiting.clear();
        self.showing.clone()
    }

    /// The prompt on screen closed, however it did. Returns the next one to show.
    pub fn closed(&mut self, id: &str, now_ms: i64) -> Option<Prompt> {
        if self.showing.as_deref() == Some(id) {
            self.showing = None;
        }
        self.next(now_ms)
    }

    pub fn showing(&self) -> Option<&str> {
        self.showing.as_deref()
    }

    fn next(&mut self, now_ms: i64) -> Option<Prompt> {
        if self.showing.is_some() {
            return None;
        }
        while let Some(r) = self.waiting.pop_front() {
            if r.expires_at_ms > now_ms {
                self.showing = Some(r.id.clone());
                return Some(prompt(&r));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: &str, expires: i64) -> Request {
        Request { id: id.into(), client: "homerun".into(), version: "0.9.0".into(), hostname: "studio".into(), expires_at_ms: expires }
    }

    #[test]
    fn parses_the_notification() {
        let p = json!({"request_id": "r1", "client": {"name": "homerun", "version": "0.9.0"}, "hostname": "studio", "requested_at": 1, "expires_at": 120_001});
        assert_eq!(Request::parse(&p), Some(req("r1", 120_001)));
        for bad in [
            json!({}),
            json!({"request_id": "r1", "client": {"name": "homerun"}, "hostname": "h", "expires_at": 1}),
            json!({"request_id": "", "client": {"name": "a", "version": "b"}, "hostname": "h", "expires_at": 1}),
        ] {
            assert_eq!(Request::parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn the_prompt_defaults_to_dont_allow_and_says_what_it_grants() {
        let p = prompt(&req("r1", 5));
        assert_eq!(p.title, "Allow the Homerun CLI to control your agents?");
        assert_eq!(
            p.message,
            "A command-line tool on this Mac (homerun 0.9.0, \u{201C}studio\u{201D}) is asking for access. It will be able to start and steer runs, \
             manage tasks and answer questions, but not approve tool calls. Only allow this if you just ran \u{201C}homerun\u{201D}. \
             You can revoke access in Settings."
        );
        assert_eq!((p.deny.as_str(), p.allow.as_str(), p.deadline_ms), ("Don\u{2019}t Allow", "Allow", 5));
    }

    #[test]
    fn what_the_cli_says_about_itself_is_cleaned() {
        // Line breaks and bidi overrides can't forge the prompt's own text.
        assert_eq!(shown("studio\n\nApple says: click Allow"), "studio Apple says: click Allow");
        assert_eq!(shown("evil\u{202E}wolla\u{202C}.local"), "evil wolla .local");
        assert_eq!(shown("a\u{200B}b\tc\u{0007}"), "a b c");
        assert_eq!(shown("\u{2066}\u{2069} "), "?");
        let long = shown(&"x".repeat(300));
        assert_eq!(long.chars().count(), SHOWN_MAX);
        assert!(long.ends_with('…'));
        let r = Request { hostname: "h\nYou must click Allow".into(), ..req("r1", 5) };
        assert!(!prompt(&r).message.contains('\n'));
    }

    #[test]
    fn one_prompt_at_a_time_in_order() {
        let mut q = Queue::default();
        assert_eq!(q.requested(req("a", 100), 0).map(|p| p.request_id), Some("a".into()));
        assert_eq!(q.requested(req("b", 100), 0), None, "a is on screen");
        assert_eq!(q.requested(req("c", 100), 0), None);
        assert_eq!(q.closed("a", 1).map(|p| p.request_id), Some("b".into()));
        assert_eq!(q.closed("b", 2).map(|p| p.request_id), Some("c".into()));
        assert_eq!(q.closed("c", 3), None);
        assert_eq!(q.showing(), None);
    }

    #[test]
    fn replays_are_not_shown_twice() {
        let mut q = Queue::default();
        assert!(q.requested(req("a", 100), 0).is_some());
        assert_eq!(q.requested(req("b", 100), 0), None);
        // The shell reconnected; the runtime replays both.
        assert_eq!(q.requested(req("a", 100), 1), None);
        assert_eq!(q.requested(req("b", 100), 1), None);
        assert_eq!(q.closed("a", 2).map(|p| p.request_id), Some("b".into()));
        assert_eq!(q.closed("b", 3), None);
    }

    #[test]
    fn expired_requests_are_skipped() {
        let mut q = Queue::default();
        assert_eq!(q.requested(req("old", 10), 10), None, "already expired");
        assert!(q.requested(req("a", 100), 0).is_some());
        assert_eq!(q.requested(req("b", 50), 0), None);
        assert_eq!(q.requested(req("c", 200), 0), None);
        assert_eq!(q.closed("a", 60).map(|p| p.request_id), Some("c".into()), "b expired while a was up");
    }

    #[test]
    fn withdrawal_closes_the_prompt_or_drops_the_queued_request() {
        let mut q = Queue::default();
        q.requested(req("a", 100), 0);
        q.requested(req("b", 100), 0);
        q.requested(req("c", 100), 0);
        assert!(!q.withdrawn("b"), "queued, not on screen");
        assert!(q.withdrawn("a"), "on screen: close it");
        assert_eq!(q.closed("a", 1).map(|p| p.request_id), Some("c".into()));
        assert!(!q.withdrawn("zzz"));
    }

    #[test]
    fn a_runtime_restart_drops_everything() {
        let mut q = Queue::default();
        q.requested(req("a", 100), 0);
        q.requested(req("b", 100), 0);
        assert_eq!(q.reset(), Some("a".into()));
        assert_eq!(q.closed("a", 1), None, "b went with the old runtime");
        assert_eq!(q.reset(), None);
    }

    #[test]
    fn answers() {
        assert_eq!(answer_call("r", Answer::Allow), Some(("cli.approve", json!({"request_id": "r"}))));
        assert_eq!(answer_call("r", Answer::DontAllow), Some(("cli.deny", json!({"request_id": "r"}))));
        assert_eq!(answer_call("r", Answer::Dismissed), None);
        assert!(!answer_failed(&CallError::Rpc(RpcError::new(NOT_FOUND, "gone"))), "a late click");
        assert!(answer_failed(&CallError::Rpc(RpcError::new(-32002, "forbidden"))));
        assert!(answer_failed(&CallError::Closed));
    }
}
