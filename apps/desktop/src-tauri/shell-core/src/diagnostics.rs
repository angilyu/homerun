//! Settings → *Create diagnostic bundle* (§11 "Diagnostics"). The webview previews the file
//! list; only the shell, after its native save panel, asks the runtime to write the zip, so a
//! compromised webview can't choose where files land (`diagnostics.create` is FILE_WRITERS).

use crate::allowlist::ShellError;
use crate::keys::ShellCalls;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// What the save panel suggests; the runtime's own default (Downloads) carries a timestamp.
pub const SUGGESTED_NAME: &str = "homerun-diagnostics.zip";

/// `name.zip`, adding the extension when the user typed none.
pub fn with_zip(p: &Path) -> PathBuf {
    let zip = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    if zip {
        p.to_path_buf()
    } else {
        let mut s = p.as_os_str().to_owned();
        s.push(".zip");
        PathBuf::from(s)
    }
}

/// Write the bundle. `chosen`: the save panel's answer, `None` for the runtime's default in
/// Downloads. `replace`: the panel already asked about a file of that name, so it goes first;
/// a file the panel didn't ask about (we added `.zip`) is never replaced. The runtime creates
/// the file exclusively either way.
pub fn save(conn: Option<&dyn ShellCalls>, chosen: Option<&Path>, replace: bool) -> Result<Value, ShellError> {
    let conn = conn.ok_or_else(|| ShellError::not_connected("Homerun's runtime isn't running."))?;
    let params = match chosen {
        None => json!({}),
        Some(p) => {
            if !p.is_absolute() {
                return Err(ShellError::shell("Choose a folder for the bundle."));
            }
            let target = with_zip(p);
            if replace && target == p {
                match std::fs::symlink_metadata(&target) {
                    Ok(m) if m.is_file() || m.file_type().is_symlink() => {
                        std::fs::remove_file(&target).map_err(|e| ShellError::shell(format!("Couldn't replace it: {e}")))?
                    }
                    Ok(_) => return Err(ShellError::shell("That's a folder.")),
                    Err(_) => {}
                }
            }
            json!({"path": target.to_string_lossy()})
        }
    };
    conn.call("diagnostics.create", params).map_err(ShellError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{CallError, RpcError};
    use std::sync::Mutex;

    struct Fake {
        calls: Mutex<Vec<(String, Value)>>,
    }
    impl ShellCalls for Fake {
        fn call(&self, method: &str, params: Value) -> Result<Value, CallError> {
            self.calls.lock().unwrap().push((method.into(), params.clone()));
            match params["path"].as_str() {
                Some(p) if Path::new(p).exists() => {
                    Err(CallError::Rpc(RpcError { code: -32006, message: "A file with that name already exists.".into(), data: None }))
                }
                Some(p) => Ok(json!({"path": p, "bytes": 10, "files": []})),
                None => Ok(json!({"path": "/Users/x/Downloads/homerun-diagnostics-20260101-000000.zip", "bytes": 10, "files": []})),
            }
        }
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hr-diag-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn default_location_and_extension() {
        let f = Fake { calls: Mutex::new(vec![]) };
        save(Some(&f), None, false).unwrap();
        let d = dir("ext");
        save(Some(&f), Some(&d.join("bundle")), false).unwrap();
        save(Some(&f), Some(&d.join("b.ZIP")), false).unwrap();
        let calls = f.calls.lock().unwrap().clone();
        assert_eq!(calls[0], ("diagnostics.create".into(), json!({})));
        assert_eq!(calls[1].1["path"], d.join("bundle.zip").to_string_lossy().as_ref());
        assert_eq!(calls[2].1["path"], d.join("b.ZIP").to_string_lossy().as_ref());
        assert!(save(Some(&f), Some(Path::new("relative.zip")), false).is_err());
        assert_eq!(save(None, None, false).unwrap_err().kind, "not_connected");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replaces_only_what_the_panel_asked_about() {
        let f = Fake { calls: Mutex::new(vec![]) };
        let d = dir("replace");
        let asked = d.join("old.zip");
        std::fs::write(&asked, "old").unwrap();
        assert_eq!(save(Some(&f), Some(&asked), false).unwrap_err().code, Some(-32006));
        assert!(asked.exists());
        save(Some(&f), Some(&asked), true).unwrap();
        assert!(!asked.exists(), "removed, then the runtime writes it");
        // The panel asked about `notes`, not `notes.zip`.
        std::fs::write(d.join("notes.zip"), "keep").unwrap();
        assert!(save(Some(&f), Some(&d.join("notes")), true).is_err());
        assert_eq!(std::fs::read_to_string(d.join("notes.zip")).unwrap(), "keep");
        // Never a folder.
        std::fs::create_dir(d.join("f.zip")).unwrap();
        assert_eq!(save(Some(&f), Some(&d.join("f.zip")), true).unwrap_err().message, "That's a folder.");
        let _ = std::fs::remove_dir_all(&d);
    }
}
