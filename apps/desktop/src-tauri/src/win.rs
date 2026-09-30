//! Win32 glue for the shell on Windows (§5.1, §18 row 64), the counterpart of macos.rs,
//! power.rs, login_item.rs, notifications.rs and keychain.rs's AppKit and Security code. As on
//! macOS, everything that decides lives in `shell-core`; this only talks to the system.
//!
//! - Launch at login: the per-user `Run` value passes `--autostart` (`shell-core::login`).
//! - Logout, restart and shutdown: a hidden top-level window hears `WM_QUERYENDSESSION` and
//!   `WM_ENDSESSION`; the runtime is stopped before the session ends, and nothing is held up.
//! - Sleep and wake: `PowerRegisterSuspendResumeNotification`, on a system thread.
//! - Dialogs: task dialogs from comctl32 v6 (the manifest tauri-build embeds), found at run time
//!   so a binary without that manifest still loads; the CLI access prompt then fails closed.
//! - Toasts: WinRT's `ToastNotificationManager`, under an AppUserModelID registered in HKCU.
//! - The API key: Credential Manager (see keychain.rs).

use crate::macos::Gone;
use crate::power::{now_ms, PowerEvent};
use homerun_shell_core::cli_access::{Answer, Prompt};
use homerun_shell_core::login::{self, LoginItem};
use homerun_shell_core::notify::{toast_tag, Permission, Post, Target};
use homerun_shell_core::quit::Dialog;
use std::ffi::c_void;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use windows::core::{s, w, BOOL, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE, HWND, LPARAM, LRESULT, S_OK, WPARAM};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW};
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_ROUTINE_FLAGS, REG_SZ, RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
};
use windows::Win32::UI::Controls::{
    TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TASKDIALOG_FLAGS, TASKDIALOG_NOTIFICATIONS, TDCBF_CANCEL_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER,
    TDM_CLICK_BUTTON, TDN_CREATED, TDN_TIMER, TD_WARNING_ICON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, MessageBoxW, RegisterClassW, SendMessageW, SetForegroundWindow, IDCANCEL, IDOK, MB_ICONQUESTION, MB_OKCANCEL,
    MB_SETFOREGROUND, WINDOW_EX_STYLE, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW, WS_OVERLAPPED,
};

/// The AppUserModelID toasts are posted under, and the Credential Manager's target prefix.
pub const APP_ID: &str = "com.angilyu.homerun";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------------------------
// Launch, logout and shutdown

/// Started by the `Run` value (§5.1): it passes `--autostart`.
pub fn launched_at_login() -> bool {
    std::env::args_os().skip(1).any(|a| a == login::AUTOSTART_ARG)
}

static POWERING_OFF: AtomicBool = AtomicBool::new(false);

/// The session is ending: logout, restart or shutdown (§5.1).
pub fn powering_off() -> bool {
    POWERING_OFF.load(Ordering::SeqCst)
}

type Hook = Box<dyn Fn() -> bool + Send + Sync>;
static QUIT_HOOK: OnceLock<Hook> = OnceLock::new();
type OnEnd = Box<dyn Fn() + Send + Sync>;
static ON_END: OnceLock<OnEnd> = OnceLock::new();

/// What the session window does when the session is really ending: stop the runtime (§5.1).
pub fn on_session_end(f: impl Fn() + Send + Sync + 'static) {
    let _ = ON_END.set(Box::new(f));
}

