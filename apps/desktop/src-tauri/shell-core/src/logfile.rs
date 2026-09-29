use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// An append-only log with one rotation: at `max` bytes the file becomes `<name>.1`, replacing
/// the previous one (§5.1: the shell captures the runtime's stderr into `logs/homerund.log`).
/// The runtime scrubs secrets before writing (§5.2), so the shell writes lines as they come.
pub struct LogFile {
    path: PathBuf,
    max: u64,
    file: Option<File>,
    size: u64,
}

impl LogFile {
    pub fn new(path: impl Into<PathBuf>, max: u64) -> Self {
        LogFile { path: path.into(), max, file: None, size: 0 }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn line(&mut self, line: &str) {
        if self.file.is_none() {
            if let Some(dir) = self.path.parent() {
                let _ = fs::create_dir_all(dir);
            }
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
            self.size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        }
        if self.size >= self.max {
            self.file = None;
            let mut old = self.path.clone().into_os_string();
            old.push(".1");
            let _ = fs::rename(&self.path, old);
            self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
            self.size = 0;
        }
        if let Some(f) = self.file.as_mut() {
            if writeln!(f, "{line}").is_ok() {
                self.size += line.len() as u64 + 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_once() {
        let dir = std::env::temp_dir().join(format!("hr-log-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut l = LogFile::new(dir.join("logs").join("x.log"), 20);
        // 7 bytes a line: 0–2, rotate, 3–5, rotate, 6. Only one old file is kept.
        for i in 0..7 {
            l.line(&format!("line {i}"));
        }
        let cur = fs::read_to_string(dir.join("logs/x.log")).unwrap();
        let old = fs::read_to_string(dir.join("logs/x.log.1")).unwrap();
        assert_eq!(cur, "line 6\n");
        assert_eq!(old, "line 3\nline 4\nline 5\n");
        fs::remove_dir_all(&dir).ok();
    }
}
