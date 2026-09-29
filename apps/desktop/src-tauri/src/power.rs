// Sleep and wake (design §8.1, §8.4): the shell observes NSWorkspace's will-sleep and did-wake
// notifications and forwards them to the runtime as `power.will_sleep` and `power.did_wake` on
// its persistent shell connection, so fires missed while asleep are attributed to sleep with
// exact times. The runtime does not depend on them: it also detects sleep from gaps in its own
// ticks. Power assertions are held by the runtime itself (caffeinate), not here.

use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, PartialEq)]
pub enum PowerEvent {
    WillSleep { at: u64 },
    DidWake { at: u64, slept_at: Option<u64> },
}

impl PowerEvent {
    pub fn method(&self) -> &'static str {
        match self {
            PowerEvent::WillSleep { .. } => "power.will_sleep",
            PowerEvent::DidWake { .. } => "power.did_wake",
        }
    }
    pub fn params(&self) -> Value {
        match self {
            PowerEvent::WillSleep { at } => json!({ "at": at }),
            PowerEvent::DidWake { at, slept_at } => json!({ "at": at, "slept_at": slept_at }),
        }
    }
}

/// Call `on_event` for each sleep and wake, on the main thread. Must be called on the main thread
/// (from Tauri's `setup`); the observers live as long as the process.
#[cfg(target_os = "macos")]
pub fn observe(on_event: impl Fn(PowerEvent) + 'static) {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification};
    use objc2_foundation::NSNotification;
    use std::cell::Cell;
    use std::ptr::NonNull;
    use std::rc::Rc;

    let on_event = Rc::new(on_event);
    let slept_at = Rc::new(Cell::new(None::<u64>));
    let (f, s) = (on_event.clone(), slept_at.clone());
    let will = RcBlock::new(move |_: NonNull<NSNotification>| {
        let at = now_ms();
        s.set(Some(at));
        f(PowerEvent::WillSleep { at });
    });
    let did = RcBlock::new(move |_: NonNull<NSNotification>| {
        on_event(PowerEvent::DidWake { at: now_ms(), slept_at: slept_at.take() });
    });
    let center = NSWorkspace::sharedWorkspace().notificationCenter();
    unsafe {
        let a = center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceWillSleepNotification), None, None, &will);
        let b = center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceDidWakeNotification), None, None, &did);
        std::mem::forget((a, b));
    }
}

#[cfg(not(target_os = "macos"))]
pub fn observe(_on_event: impl Fn(PowerEvent) + 'static) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_map_to_the_power_notifications() {
        let w = PowerEvent::WillSleep { at: 1 };
        assert_eq!((w.method(), w.params()), ("power.will_sleep", json!({"at": 1})));
        let d = PowerEvent::DidWake { at: 2, slept_at: None };
        assert_eq!((d.method(), d.params()), ("power.did_wake", json!({"at": 2, "slept_at": null})));
    }
}
