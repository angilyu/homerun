//! The supervisor's decisions as a pure state machine (§5.1): events in, effects out, time
//! passed in. `runtime.rs` executes the effects with real processes, sockets and timers; the
//! tests here drive it with a fake clock.
//!
//! - Start: spawn `homerund serve` with the launch token on stdin. It is ready when it prints its
//!   `ready` line and both connections complete `hello`, within `ready_timeout`.
//! - Health: `ping` every `ping_every`; `ping_misses` misses in a row count as a hang. A wake
//!   resets the count, because nothing answers while the Mac sleeps.
//! - An unexpected exit restarts with backoff (1, 2, 4, 8, 16, 30 s), reset after the runtime was
//!   healthy for `healthy_reset`. `loop_count` exits within `loop_window` is a crash loop: fast
//!   restarts stop, the UI says so, and the shell retries every `loop_retry` so monitors don't
//!   silently die (§8.2).
//! - Exit 3 (another runtime owns the data folder), exit 64 (a usage error, i.e. a bug) and a
//!   database written by a newer version (§6.3) block: retrying can't help, the user must act.
//! - Stop: close stdin (the runtime checkpoints and exits), then SIGTERM after `stop_grace`, then
//!   SIGKILL after `term_grace`.

use crate::status::{BlockedReason, RuntimeStatus};

#[derive(Clone, Debug)]
pub struct Timing {
    pub ready_timeout: u64,
    pub ping_every: u64,
    pub ping_misses: u32,
    pub backoff: Vec<u64>,
    pub healthy_reset: u64,
    pub loop_window: u64,
    pub loop_count: usize,
    pub loop_retry: u64,
    pub stop_grace: u64,
    pub term_grace: u64,
}

impl Default for Timing {
    fn default() -> Self {
        const S: u64 = 1000;
        Timing {
            ready_timeout: 60 * S,
            ping_every: 15 * S,
            ping_misses: 3,
            backoff: vec![S, 2 * S, 4 * S, 8 * S, 16 * S, 30 * S],
            healthy_reset: 120 * S,
            loop_window: 180 * S,
            loop_count: 5,
            loop_retry: 600 * S,
            stop_grace: 10 * S,
            term_grace: 5 * S,
        }
    }
}

/// Monotonic milliseconds for timers, wall-clock milliseconds for what the UI shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Now {
    pub mono: u64,
    pub wall: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// The last error the runtime logged, if any.
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Hello {
    pub device_id: String,
    pub runtime_version: String,
    pub protocol: u64,
}

/// `gen` identifies the child an event is about; events about an earlier child are ignored.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Start,
    SpawnFailed {
        gen: u64,
        error: String,
    },
    ReadyLine {
        gen: u64,
        socket: String,
    },
    Connected {
        gen: u64,
        hello: Hello,
    },
    ConnectFailed {
        gen: u64,
        error: String,
        incompatible: bool,
    },
    Ping {
        gen: u64,
        ok: bool,
    },
    Exited {
        gen: u64,
        exit: Exit,
    },
    /// A timer is due; `handle` checks which.
    Tick,
    /// The Mac woke (§8.4).
    Woke,
    /// The user asked for a restart (the banner's *Restart runtime*).
    Restart,
    Stop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Spawn {
        gen: u64,
    },
    Connect {
        gen: u64,
        socket: String,
    },
    /// Drop the connections (they belong to a child that is going away).
    Disconnect,
    Ping {
        gen: u64,
    },
    CloseStdin,
    Signal(Signal),
    Status(RuntimeStatus),
    /// The child is gone after `Stop`: the app may exit.
    Stopped,
}

#[derive(Clone, Debug, PartialEq)]
enum After {
    Crash(String),
    Block(BlockedReason, String),
    Respawn,
    Stop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// Stdin closed; waiting for a clean exit.
    Close,
    Term,
    Kill,
}

#[derive(Clone, Debug, PartialEq)]
enum Phase {
    Idle,
    Starting {
        since: u64,
        socket: bool,
    },
    Ready {
        since: u64,
        next_ping: u64,
        misses: u32,
        pinging: bool,
    },
    /// The child is being stopped; `then` says what comes after its exit.
    Ending {
        stage: Stage,
        deadline: Option<u64>,
        then: After,
        was_ready_since: Option<u64>,
    },
    Waiting {
        until: u64,
    },
    Blocked,
    Stopped,
}

