//! A named-pipe stream (§5.2) that one thread can read while another writes. A synchronous pipe
//! handle serializes its I/O, so a blocked read would hold up every write; this one is opened
//! overlapped, and each read or write waits for its own completion, for the connection's close,
//! or for its timeout. `shutdown` wakes whatever is waiting, then closes the handle, so the other
//! end sees the pipe break at once, as a socket's `shutdown` does.

use super::{wide, Handle};
use crate::transport::WRITE_TIMEOUT_MS;
use std::io::{self, Read, Write};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED,
    ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_SHARE_NONE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
    SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId, WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

struct Pipe {
    h: HANDLE,
    /// Set once, by `shutdown`: every wait below wakes on it.
    closed: Handle,
    /// Held shared for each operation, exclusively to close `h`, so no operation ever uses a
    /// closed (or reused) handle.
    open: RwLock<bool>,
}

unsafe impl Send for Pipe {}
unsafe impl Sync for Pipe {}

fn event() -> io::Result<Handle> {
    Handle::new(unsafe { CreateEventW(null(), 1, 0, null()) })
}

impl Pipe {
    fn new(h: HANDLE) -> io::Result<Pipe> {
        match event() {
            Ok(closed) => Ok(Pipe { h, closed, open: RwLock::new(true) }),
            Err(e) => {
                unsafe { CloseHandle(h) };
                Err(e)
            }
        }
    }