unsafe extern "system" fn session_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_QUERYENDSESSION => {
            // Never hold up a logout or shutdown (§5.1): the answer is always yes.
            POWERING_OFF.store(true, Ordering::SeqCst);
            if let Some(h) = QUIT_HOOK.get() {
                h();
            }
            LRESULT(1)
        }
        WM_ENDSESSION => {
            if wp.0 != 0 {
                // The process ends when this returns. While the runtime stops, Windows shows why.
                let _ = unsafe { windows::Win32::System::Shutdown::ShutdownBlockReasonCreate(hwnd, w!("Homerun is saving its runs.")) };
                if let Some(f) = ON_END.get() {
                    f();
                }
                let _ = unsafe { windows::Win32::System::Shutdown::ShutdownBlockReasonDestroy(hwnd) };
            } else {
                POWERING_OFF.store(false, Ordering::SeqCst);
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}

/// Windows has no `terminate:` to route: the tray's *Quit* is the only way to quit, and it
/// already asks (lifecycle.rs). What is left is the session ending, which only top-level windows
/// hear, so this makes a hidden one on the main thread, whose message loop (tao's) serves it.
/// `hook` is told, as macOS's is, and always lets the session end.
pub fn install_quit_hook(hook: impl Fn() -> bool + Send + Sync + 'static) -> bool {
    if QUIT_HOOK.set(Box::new(hook)).is_err() {
        return false;
    }
    unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return false };
        let class = w!("HomerunSession");
        let wc = WNDCLASSW { lpfnWndProc: Some(session_proc), hInstance: module.into(), lpszClassName: class, ..Default::default() };
        if RegisterClassW(&wc) == 0 {
            return false;
        }
        CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("Homerun"), WS_OVERLAPPED, 0, 0, 0, 0, None, None, Some(module.into()), None).is_ok()
    }
}

/// The session window hears the end of the session already.
pub fn observe_power_off() {}

// ---------------------------------------------------------------------------------------------
// Sleep and wake

static SLEPT_AT: AtomicU64 = AtomicU64::new(0);
type OnPower = Box<dyn Fn(PowerEvent) + Send + Sync>;
static ON_POWER: OnceLock<OnPower> = OnceLock::new();

unsafe extern "system" fn power_callback(_ctx: *const c_void, kind: u32, _setting: *const c_void) -> u32 {
    use windows::Win32::UI::WindowsAndMessaging::{PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND};
    let Some(f) = ON_POWER.get() else { return 0 };
    match kind {
        PBT_APMSUSPEND => {
            let at = now_ms();
            SLEPT_AT.store(at, Ordering::SeqCst);
            f(PowerEvent::WillSleep { at });
        }
        // Every resume sends this; PBT_APMRESUMESUSPEND follows only when a user is there.
        PBT_APMRESUMEAUTOMATIC => {
            let slept = SLEPT_AT.swap(0, Ordering::SeqCst);
            f(PowerEvent::DidWake { at: now_ms(), slept_at: (slept != 0).then_some(slept) });
        }
        _ => {}
    }
    0
}

/// `on_event` for each suspend and resume, on a system thread. The registration lives as long
/// as the process. False if Windows refused it, or it was already made; the runtime's own tick-gap
/// check still catches up after a sleep (§8.4).
pub fn observe_power(on_event: impl Fn(PowerEvent) + Send + Sync + 'static) -> bool {
    use windows::Win32::System::Power::{PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS};
    use windows::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK;
    if ON_POWER.set(Box::new(on_event)).is_err() {
        return false;
    }
    // The system keeps the pointer: the parameters live as long as the process.
    let params: &'static mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS =
        Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS { Callback: Some(power_callback), Context: std::ptr::null_mut() }));
    let mut handle: *mut c_void = std::ptr::null_mut();
    let r = unsafe { PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK, HANDLE(params as *mut _ as *mut c_void), &mut handle) };
    r == ERROR_SUCCESS
}

// ---------------------------------------------------------------------------------------------
// Dialogs

type TaskDialogIndirect = unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> HRESULT;

/// comctl32 v6's `TaskDialogIndirect`, which only the manifest tauri-build embeds activates.
fn task_dialog() -> Option<TaskDialogIndirect> {
    unsafe {
        let m = LoadLibraryW(w!("comctl32.dll")).ok()?;
        let f = GetProcAddress(m, s!("TaskDialogIndirect"))?;
        Some(std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirect>(f))
    }
}

const ID_CONFIRM: i32 = 100;
const ID_DENY: i32 = 101;
const ID_ALLOW: i32 = 102;

struct Watch<'a> {
    gone: Option<&'a Gone>,
}