pub const MSG_OTHER_RUNTIME: &str = "Another Homerun runtime is using this data folder. Quit the other copy of Homerun, then restart the runtime.";
pub const MSG_DB_TOO_NEW: &str = "This data was written by a newer version of Homerun. Update Homerun to open it.";
pub const MSG_USAGE: &str = "The runtime refused to start (exit 64). This is a bug; reinstalling Homerun may help.";
pub const MSG_NOT_READY: &str = "The runtime didn't start within a minute.";
pub const MSG_HUNG: &str = "The runtime stopped responding.";

pub struct Policy {
    t: Timing,
    phase: Phase,
    gen: u64,
    connection: u64,
    backoff_idx: usize,
    exits: Vec<u64>,
    in_loop: bool,
    status: RuntimeStatus,
}

impl Policy {
    pub fn new(t: Timing) -> Self {
        Policy { t, phase: Phase::Idle, gen: 0, connection: 0, backoff_idx: 0, exits: vec![], in_loop: false, status: RuntimeStatus::Starting }
    }

    pub fn status(&self) -> &RuntimeStatus {
        &self.status
    }

    /// The generation of the current child.
    pub fn gen(&self) -> u64 {
        self.gen
    }

    pub fn is_stopped(&self) -> bool {
        self.phase == Phase::Stopped
    }

    /// When `handle(Tick)` next has something to do.
    pub fn deadline(&self) -> Option<u64> {
        match &self.phase {
            Phase::Starting { since, .. } => Some(since + self.t.ready_timeout),
            Phase::Ready { next_ping, pinging: false, .. } => Some(*next_ping),
            Phase::Ending { deadline, .. } => *deadline,
            Phase::Waiting { until } => Some(*until),
            _ => None,
        }
    }

    pub fn handle(&mut self, now: Now, ev: Event) -> Vec<Effect> {
        let mut fx = vec![];
        self.step(now, ev, &mut fx);
        fx
    }

    fn set_status(&mut self, s: RuntimeStatus, fx: &mut Vec<Effect>) {
        if self.status != s {
            self.status = s.clone();
            fx.push(Effect::Status(s));
        }
    }

    fn current(&self, gen: u64) -> bool {
        gen == self.gen
    }

    fn spawn(&mut self, now: Now, fx: &mut Vec<Effect>) {
        self.gen += 1;
        self.phase = Phase::Starting { since: now.mono, socket: false };
        fx.push(Effect::Spawn { gen: self.gen });
        self.set_status(RuntimeStatus::Starting, fx);
    }

    fn end(&mut self, now: Now, stage: Stage, then: After, fx: &mut Vec<Effect>) {
        let was_ready_since = match self.phase {
            Phase::Ready { since, .. } => Some(since),
            _ => None,
        };
        fx.push(Effect::Disconnect);
        let deadline = match stage {
            Stage::Close => {
                fx.push(Effect::CloseStdin);
                Some(now.mono + self.t.stop_grace)
            }
            Stage::Term => {
                fx.push(Effect::Signal(Signal::Term));
                Some(now.mono + self.t.term_grace)
            }
            Stage::Kill => {
                fx.push(Effect::Signal(Signal::Kill));
                None
            }
        };
        if then == After::Stop {
            self.set_status(RuntimeStatus::Stopping, fx);
        }
        self.phase = Phase::Ending { stage, deadline, then, was_ready_since };
    }

    fn block(&mut self, reason: BlockedReason, message: String, fx: &mut Vec<Effect>) {
        self.phase = Phase::Blocked;
        self.set_status(RuntimeStatus::Blocked { reason, message }, fx);
    }

    /// An unexpected exit, a failed spawn or a hang: back off, or call it a crash loop.
    fn crash(&mut self, now: Now, error: Option<String>, ready_since: Option<u64>, fx: &mut Vec<Effect>) {
        if ready_since.is_some_and(|s| now.mono.saturating_sub(s) >= self.t.healthy_reset) {
            self.backoff_idx = 0;
            self.in_loop = false;
        }
        self.exits.push(now.mono);
        let window = self.t.loop_window;
        self.exits.retain(|&x| now.mono.saturating_sub(x) < window);
        if self.in_loop || self.exits.len() >= self.t.loop_count {
            self.in_loop = true;
            self.phase = Phase::Waiting { until: now.mono + self.t.loop_retry };
            self.set_status(RuntimeStatus::CrashLoop { retry_at: Some(now.wall + self.t.loop_retry), last_error: error }, fx);
        } else {
            let delay = self.t.backoff[self.backoff_idx.min(self.t.backoff.len() - 1)];
            self.backoff_idx += 1;
            self.phase = Phase::Waiting { until: now.mono + delay };
            self.set_status(RuntimeStatus::Restarting { retry_at: Some(now.wall + delay), last_error: error }, fx);
        }
    }

