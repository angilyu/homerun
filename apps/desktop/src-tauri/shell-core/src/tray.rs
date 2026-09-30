//! The menu-bar item (§5.1): what it shows, built from the runtime status, the summary and the
//! updater. The Tauri crate turns a `Menu` into an `NSMenu` and routes item ids back as `Action`s.

use crate::notify::clean;
use crate::status::RuntimeStatus;
use crate::summary::{PendingKind, Summary};
use crate::update::UpdateState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Icon {
    Normal,
    /// Something is waiting for the user.
    Attention,
    /// A crash loop or a blocked start.
    Trouble,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Open,
    Thread(String),
    RestartRuntime,
    PauseAll,
    ResumeAll,
    CheckUpdates,
    RestartToUpdate,
    DownloadPage,
    Quit,
}

impl Action {
    pub fn id(&self) -> String {
        match self {
            Action::Open => "open".into(),
            Action::Thread(t) => format!("thread:{t}"),
            Action::RestartRuntime => "restart_runtime".into(),
            Action::PauseAll => "pause_all".into(),
            Action::ResumeAll => "resume_all".into(),
            Action::CheckUpdates => "check_updates".into(),
            Action::RestartToUpdate => "restart_to_update".into(),
            Action::DownloadPage => "download_page".into(),
            Action::Quit => "quit".into(),
        }
    }
    pub fn parse(id: &str) -> Option<Action> {
        Some(match id {
            "open" => Action::Open,
            "restart_runtime" => Action::RestartRuntime,
            "pause_all" => Action::PauseAll,
            "resume_all" => Action::ResumeAll,
            "check_updates" => Action::CheckUpdates,
            "restart_to_update" => Action::RestartToUpdate,
            "download_page" => Action::DownloadPage,
            "quit" => Action::Quit,
            _ => Action::Thread(id.strip_prefix("thread:").filter(|t| !t.is_empty())?.to_string()),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    Item { label: String, action: Option<Action> },
    Submenu { label: String, items: Vec<Entry> },
    Separator,
}

fn item(label: impl Into<String>, action: Action) -> Entry {
    Entry::Item { label: label.into(), action: Some(action) }
}

fn text(label: impl Into<String>) -> Entry {
    Entry::Item { label: label.into(), action: None }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Menu {
    pub icon: Icon,
    /// Shown next to the icon: pending approvals and questions. None at zero.
    pub badge: Option<String>,
    pub tooltip: String,
    pub entries: Vec<Entry>,
}

/// Rows per submenu; the rest are behind "and N more…", which opens the window.
pub const ROWS: usize = 8;
const LABEL_MAX: usize = 48;

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

pub fn build(status: &RuntimeStatus, summary: Option<&Summary>, update: &UpdateState) -> Menu {
    let ready = matches!(status, RuntimeStatus::Ready { .. });
    let s = summary.filter(|_| ready);
    let (line, trouble) = match status {
        RuntimeStatus::Starting => ("Homerun is starting…".to_string(), false),
        RuntimeStatus::Ready { .. } => match s.map_or(0, |s| s.monitors_on) {
            0 => ("Homerun is running".into(), false),
            n => (format!("Homerun is running · {} on", plural(n, "monitor", "monitors")), false),
        },
        RuntimeStatus::Restarting { .. } => ("Restarting the runtime…".into(), false),
        RuntimeStatus::CrashLoop { .. } => ("The runtime keeps stopping".into(), true),
        RuntimeStatus::Blocked { message, .. } => (clean(message, LABEL_MAX), true),
        RuntimeStatus::Stopping => ("Quitting…".into(), false),
    };
    let mut e = vec![text(line.clone())];
    if trouble {
        e.push(item("Restart Runtime", Action::RestartRuntime));
    }
    if let Some(s) = s {
        let has_lists = !s.pending.is_empty() || !s.running.is_empty();
        if has_lists {
            e.push(Entry::Separator);
        }
        if !s.pending.is_empty() {
            let mut rows: Vec<Entry> = s
                .pending
                .iter()
                .take(ROWS)
                .map(|p| {
                    let what = match &p.kind {
                        PendingKind::Approval { tool } => format!("Approve {tool}"),
                        PendingKind::Question => "Question".into(),
                        PendingKind::Ambiguous { tool } => format!("Check {tool}"),
                    };
                    let label = clean(&format!("{what} — {}", p.title), LABEL_MAX);
                    item(label, p.thread_id.clone().map_or(Action::Open, Action::Thread))
                })
                .collect();
            if s.pending.len() > ROWS {
                rows.push(item(format!("and {} more…", s.pending.len() - ROWS), Action::Open));
            }
            e.push(Entry::Submenu { label: format!("Waiting for You ({})", s.pending.len()), items: rows });
        }
        if !s.running.is_empty() {
            let mut rows: Vec<Entry> = s.running.iter().take(ROWS).map(|r| item(clean(&r.title, LABEL_MAX), Action::Thread(r.thread_id.clone()))).collect();
            if s.running.len() > ROWS {
                rows.push(item(format!("and {} more…", s.running.len() - ROWS), Action::Open));
            }
            e.push(Entry::Submenu { label: format!("Running ({})", s.running.len()), items: rows });
        }
    }
    e.push(Entry::Separator);
    e.push(item("Open Homerun", Action::Open));
    if let Some(s) = s {
        if s.paused_by_shell > 0 {
            e.push(item(format!("Resume Monitors ({})", s.paused_by_shell), Action::ResumeAll));
        } else if s.monitors_on > 0 {
            e.push(item("Pause All Monitors", Action::PauseAll));
        }
    }
    e.push(match update {
        UpdateState::Unavailable { .. } => text("Updates Unavailable in This Build"),
        UpdateState::Checking => text("Checking for Updates…"),
        UpdateState::Downloading { version } => text(format!("Downloading Homerun {version}…")),
        UpdateState::Ready { version, .. } => item(format!("Restart to Update to {version}"), Action::RestartToUpdate),
        UpdateState::Manual { version, .. } => item(format!("Download Homerun {version}…"), Action::DownloadPage),
        _ => item("Check for Updates…", Action::CheckUpdates),
    });
    e.push(Entry::Separator);
    e.push(item("Quit Homerun", Action::Quit));
    let waiting = s.map_or(0, |s| s.pending.len());
    Menu {
        icon: if trouble {
            Icon::Trouble
        } else if waiting > 0 {
            Icon::Attention
        } else {
            Icon::Normal
        },
        badge: (waiting > 0).then(|| waiting.to_string()),
        tooltip: if waiting > 0 { format!("Homerun — {} waiting", waiting) } else { format!("Homerun — {}", line) },
        entries: e,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::BlockedReason;
    use crate::summary::{Pending, Running};

    fn ready() -> RuntimeStatus {
        RuntimeStatus::Ready { connection: 1, device_id: "d".into(), runtime_version: "v".into(), protocol: 1 }
    }

    fn labels(m: &Menu) -> Vec<String> {
        m.entries
            .iter()
            .map(|e| match e {
                Entry::Item { label, action: Some(a) } => format!("{label} [{}]", a.id()),
                Entry::Item { label, action: None } => format!("({label})"),
                Entry::Submenu { label, items } => format!("{label} > {}", items.len()),
                Entry::Separator => "—".into(),
            })
            .collect()
    }

    #[test]
    fn idle() {
        let s = Summary { monitors_on: 4, ..Default::default() };
        let m = build(&ready(), Some(&s), &UpdateState::Idle);
        assert_eq!((m.icon, m.badge.clone()), (Icon::Normal, None));
        assert_eq!(
            labels(&m),
            [
                "(Homerun is running · 4 monitors on)",
                "—",
                "Open Homerun [open]",
                "Pause All Monitors [pause_all]",
                "Check for Updates… [check_updates]",
                "—",
                "Quit Homerun [quit]"
            ]
        );
    }

    #[test]
    fn busy_with_pending_running_paused_and_an_update() {
        let mut s = Summary { monitors_on: 0, paused_by_shell: 3, active_runs: 12, ..Default::default() };
        s.pending.push(Pending {
            thread_id: Some("t1".into()),
            title: "Deploy the marketing site to production now please".into(),
            kind: PendingKind::Approval { tool: "Bash".into() },
        });
        s.pending.push(Pending { thread_id: None, title: "Homerun".into(), kind: PendingKind::Question });
        for i in 0..10 {
            s.running.push(Running { thread_id: format!("r{i}"), title: format!("Watch {i}") });
        }
        let m = build(&ready(), Some(&s), &UpdateState::Ready { version: "0.8.1".into(), note: None });
        assert_eq!((m.icon, m.badge.as_deref()), (Icon::Attention, Some("2")));
        assert_eq!(
            labels(&m),
            [
                "(Homerun is running)",
                "—",
                "Waiting for You (2) > 2",
                "Running (10) > 9",
                "—",
                "Open Homerun [open]",
                "Resume Monitors (3) [resume_all]",
                "Restart to Update to 0.8.1 [restart_to_update]",
                "—",
                "Quit Homerun [quit]"
            ]
        );
        let Entry::Submenu { items, .. } = &m.entries[2] else { panic!() };
        assert_eq!(items[0], item("Approve Bash — Deploy the marketing site to pro…", Action::Thread("t1".into())));
        assert_eq!(items[1], item("Question — Homerun", Action::Open));
        let Entry::Submenu { items, .. } = &m.entries[3] else { panic!() };
        assert_eq!(items[8], item("and 2 more…", Action::Open));
    }

    #[test]
    fn trouble_hides_the_lists_and_offers_a_restart() {
        let s = Summary { monitors_on: 2, ..Default::default() };
        let b = RuntimeStatus::Blocked { reason: BlockedReason::OtherRuntime, message: "Another Homerun is using this data folder.".into() };
        let m = build(&b, Some(&s), &UpdateState::Checking);
        assert_eq!(m.icon, Icon::Trouble);
        assert_eq!(
            labels(&m),
            [
                "(Another Homerun is using this data folder.)",
                "Restart Runtime [restart_runtime]",
                "—",
                "Open Homerun [open]",
                "(Checking for Updates…)",
                "—",
                "Quit Homerun [quit]"
            ]
        );
        let m = build(&RuntimeStatus::CrashLoop { retry_at: None, last_error: None }, None, &UpdateState::Idle);
        assert_eq!(labels(&m)[..2], ["(The runtime keeps stopping)", "Restart Runtime [restart_runtime]"]);
    }

    #[test]
    fn ids_round_trip() {
        for a in [
            Action::Open,
            Action::Thread("0192-ab".into()),
            Action::RestartRuntime,
            Action::PauseAll,
            Action::ResumeAll,
            Action::CheckUpdates,
            Action::RestartToUpdate,
            Action::DownloadPage,
            Action::Quit,
        ] {
            assert_eq!(Action::parse(&a.id()), Some(a));
        }
        assert_eq!(Action::parse("thread:"), None);
        assert_eq!(Action::parse("nope"), None);
    }
}
