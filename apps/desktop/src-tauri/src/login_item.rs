//! Open at login (§5.1, §11): `SMAppService.mainApp`, as spike 9 proved. The status is read fresh
//! every time, so turning it off in System Settings → Login Items shows up in Settings at once.

use homerun_shell_core::login::LoginItem;

#[cfg(target_os = "macos")]
pub fn status() -> LoginItem {
    use objc2_service_management::SMAppService;
    if !crate::macos::in_app_bundle() {
        return LoginItem::Unavailable;
    }
    let raw = unsafe { SMAppService::mainAppService().status() }.0;
    LoginItem::from_raw(raw)
}

#[cfg(target_os = "macos")]
pub fn set(on: bool) -> Result<LoginItem, String> {
    use objc2_service_management::SMAppService;
    if !crate::macos::in_app_bundle() {
        return Err("Open at login needs the installed app.".into());
    }
    let svc = unsafe { SMAppService::mainAppService() };
    let r = if on { unsafe { svc.registerAndReturnError() } } else { unsafe { svc.unregisterAndReturnError() } };
    // Unregistering something that isn't registered is an error we don't care about.
    if let Err(e) = r {
        let now = status();
        let settled = if on { matches!(now, LoginItem::Enabled | LoginItem::NeedsApproval) } else { now == LoginItem::Off };
        if !settled {
            return Err(e.localizedDescription().to_string());
        }
    }
    Ok(status())
}

/// System Settings → General → Login Items, for *Needs approval* or a toggle the user turned off.
#[cfg(target_os = "macos")]
pub fn open_settings() {
    unsafe { objc2_service_management::SMAppService::openSystemSettingsLoginItems() };
}

#[cfg(not(target_os = "macos"))]
pub fn status() -> LoginItem {
    LoginItem::Unavailable
}
#[cfg(not(target_os = "macos"))]
pub fn set(_on: bool) -> Result<LoginItem, String> {
    Err("Open at login is macOS-only for now.".into())
}
#[cfg(not(target_os = "macos"))]
pub fn open_settings() {}