    fn step(&mut self, now: Now, ev: Event, fx: &mut Vec<Effect>) {
        match ev {
            Event::Start => {
                if self.phase == Phase::Idle {
                    self.spawn(now, fx);
                }
            }
            Event::SpawnFailed { gen, error } => {
                if self.current(gen) && matches!(self.phase, Phase::Starting { .. }) {
                    self.crash(now, Some(error), None, fx);
                }
            }
            Event::ReadyLine { gen, socket } => {
                if let Phase::Starting { socket: seen @ false, .. } = &mut self.phase {
                    if gen == self.gen {
                        *seen = true;
                        fx.push(Effect::Connect { gen, socket });
                    }
                }
            }
            Event::Connected { gen, hello } => {
                if self.current(gen) && matches!(self.phase, Phase::Starting { .. }) {
                    self.connection += 1;
                    self.phase = Phase::Ready { since: now.mono, next_ping: now.mono + self.t.ping_every, misses: 0, pinging: false };
                    self.set_status(
                        RuntimeStatus::Ready {
                            connection: self.connection,
                            device_id: hello.device_id,
                            runtime_version: hello.runtime_version,
                            protocol: hello.protocol,
                        },
                        fx,
                    );
                }
            }
            Event::ConnectFailed { gen, error, incompatible } => {
                if self.current(gen) && matches!(self.phase, Phase::Starting { .. }) {
                    let then = if incompatible { After::Block(BlockedReason::Incompatible, error) } else { After::Crash(error) };
                    self.end(now, Stage::Close, then, fx);
                }
            }
            Event::Ping { gen, ok } => {
                if !self.current(gen) {
                    return;
                }
                let every = self.t.ping_every;
                let max = self.t.ping_misses;
                if let Phase::Ready { next_ping, misses, pinging, .. } = &mut self.phase {
                    *pinging = false;
                    *next_ping = now.mono + every;
                    *misses = if ok { 0 } else { *misses + 1 };
                    if *misses >= max {
                        self.end(now, Stage::Term, After::Crash(MSG_HUNG.into()), fx);
                    }
                }
            }
            Event::Exited { gen, exit } => {
                if !self.current(gen) {
                    return;
                }
                match std::mem::replace(&mut self.phase, Phase::Idle) {
                    Phase::Ending { then, was_ready_since, .. } => match then {
                        After::Stop => {
                            self.phase = Phase::Stopped;
                            fx.push(Effect::Stopped);
                        }
                        After::Respawn => self.spawn(now, fx),
                        After::Block(r, m) => self.block(r, m, fx),
                        After::Crash(why) => self.crash(now, Some(why), was_ready_since, fx),
                    },
                    Phase::Starting { .. } => self.exited(now, exit, None, fx),
                    Phase::Ready { since, .. } => {
                        fx.push(Effect::Disconnect);
                        self.exited(now, exit, Some(since), fx)
                    }
                    other => self.phase = other,
                }
            }
            Event::Tick => self.tick(now, fx),
            Event::Woke => match &mut self.phase {
                Phase::Ready { next_ping, misses, .. } => {
                    *misses = 0;
                    *next_ping = now.mono + self.t.ping_every;
                }
                Phase::Starting { since, .. } => *since = now.mono,
                _ => {}
            },
            Event::Restart => match &mut self.phase {
                Phase::Idle | Phase::Waiting { .. } | Phase::Blocked => {
                    self.exits.clear();
                    self.in_loop = false;
                    self.backoff_idx = 0;
                    self.spawn(now, fx);
                }
                Phase::Starting { .. } | Phase::Ready { .. } => {
                    self.exits.clear();
                    self.in_loop = false;
                    self.backoff_idx = 0;
                    self.end(now, Stage::Close, After::Respawn, fx);
                    self.set_status(RuntimeStatus::Restarting { retry_at: None, last_error: None }, fx);
                }
                Phase::Ending { .. } | Phase::Stopped => {}
            },
            Event::Stop => match &mut self.phase {
                Phase::Starting { .. } | Phase::Ready { .. } => self.end(now, Stage::Close, After::Stop, fx),
                Phase::Ending { then, .. } => {
                    *then = After::Stop;
                    self.set_status(RuntimeStatus::Stopping, fx);
                }
                Phase::Idle | Phase::Waiting { .. } | Phase::Blocked => {
                    self.phase = Phase::Stopped;
                    self.set_status(RuntimeStatus::Stopping, fx);
                    fx.push(Effect::Stopped);
                }
                Phase::Stopped => {}
            },
        }
    }

