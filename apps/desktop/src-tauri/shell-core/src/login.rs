//! Open at login (§5.1, §11): `SMAppService.mainApp`'s status as Settings shows it. The system
//! is the source of truth; the user can turn the item off in System Settings at any time.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginItem {
    Enabled,
    Off,
    /// Registered, but turned off in System Settings → General → Login Items.
    NeedsApproval,
    /// Not a bundle (e.g. `tauri dev`), or not macOS.
    Unavailable,
}

impl LoginItem {
    /// `SMAppServiceStatus`: 0 notRegistered, 1 enabled, 2 requiresApproval, 3 notFound.
    pub fn from_raw(raw: isize) -> LoginItem {
        match raw {
            0 => LoginItem::Off,
            1 => LoginItem::Enabled,
            2 => LoginItem::NeedsApproval,
            _ => LoginItem::Unavailable,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_status() {
        assert_eq!(
            [0, 1, 2, 3, 99].map(LoginItem::from_raw),
            [LoginItem::Off, LoginItem::Enabled, LoginItem::NeedsApproval, LoginItem::Unavailable, LoginItem::Unavailable]
        );
        assert_eq!(serde_json::to_value(LoginItem::NeedsApproval).unwrap(), "needs_approval");
    }
}
