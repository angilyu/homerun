//! The shell's end of the runtime's endpoint (§5.2): a Unix socket on macOS and Linux, a named
//! pipe on Windows. `connect` gives the reading half, the writing half and a way to close both,
//! which is all `rpc::Connection` needs; nothing above this module knows which it has.
//!
//! On Windows the pipe's server must be the runtime the shell started: `GetNamedPipeServerProcessId`
//! on the connected handle is compared with the child's pid before a byte is written, so a pipe
//! squatted by another process never sees the launch token. The handle is opened for
//! identification only (`SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION`), so even that server
//! could not act as the user. POSIX relies on the socket's private directory (§5.2).

use std::io::{self, Read, Write};
use std::path::Path;

pub struct Parts {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// Close the connection both ways; a read blocked on the other half returns.
    pub closer: Box<dyn Fn() + Send + Sync>,
}

/// How long a write may block before the connection counts as stuck.
pub const WRITE_TIMEOUT_MS: u32 = 10_000;

/// Connect to `endpoint`. `server_pid` is the process that must be serving it: required, and
/// checked, on Windows; not used on POSIX.
pub fn connect(endpoint: &Path, server_pid: Option<u32>) -> io::Result<Parts> {
    imp::connect(endpoint, server_pid)
}

#[cfg(unix)]
mod imp {
    use super::{Parts, WRITE_TIMEOUT_MS};
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    use std::path::Path;
    use std::time::Duration;

    pub fn connect(endpoint: &Path, _server_pid: Option<u32>) -> std::io::Result<Parts> {
        let stream = UnixStream::connect(endpoint)?;
        stream.set_write_timeout(Some(Duration::from_millis(WRITE_TIMEOUT_MS as u64)))?;
        let reader = stream.try_clone()?;
        let closer = stream.try_clone()?;
        Ok(Parts {
            reader: Box::new(reader),
            writer: Box::new(stream),
            closer: Box::new(move || {
                let _ = closer.shutdown(Shutdown::Both);
            }),
        })
    }
}

#[cfg(windows)]
mod imp {
    use super::Parts;
    use crate::win::pipe::PipeStream;
    use std::path::Path;

    pub fn connect(endpoint: &Path, server_pid: Option<u32>) -> std::io::Result<Parts> {
        let Some(pid) = server_pid else {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "a pipe client must know which process serves it"));
        };
        let s = PipeStream::connect(endpoint, pid)?;
        let (r, c) = (s.try_clone(), s.try_clone());
        Ok(Parts { reader: Box::new(r), writer: Box::new(s), closer: Box::new(move || c.shutdown()) })
    }
}