    fn exited(&mut self, now: Now, exit: Exit, ready_since: Option<u64>, fx: &mut Vec<Effect>) {
        let too_new = exit.last_error.as_deref().is_some_and(|e| e.contains("database is too new"));
        match exit.code {
            Some(3) => self.block(BlockedReason::OtherRuntime, MSG_OTHER_RUNTIME.into(), fx),
            Some(64) => self.block(BlockedReason::Failed, MSG_USAGE.into(), fx),
            Some(1) if too_new => self.block(BlockedReason::DatabaseTooNew, MSG_DB_TOO_NEW.into(), fx),
            _ => {
                let what = match (exit.code, exit.signal) {
                    (_, Some(s)) => format!("The runtime stopped unexpectedly (signal {s})."),
                    (Some(c), _) => format!("The runtime stopped unexpectedly (exit {c})."),
                    _ => "The runtime stopped unexpectedly.".to_string(),
                };
                let error = exit.last_error.map(|e| format!("{what} {e}")).unwrap_or(what);
                self.crash(now, Some(error), ready_since, fx)
            }
        }
    }

    fn tick(&mut self, now: Now, fx: &mut Vec<Effect>) {
        let Some(due) = self.deadline() else { return };
        if now.mono < due {
            return;
        }
        match &mut self.phase {
            Phase::Starting { .. } => self.end(now, Stage::Term, After::Crash(MSG_NOT_READY.into()), fx),
            Phase::Ready { pinging, .. } => {
                *pinging = true;
                fx.push(Effect::Ping { gen: self.gen });
            }
            Phase::Ending { stage, deadline, .. } => match stage {
                Stage::Close => {
                    *stage = Stage::Term;
                    *deadline = Some(now.mono + self.t.term_grace);
                    fx.push(Effect::Signal(Signal::Term));
                }
                Stage::Term => {
                    *stage = Stage::Kill;
                    *deadline = None;
                    fx.push(Effect::Signal(Signal::Kill));
                }
                Stage::Kill => *deadline = None,
            },
            Phase::Waiting { .. } => self.spawn(now, fx),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1000;

    struct H {
        p: Policy,
        t: u64,
    }

    impl H {
        fn new() -> Self {
            H { p: Policy::new(Timing::default()), t: 10_000 }
        }
        fn now(&self) -> Now {
            Now { mono: self.t, wall: 1_700_000_000_000 + self.t }
        }
        fn ev(&mut self, e: Event) -> Vec<Effect> {
            let n = self.now();
            self.p.handle(n, e)
        }
        /// Advance the clock, firing every timer on the way.
        fn advance(&mut self, ms: u64) -> Vec<Effect> {
            let end = self.t + ms;
            let mut fx = vec![];
            while let Some(d) = self.p.deadline().filter(|&d| d <= end) {
                self.t = self.t.max(d);
                fx.extend(self.ev(Event::Tick));
            }
            self.t = end;
            fx
        }
        fn gen(&self) -> u64 {
            self.p.gen()
        }
        fn up(&mut self) -> Vec<Effect> {
            let g = self.gen();
            let mut fx = self.ev(Event::ReadyLine { gen: g, socket: "/s".into() });
            fx.extend(self.ev(Event::Connected { gen: g, hello: Hello { device_id: "d".into(), runtime_version: "v".into(), protocol: 1 } }));
            fx
        }
        fn exit(&mut self, code: i32) -> Vec<Effect> {
            let g = self.gen();
            self.ev(Event::Exited { gen: g, exit: Exit { code: Some(code), signal: None, last_error: None } })
        }
        fn state(&self) -> &'static str {
            match self.p.status() {
                RuntimeStatus::Starting => "starting",
                RuntimeStatus::Ready { .. } => "ready",
                RuntimeStatus::Restarting { .. } => "restarting",
                RuntimeStatus::CrashLoop { .. } => "crash_loop",
                RuntimeStatus::Blocked { .. } => "blocked",
                RuntimeStatus::Stopping => "stopping",
            }
        }
    }

    fn spawns(fx: &[Effect]) -> usize {
        fx.iter().filter(|e| matches!(e, Effect::Spawn { .. })).count()
    }

    #[test]
    fn starts_connects_and_reports_ready() {
        let mut h = H::new();
        assert_eq!(h.ev(Event::Start), vec![Effect::Spawn { gen: 1 }]);
        let fx = h.up();
        assert_eq!(fx[0], Effect::Connect { gen: 1, socket: "/s".into() });
        assert!(matches!(&fx[1], Effect::Status(RuntimeStatus::Ready { connection: 1, .. })));
        // A second ready line is ignored.
        assert!(h.ev(Event::ReadyLine { gen: 1, socket: "/x".into() }).is_empty());
    }

    #[test]
    fn backoff_doubles_to_30s_then_resets_after_healthy() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.up();
        let mut delays = vec![];
        for _ in 0..4 {
            h.exit(2);
            let RuntimeStatus::Restarting { retry_at: Some(at), last_error } = h.p.status().clone() else { panic!("{:?}", h.p.status()) };
            assert!(last_error.unwrap().contains("exit 2"));
            delays.push(at - h.now().wall);
            assert_eq!(spawns(&h.advance(at - h.now().wall)), 1);
            h.up();
            h.advance(50 * S); // up for a while, not long enough to count as healthy; outside the loop window
        }
        assert_eq!(delays, vec![S, 2 * S, 4 * S, 8 * S]);
        // Healthy for two minutes: the next crash starts again at 1 s.
        h.advance(120 * S);
        h.exit(2);
        let RuntimeStatus::Restarting { retry_at: Some(at), .. } = h.p.status().clone() else { panic!() };
        assert_eq!(at - h.now().wall, S);
    }

