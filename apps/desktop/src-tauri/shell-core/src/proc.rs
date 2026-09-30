//! The runtime's process tree (§5.1), the one part of the supervisor that differs by OS.
//!
//! - POSIX: `homerund` gets its own process group, so a terminal's Ctrl-C to the shell doesn't
//!   reach it; `Term` and `Kill` are SIGTERM and SIGKILL. `homerund` owns its own children's
//!   groups.
//! - Windows: `homerund` gets a new console process group and no console window, and the shell
//!   puts it in a job object at once, so everything it starts (`claude`, tools, MCP servers)
//!   joins. Windows has no SIGTERM: `Term` and `Kill` both terminate the job, which is why the
//!   stop sequence closes stdin first and waits. When `homerund` exits, however it exits, the job
//!   is terminated too, so nothing it started outlives it.

use crate::policy::Signal;
use std::process::{Child, Command, ExitStatus};

pub use imp::Tree;

/// Set up `cmd` before it spawns `homerund`.
pub fn prepare(cmd: &mut Command) {
    imp::prepare(cmd)
}

/// Take charge of a spawned `homerund`'s tree. `warn` is told what couldn't be done.
pub fn adopt(child: &Child, warn: impl Fn(&str)) -> Tree {
    imp::adopt(child, warn)
}

/// An exit status as (code, signal).
pub fn exit_parts(s: &ExitStatus) -> (Option<i32>, Option<i32>) {
    imp::exit_parts(s)
}

#[cfg(unix)]
mod imp {
    use super::Signal;
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    use std::process::{Child, Command, ExitStatus};

    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    pub struct Tree {
        pid: u32,
    }

    pub fn prepare(cmd: &mut Command) {
        cmd.process_group(0);
    }

    pub fn adopt(child: &Child, _warn: impl Fn(&str)) -> Tree {
        Tree { pid: child.id() }
    }

    impl Tree {
        pub fn pid(&self) -> u32 {
            self.pid
        }
        /// Send `s`; returns its name for the log.
        pub fn signal(&self, s: Signal) -> &'static str {
            let (sig, name) = match s {
                Signal::Term => (15, "SIGTERM"),
                Signal::Kill => (9, "SIGKILL"),
            };
            unsafe { kill(self.pid as i32, sig) };
            name
        }
        /// After the exit: nothing to do, `homerund` cleans up its own groups (§5.4).
        pub fn reap(&self) {}
    }

    pub fn exit_parts(s: &ExitStatus) -> (Option<i32>, Option<i32>) {
        (s.code(), s.signal())
    }
}

#[cfg(windows)]
mod imp {
    use super::Signal;
    use crate::win::job::Job;
    use crate::win::Handle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, ExitStatus};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, PROCESS_TERMINATE};

    /// The exit code a terminated tree reports: 128 + SIGKILL, as a POSIX shell would show it.
    pub const TERMINATED: u32 = 137;

    pub struct Tree {
        pid: u32,
        job: Option<Job>,
        /// For a tree with no job: held from the spawn, so the pid can't be reused under us.
        process: Option<Handle>,
    }

    pub fn prepare(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    pub fn adopt(child: &Child, warn: impl Fn(&str)) -> Tree {
        let pid = child.id();
        let job = Job::new().and_then(|j| j.assign(child).map(|_| j));
        let job = match job {
            Ok(j) => Some(j),
            Err(e) => {
                warn(&format!("could not put the runtime in a job ({e}); stopping it ends the runtime alone"));
                None
            }
        };
        let process = Handle::new(unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) }).ok();
        Tree { pid, job, process }
    }

    impl Tree {
        pub fn pid(&self) -> u32 {
            self.pid
        }
        /// There is no SIGTERM: either signal ends the whole tree.
        pub fn signal(&self, _s: Signal) -> &'static str {
            self.end();
            "TerminateJobObject"
        }
        /// After the exit: end whatever it started that is still running.
        pub fn reap(&self) {
            if let Some(j) = &self.job {
                let _ = j.terminate(TERMINATED);
            }
        }
        fn end(&self) {
            match (&self.job, &self.process) {
                (Some(j), _) if j.terminate(TERMINATED).is_ok() => {}
                (_, Some(p)) => {
                    unsafe { TerminateProcess(p.0, TERMINATED) };
                }
                _ => {}
            }
        }
    }

    pub fn exit_parts(s: &ExitStatus) -> (Option<i32>, Option<i32>) {
        (s.code(), None)
    }
}
