//! Crash reports the shell writes (§11 "Diagnostics"): its own panics, and the runtime exits its
//! supervisor observes. The shell never sends anything: it writes the same allowlisted JSON as
//! the runtime's reports into `<data>/crash-reports/`, and the runtime, which re-parses each file
//! through its allowlist (`apps/homerund/src/diagnostics/scrub.ts`), sends them if and only if the
//! user turned crash reports on. A file that doesn't pass is deleted there.
//!
//! A report holds the exception type, stack frames (function, a module path relative to the
//! source tree, line), how the runtime ended, and the app, OS, arch, version and channel. Never
//! the panic message: it can quote anything.

use crate::token::launch_token;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CRASH_DIR: &str = "crash-reports";
/// Reports kept on disk; the runtime prunes the same way.
pub const MAX_SPOOLED: usize = 20;
const MAX_FRAMES: usize = 50;

#[derive(Clone, Debug, PartialEq)]
pub struct Build {
    pub version: String,
    pub channel: String,
}

impl Build {
    /// The shell's build: a debug build is its own channel, so a policy or a report filter for
    /// stable never mixes in development builds (as the runtime does).
    pub fn this(version: &str, release_channel: Option<&str>) -> Build {
        let channel = if cfg!(debug_assertions) { "development" } else { release_channel.filter(|c| !c.is_empty()).unwrap_or("stable") };
        Build { version: version.into(), channel: channel.into() }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Frame {
    pub function: String,
    pub module: String,
    pub lineno: Option<u32>,
}

pub fn os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        _ => "unknown",
    }
}

fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn tag(v: &str) -> String {
    let ok = !v.is_empty()
        && v.len() <= 64
        && v.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && v.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c));
    if ok {
        v.to_string()
    } else {
        "unknown".into()
    }
}

/// The report the runtime's `CrashReport` schema accepts.
pub fn report(kind: &str, at: u64, build: &Build, exception_type: &str, frames: &[Frame], exit: Option<(Option<i32>, Option<i32>)>) -> Value {
    let id: String = launch_token().map(|t| t[..32].to_string()).unwrap_or_else(|_| format!("{:032x}", at as u128 ^ (std::process::id() as u128) << 64));
    let mut r = json!({
        "v": 1,
        "id": id,
        "kind": kind,
        "at": at,
        "app": "shell",
        "exception_type": exception_type,
        "frames": frames.iter().take(MAX_FRAMES).map(|f| json!({"function": f.function, "module": f.module, "lineno": f.lineno})).collect::<Vec<_>>(),
        "os": os(),
        "arch": tag(std::env::consts::ARCH),
        "version": tag(&build.version),
        "channel": tag(&build.channel),
    });
    if let Some((code, signal)) = exit {
        r["exit"] = json!({"code": code, "signal": signal.map(signal_name)});
    }
    r
}

/// A report for a runtime that ended unexpectedly, or that the shell ended because it hung.
pub fn runtime_exited(build: &Build, code: Option<i32>, signal: Option<i32>, hung: bool) -> Value {
    report("runtime_exited", wall_ms(), build, if hung { "RuntimeHung" } else { "RuntimeExited" }, &[], Some((code, signal)))
}

/// Write a report: a new private file, `<at>-<id>.json`, then keep the newest 20. Never follows
/// or replaces an existing file.
pub fn spool(dir: &Path, report: &Value) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let name = format!("{}-{}.json", report["at"].as_u64().unwrap_or(0), report["id"].as_str().unwrap_or("0"));
    let path = dir.join(name);
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(&path)?;
    f.write_all(report.to_string().as_bytes())?;
    drop(f);
    prune(dir);
    Ok(path)
}

fn prune(dir: &Path) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".json")).collect();
    names.sort();
    let extra = names.len().saturating_sub(MAX_SPOOLED);
    for n in &names[..extra] {
        let _ = fs::remove_file(dir.join(n));
    }
}

/// Common POSIX signals by name; others by number.
pub fn signal_name(s: i32) -> String {
    match s {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        3 => "SIGQUIT".into(),
        4 => "SIGILL".into(),
        5 => "SIGTRAP".into(),
        6 => "SIGABRT".into(),
        8 => "SIGFPE".into(),
        9 => "SIGKILL".into(),
        10 if cfg!(target_os = "macos") => "SIGBUS".into(),
        7 if cfg!(target_os = "linux") => "SIGBUS".into(),
        11 => "SIGSEGV".into(),
        13 => "SIGPIPE".into(),
        15 => "SIGTERM".into(),
        n => n.unsigned_abs().to_string(),
    }
}

// ---------------------------------------------------------------- frames