    #[test]
    fn five_exits_in_three_minutes_is_a_crash_loop_with_slow_retries() {
        let mut h = H::new();
        h.ev(Event::Start);
        for i in 0..5 {
            h.exit(1);
            if i < 4 {
                assert_eq!(h.state(), "restarting");
                h.advance(30 * S);
            }
        }
        assert_eq!(h.state(), "crash_loop");
        let RuntimeStatus::CrashLoop { retry_at: Some(at), .. } = h.p.status().clone() else { panic!() };
        assert_eq!(at - h.now().wall, 600 * S);
        assert_eq!(spawns(&h.advance(599 * S)), 0);
        assert_eq!(spawns(&h.advance(S)), 1);
        // Still failing: straight back to the slow retry.
        h.exit(1);
        assert_eq!(h.state(), "crash_loop");
        // The user's restart clears it.
        assert_eq!(spawns(&h.ev(Event::Restart)), 1);
        h.exit(1);
        assert_eq!(h.state(), "restarting");
    }

    #[test]
    fn exit_codes_that_block() {
        for (code, err, reason) in [
            (3, None, BlockedReason::OtherRuntime),
            (64, None, BlockedReason::Failed),
            (1, Some(r#"{"level":"error","msg":"database is too new"}"#), BlockedReason::DatabaseTooNew),
        ] {
            let mut h = H::new();
            h.ev(Event::Start);
            let g = h.gen();
            h.ev(Event::Exited { gen: g, exit: Exit { code: Some(code), signal: None, last_error: err.map(String::from) } });
            assert!(matches!(h.p.status(), RuntimeStatus::Blocked { reason: r, .. } if *r == reason), "{code}");
            assert!(h.advance(3600 * S).is_empty(), "no automatic restart");
        }
        // A plain exit 1 is a crash, with the runtime's last error.
        let mut h = H::new();
        h.ev(Event::Start);
        h.ev(Event::Exited { gen: 1, exit: Exit { code: Some(1), signal: None, last_error: Some("startup failed: disk full".into()) } });
        let RuntimeStatus::Restarting { last_error: Some(e), .. } = h.p.status() else { panic!() };
        assert!(e.contains("disk full"));
    }

    #[test]
    fn not_ready_in_time_is_killed_and_counted() {
        let mut h = H::new();
        h.ev(Event::Start);
        let fx = h.advance(60 * S);
        assert!(fx.contains(&Effect::Signal(Signal::Term)));
        let fx = h.advance(5 * S);
        assert_eq!(fx, vec![Effect::Signal(Signal::Kill)]);
        h.ev(Event::Exited { gen: 1, exit: Exit { code: None, signal: Some(9), last_error: None } });
        let RuntimeStatus::Restarting { last_error: Some(e), .. } = h.p.status() else { panic!() };
        assert_eq!(e, MSG_NOT_READY);
    }

    #[test]
    fn three_missed_pings_restart_a_hung_runtime_but_a_wake_forgives() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.up();
        let mut pings = 0;
        for _ in 0..2 {
            let fx = h.advance(15 * S);
            assert_eq!(fx, vec![Effect::Ping { gen: 1 }]);
            pings += 1;
            h.ev(Event::Ping { gen: 1, ok: false });
        }
        h.ev(Event::Woke);
        for _ in 0..2 {
            h.advance(15 * S);
            h.ev(Event::Ping { gen: 1, ok: false });
        }
        assert_eq!(h.state(), "ready", "the wake reset the count after {pings}");
        h.advance(15 * S);
        let fx = h.ev(Event::Ping { gen: 1, ok: false });
        assert!(fx.contains(&Effect::Disconnect) && fx.contains(&Effect::Signal(Signal::Term)));
        h.ev(Event::Exited { gen: 1, exit: Exit { code: None, signal: Some(15), last_error: None } });
        let RuntimeStatus::Restarting { last_error: Some(e), .. } = h.p.status() else { panic!() };
        assert_eq!(e, MSG_HUNG);
    }

    #[test]
    fn clean_shutdown_closes_stdin_then_terms_then_kills() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.up();
        let fx = h.ev(Event::Stop);
        assert_eq!(fx, vec![Effect::Disconnect, Effect::CloseStdin, Effect::Status(RuntimeStatus::Stopping)]);
        assert_eq!(h.advance(10 * S - 1), vec![]);
        assert_eq!(h.advance(1), vec![Effect::Signal(Signal::Term)]);
        assert_eq!(h.advance(5 * S), vec![Effect::Signal(Signal::Kill)]);
        assert_eq!(h.exit(0), vec![Effect::Stopped]);
        assert!(h.p.is_stopped());
        assert!(h.ev(Event::Restart).is_empty());
    }

