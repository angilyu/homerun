//! Local notifications (§8.2, §9.7) through `UNUserNotificationCenter`. The runtime writes the
//! text and `shell-core` decides what goes out; this posts, withdraws and routes a click to its
//! screen. No action buttons and no sound: approvals are answered in the app (§9.7).

pub use homerun_shell_core::notify::Permission;
use homerun_shell_core::notify::{Post, Target};
use std::sync::atomic::{AtomicBool, Ordering};

static FOCUSED: AtomicBool = AtomicBool::new(false);

/// The window's focus, from Tauri's window events. While Homerun is in front its own UI shows the
/// same thing, so a banner would only repeat it.
pub fn set_focused(f: bool) {
    FOCUSED.store(f, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSArray, NSError, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSettings, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::sync::OnceLock;
    use std::time::Duration;

    type OnClick = Box<dyn Fn(Target) + Send + Sync>;
    static ON_CLICK: OnceLock<OnClick> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(&self, _c: &UNUserNotificationCenter, _n: &UNNotification, done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
                let opts = if FOCUSED.load(Ordering::SeqCst) {
                    UNNotificationPresentationOptions::empty()
                } else {
                    UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List
                };
                done.call((opts,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(&self, _c: &UNUserNotificationCenter, r: &UNNotificationResponse, done: &DynBlock<dyn Fn()>) {
                let t = r.notification().request().content().threadIdentifier().to_string();
                if let Some(f) = ON_CLICK.get() {
                    f(Target::from_thread_identifier(&t));
                }
                done.call(());
            }
        }
    );

    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        // currentNotificationCenter throws outside a bundle.
        crate::macos::in_app_bundle().then(UNUserNotificationCenter::currentNotificationCenter)
    }

    /// Set the delegate before `applicationDidFinishLaunching:` returns, so a click that launched
    /// the app is delivered too.
    pub fn init(on_click: impl Fn(Target) + Send + Sync + 'static) {
        let Some(c) = center() else { return };
        let _ = ON_CLICK.set(Box::new(on_click));
        let d: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        c.setDelegate(Some(ProtocolObject::from_ref(&*d)));
        // The center holds its delegate weakly; this one lives as long as the app.
        std::mem::forget(d);
    }

    pub fn post(p: &Post) {
        let Some(c) = center() else { return };
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&p.title));
        if !p.body.is_empty() {
            content.setBody(&NSString::from_str(&p.body));
        }
        content.setThreadIdentifier(&NSString::from_str(&p.target.thread_identifier()));
        let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&p.key), &content, None);
        c.addNotificationRequest_withCompletionHandler(&req, None);
    }

    pub fn withdraw(key: &str) {
        let Some(c) = center() else { return };
        let ids = NSArray::from_retained_slice(&[NSString::from_str(key)]);
        c.removePendingNotificationRequestsWithIdentifiers(&ids);
        c.removeDeliveredNotificationsWithIdentifiers(&ids);
    }

    /// Blocks up to two seconds: call it off the main thread.
    pub fn status() -> Permission {
        let Some(c) = center() else { return Permission::Unavailable };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |s: NonNull<UNNotificationSettings>| {
            let _ = tx.send(Permission::from_raw(unsafe { s.as_ref() }.authorizationStatus().0));
        });
        c.getNotificationSettingsWithCompletionHandler(&block);
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or(Permission::NotDetermined)
    }

    /// The system prompt, once; after that it only reports. Blocks until the user answers.
    pub fn request() -> Permission {
        let Some(c) = center() else { return Permission::Unavailable };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |_ok: Bool, _e: *mut NSError| {
            let _ = tx.send(());
        });
        c.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &block);
        let _ = rx.recv_timeout(Duration::from_secs(300));
        status()
    }
}

/// Windows: toasts (win.rs). Windows doesn't ask first, so `request` only reports.
#[cfg(windows)]
mod imp {
    use super::*;
    use crate::win;
    pub fn init(on_click: impl Fn(Target) + Send + Sync + 'static) {
        win::toasts_init(on_click);
    }
    pub fn post(p: &Post) {
        if !FOCUSED.load(Ordering::SeqCst) {
            win::toast_post(p);
        }
    }
    pub fn withdraw(key: &str) {
        win::toast_withdraw(key);
    }
    pub fn status() -> Permission {
        win::toast_status()
    }
    pub fn request() -> Permission {
        win::toast_status()
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::*;
    pub fn init(_on_click: impl Fn(Target) + Send + Sync + 'static) {}
    pub fn post(_p: &Post) {}
    pub fn withdraw(_key: &str) {}
    pub fn status() -> Permission {
        Permission::Unavailable
    }
    pub fn request() -> Permission {
        Permission::Unavailable
    }
}

pub use imp::*;

/// System Settings → Notifications → Homerun.
#[cfg(not(windows))]
pub const SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.angilyu.homerun";
/// Settings → System → Notifications.
#[cfg(windows)]
pub const SETTINGS_URL: &str = crate::win::NOTIFICATION_SETTINGS;