    /// Start one overlapped operation with `start` and wait for it: until it completes, `timeout`
    /// ms pass, or the pipe is shut down (then it is cancelled). Returns the bytes transferred.
    fn overlapped(&self, timeout: u32, start: impl FnOnce(HANDLE, *mut OVERLAPPED) -> BOOL) -> io::Result<u32> {
        let open = self.open.read().unwrap_or_else(|e| e.into_inner());
        if !*open {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        let done = event()?;
        let mut ov = OVERLAPPED { hEvent: done.0, ..Default::default() };
        let mut n = 0u32;
        if start(self.h, &mut ov) == 0 {
            let e = unsafe { GetLastError() };
            if e != ERROR_IO_PENDING {
                return Err(io::Error::from_raw_os_error(e as i32));
            }
            let waits = [done.0, self.closed.0];
            let w = unsafe { WaitForMultipleObjects(2, waits.as_ptr(), 0, timeout) };
            if w != WAIT_OBJECT_0 {
                unsafe { CancelIoEx(self.h, &ov) };
            }
            // Always wait for the end: the operation writes to `ov` and the buffer until then.
            if unsafe { GetOverlappedResult(self.h, &ov, &mut n, 1) } == 0 {
                let e = unsafe { GetLastError() };
                return Err(if w == WAIT_TIMEOUT && e == ERROR_OPERATION_ABORTED {
                    io::ErrorKind::TimedOut.into()
                } else {
                    io::Error::from_raw_os_error(e as i32)
                });
            }
            return Ok(n);
        }
        if unsafe { GetOverlappedResult(self.h, &ov, &mut n, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(n)
    }

    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let (ptr, len) = (buf.as_mut_ptr(), buf.len().min(u32::MAX as usize) as u32);
        match self.overlapped(INFINITE, |h, ov| unsafe { ReadFile(h, ptr, len, null_mut(), ov) }) {
            Ok(n) => Ok(n as usize),
            // The other end closed: end of stream, as a socket reports it.
            Err(e) if matches!(e.raw_os_error().map(|c| c as u32), Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED)) => Ok(0),
            Err(e) => Err(e),
        }
    }

    fn write(&self, buf: &[u8]) -> io::Result<usize> {
        let (ptr, len) = (buf.as_ptr(), buf.len().min(u32::MAX as usize) as u32);
        match self.overlapped(WRITE_TIMEOUT_MS, |h, ov| unsafe { WriteFile(h, ptr, len, null_mut(), ov) }) {
            Ok(n) => Ok(n as usize),
            Err(e) if matches!(e.raw_os_error().map(|c| c as u32), Some(ERROR_NO_DATA | ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED)) => {
                Err(io::ErrorKind::BrokenPipe.into())
            }
            Err(e) => Err(e),
        }
    }

    fn shutdown(&self) {
        unsafe { SetEvent(self.closed.0) };
        // Every operation holding the lock wakes on `closed` and lets go.
        let mut open = self.open.write().unwrap_or_else(|e| e.into_inner());
        if std::mem::replace(&mut *open, false) {
            unsafe { CloseHandle(self.h) };
        }
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// One end of a pipe connection. Clones share it; `shutdown` closes it for all of them.
pub struct PipeStream(Arc<Pipe>);

impl PipeStream {
    /// Connect to pipe `name` as a client, and check that process `server_pid` serves it
    /// before anything is written (§5.2). A busy pipe is retried for up to five seconds.
    pub fn connect(name: &Path, server_pid: u32) -> io::Result<PipeStream> {
        let w = wide(name.as_os_str());
        let deadline = Instant::now() + Duration::from_secs(5);
        let h = loop {
            // Identification only: the server may learn who we are, never act as us.
            let flags = FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION;
            let h = unsafe { CreateFileW(w.as_ptr(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_NONE, null(), OPEN_EXISTING, flags, null_mut()) };
            if h != INVALID_HANDLE_VALUE {
                break h;
            }
            let e = io::Error::last_os_error();
            if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && Instant::now() < deadline {
                unsafe { WaitNamedPipeW(w.as_ptr(), 500) };
                continue;
            }
            return Err(e);
        };
        let s = PipeStream(Arc::new(Pipe::new(h)?));
        check_server(h, server_pid)?;
        Ok(s)
    }

    pub fn try_clone(&self) -> PipeStream {
        PipeStream(self.0.clone())
    }

    /// Close the connection: pending reads and writes on every clone return, and the other end
    /// sees the pipe break.
    pub fn shutdown(&self) {
        self.0.shutdown();
    }
}

/// Fail unless the process serving the connected pipe `h` is `want`.
fn check_server(h: HANDLE, want: u32) -> io::Result<()> {
    let mut got = 0u32;
    if unsafe { GetNamedPipeServerProcessId(h, &mut got) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if got != want {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the pipe is served by process {got}, not the runtime the shell started ({want}); nothing was sent"),
        ));
    }
    Ok(())
}

impl Read for PipeStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl Write for PipeStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A pipe server, for the tests and `fake_homerund` only: it keeps the default security
/// descriptor. The real server is `homerund`, whose pipe admits the current user alone (§5.2).
pub struct PipeListener {
    name: Vec<u16>,
    next: Option<Arc<Pipe>>,
}

impl PipeListener {
    /// Create the pipe's first instance; fails if the name is taken.
    pub fn bind(name: &Path) -> io::Result<PipeListener> {
        let name = wide(name.as_os_str());
        let first = instance(&name, true)?;
        Ok(PipeListener { name, next: Some(first) })
    }

    /// Wait for a client, and have the next instance ready for the one after.
    ///
    /// An instance is open to clients from its creation, before `accept` is called. A client that
    /// connected and already hung up by then (a refused peer check does exactly that) leaves the
    /// instance with no data: it is reset and waits again, keeping the name alive throughout.
    pub fn accept(&mut self) -> io::Result<PipeStream> {
        let p = match self.next.take() {
            Some(p) => p,
            None => instance(&self.name, false)?,
        };
        loop {
            match p.overlapped(INFINITE, |h, ov| unsafe { ConnectNamedPipe(h, ov) }) {
                Ok(_) => break,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_CONNECTED as i32) => break,
                Err(e) if e.raw_os_error() == Some(ERROR_NO_DATA as i32) => {
                    if unsafe { DisconnectNamedPipe(p.h) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Err(e) => return Err(e),
            }
        }
        self.next = Some(instance(&self.name, false)?);
        Ok(PipeStream(p))
    }
}

fn instance(name: &[u16], first: bool) -> io::Result<Arc<Pipe>> {
    let open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
    let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    let h = unsafe { CreateNamedPipeW(name.as_ptr(), open, mode, PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, null()) };
    if h == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(Arc::new(Pipe::new(h)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn name(tag: &str) -> PathBuf {
        PathBuf::from(format!(r"\\.\pipe\hr-pipe-{}-{tag}", std::process::id()))
    }

    /// A client that connects and hangs up before the server gets to `accept` (a refused peer
    /// check) neither ends the listener nor leaves the name missing for the next client.
    #[test]
    fn a_client_gone_before_accept_does_not_end_the_listener() {
        let n = name("gone");
        let mut l = PipeListener::bind(&n).unwrap();
        // Connect and hang up while nobody is accepting.
        drop(PipeStream::connect(&n, std::process::id()).unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut s = l.accept().unwrap();
            let mut b = [0u8; 5];
            s.read_exact(&mut b).unwrap();
            tx.send(b).unwrap();
        });
        let mut c = PipeStream::connect(&n, std::process::id()).unwrap();
        c.write_all(b"hello").unwrap();
        assert_eq!(&rx.recv_timeout(Duration::from_secs(10)).unwrap(), b"hello");
    }

    /// The peer check refuses a pipe another process serves, before anything is written, and the
    /// error says so.
    #[test]
    fn the_wrong_server_pid_is_refused() {
        let n = name("pid");
        let _l = PipeListener::bind(&n).unwrap();
        let e = PipeStream::connect(&n, std::process::id() + 4).err().expect("refused");
        assert_eq!(e.kind(), io::ErrorKind::PermissionDenied, "{e}");
    }
}
