//! AppKit glue for the process model (§5.1): how the app was launched, the quit hook, the
//! power-off signal and native alerts, including the CLI access prompt (§5.2). Everything that
//! decides lives in `shell-core`. On Windows the same functions come from win.rs.

#[cfg(not(windows))]
use homerun_shell_core::cli_access::{Answer, Prompt};
#[cfg(not(windows))]
use homerun_shell_core::quit::Dialog;

/// Polled by the CLI access prompt; true closes it with no answer.
pub type Gone = Box<dyn Fn() -> bool + Send + Sync>;

/// A real `.app` launch, as opposed to `tauri dev`'s bare binary: `SMAppService` and
/// `UNUserNotificationCenter` need a bundle.
#[cfg(target_os = "macos")]
pub fn in_app_bundle() -> bool {
    std::env::current_exe().ok().is_some_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{Answer, Dialog, Gone, Prompt};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, msg_send, sel, MainThreadMarker};
    use objc2_app_kit::{NSAlert, NSAlertStyle, NSApplication, NSWorkspace, NSWorkspaceWillPowerOffNotification};
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager, NSNotification, NSRunLoop, NSRunLoopCommonModes, NSString, NSTimer};
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    const fn code(s: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*s)
    }

    fn current_event() -> Option<Retained<NSAppleEventDescriptor>> {
        NSAppleEventManager::sharedAppleEventManager().currentAppleEvent()
    }

    /// Launched by the login item (§5.1): the open-application event carries
    /// `keyAELaunchedAsLogInItem`. Read from `setup`, which runs inside
    /// `applicationDidFinishLaunching:` while that event is still current.
    pub fn launched_at_login() -> bool {
        let Some(ev) = current_event() else { return false };
        // eventID and paramDescriptorForKeyword: are behind objc2-core-services; msg_send avoids it.
        let id: u32 = unsafe { msg_send![&*ev, eventID] };
        if id != code(b"oapp") {
            return false;
        }
        let prop: Option<Retained<NSAppleEventDescriptor>> = unsafe { msg_send![&*ev, paramDescriptorForKeyword: code(b"prdt")] };
        prop.is_some_and(|p| p.enumCodeValue() == code(b"lgit"))
    }

    static POWERING_OFF: AtomicBool = AtomicBool::new(false);

    /// Logout, restart or shutdown (§5.1): `NSWorkspaceWillPowerOffNotification`, or the quit
    /// event's `kAEQuitReason`.
    pub fn powering_off() -> bool {
        if POWERING_OFF.load(Ordering::SeqCst) {
            return true;
        }
        let Some(ev) = current_event() else { return false };
        let why: Option<Retained<NSAppleEventDescriptor>> = unsafe { msg_send![&*ev, attributeDescriptorForKeyword: code(b"why?")] };
        why.is_some_and(|w| [b"logo", b"rlgo", b"rrst", b"rsdn", b"rest", b"shut"].iter().any(|c| w.typeCodeValue() == code(c)))
    }

    pub fn observe_power_off() {
        let block = RcBlock::new(|_: NonNull<NSNotification>| POWERING_OFF.store(true, Ordering::SeqCst));
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let token = unsafe { center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceWillPowerOffNotification), None, None, &block) };
        std::mem::forget(token);
    }

    type Hook = Box<dyn Fn() -> bool + Send + Sync>;
    static HOOK: OnceLock<Hook> = OnceLock::new();

    extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> usize {
        // NSTerminateNow = 1, NSTerminateCancel = 0.
        usize::from(HOOK.get().is_none_or(|f| f()))
    }

    /// Route every `terminate:` (⌘Q, Dock → Quit, AppleScript, logout) through `hook`, which
    /// returns true to quit now. tao's app delegate has no `applicationShouldTerminate:`, so it is
    /// added to its class; if a later tao grows one, nothing is replaced and this returns false
    /// (the caller then puts its own ⌘Q item in the menu).
    pub fn install_quit_hook(hook: impl Fn() -> bool + Send + Sync + 'static) -> bool {
        let Some(mtm) = MainThreadMarker::new() else { return false };
        let app = NSApplication::sharedApplication(mtm);
        let Some(delegate) = app.delegate() else { return false };
        let obj: &AnyObject = delegate.as_ref();
        let cls: &AnyClass = obj.class();
        let sel = sel!(applicationShouldTerminate:);
        if cls.instance_method(sel).is_some() || HOOK.set(Box::new(hook)).is_err() {
            return false;
        }
        let imp: Imp = unsafe { std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize, Imp>(should_terminate) };
        let added = unsafe { ffi::class_addMethod(cls as *const AnyClass as *mut AnyClass, sel, imp, c"Q@:@".as_ptr()) }.as_bool();
        // NSApplication caches which delegate methods exist when the delegate is set.
        app.setDelegate(Some(&delegate));
        added
    }

    #[allow(deprecated)]
    fn activate(mtm: MainThreadMarker) {
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    }

    /// A native alert, so it works with no window open. Main thread only.
    pub fn confirm(d: &Dialog) -> bool {
        let Some(mtm) = MainThreadMarker::new() else { return false };
        activate(mtm);
        let a = NSAlert::new(mtm);
        a.setMessageText(&NSString::from_str(&d.title));
        a.setInformativeText(&NSString::from_str(&d.message));
        a.addButtonWithTitle(&NSString::from_str(&d.confirm));
        // "Cancel" gets Esc from AppKit.
        a.addButtonWithTitle(&NSString::from_str("Cancel"));
        a.runModal() == 1000
    }

    /// The CLI access prompt (§5.2), also used to link a device by code (§10.5): app-modal, so it shows with no window open. **Don't Allow**
    /// is the first button and gets Return; **Allow** has no key equivalent and needs a click. A
    /// timer in the common run-loop modes, which run inside `runModal`, closes it with no answer
    /// once `gone` says so: the request was withdrawn, expired, or its runtime went away.
    pub fn ask_cli_access(p: &Prompt, gone: Gone) -> Answer {
        let Some(mtm) = MainThreadMarker::new() else { return Answer::Dismissed };
        activate(mtm);
        let a = NSAlert::new(mtm);
        a.setAlertStyle(NSAlertStyle::Warning);
        a.setMessageText(&NSString::from_str(&p.title));
        a.setInformativeText(&NSString::from_str(&p.message));
        a.addButtonWithTitle(&NSString::from_str(&p.deny));
        let allow = a.addButtonWithTitle(&NSString::from_str(&p.allow));
        allow.setKeyEquivalent(&NSString::from_str(""));
        let tick = RcBlock::new(move |_: std::ptr::NonNull<NSTimer>| {
            if gone() {
                if let Some(mtm) = MainThreadMarker::new() {
                    NSApplication::sharedApplication(mtm).abortModal();
                }
            }
        });
        // The block is Send + Sync, as the method requires.
        let timer = unsafe { NSTimer::timerWithTimeInterval_repeats_block(0.25, true, &tick) };
        unsafe { NSRunLoop::currentRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
        let r = a.runModal();
        timer.invalidate();
        match r {
            1000 => Answer::DontAllow,
            1001 => Answer::Allow,
            _ => Answer::Dismissed,
        }
    }
}

#[cfg(windows)]
mod imp {
    pub use crate::win::{ask_cli_access, confirm, install_quit_hook, launched_at_login, observe_power_off, powering_off};
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::{Answer, Dialog, Gone, Prompt};
    pub fn launched_at_login() -> bool {
        false
    }
    pub fn powering_off() -> bool {
        false
    }
    pub fn observe_power_off() {}
    pub fn install_quit_hook(_hook: impl Fn() -> bool + Send + Sync + 'static) -> bool {
        false
    }
    pub fn confirm(_d: &Dialog) -> bool {
        true
    }
    /// No prompt: the request expires unanswered.
    pub fn ask_cli_access(_p: &Prompt, _gone: Gone) -> Answer {
        Answer::Dismissed
    }
}

pub use imp::*;
