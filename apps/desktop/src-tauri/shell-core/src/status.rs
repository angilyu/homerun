use serde::Serialize;

/// Why the runtime can't run until the user acts (§5.1). No automatic restart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedReason {
    /// Exit 3: another `homerund` holds this data folder.
    OtherRuntime,
    /// The database was written by a newer runtime (§6.3).
    DatabaseTooNew,
    /// No protocol version in common (§14).
    Incompatible,
    /// A startup error that retrying won't fix, e.g. exit 64.
    Failed,
}

/// The runtime as the webview sees it; `@homerun/app-state`'s `RuntimeStatus` has the same shape.
/// `connection` grows with every new connection, so the UI knows its subscriptions are gone.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RuntimeStatus {
    Starting,
    Ready { connection: u64, device_id: String, runtime_version: String, protocol: u64 },
    Restarting { retry_at: Option<u64>, last_error: Option<String> },
    CrashLoop { retry_at: Option<u64>, last_error: Option<String> },
    Blocked { reason: BlockedReason, message: String },
    Stopping,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_like_app_state() {
        let s = RuntimeStatus::Ready { connection: 2, device_id: "d".into(), runtime_version: "0.2.0".into(), protocol: 1 };
        assert_eq!(serde_json::to_value(s).unwrap(), json!({"state": "ready", "connection": 2, "device_id": "d", "runtime_version": "0.2.0", "protocol": 1}));
        let s = RuntimeStatus::CrashLoop { retry_at: Some(5), last_error: None };
        assert_eq!(serde_json::to_value(s).unwrap(), json!({"state": "crash_loop", "retry_at": 5, "last_error": null}));
        let s = RuntimeStatus::Blocked { reason: BlockedReason::DatabaseTooNew, message: "m".into() };
        assert_eq!(serde_json::to_value(s).unwrap(), json!({"state": "blocked", "reason": "database_too_new", "message": "m"}));
        assert_eq!(serde_json::to_value(RuntimeStatus::Starting).unwrap(), json!({"state": "starting"}));
    }
}