unsafe extern "system" fn dialog_callback(hwnd: HWND, msg: TASKDIALOG_NOTIFICATIONS, _wp: WPARAM, _lp: LPARAM, data: isize) -> HRESULT {
    let watch = unsafe { &*(data as *const Watch) };
    if msg == TDN_CREATED {
        let _ = unsafe { SetForegroundWindow(hwnd) };
    } else if msg == TDN_TIMER && watch.gone.is_some_and(|g| g()) {
        // Closes it as Esc would: no answer.
        unsafe { SendMessageW(hwnd, TDM_CLICK_BUTTON.0 as u32, Some(WPARAM(IDCANCEL.0 as usize)), Some(LPARAM(0))) };
    }
    S_OK
}

/// A task dialog with `buttons`; the first is the default (Return). Esc and the close box
/// cancel. `None` when comctl32 v6 isn't there.
fn show(title: &str, instruction: &str, content: &str, buttons: &[(i32, &str)], cancel_button: bool, warn: bool, gone: Option<&Gone>) -> Option<i32> {
    let run = task_dialog()?;
    let (title, instruction, content) = (wide(title), wide(instruction), wide(content));
    let labels: Vec<Vec<u16>> = buttons.iter().map(|(_, l)| wide(l)).collect();
    let tb: Vec<TASKDIALOG_BUTTON> =
        buttons.iter().zip(&labels).map(|((id, _), l)| TASKDIALOG_BUTTON { nButtonID: *id, pszButtonText: PCWSTR(l.as_ptr()) }).collect();
    let watch = Watch { gone };
    let mut cfg = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | if gone.is_some() { TDF_CALLBACK_TIMER } else { TASKDIALOG_FLAGS(0) },
        pszWindowTitle: PCWSTR(title.as_ptr()),
        pszMainInstruction: PCWSTR(instruction.as_ptr()),
        pszContent: PCWSTR(content.as_ptr()),
        cButtons: tb.len() as u32,
        pButtons: tb.as_ptr(),
        nDefaultButton: buttons.first().map(|b| b.0).unwrap_or(0),
        pfCallback: Some(dialog_callback),
        lpCallbackData: &watch as *const Watch as isize,
        ..Default::default()
    };
    if cancel_button {
        cfg.dwCommonButtons = TDCBF_CANCEL_BUTTON;
    }
    if warn {
        cfg.Anonymous1.pszMainIcon = TD_WARNING_ICON;
    }
    let mut pressed = 0i32;
    let r = unsafe { run(&cfg, &mut pressed, std::ptr::null_mut(), std::ptr::null_mut()) };
    Some(if r.is_ok() { pressed } else { IDCANCEL.0 })
}

/// The quit confirmation (§5.1): *Quit* (Return) or *Cancel* (Esc). Main thread.
pub fn confirm(d: &Dialog) -> bool {
    if let Some(r) = show("Homerun", &d.title, &d.message, &[(ID_CONFIRM, &d.confirm)], true, false, None) {
        return r == ID_CONFIRM;
    }
    let text = HSTRING::from(format!("{}\n\n{}", d.title, d.message));
    unsafe { MessageBoxW(None, &text, w!("Homerun"), MB_OKCANCEL | MB_ICONQUESTION | MB_SETFOREGROUND) == IDOK }
}

/// The CLI access prompt (§5.2): **Don't Allow** is the default button (Return), **Allow** has
/// to be chosen, and Esc or the close box is no answer. A timer closes it with no answer once
/// `gone` says so. Without task dialogs there is no prompt: the request expires unanswered,
/// which the CLI reports as denied.
pub fn ask_cli_access(p: &Prompt, gone: Gone) -> Answer {
    match show("Homerun", &p.title, &p.message, &[(ID_DENY, &p.deny), (ID_ALLOW, &p.allow)], false, true, Some(&gone)) {
        Some(ID_DENY) => Answer::DontAllow,
        Some(ID_ALLOW) => Answer::Allow,
        _ => Answer::Dismissed,
    }
}

// ---------------------------------------------------------------------------------------------
// Open at login

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const APPROVED_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run");