/// A Rust symbol as the runtime's allowlist takes it: `::` as `.`, closures as `<closure>`, the
/// symbol hash dropped. Anything else (generic impls, spaces) is `?`.
pub fn function_name(raw: &str) -> String {
    let mut s = raw.trim().replace("{{closure}}", "<closure>").replace("::", ".");
    if let Some(i) = s.rfind(".h") {
        let tail = &s[i + 2..];
        if tail.len() == 16 && tail.chars().all(|c| c.is_ascii_hexdigit()) {
            s.truncate(i);
        }
    }
    let ok = !s.is_empty()
        && s.len() <= 150
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$' || c == '<')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "_$.<>".contains(c));
    if ok {
        s
    } else {
        "?".into()
    }
}

/// Where a path sits in the source trees the build came from, or `<external>`. The same roots as
/// the runtime's `relativeModule`: the repository's `apps/`, `packages/` and `src-tauri/`, a
/// crate from the registry, the Rust standard library, or an already relative `src/…`.
pub fn module_path(raw: &str) -> String {
    let p = raw.trim().replace('\\', "/");
    let rel = if let Some(i) = p.find("/.cargo/registry/src/") {
        let rest = &p[i + "/.cargo/registry/src/".len()..];
        rest.split_once('/').map(|(_, r)| format!("crates/{r}"))
    } else if let Some(rest) = p.strip_prefix("/rustc/") {
        rest.split_once('/').map(|(_, r)| format!("rustc/{r}"))
    } else if let Some(i) = p.find("/src-tauri/") {
        Some(p[i + 1..].to_string())
    } else if let Some(i) = p.find("/apps/").or_else(|| p.find("/packages/")) {
        Some(p[i + 1..].to_string())
    } else if p.starts_with('/') || p.starts_with('~') || p.get(1..3) == Some(":/") {
        None
    } else {
        let r = p.trim_start_matches("./").to_string();
        let first = r.split('/').next().unwrap_or("");
        ["src", "apps", "packages", "shell-core", "src-tauri", "crates", "rustc", "library"].contains(&first).then_some(r)
    };
    match rel {
        Some(r) if valid_module(&r) => r,
        _ => "<external>".into(),
    }
}

fn valid_module(r: &str) -> bool {
    let parts: Vec<&str> = r.split('/').collect();
    parts.len() <= 16
        && parts.iter().all(|s| {
            !s.is_empty()
                && *s != ".."
                && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || "_@$-".contains(c))
                && s.chars().all(|c| c.is_ascii_alphanumeric() || "_@$.-".contains(c))
        })
}

/// Frames from `std::backtrace::Backtrace`'s text: `  N: symbol` lines, each optionally followed
/// by `at path:line:col`. The panic machinery's own frames are dropped.
pub fn frames_from_backtrace(text: &str) -> Vec<Frame> {
    let mut out: Vec<Frame> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(loc) = t.strip_prefix("at ") {
            if let Some(f) = out.last_mut() {
                let mut it = loc.rsplitn(3, ':');
                let (_col, line_no, path) = (it.next(), it.next(), it.next());
                if let (Some(l), Some(p)) = (line_no.and_then(|l| l.parse::<u32>().ok()), path) {
                    f.module = module_path(p);
                    f.lineno = Some(l.min(10_000_000));
                }
            }
            continue;
        }
        let Some((n, sym)) = t.split_once(": ") else { continue };
        if n.is_empty() || !n.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        out.push(Frame { function: function_name(sym), module: "<native>".into(), lineno: None });
    }
    // Everything up to and including the panic entry points is the hook's own machinery.
    let start = out
        .iter()
        .rposition(|f| {
            f.function.starts_with("std.panicking.")
                || f.function.starts_with("core.panicking.")
                || f.function == "rust_begin_unwind"
                || f.function == "__rustc.rust_begin_unwind"
        })
        .map(|i| i + 1)
        .unwrap_or(0);
    out.into_iter().skip(start).take(MAX_FRAMES).collect()
}

