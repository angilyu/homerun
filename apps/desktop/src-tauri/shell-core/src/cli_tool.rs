//! *Install command-line tool* (§5.2): a symlink `~/.local/bin/homerun` to the release CLI in
//! the app bundle, `Homerun.app/Contents/MacOS/homerun-cli`. No admin rights and no shell: the
//! link is the user's own, and the UI shows how to put `~/.local/bin` on `PATH` rather than
//! reading anyone's shell profile. It never replaces a file that isn't a link to some Homerun's
//! CLI, and it won't link to a copy that is about to go away (a disk image or a translocated app).
//! Windows has no bundled CLI to link yet (§18 row @cli): every status there is `Unavailable`.

use serde::Serialize;
use std::fs;
use std::io;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

pub const LINK_NAME: &str = "homerun";
pub const BUNDLED_CLI: &str = "homerun-cli";
pub const PATH_HINT: &str = "export PATH=\"$HOME/.local/bin:$PATH\"";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ToolStatus {
    /// No CLI to link to: a development build, or an app that must be moved first.
    Unavailable {
        reason: String,
    },
    NotInstalled {
        link: PathBuf,
    },
    Installed {
        link: PathBuf,
    },
    /// A link to another copy of Homerun's CLI; installing points it here.
    OtherCopy {
        link: PathBuf,
        target: PathBuf,
    },
    /// A link to a Homerun CLI that is gone: the app moved or was deleted.
    Dangling {
        link: PathBuf,
        target: PathBuf,
    },
    /// Something that isn't Homerun's is in the way; it is left alone.
    Foreign {
        link: PathBuf,
    },
}

/// Where the app runs from, and so where its CLI is.
#[derive(Clone, Debug)]
pub struct Place {
    pub home: PathBuf,
    /// The shell's own executable, `…/Homerun.app/Contents/MacOS/homerun`.
    pub exe: PathBuf,
}

impl Place {
    pub fn link(&self) -> PathBuf {
        self.home.join(".local").join("bin").join(LINK_NAME)
    }

    /// The bundled CLI, or why there isn't one to link to.
    pub fn cli(&self) -> Result<PathBuf, String> {
        if cfg!(windows) {
            return Err("On Windows the command-line tool isn't installed from the app yet.".into());
        }
        let exe = self.exe.to_string_lossy();
        if !exe.contains(".app/Contents/MacOS/") {
            return Err("The command-line tool comes with the Homerun app; this is a development build.".into());
        }
        if exe.contains("/AppTranslocation/") || exe.starts_with("/Volumes/") {
            return Err("Move Homerun to your Applications folder first, then install the command-line tool.".into());
        }
        let cli = self.exe.with_file_name(BUNDLED_CLI);
        if !cli.is_file() {
            return Err("This copy of Homerun has no command-line tool.".into());
        }
        Ok(cli)
    }
}

/// A link target that is some Homerun's bundled CLI.
fn ours(target: &Path) -> bool {
    let t = target.to_string_lossy();
    t.ends_with(&format!(".app/Contents/MacOS/{BUNDLED_CLI}")) && target.is_absolute()
}