    #[test]
    fn stop_while_waiting_or_blocked_is_immediate() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.exit(2);
        assert!(h.ev(Event::Stop).contains(&Effect::Stopped));
        let mut h = H::new();
        h.ev(Event::Start);
        h.exit(3);
        assert!(h.ev(Event::Stop).contains(&Effect::Stopped));
    }

    #[test]
    fn stop_during_a_restart_wins() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.up();
        h.ev(Event::Restart);
        assert_eq!(h.state(), "restarting");
        h.ev(Event::Stop);
        assert_eq!(h.exit(0), vec![Effect::Stopped]);
    }

    #[test]
    fn a_user_restart_respawns_after_the_exit_without_backoff() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.up();
        let fx = h.ev(Event::Restart);
        assert!(fx.contains(&Effect::CloseStdin));
        let fx = h.exit(0);
        assert_eq!(fx, vec![Effect::Spawn { gen: 2 }, Effect::Status(RuntimeStatus::Starting)]);
        let fx = h.up();
        assert!(matches!(&fx[1], Effect::Status(RuntimeStatus::Ready { connection: 2, .. })));
    }

    #[test]
    fn an_incompatible_runtime_is_stopped_and_blocks() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.ev(Event::ReadyLine { gen: 1, socket: "/s".into() });
        let fx = h.ev(Event::ConnectFailed { gen: 1, error: "No protocol in common".into(), incompatible: true });
        assert!(fx.contains(&Effect::CloseStdin));
        h.exit(0);
        assert!(matches!(h.p.status(), RuntimeStatus::Blocked { reason: BlockedReason::Incompatible, .. }));
    }

    #[test]
    fn events_about_an_earlier_child_are_ignored() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.exit(2);
        h.advance(S);
        assert_eq!(h.gen(), 2);
        assert!(h.ev(Event::Exited { gen: 1, exit: Exit { code: Some(2), signal: None, last_error: None } }).is_empty());
        assert!(h.ev(Event::Connected { gen: 1, hello: Hello { device_id: "d".into(), runtime_version: "v".into(), protocol: 1 } }).is_empty());
        assert_eq!(h.state(), "starting");
    }

    #[test]
    fn a_failed_spawn_backs_off_like_a_crash() {
        let mut h = H::new();
        h.ev(Event::Start);
        h.ev(Event::SpawnFailed { gen: 1, error: "No such file".into() });
        let RuntimeStatus::Restarting { last_error: Some(e), .. } = h.p.status() else { panic!() };
        assert_eq!(e, "No such file");
    }
}