fn reg_get(key: PCWSTR, name: &str, flags: REG_ROUTINE_FLAGS) -> Option<Vec<u8>> {
    let name = wide(name);
    let mut size = 0u32;
    unsafe {
        if RegGetValueW(HKEY_CURRENT_USER, key, PCWSTR(name.as_ptr()), flags, None, None, Some(&mut size)) != ERROR_SUCCESS {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        if RegGetValueW(HKEY_CURRENT_USER, key, PCWSTR(name.as_ptr()), flags, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) != ERROR_SUCCESS {
            return None;
        }
        buf.truncate(size as usize);
        Some(buf)
    }
}

fn reg_string(key: PCWSTR, name: &str) -> Option<String> {
    let b = reg_get(key, name, RRF_RT_REG_SZ)?;
    let units: Vec<u16> = b.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).take_while(|&u| u != 0).collect();
    Some(String::from_utf16_lossy(&units))
}

pub fn login_status() -> LoginItem {
    // `tauri dev`'s executable is rebuilt in place; only a built app starts at login.
    if cfg!(debug_assertions) {
        return LoginItem::Unavailable;
    }
    let Ok(exe) = std::env::current_exe() else { return LoginItem::Unavailable };
    let run = reg_string(RUN_KEY, login::RUN_VALUE);
    let approved = reg_get(APPROVED_KEY, login::RUN_VALUE, RRF_RT_REG_BINARY);
    LoginItem::from_windows(run.as_deref(), &exe, approved.as_deref())
}

/// Adds or removes the `Run` value. Task Manager's switch is the user's and is left alone: if
/// they turned Homerun off there, Settings shows *Needs approval* and links to it.
pub fn login_set(on: bool) -> Result<LoginItem, String> {
    if cfg!(debug_assertions) {
        return Err("Open at login needs a built app.".into());
    }
    let name = wide(login::RUN_VALUE);
    let r = unsafe {
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let data = wide(&login::run_command(&exe));
            RegSetKeyValueW(HKEY_CURRENT_USER, RUN_KEY, PCWSTR(name.as_ptr()), REG_SZ.0, Some(data.as_ptr().cast()), (data.len() * 2) as u32)
        } else {
            match RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, PCWSTR(name.as_ptr())) {
                ERROR_FILE_NOT_FOUND => ERROR_SUCCESS,
                e => e,
            }
        }
    };
    if r != ERROR_SUCCESS {
        return Err(format!("Windows refused ({}).", r.0));
    }
    Ok(login_status())
}

// ---------------------------------------------------------------------------------------------
// Opening things

/// A web or mail link, or an `ms-settings:` page, in its default handler. No shell parses it.
pub fn shell_open(target: &str) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(target), None, None, SW_SHOWNORMAL) };
    // Values above 32 mean success.
    if r.0 as usize > 32 {
        Ok(())
    } else {
        Err(format!("Windows couldn't open it ({}).", r.0 as usize))
    }
}

/// A file selected in Explorer. Paths can't contain `"`, so quoting is enough.
pub fn reveal(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", path.display())).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub const STARTUP_SETTINGS: &str = "ms-settings:startupapps";
pub const NOTIFICATION_SETTINGS: &str = "ms-settings:notifications";

// ---------------------------------------------------------------------------------------------
// Toasts

/// Toasts need an AppUserModelID Windows knows: an unpackaged app registers one under HKCU
/// (the installer, milestone 11, adds a Start menu shortcut with the same ID).
fn register_app_id() {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let key = wide(&format!("Software\\Classes\\AppUserModelId\\{APP_ID}"));
    let name = wide("Homerun");
    unsafe {
        let _ = RegSetKeyValueW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), w!("DisplayName"), REG_SZ.0, Some(name.as_ptr().cast()), (name.len() * 2) as u32);
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID));
    }
}

enum Cmd {
    Post(Post),
    Withdraw(String),
    Status(mpsc::Sender<Permission>),
}

static TOASTS: OnceLock<Mutex<mpsc::Sender<Cmd>>> = OnceLock::new();
const GROUP: &str = "homerun";
/// Toasts kept so their click handler lives; older ones are only in Action Center.
const KEEP: usize = 64;

fn send(c: Cmd) -> bool {
    TOASTS.get().is_some_and(|t| t.lock().unwrap().send(c).is_ok())
}

type OnClick = std::sync::Arc<dyn Fn(Target) + Send + Sync>;

