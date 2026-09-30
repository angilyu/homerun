//! A job object (§5.1): the Windows counterpart of a process group, and more, since a process
//! can't leave it and everything it starts joins it.

use super::Handle;
use std::io;
use std::os::windows::io::AsRawHandle;
use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};

pub struct Job(Handle);

impl Job {
    /// A new, unnamed job with no limits. It is not kill-on-close: a shell that dies leaves the
    /// runtime to exit on stdin EOF, cleanly, as on POSIX.
    pub fn new() -> io::Result<Job> {
        Handle::new(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) }).map(Job)
    }

    /// Put a process in the job; whatever it starts from now on joins too. A process already in
    /// a job (the CI runner's, a terminal's) gets this one nested inside it.
    pub fn assign(&self, process: &impl AsRawHandle) -> io::Result<()> {
        if unsafe { AssignProcessToJobObject(self.0 .0, process.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// End every process in the job with `code`.
    pub fn terminate(&self, code: u32) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0 .0, code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
