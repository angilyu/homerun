//! The updater's decisions (§11, §14): when to check, whether an offered version may install
//! itself, and when a downloaded update installs. The Tauri crate does the network, signature and
//! bundle work with `tauri-plugin-updater`.

use crate::quit::Why;
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;

/// Committed in `tauri.conf.json` until the release key exists. A build carrying it never checks
/// for updates: fail closed rather than trust a key nobody holds (§14).
pub const PLACEHOLDER_PUBKEY: &str = "HOMERUN_UPDATER_PUBKEY_NOT_SET";

pub fn pubkey_configured(pubkey: &str) -> bool {
    let k = pubkey.trim();
    !k.is_empty() && k != PLACEHOLDER_PUBKEY
}

pub const FIRST_CHECK_MS: u64 = 60_000;
pub const CHECK_EVERY_MS: u64 = 6 * 60 * 60 * 1000;

/// Wall-clock schedule: a check missed while the Mac slept is due as soon as it wakes.
#[derive(Clone, Debug)]
pub struct Schedule {
    launched_at: u64,
    last: Option<u64>,
}

impl Schedule {
    pub fn new(launched_at: u64) -> Self {
        Schedule { launched_at, last: None }
    }
    pub fn next(&self) -> u64 {
        match self.last {
            None => self.launched_at + FIRST_CHECK_MS,
            Some(t) => t + CHECK_EVERY_MS,
        }
    }
    pub fn due(&self, now: u64) -> bool {
        now >= self.next()
    }
    /// After any check, automatic or *Check for Updates…*.
    pub fn checked(&mut self, now: u64) {
        self.last = Some(now);
    }
}

/// `major.minor.patch[-pre]`; a pre-release sorts before its release.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    core: (u64, u64, u64),
    pre: Option<String>,
}

impl Version {
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.trim().trim_start_matches('v');
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') => (c, Some(p.to_string())),
            Some(_) => return None,
            None => (s, None),
        };
        let mut it = core.split('.').map(|p| if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && p.len() <= 9 { p.parse().ok() } else { None });
        let v = (it.next()??, it.next()??, it.next()??);
        if it.next().is_some() {
            return None;
        }
        Some(Version { core: v, pre })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Version {
    fn cmp(&self, o: &Self) -> Ordering {
        self.core.cmp(&o.core).then_with(|| match (&self.pre, &o.pre) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(a), Some(b)) => a.cmp(b),
        })
    }
}

/// Version strings from the manifest end up in file names: only plain versions are accepted.
pub fn safe_version(v: &str) -> bool {
    v.len() <= 40 && Version::parse(v).is_some() && !v.starts_with('v')
}

/// What an offered update may do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Gate {
    Install {
        note: Option<String>,
    },
    /// Not installed automatically; the user downloads it (§14, e.g. after a key rotation).
    Manual {
        reason: String,
    },
    /// Not newer, or unreadable: ignored. Never a downgrade.
    Ignore,
}

/// `raw` is the whole `latest.json`; our part is its `homerun` object (§11):
/// `{"min_update_from": "0.8.0", "protocol": {"min": 1, "max": 1}}`. Tauri ignores it.
pub fn gate(current: &str, current_protocol: u64, offered: &str, raw: &Value) -> Gate {
    let (Some(cur), Some(new)) = (Version::parse(current), Version::parse(offered)) else { return Gate::Ignore };
    if new <= cur || !safe_version(offered) {
        return Gate::Ignore;
    }
    let ext = match raw.get("homerun") {
        None | Some(Value::Null) => return Gate::Install { note: None },
        Some(e) => e,
    };
    let bad = || Gate::Manual { reason: format!("Homerun {offered} can't be installed from here. Download it from the website.") };
    let min_from = match ext.get("min_update_from") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => match Version::parse(s) {
            Some(v) => Some(v),
            None => return bad(),
        },
        Some(_) => return bad(),
    };
    let proto_min = match ext.pointer("/protocol/min") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_u64() {
            Some(n) => Some(n),
            None => return bad(),
        },
    };
    if min_from.is_some_and(|m| cur < m) {
        return Gate::Manual { reason: format!("Homerun {offered} needs a fresh download from the website.") };
    }
    // The shell and runtime ship and swap together, so a new protocol is fine for them; older
    // command-line tools get INCOMPATIBLE_PROTOCOL from `hello` (§14).
    let note = proto_min.filter(|m| *m > current_protocol).map(|_| format!("Command-line tools older than {offered} will need updating."));
    Gate::Install { note }
}

/// What Settings, the banner and the menu show.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateState {
    Idle,
    /// No update key in this build, a debug build, or not an Apple silicon Mac.
    Unavailable {
        message: String,
    },
    Checking,
    UpToDate {
        checked_at: u64,
    },
    Downloading {
        version: String,
    },
    /// Downloaded and verified; installs on quit or *Restart now*.
    Ready {
        version: String,
        note: Option<String>,
    },
    Manual {
        version: String,
        reason: String,
    },
    Failed {
        message: String,
        checked_at: u64,
    },
}