/// One thread owns WinRT (a multithreaded apartment): posts, withdrawals and status go to it in
/// order.
pub fn toasts_init(on_click: impl Fn(Target) + Send + Sync + 'static) {
    let (tx, rx) = mpsc::channel::<Cmd>();
    if TOASTS.set(Mutex::new(tx)).is_err() {
        return;
    }
    register_app_id();
    let on_click: OnClick = std::sync::Arc::new(on_click);
    let _ = std::thread::Builder::new().name("toasts".into()).spawn(move || toast_thread(rx, on_click));
}

fn toast_thread(rx: mpsc::Receiver<Cmd>, on_click: OnClick) {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::UI::Notifications::{NotificationSetting, ToastNotificationManager};
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let app = HSTRING::from(APP_ID);
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&app).ok();
    let mut kept: std::collections::VecDeque<(String, windows::UI::Notifications::ToastNotification)> = Default::default();
    for cmd in rx {
        match cmd {
            Cmd::Post(p) => {
                let Some(n) = &notifier else { continue };
                if let Ok(t) = toast(&p, on_click.clone()) {
                    if n.Show(&t).is_ok() {
                        let tag = toast_tag(&p.key);
                        kept.retain(|(k, _)| *k != tag);
                        kept.push_back((tag, t));
                        if kept.len() > KEEP {
                            kept.pop_front();
                        }
                    }
                }
            }
            Cmd::Withdraw(key) => {
                let tag = toast_tag(&key);
                kept.retain(|(k, _)| *k != tag);
                if let Ok(h) = ToastNotificationManager::History() {
                    let _ = h.RemoveGroupedTagWithId(&HSTRING::from(tag), &HSTRING::from(GROUP), &app);
                }
            }
            Cmd::Status(reply) => {
                let s = match notifier.as_ref().map(|n| n.Setting()) {
                    Some(Ok(NotificationSetting::Enabled)) => Permission::Allowed,
                    Some(Ok(_)) => Permission::Denied,
                    _ => Permission::Unavailable,
                };
                let _ = reply.send(s);
            }
        }
    }
}

/// Title and body as text nodes, so nothing in them is read as markup; silent, as on macOS.
fn toast(p: &Post, on_click: OnClick) -> windows::core::Result<windows::UI::Notifications::ToastNotification> {
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager, ToastTemplateType};
    let kind = if p.body.is_empty() { ToastTemplateType::ToastText01 } else { ToastTemplateType::ToastText02 };
    let doc = ToastNotificationManager::GetTemplateContent(kind)?;
    let texts = doc.GetElementsByTagName(&HSTRING::from("text"))?;
    for (i, s) in [&p.title, &p.body].into_iter().enumerate().take(texts.Length()? as usize) {
        texts.Item(i as u32)?.AppendChild(&doc.CreateTextNode(&HSTRING::from(s.as_str()))?)?;
    }
    let audio = doc.CreateElement(&HSTRING::from("audio"))?;
    audio.SetAttribute(&HSTRING::from("silent"), &HSTRING::from("true"))?;
    doc.DocumentElement()?.AppendChild(&audio)?;
    let t = ToastNotification::CreateToastNotification(&doc)?;
    t.SetTag(&HSTRING::from(toast_tag(&p.key)))?;
    t.SetGroup(&HSTRING::from(GROUP))?;
    let target = p.target.clone();
    t.Activated(&TypedEventHandler::new(move |_, _| {
        on_click(target.clone());
        Ok(())
    }))?;
    Ok(t)
}

pub fn toast_post(p: &Post) {
    send(Cmd::Post(p.clone()));
}

pub fn toast_withdraw(key: &str) {
    send(Cmd::Withdraw(key.to_string()));
}

/// Settings → Notifications → Homerun. Windows doesn't ask: toasts are on until turned off.
pub fn toast_status() -> Permission {
    let (tx, rx) = mpsc::channel();
    if !send(Cmd::Status(tx)) {
        return Permission::Unavailable;
    }
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or(Permission::Unavailable)
}

// ---------------------------------------------------------------------------------------------
// Credential Manager

