//! AppKit glue for the process model (§5.1): how the app was launched, the quit hook, the
//! power-off signal and native alerts. Everything that decides lives in `shell-core`.

use homerun_shell_core::quit::Dialog;

/// A real `.app` launch, as opposed to `tauri dev`'s bare binary: `SMAppService` and
/// `UNUserNotificationCenter` need a bundle.
pub fn in_app_bundle() -> bool {
    std::env::current_exe().ok().is_some_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Dialog;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{ffi, msg_send, sel, MainThreadMarker};
    use objc2_app_kit::{NSAlert, NSApplication, NSWorkspace, NSWorkspaceWillPowerOffNotification};
    use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventManager, NSNotification, NSString};
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
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::Dialog;
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
}

pub use imp::*;
