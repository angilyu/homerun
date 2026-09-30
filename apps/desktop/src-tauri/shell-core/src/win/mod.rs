//! The Windows calls the shell core makes (§5.1, §5.2): the named pipe, job objects and the
//! system random source. Everything here is a thin, safe wrapper; the decisions are elsewhere.

pub mod job;
pub mod pipe;

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};

/// An owned kernel handle, closed on drop.
pub struct Handle(pub HANDLE);

// A kernel handle is a process-wide index; any thread may use or close it.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Handle {
    /// Take ownership of `h`, or the last error if it is null or invalid.
    pub fn new(h: HANDLE) -> io::Result<Handle> {
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            Err(io::Error::last_os_error())
        } else {
            Ok(Handle(h))
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// `s` as a NUL-terminated UTF-16 string.
pub fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// Fill `buf` from the system's preferred random source (`BCryptGenRandom`): Windows has no
/// `/dev/urandom`.
pub fn random(buf: &mut [u8]) -> io::Result<()> {
    let len = u32::try_from(buf.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too many random bytes"))?;
    let status = unsafe { BCryptGenRandom(std::ptr::null_mut(), buf.as_mut_ptr(), len, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    if status < 0 {
        return Err(io::Error::other(format!("BCryptGenRandom failed ({status:#x})")));
    }
    Ok(())
}