/// A generic credential per account, `com.angilyu.homerun/<account>`, persisted on this machine
/// only (never roamed). Any process running as this user can read it, like a keychain item
/// without an ACL (§13, §18 row 62). Errors are Win32 codes.
pub mod cred {
    use super::wide;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{ERROR_NOT_FOUND, WIN32_ERROR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_FLAGS, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn target(service: &str, account: &str) -> Vec<u16> {
        wide(&format!("{service}/{account}"))
    }

    fn code(e: windows::core::Error) -> i32 {
        WIN32_ERROR::from_error(&e).map(|w| w.0 as i32).unwrap_or(e.code().0)
    }

    pub fn get(service: &str, account: &str) -> Result<Option<String>, i32> {
        let t = target(service, account);
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        match unsafe { CredReadW(windows::core::PCWSTR(t.as_ptr()), CRED_TYPE_GENERIC, None, &mut p) } {
            Err(e) if WIN32_ERROR::from_error(&e) == Some(ERROR_NOT_FOUND) => Ok(None),
            Err(e) => Err(code(e)),
            Ok(()) => {
                let c = unsafe { &*p };
                let bytes = if c.CredentialBlob.is_null() {
                    vec![]
                } else {
                    unsafe { std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize) }.to_vec()
                };
                unsafe { CredFree(p as *const _) };
                String::from_utf8(bytes).map(Some).map_err(|_| -1)
            }
        }
    }

    pub fn set(service: &str, account: &str, value: &str) -> Result<(), i32> {
        let mut t = target(service, account);
        let mut user = wide("Homerun");
        let mut blob = value.as_bytes().to_vec();
        let c = CREDENTIALW {
            Flags: CRED_FLAGS(0),
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(t.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        let r = unsafe { CredWriteW(&c, 0) }.map_err(code);
        blob.fill(0);
        r
    }

    pub fn delete(service: &str, account: &str) -> Result<(), i32> {
        let t = target(service, account);
        match unsafe { CredDeleteW(windows::core::PCWSTR(t.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Err(e) if WIN32_ERROR::from_error(&e) != Some(ERROR_NOT_FOUND) => Err(code(e)),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dummy value on the allowlist; never a real key.
    const DUMMY: &str = "sk-ant-TEST-not-a-real-key";

    #[test]
    fn a_credential_round_trips_and_deleting_twice_is_fine() {
        let service = format!("{APP_ID}.test-{}", std::process::id());
        assert_eq!(cred::get(&service, "anthropic_api_key"), Ok(None));
        cred::set(&service, "anthropic_api_key", DUMMY).unwrap();
        assert_eq!(cred::get(&service, "anthropic_api_key").unwrap().as_deref(), Some(DUMMY));
        cred::set(&service, "anthropic_api_key", "sk-ant-mock-not-a-real-key").unwrap();
        assert_eq!(cred::get(&service, "anthropic_api_key").unwrap().as_deref(), Some("sk-ant-mock-not-a-real-key"));
        assert_eq!(cred::get(&service, "other"), Ok(None));
        cred::delete(&service, "anthropic_api_key").unwrap();
        assert_eq!(cred::get(&service, "anthropic_api_key"), Ok(None));
        cred::delete(&service, "anthropic_api_key").unwrap();
    }

    #[test]
    fn registry_strings_read_back_and_a_missing_value_is_none() {
        use windows::Win32::System::Registry::RegDeleteTreeW;
        let key = wide(&format!("Software\\Homerun-test-{}", std::process::id()));
        let key = PCWSTR(key.as_ptr());
        let name = wide("Homerun");
        let data = wide(&login::run_command(Path::new("C:\\Program Files\\Homerun\\homerun.exe")));
        let r = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key, PCWSTR(name.as_ptr()), REG_SZ.0, Some(data.as_ptr().cast()), (data.len() * 2) as u32) };
        assert_eq!(r, ERROR_SUCCESS);
        let back = reg_string(key, "Homerun");
        let missing = reg_string(key, "Nothing");
        let _ = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, key) };
        let _ = unsafe { windows::Win32::System::Registry::RegDeleteKeyW(HKEY_CURRENT_USER, key) };
        assert_eq!(back.as_deref(), Some(login::run_command(Path::new("C:\\Program Files\\Homerun\\homerun.exe")).as_str()));
        assert_eq!(missing, None);
    }

    #[test]
    fn sleep_and_wake_registration_is_accepted_once() {
        assert!(observe_power(|_| {}));
        assert!(!observe_power(|_| {}));
    }
}
