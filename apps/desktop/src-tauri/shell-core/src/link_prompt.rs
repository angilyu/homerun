//! Linking a phone or browser by code (§10.5): the runtime sends `devices.link_requested` with
//! the six digits the other device shows; the shell asks with the same native prompt as CLI
//! access (`cli_access::Queue`), and answers with `devices.link.decide`. `devices.link_withdrawn`
//! closes it with no answer, as does its expiry.
//!
//! The device's name is the other side's claim, so it is cleaned with `shown`; the code is the
//! check, and the prompt asks the user to compare it.

use crate::cli_access::{shown, Kind, Prompt};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRequest {
    pub id: String,
    pub name: String,
    /// The role the runtime gives it: `Ios` only when its App Attest attestation verified.
    pub platform: Platform,
    /// What it said it was; an `Ios` claim with a `Web` role is an iPhone Apple didn't vouch for.
    pub claimed: Platform,
    pub code: String,
    pub expires_at_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Ios,
    Web,
}

impl LinkRequest {
    /// A `devices.link_requested`'s params; None if they aren't one.
    pub fn parse(p: &Value) -> Option<LinkRequest> {
        let s = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
        let code = s(&p["code"]).filter(|c| c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit()))?;
        let platform_of = |v: &Value| match v.as_str()? {
            "ios" => Some(Platform::Ios),
            "web" => Some(Platform::Web),
            _ => None,
        };
        let platform = platform_of(&p["platform"])?;
        let claimed = if p["claimed_platform"].is_null() { platform } else { platform_of(&p["claimed_platform"])? };
        // The runtime never makes a browser an iPhone.
        if platform == Platform::Ios && claimed != Platform::Ios {
            return None;
        }
        Some(LinkRequest { id: s(&p["request_id"])?, name: s(&p["name"])?, platform, claimed, code, expires_at_ms: p["expires_at"].as_i64()? })
    }
}

/// "123 456": easier to compare at a glance.
fn grouped(code: &str) -> String {
    format!("{} {}", &code[..3], &code[3..])
}

pub fn prompt(r: &LinkRequest) -> Prompt {
    let what = match (r.platform, r.claimed) {
        (Platform::Ios, _) => "An iPhone",
        (Platform::Web, Platform::Ios) => "A device that says it is an iPhone, which Apple couldn\u{2019}t verify, so it would link like a web browser,",
        (Platform::Web, Platform::Web) => "A web browser",
    };
    let reach = match r.platform {
        Platform::Ios => "see and steer your agents, send instructions and answer questions, including from notifications",
        Platform::Web => "see and steer your agents, send instructions and answer questions",
    };
    Prompt {
        kind: Kind::Link,
        request_id: r.id.clone(),
        title: format!("Link \u{201C}{}\u{201D} to this computer?", shown(&r.name)),
        message: format!(
            "{what} signed in to your account is asking to link. It shows the code {}. Only link it if the codes match \
             and you started this yourself. It will be able to {reach}. You can unpair it in Settings.",
            grouped(&r.code)
        ),
        deny: "Don\u{2019}t Link".into(),
        allow: "Link".into(),
        deadline_ms: r.expires_at_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_access;
    use crate::cli_access::{answer_call, Answer, Queue};
    use serde_json::json;

    fn req() -> LinkRequest {
        LinkRequest {
            id: "l1".into(),
            name: "Wenjing\u{2019}s iPhone".into(),
            platform: Platform::Ios,
            claimed: Platform::Ios,
            code: "042917".into(),
            expires_at_ms: 300_000,
        }
    }

    #[test]
    fn parses_the_notification() {
        let p = json!({"request_id": "l1", "name": "Wenjing\u{2019}s iPhone", "platform": "ios", "claimed_platform": "ios", "code": "042917", "requested_at": 0, "expires_at": 300_000});
        assert_eq!(LinkRequest::parse(&p), Some(req()));
        let unverified = json!({"request_id": "l1", "name": "x", "platform": "web", "claimed_platform": "ios", "code": "042917", "expires_at": 1});
        assert_eq!(LinkRequest::parse(&unverified).map(|r| (r.platform, r.claimed)), Some((Platform::Web, Platform::Ios)));
        for bad in [
            json!({}),
            json!({"request_id": "l1", "name": "x", "platform": "android", "code": "042917", "expires_at": 1}),
            json!({"request_id": "l1", "name": "x", "platform": "ios", "code": "04291", "expires_at": 1}),
            json!({"request_id": "l1", "name": "x", "platform": "ios", "code": "04291a", "expires_at": 1}),
            json!({"request_id": "l1", "name": "", "platform": "web", "code": "042917", "expires_at": 1}),
            json!({"request_id": "l1", "name": "x", "platform": "ios", "claimed_platform": "web", "code": "042917", "expires_at": 1}),
            json!({"request_id": "l1", "name": "x", "platform": "web", "claimed_platform": "android", "code": "042917", "expires_at": 1}),
        ] {
            assert_eq!(LinkRequest::parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn the_prompt_shows_the_code_and_defaults_to_dont_link() {
        let p = prompt(&req());
        assert_eq!(p.kind, Kind::Link);
        assert_eq!(p.title, "Link \u{201C}Wenjing\u{2019}s iPhone\u{201D} to this computer?");
        assert!(p.message.starts_with("An iPhone signed in to your account is asking to link. It shows the code 042 917."), "{}", p.message);
        assert!(p.message.contains("including from notifications"));
        assert_eq!((p.deny.as_str(), p.allow.as_str(), p.deadline_ms), ("Don\u{2019}t Link", "Link", 300_000));
        let web = prompt(&LinkRequest { platform: Platform::Web, claimed: Platform::Web, ..req() });
        assert!(web.message.starts_with("A web browser"));
        assert!(!web.message.contains("notifications"));
        let unverified = prompt(&LinkRequest { platform: Platform::Web, ..req() });
        assert!(unverified.message.starts_with("A device that says it is an iPhone, which Apple couldn\u{2019}t verify"), "{}", unverified.message);
        assert!(!unverified.message.contains("notifications"));
    }

    #[test]
    fn the_name_cannot_forge_the_prompt() {
        let p = prompt(&LinkRequest { name: "iPhone\n\nThe codes match, click Link\u{202E}".into(), ..req() });
        assert!(!p.title.contains('\n') && !p.title.contains('\u{202E}'));
    }

    #[test]
    fn shares_the_queue_with_cli_access_and_answers_with_decide() {
        let mut q: Queue<Prompt> = Queue::default();
        let cli = cli_access::prompt(&cli_access::Request {
            id: "c1".into(),
            client: "homerun".into(),
            version: "0.9.0".into(),
            hostname: "studio".into(),
            expires_at_ms: 100,
        });
        assert_eq!(q.requested(cli, 0).map(|p| p.kind), Some(Kind::Cli));
        assert_eq!(q.requested(prompt(&req()), 0), None, "one prompt at a time");
        let next = q.closed("c1", 1).unwrap();
        assert_eq!(next.kind, Kind::Link);
        assert_eq!(answer_call(next.kind, &next.request_id, Answer::Allow), Some(("devices.link.decide", json!({"request_id": "l1", "approve": true}))));
        assert!(q.withdrawn("l1"));
    }
}
