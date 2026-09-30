//! What the webview may call (§5.2): the `webview` list in core's generated `callers.json`,
//! compiled in so it can't drift from the runtime's own table. The runtime enforces the same
//! list on the webview-role connection, so a method needs both checks to pass.

use crate::rpc::{codes, CallError, Connection, RpcError};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

const CALLERS_JSON: &str = include_str!("../../../../../packages/core/schema/callers.json");

pub struct Callers {
    webview: HashSet<String>,
    #[cfg_attr(not(test), allow(dead_code))] // the tests check webview ⊆ shell
    shell: HashSet<String>,
    preauth: HashSet<String>,
    shell_only: HashSet<String>,
}

fn names(v: &Value) -> HashSet<String> {
    v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
}

pub fn callers() -> &'static Callers {
    static C: OnceLock<Callers> = OnceLock::new();
    C.get_or_init(|| {
        let v: Value = serde_json::from_str(CALLERS_JSON).expect("callers.json");
        Callers {
            webview: names(&v["allowlists"]["webview"]),
            shell: names(&v["allowlists"]["shell"]),
            preauth: names(&v["preauth"]),
            shell_only: names(&v["shell_only"]),
        }
    })
}

/// A method the webview may have forwarded. `hello` is the shell's: it authenticates the
/// connection with the launch token, which the webview never sees.
pub fn webview_allows(method: &str) -> bool {
    let c = callers();
    method != "hello" && c.webview.contains(method) && !c.preauth.contains(method) && !c.shell_only.contains(method)
}

/// An error as the webview receives it. `not_connected`: the runtime isn't reachable now
/// (starting, restarting, stopped); the state layer queues and retries.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ShellError {
    pub kind: &'static str,
    pub code: Option<i64>,
    pub message: String,
    pub data: Option<Value>,
}

impl ShellError {
    pub fn rpc(code: i64, message: impl Into<String>) -> Self {
        ShellError { kind: "rpc", code: Some(code), message: message.into(), data: None }
    }
    pub fn not_connected(message: impl Into<String>) -> Self {
        ShellError { kind: "not_connected", code: None, message: message.into(), data: None }
    }
    pub fn shell(message: impl Into<String>) -> Self {
        ShellError { kind: "shell", code: None, message: message.into(), data: None }
    }
}

impl From<CallError> for ShellError {
    fn from(e: CallError) -> Self {
        match e {
            CallError::Rpc(RpcError { code, message, data }) => ShellError { kind: "rpc", code: Some(code), message, data },
            CallError::Closed | CallError::Io(_) => ShellError::not_connected("Homerun's runtime isn't running right now."),
            CallError::Timeout => ShellError::not_connected("Homerun's runtime didn't answer in time."),
        }
    }
}

/// How long a forwarded call may take. Every webview method answers promptly; long work
/// happens in runs and streams back as events.
pub const FORWARD_TIMEOUT: Duration = Duration::from_secs(60);

/// Forward one webview call on the webview-role connection (§5.2).
pub fn forward(conn: Option<&Connection>, method: &str, params: Value) -> Result<Value, ShellError> {
    if !webview_allows(method) {
        return Err(ShellError::rpc(codes::FORBIDDEN, format!("The app may not call {method}.")));
    }
    if !params.is_object() {
        return Err(ShellError::rpc(codes::INVALID_PARAMS, "Params must be an object."));
    }
    let Some(conn) = conn.filter(|c| !c.is_closed()) else {
        return Err(ShellError::not_connected("Homerun's runtime isn't running right now."));
    };
    conn.call(method, params, FORWARD_TIMEOUT).map_err(ShellError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::tests::{me, serve, sock, Recorder};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    fn the_webview_list_is_the_core_one_minus_the_shells_methods() {
        for m in [
            "threads.subscribe",
            "messages.send",
            "input.answer",
            "grants.revoke",
            "tasks.update",
            "schedules.coverage",
            "health.digest",
            "ping",
            "account.sign_in",
            "devices.list",
            "devices.pairing.start",
            "devices.unpair",
        ] {
            assert!(webview_allows(m), "{m}");
        }
        for m in [
            "hello",
            "cli.request_access",
            "secrets.set",
            "secrets.clear",
            "secrets.verify",
            "secrets.persist",
            "cli.approve",
            "cli.deny",
            "power.did_wake",
            "secrets.delete",
            "devices.link.decide",
            "nope",
        ] {
            assert!(!webview_allows(m), "{m}");
        }
        let c = callers();
        assert!(c.webview.is_subset(&c.shell), "the shell may call whatever it forwards");
        assert!(c.webview.len() > 30);
    }

    #[test]
    fn forward_checks_before_it_sends() {
        assert_eq!(forward(None, "secrets.set", json!({})).unwrap_err().code, Some(codes::FORBIDDEN));
        assert_eq!(forward(None, "threads.list", json!([1])).unwrap_err().code, Some(codes::INVALID_PARAMS));
        assert_eq!(forward(None, "threads.list", json!({})).unwrap_err().kind, "not_connected");

        let p = sock("fwd");
        serve(&p, |v, w| {
            use std::io::Write;
            let r = if v["method"] == "threads.list" {
                json!({"jsonrpc": "2.0", "id": v["id"], "result": {"threads": [], "has_more": false}})
            } else {
                json!({"jsonrpc": "2.0", "id": v["id"], "error": {"code": -32005, "message": "Changed elsewhere", "data": {"current_version": 3}}})
            };
            writeln!(w, "{r}").unwrap();
        });
        let c = Connection::connect(&p, me(), Arc::new(Recorder(Mutex::new(vec![])))).unwrap();
        assert_eq!(forward(Some(&c), "threads.list", json!({})).unwrap(), json!({"threads": [], "has_more": false}));
        let e = forward(Some(&c), "tasks.update", json!({})).unwrap_err();
        assert_eq!(e, ShellError { kind: "rpc", code: Some(-32005), message: "Changed elsewhere".into(), data: Some(json!({"current_version": 3})) });
    }
}