/// Write a `shell_panic` report for every panic, then run the previous hook (which prints to
/// stderr as before). The panic's message and payload are never recorded.
pub fn install_panic_hook(dir: PathBuf, build: Build) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        let mut frames = frames_from_backtrace(&bt);
        // Where it panicked, even when the binary has no symbols.
        if let Some(loc) = info.location() {
            frames.insert(0, Frame { function: "?".into(), module: module_path(loc.file()), lineno: Some(loc.line()) });
            frames.truncate(MAX_FRAMES);
        }
        let _ = spool(&dir, &report("shell_panic", wall_ms(), &build, "Panic", &frames, None));
        prev(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hr-crash-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn rust_symbols_become_allowlisted_names() {
        assert_eq!(function_name("homerun_shell_core::runtime::Driver::apply::h0123456789abcdef"), "homerun_shell_core.runtime.Driver.apply");
        assert_eq!(function_name("homerun::main::{{closure}}"), "homerun.main.<closure>");
        assert_eq!(function_name("<alloc::boxed::Box<F,A> as core::ops::function::Fn<Args>>::call"), "?");
        assert_eq!(function_name("weird name with spaces"), "?");
        assert_eq!(function_name(&"a".repeat(200)), "?");
    }

    #[test]
    fn paths_are_relative_to_the_source_trees_or_external() {
        assert_eq!(module_path("/Users/runner/work/homerun/homerun/apps/desktop/src-tauri/src/main.rs"), "src-tauri/src/main.rs");
        assert_eq!(module_path("/Users/alice/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.12.0/src/app.rs"), "crates/tauri-2.12.0/src/app.rs");
        assert_eq!(module_path("/rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/panicking.rs"), "rustc/library/std/src/panicking.rs");
        assert_eq!(module_path("./src/shell.rs"), "src/shell.rs");
        assert_eq!(module_path("shell-core/src/runtime.rs"), "shell-core/src/runtime.rs");
        assert_eq!(module_path("C:\\Users\\alice\\homerun\\apps\\desktop\\src-tauri\\src\\win.rs"), "src-tauri/src/win.rs");
        for bad in [
            "/Users/alice/Documents/payroll.xlsx",
            "C:\\Users\\alice\\notes.txt",
            "~/x.rs",
            "Documents/x.rs",
            "src/../../../etc/passwd",
            "src/a b.rs",
            "../../Users/alice/x.rs",
        ] {
            assert_eq!(module_path(bad), "<external>", "{bad}");
        }
    }

    #[test]
    fn backtrace_text_becomes_frames_without_the_panic_machinery() {
        let bt = "   0: std::backtrace_rs::backtrace::libunwind::trace
             at /rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/../../backtrace/src/backtrace/libunwind.rs:117:9
   1: std::panicking::begin_panic_handler
             at /rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/panicking.rs:697:5
   2: core::panicking::panic_fmt
             at /rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/core/src/panicking.rs:75:14
   3: homerun::shell::start::h00112233445566aa
             at /Users/alice/homerun/apps/desktop/src-tauri/src/shell.rs:42:7
   4: secret_stuff_for_alice
             at /Users/alice/Documents/payroll.rs:1:1
   5: main
";
        assert_eq!(
            frames_from_backtrace(bt),
            vec![
                Frame { function: "homerun.shell.start".into(), module: "src-tauri/src/shell.rs".into(), lineno: Some(42) },
                Frame { function: "secret_stuff_for_alice".into(), module: "<external>".into(), lineno: Some(1) },
                Frame { function: "main".into(), module: "<native>".into(), lineno: None },
            ]
        );
    }

    #[test]
    fn a_report_has_the_runtime_schema_and_no_message() {
        let b = Build { version: "0.3.0".into(), channel: "stable".into() };
        let r = report("shell_panic", 1_700_000_000_000, &b, "Panic", &[Frame { function: "f".into(), module: "src/a.rs".into(), lineno: Some(3) }], None);
        let keys: Vec<&str> = r.as_object().unwrap().keys().map(String::as_str).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(sorted, ["app", "arch", "at", "channel", "exception_type", "frames", "id", "kind", "os", "v", "version"]);
        assert_eq!(r["id"].as_str().unwrap().len(), 32);
        assert!(r["id"].as_str().unwrap().chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        let e = runtime_exited(&Build { version: "0.3.0 /Users/alice".into(), channel: "stable".into() }, None, Some(9), false);
        assert_eq!(e["exit"], json!({"code": null, "signal": "SIGKILL"}));
        assert_eq!(e["version"], "unknown");
        assert_eq!(e["kind"], "runtime_exited");
    }

    #[test]
    fn spooled_privately_never_replacing_and_capped() {
        let d = tmp("spool");
        let b = Build { version: "0.3.0".into(), channel: "stable".into() };
        for i in 0..(MAX_SPOOLED as u64 + 3) {
            spool(&d, &report("runtime_exited", 1_000 + i, &b, "RuntimeExited", &[], Some((Some(1), None)))).unwrap();
        }
        let mut names: Vec<String> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names.len(), MAX_SPOOLED);
        assert!(names[0].starts_with("1003-"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(d.join(&names[0])).unwrap().permissions().mode() & 0o077, 0);
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn the_panic_hook_writes_a_report_without_the_message() {
        let d = tmp("hook");
        install_panic_hook(d.clone(), Build { version: "0.3.0".into(), channel: "stable".into() });
        let r = std::panic::catch_unwind(|| panic!("secret prompt for alice@example.com at /Users/alice/x"));
        let _ = std::panic::take_hook();
        assert!(r.is_err());
        let files: Vec<PathBuf> = fs::read_dir(&d).unwrap().map(|e| e.unwrap().path()).collect();
        assert_eq!(files.len(), 1);
        let text = fs::read_to_string(&files[0]).unwrap();
        assert!(!text.contains("secret") && !text.contains("alice"), "{text}");
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["kind"], "shell_panic");
        assert_eq!(v["frames"][0]["module"], "shell-core/src/crash.rs");
        let _ = fs::remove_dir_all(&d);
    }
}
