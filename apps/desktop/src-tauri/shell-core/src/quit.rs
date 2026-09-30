//! Quit confirmation (§5.1): one decision for ⌘Q, Dock → Quit, AppleScript `quit`, the menu-bar
//! item and *Restart to Update*. It asks only when quitting interrupts something the user started
//! or is waiting on; logout, restart and shutdown are never held up.

use crate::summary::Summary;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// ⌘Q, Dock, AppleScript, the menu-bar item.
    User,
    /// Logout, restart or shutdown: `NSWorkspaceWillPowerOffNotification` or the quit Apple
    /// event's `kAEQuitReason`.
    PowerOff,
    /// *Restart to Update* (§11).
    Update,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dialog {
    pub title: String,
    pub message: String,
    pub confirm: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Now,
    Confirm(Dialog),
}

fn n(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// `summary` is the cached one, or None when the runtime isn't ready (nothing to protect: runs
/// resume from the store either way, §5.4).
pub fn decide(summary: Option<&Summary>, why: Why) -> Decision {
    let Some(s) = summary else { return Decision::Now };
    if why == Why::PowerOff || (s.active_runs == 0 && s.pending.is_empty()) {
        return Decision::Now;
    }
    let mut lines = vec![];
    if s.active_runs > 0 {
        let runs = n(s.active_runs, "run", "runs");
        let it = if s.active_runs == 1 { "it" } else { "they" };
        lines.push(match why {
            Why::Update => format!("{runs} will pause and continue after the restart."),
            _ => format!("{runs} will pause and continue where {it} left off the next time you open Homerun."),
        });
    }
    let waiting: Vec<String> = [(s.approvals(), "approval", "approvals"), (s.questions(), "question", "questions")]
        .into_iter()
        .filter(|(c, ..)| *c > 0)
        .map(|(c, one, many)| n(c, one, many))
        .collect();
    if !waiting.is_empty() {
        let are = if s.pending.len() == 1 { "is" } else { "are" };
        lines.push(format!("{} {are} waiting for you.", waiting.join(" and ")));
    }
    if why == Why::User && s.monitors_on > 0 {
        let m = if s.monitors_on == 1 { "your monitor won't run".to_string() } else { format!("your {} monitors won't run", s.monitors_on) };
        lines.push(format!("While Homerun is quit, {m}."));
    }
    let (title, confirm) = match why {
        Why::Update => ("Restart to update Homerun?", "Restart"),
        _ => ("Quit Homerun?", "Quit"),
    };
    Decision::Confirm(Dialog { title: title.into(), message: lines.join(" "), confirm: confirm.into() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summary::{Pending, PendingKind};

    fn summary(runs: usize, approvals: usize, questions: usize, monitors: usize) -> Summary {
        let mut s = Summary { active_runs: runs, monitors_on: monitors, ..Default::default() };
        for _ in 0..approvals {
            s.pending.push(Pending { thread_id: None, title: "t".into(), kind: PendingKind::Approval { tool: "Bash".into() } });
        }
        for _ in 0..questions {
            s.pending.push(Pending { thread_id: None, title: "t".into(), kind: PendingKind::Question });
        }
        s
    }

    fn msg(d: Decision) -> String {
        match d {
            Decision::Confirm(d) => format!("{} | {} | {}", d.title, d.message, d.confirm),
            Decision::Now => "now".into(),
        }
    }

    #[test]
    fn asks_only_for_runs_or_pending_input() {
        assert_eq!(decide(None, Why::User), Decision::Now, "runtime not ready");
        assert_eq!(decide(Some(&summary(0, 0, 0, 4)), Why::User), Decision::Now, "monitors alone don't ask");
        assert_eq!(
            msg(decide(Some(&summary(2, 1, 0, 4)), Why::User)),
            "Quit Homerun? | 2 runs will pause and continue where they left off the next time you open Homerun. \
             1 approval is waiting for you. While Homerun is quit, your 4 monitors won't run. | Quit"
        );
        assert_eq!(
            msg(decide(Some(&summary(1, 0, 0, 1)), Why::User)),
            "Quit Homerun? | 1 run will pause and continue where it left off the next time you open Homerun. \
             While Homerun is quit, your monitor won't run. | Quit"
        );
        assert_eq!(msg(decide(Some(&summary(0, 2, 1, 0)), Why::User)), "Quit Homerun? | 2 approvals and 1 question are waiting for you. | Quit");
        assert_eq!(
            msg(decide(Some(&summary(3, 0, 1, 2)), Why::Update)),
            "Restart to update Homerun? | 3 runs will pause and continue after the restart. 1 question is waiting for you. | Restart"
        );
    }

    #[test]
    fn logout_restart_and_shutdown_never_ask() {
        assert_eq!(decide(Some(&summary(5, 5, 5, 5)), Why::PowerOff), Decision::Now);
    }
}
