//! The shell's own settings (§5.1, §11): a small JSON file next to the runtime's data. The
//! system is the source of truth for the login item and notification permission; this file only
//! remembers what the shell asked and did.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    pub version: u32,
    /// The onboarding step "Keep Homerun running" was shown (§5.1). M7 installs see it once.
    pub keep_running_asked: bool,
    /// Schedules that *Pause All Monitors* paused, so *Resume* restores only those (§8.2).
    pub paused_by_pause_all: Vec<String>,
    /// Settings → Updates: download in the background, install on quit (§11).
    pub auto_download_updates: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { version: 1, keep_running_asked: false, paused_by_pause_all: vec![], auto_download_updates: true }
    }
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("shell-prefs.json")
}

/// A missing or unreadable file gives the defaults: nothing in it is worth refusing to start for.
pub fn load(path: &Path) -> Prefs {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Write-then-rename, so a crash mid-write leaves the old file.
pub fn save(path: &Path, prefs: &Prefs) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(prefs).map_err(std::io::Error::other)?)?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_defaults_and_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("hr-prefs-{}", std::process::id()));
        let p = path(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&p), Prefs::default(), "missing file");
        assert!(Prefs::default().auto_download_updates);
        let v = Prefs { keep_running_asked: true, paused_by_pause_all: vec!["a".into()], ..Default::default() };
        save(&p, &v).unwrap();
        assert_eq!(load(&p), v);
        // An older file without newer fields, and a newer one with unknown fields, both load.
        std::fs::write(&p, r#"{"version":1,"keep_running_asked":true,"from_the_future":1}"#).unwrap();
        let l = load(&p);
        assert!(l.keep_running_asked && l.auto_download_updates && l.paused_by_pause_all.is_empty());
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(load(&p), Prefs::default(), "corrupt file");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