fn same(a: &Path, b: &Path) -> bool {
    a == b || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

pub fn status(p: &Place) -> ToolStatus {
    let link = p.link();
    let cli = match p.cli() {
        Ok(c) => Some(c),
        Err(reason) => {
            // Still report a link it could remove.
            if fs::symlink_metadata(&link).is_err() {
                return ToolStatus::Unavailable { reason };
            }
            None
        }
    };
    let Ok(meta) = fs::symlink_metadata(&link) else { return ToolStatus::NotInstalled { link } };
    if !meta.file_type().is_symlink() {
        return ToolStatus::Foreign { link };
    }
    let Ok(target) = fs::read_link(&link) else { return ToolStatus::Foreign { link } };
    if !ours(&target) {
        return ToolStatus::Foreign { link };
    }
    if cli.as_deref().is_some_and(|c| same(&target, c)) {
        return ToolStatus::Installed { link };
    }
    if target.exists() {
        ToolStatus::OtherCopy { link, target }
    } else {
        ToolStatus::Dangling { link, target }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ToolError(pub String);

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn io_err(what: &str, e: io::Error) -> ToolError {
    ToolError(format!("Couldn't {what}: {e}"))
}

fn in_the_way(link: &Path) -> ToolError {
    ToolError(format!("{} already exists and isn't Homerun's. Remove it first, or leave it and run the tool from the app.", link.display()))
}

pub fn install(p: &Place) -> Result<ToolStatus, ToolError> {
    let cli = p.cli().map_err(ToolError)?;
    let link = p.link();
    match status(p) {
        ToolStatus::Installed { .. } => return Ok(status(p)),
        ToolStatus::Foreign { .. } => return Err(in_the_way(&link)),
        ToolStatus::Unavailable { reason } => return Err(ToolError(reason)),
        ToolStatus::NotInstalled { .. } => {
            let dir = link.parent().expect("the link has a directory");
            fs::create_dir_all(dir).map_err(|e| io_err(&format!("create {}", dir.display()), e))?;
            // Fails if anything appeared meanwhile, rather than replacing it.
            symlink(&cli, &link).map_err(|e| if e.kind() == io::ErrorKind::AlreadyExists { in_the_way(&link) } else { io_err("create the link", e) })?;
        }
        ToolStatus::OtherCopy { .. } | ToolStatus::Dangling { .. } => {
            let tmp = link.with_file_name(format!(".{LINK_NAME}.{}.tmp", std::process::id()));
            let _ = fs::remove_file(&tmp);
            symlink(&cli, &tmp).map_err(|e| io_err("create the link", e))?;
            // Still one of ours? Then swap it atomically.
            let still_ours = fs::read_link(&link).is_ok_and(|t| ours(&t));
            let r = if still_ours { fs::rename(&tmp, &link).map_err(|e| io_err("replace the link", e)) } else { Err(in_the_way(&link)) };
            if r.is_err() {
                let _ = fs::remove_file(&tmp);
            }
            r?;
        }
    }
    Ok(status(p))
}

#[cfg(not(unix))]
fn symlink(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

pub fn remove(p: &Place) -> Result<ToolStatus, ToolError> {
    let link = p.link();
    match status(p) {
        ToolStatus::Foreign { .. } => return Err(in_the_way(&link)),
        ToolStatus::Installed { .. } | ToolStatus::OtherCopy { .. } | ToolStatus::Dangling { .. } => {
            fs::remove_file(&link).map_err(|e| io_err("remove the link", e))?;
        }
        ToolStatus::NotInstalled { .. } | ToolStatus::Unavailable { .. } => {}
    }
    Ok(status(p))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A HOME and an app bundle with a CLI in it.
    fn setup(name: &str) -> (Tmp, Place, PathBuf) {
        let root = std::env::temp_dir().join(format!("hr-cli-tool-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let macos = root.join("Applications/Homerun.app/Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        let cli = macos.join(BUNDLED_CLI);
        fs::write(&cli, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        (Tmp(root), Place { home, exe: macos.join("homerun") }, cli)
    }

    #[test]
    fn install_creates_the_directory_and_the_link_and_is_idempotent() {
        let (_t, p, cli) = setup("install");
        assert_eq!(status(&p), ToolStatus::NotInstalled { link: p.link() });
        assert_eq!(install(&p), Ok(ToolStatus::Installed { link: p.link() }));
        assert_eq!(fs::read_link(p.link()).unwrap(), cli);
        assert_eq!(install(&p), Ok(ToolStatus::Installed { link: p.link() }));
        assert_eq!(remove(&p), Ok(ToolStatus::NotInstalled { link: p.link() }));
        assert!(fs::symlink_metadata(p.link()).is_err());
        assert_eq!(remove(&p), Ok(ToolStatus::NotInstalled { link: p.link() }));
    }

    #[test]
    fn never_replaces_or_removes_what_isnt_homeruns() {
        let (_t, p, _) = setup("foreign");
        fs::create_dir_all(p.link().parent().unwrap()).unwrap();
        // A file, a link elsewhere, a link to something merely named homerun-cli, a directory.
        type Make = Box<dyn Fn(&Path)>;
        let cases: Vec<Make> = vec![
            Box::new(|l| fs::write(l, "mine").unwrap()),
            Box::new(|l| symlink("/usr/local/bin/other", l).unwrap()),
            Box::new(|l| symlink("/tmp/homerun-cli", l).unwrap()),
            Box::new(|l| symlink("Homerun.app/Contents/MacOS/homerun-cli", l).unwrap()),
            Box::new(|l| fs::create_dir(l).unwrap()),
        ];
        for (i, make) in cases.iter().enumerate() {
            let l = p.link();
            make(&l);
            let before = fs::symlink_metadata(&l).unwrap();
            assert_eq!(status(&p), ToolStatus::Foreign { link: l.clone() }, "case {i}");
            assert!(install(&p).unwrap_err().0.contains("isn't Homerun's"), "case {i}");
            assert!(remove(&p).is_err(), "case {i}");
            let after = fs::symlink_metadata(&l).unwrap();
            assert_eq!((before.file_type(), before.len()), (after.file_type(), after.len()), "case {i} untouched");
            if after.is_dir() {
                fs::remove_dir(&l).unwrap();
            } else {
                fs::remove_file(&l).unwrap();
            }
        }
    }

    #[test]
    fn replaces_a_link_to_another_or_a_vanished_copy() {
        let (t, p, cli) = setup("other");
        let old = t.0.join("Downloads/Homerun.app/Contents/MacOS");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(BUNDLED_CLI), "").unwrap();
        fs::create_dir_all(p.link().parent().unwrap()).unwrap();
        symlink(old.join(BUNDLED_CLI), p.link()).unwrap();
        assert_eq!(status(&p), ToolStatus::OtherCopy { link: p.link(), target: old.join(BUNDLED_CLI) });
        assert_eq!(install(&p), Ok(ToolStatus::Installed { link: p.link() }));
        assert_eq!(fs::read_link(p.link()).unwrap(), cli);

        fs::remove_file(p.link()).unwrap();
        let gone = PathBuf::from("/Applications/Old Homerun.app/Contents/MacOS/homerun-cli");
        symlink(&gone, p.link()).unwrap();
        assert_eq!(status(&p), ToolStatus::Dangling { link: p.link(), target: gone });
        assert_eq!(install(&p), Ok(ToolStatus::Installed { link: p.link() }));
        let leftovers: Vec<_> = fs::read_dir(p.link().parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(LINK_NAME)], "no temporary link left behind");
    }

    #[test]
    fn a_moved_app_leaves_a_dangling_link_it_can_remove() {
        let (t, p, _) = setup("moved");
        install(&p).unwrap();
        fs::rename(t.0.join("Applications/Homerun.app"), t.0.join("Applications/Moved.app")).unwrap();
        let moved = Place { exe: t.0.join("Applications/Moved.app/Contents/MacOS/homerun"), ..p.clone() };
        assert!(matches!(status(&moved), ToolStatus::Dangling { .. }));
        assert_eq!(install(&moved), Ok(ToolStatus::Installed { link: p.link() }));
    }

    #[test]
    fn refuses_development_builds_disk_images_and_translocated_apps() {
        let (_t, p, _) = setup("where");
        for (exe, says) in [
            ("/Users/me/homerun/target/debug/homerun", "development build"),
            ("/Volumes/Homerun/Homerun.app/Contents/MacOS/homerun", "Applications folder"),
            ("/private/var/folders/x/AppTranslocation/ABC/d/Homerun.app/Contents/MacOS/homerun", "Applications folder"),
        ] {
            let q = Place { exe: exe.into(), ..p.clone() };
            match status(&q) {
                ToolStatus::Unavailable { reason } => assert!(reason.contains(says), "{exe}: {reason}"),
                s => panic!("{exe}: {s:?}"),
            }
            assert!(install(&q).unwrap_err().0.contains(says), "{exe}");
            assert!(fs::symlink_metadata(q.link()).is_err(), "{exe}: nothing created");
        }
        fs::remove_file(p.exe.with_file_name(BUNDLED_CLI)).unwrap();
        assert!(install(&p).unwrap_err().0.contains("no command-line tool"));
    }

    #[test]
    fn a_development_build_can_still_remove_an_installed_link() {
        let (_t, p, _) = setup("dev-remove");
        install(&p).unwrap();
        let dev = Place { exe: "/Users/me/homerun/target/debug/homerun".into(), ..p.clone() };
        assert!(matches!(status(&dev), ToolStatus::OtherCopy { .. }));
        assert_eq!(remove(&dev), Ok(ToolStatus::Unavailable { reason: dev.cli().unwrap_err() }));
    }

    #[test]
    fn status_serializes_for_the_webview() {
        let s = serde_json::to_value(ToolStatus::NotInstalled { link: "/h/.local/bin/homerun".into() }).unwrap();
        assert_eq!(s, serde_json::json!({"state": "not_installed", "link": "/h/.local/bin/homerun"}));
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_has_nothing_to_link_so_nothing_is_touched() {
        let home = std::env::temp_dir().join(format!("hr-cli-tool-win-{}", std::process::id()));
        let p = Place { home: home.clone(), exe: home.join("Homerun").join("homerun.exe") };
        assert!(matches!(status(&p), ToolStatus::Unavailable { .. }));
        assert!(install(&p).is_err());
        assert!(!home.exists());
    }
}