impl UpdateState {
    pub fn busy(&self) -> bool {
        matches!(self, UpdateState::Checking | UpdateState::Downloading { .. })
    }
}

/// Install on the user's quit and on *Restart now*; never at logout, restart or shutdown, where
/// the system must not wait on us. The payload stays staged for the next quit (§11).
pub fn install_on_exit(state: &UpdateState, why: Why) -> bool {
    matches!(state, UpdateState::Ready { .. }) && why != Why::PowerOff
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn schedule_first_after_a_minute_then_every_six_hours_and_on_wake() {
        let mut s = Schedule::new(1_000);
        assert!(!s.due(1_000 + FIRST_CHECK_MS - 1));
        assert!(s.due(1_000 + FIRST_CHECK_MS));
        s.checked(100_000);
        assert!(!s.due(100_000 + CHECK_EVERY_MS - 1));
        // Asleep for a day: due at once on wake.
        assert!(s.due(100_000 + 24 * CHECK_EVERY_MS));
        assert_eq!(s.next(), 100_000 + CHECK_EVERY_MS);
    }

    #[test]
    fn versions() {
        let v = |s| Version::parse(s).unwrap();
        assert!(v("0.8.1") > v("0.8.0") && v("0.10.0") > v("0.9.9") && v("1.0.0") > v("1.0.0-beta.2"));
        assert!(v("1.0.0-beta.2") > v("1.0.0-beta.1"));
        for bad in ["", "1.2", "1.2.3.4", "1.x.3", "1.2.3-", "1.2.3-a/b", "../1.2.3", "1.2.3-../x", "01234567890.1.1"] {
            assert!(Version::parse(bad).is_none(), "{bad}");
        }
        assert!(safe_version("0.8.1") && !safe_version("v0.8.1") && !safe_version("0.8.1/../../x"));
    }

    #[test]
    fn the_gate() {
        let none = json!({"version": "0.8.1"});
        assert_eq!(gate("0.8.0", 1, "0.8.1", &none), Gate::Install { note: None });
        assert_eq!(gate("0.8.1", 1, "0.8.1", &none), Gate::Ignore, "same version");
        assert_eq!(gate("0.9.0", 1, "0.8.1", &none), Gate::Ignore, "never a downgrade");
        assert_eq!(gate("0.8.0", 1, "garbage", &none), Gate::Ignore);
        let ext = |e: Value| json!({"version": "0.9.0", "homerun": e});
        assert_eq!(gate("0.8.0", 1, "0.9.0", &ext(json!({"min_update_from": "0.8.0", "protocol": {"min": 1, "max": 1}}))), Gate::Install { note: None });
        assert!(matches!(gate("0.7.9", 1, "0.9.0", &ext(json!({"min_update_from": "0.8.0"}))), Gate::Manual { .. }), "key rotation");
        assert_eq!(
            gate("0.8.0", 1, "0.9.0", &ext(json!({"protocol": {"min": 2, "max": 2}}))),
            Gate::Install { note: Some("Command-line tools older than 0.9.0 will need updating.".into()) }
        );
        // An extension we can't read fails closed: no automatic install.
        for bad in [json!({"min_update_from": 8}), json!({"min_update_from": "eight"}), json!({"protocol": {"min": "2"}})] {
            assert!(matches!(gate("0.8.0", 1, "0.9.0", &ext(bad.clone())), Gate::Manual { .. }), "{bad}");
        }
        // Unknown fields are for later versions.
        assert_eq!(gate("0.8.0", 1, "0.9.0", &ext(json!({"channel": "beta"}))), Gate::Install { note: None });
    }

    #[test]
    fn install_only_on_a_user_quit_or_restart() {
        let ready = UpdateState::Ready { version: "0.8.1".into(), note: None };
        assert!(install_on_exit(&ready, Why::User) && install_on_exit(&ready, Why::Update));
        assert!(!install_on_exit(&ready, Why::PowerOff));
        assert!(!install_on_exit(&UpdateState::Downloading { version: "0.8.1".into() }, Why::User));
    }

    #[test]
    fn placeholder_key_fails_closed() {
        assert!(!pubkey_configured(PLACEHOLDER_PUBKEY) && !pubkey_configured(" "));
        assert!(pubkey_configured("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="));
    }

    #[test]
    fn state_serializes_for_the_ui() {
        let s = UpdateState::Ready { version: "0.8.1".into(), note: None };
        assert_eq!(serde_json::to_value(s).unwrap(), json!({"state": "ready", "version": "0.8.1", "note": null}));
    }
}
