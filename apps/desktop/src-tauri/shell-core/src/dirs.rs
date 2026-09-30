//! Where Homerun keeps its data, as `@homerun/client`'s `dataDir` resolves it, so the shell's
//! log and prefs land next to the runtime's data: `HOMERUN_DATA_DIR`, else
//! `~/Library/Application Support/Homerun` on macOS, `%LOCALAPPDATA%\Homerun` on Windows (local,
//! so it never roams with the profile).

use std::ffi::OsString;
use std::path::PathBuf;

pub fn data_dir(windows: bool, env: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    let set = |k: &str| env(k).filter(|v| !v.is_empty());
    if let Some(d) = set("HOMERUN_DATA_DIR") {
        return PathBuf::from(d);
    }
    if windows {
        let local = set("LOCALAPPDATA").map(PathBuf::from).or_else(|| set("USERPROFILE").map(|h| PathBuf::from(h).join("AppData").join("Local")));
        return local.unwrap_or_else(std::env::temp_dir).join("Homerun");
    }
    let home = set("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    home.join("Library").join("Application Support").join("Homerun")
}

/// The user's home: `HOME`, or `USERPROFILE` on Windows.
pub fn home(windows: bool, env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    env(if windows { "USERPROFILE" } else { "HOME" }).filter(|h| !h.is_empty()).map(PathBuf::from)
}

pub fn this_data_dir() -> PathBuf {
    data_dir(cfg!(windows), |k| std::env::var_os(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v))
    }

    #[test]
    fn the_override_wins_everywhere() {
        for w in [false, true] {
            assert_eq!(data_dir(w, env(&[("HOMERUN_DATA_DIR", "/x/y"), ("HOME", "/h"), ("LOCALAPPDATA", "L")])), PathBuf::from("/x/y"));
        }
    }

    #[test]
    fn windows_uses_local_app_data_then_the_profile() {
        let d = data_dir(true, env(&[("LOCALAPPDATA", "C:\\Users\\a\\AppData\\Local"), ("HOME", "/nope")]));
        assert_eq!(d, PathBuf::from("C:\\Users\\a\\AppData\\Local").join("Homerun"));
        let d = data_dir(true, env(&[("LOCALAPPDATA", ""), ("USERPROFILE", "C:\\Users\\a")]));
        assert_eq!(d, PathBuf::from("C:\\Users\\a").join("AppData").join("Local").join("Homerun"));
        assert_eq!(home(true, env(&[("HOME", "/h"), ("USERPROFILE", "C:\\Users\\a")])), Some(PathBuf::from("C:\\Users\\a")));
    }

    #[test]
    fn macos_uses_application_support() {
        let d = data_dir(false, env(&[("HOME", "/Users/a"), ("LOCALAPPDATA", "L")]));
        assert_eq!(d, PathBuf::from("/Users/a/Library/Application Support/Homerun"));
        assert_eq!(home(false, env(&[("USERPROFILE", "C:\\x")])), None);
    }
}
