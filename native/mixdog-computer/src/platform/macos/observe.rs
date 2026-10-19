//! Input observation. A listen-only event tap sees every mouse and keyboard
//! event and reads the marker this process stamps on its own; without the
//! tap, the system's last-input clock is watched and attributed by time.

use super::ffi::*;
use crate::observer::{now_ms, Shared};
use std::ffi::c_void;
use std::sync::Arc;

struct TapContext {
    shared: Arc<Shared>,
    marker: i64,
    tap: std::sync::atomic::AtomicPtr<c_void>,
}

extern "C" fn on_event(
    _proxy: *mut c_void,
    kind: u32,
    event: CGEventRef,
    user_info: *mut c_void,
) -> CGEventRef {
    // SAFETY: user_info is the leaked TapContext this tap was created with.
    let context = unsafe { &*(user_info as *const TapContext) };
    if kind == kCGEventTapDisabledByTimeout || kind == kCGEventTapDisabledByUserInput {
        // Re-enabling cannot erase a period in which input went unobserved.
        context.shared.record(false);
        super::target_input::lose("global event tap gap; restart observer");
        let tap = context.tap.load(std::sync::atomic::Ordering::SeqCst);
        if !tap.is_null() {
            // SAFETY: tap is the live mach port this callback belongs to.
            unsafe { CGEventTapEnable(tap, true) };
        }
        return event;
    }
    // SAFETY: event is the live event being observed.
    let origin = unsafe { CGEventGetIntegerValueField(event, kCGEventSourceUserData) };
    context.shared.record(origin == context.marker);
    event
}

extern "C" fn on_target_event(
    _proxy: *mut c_void,
    kind: u32,
    event: CGEventRef,
    user_info: *mut c_void,
) -> CGEventRef {
    if kind == kCGEventTapDisabledByTimeout || kind == kCGEventTapDisabledByUserInput {
        super::target_input::lose("target event tap gap; restart observer");
        return event;
    }
    if event.is_null() {
        super::target_input::lose("target event is unavailable; restart observer");
        return event;
    }
    let context = unsafe { &*(user_info as *const TapContext) };
    let (origin, pid) = unsafe {
        (CGEventGetIntegerValueField(event, kCGEventSourceUserData),
         CGEventGetIntegerValueField(event, kCGEventTargetUnixProcessID))
    };
    super::target_input::record(origin == context.marker, pid);
    event
}

fn mask() -> u64 {
    [
        kCGEventLeftMouseDown,
        kCGEventLeftMouseUp,
        kCGEventRightMouseDown,
        kCGEventRightMouseUp,
        kCGEventMouseMoved,
        kCGEventLeftMouseDragged,
        kCGEventRightMouseDragged,
        kCGEventKeyDown,
        kCGEventKeyUp,
        kCGEventFlagsChanged,
        kCGEventScrollWheel,
        kCGEventOtherMouseDown,
        kCGEventOtherMouseUp,
        kCGEventOtherMouseDragged,
    ]
    .iter()
    .fold(0u64, |mask, kind| mask | (1u64 << kind))
}

pub fn start(shared: Arc<Shared>, marker: i64) {
    std::thread::Builder::new()
        .name("mixdog input observation".into())
        .spawn(move || {
            let context = Box::into_raw(Box::new(TapContext {
                shared: shared.clone(),
                marker,
                tap: Default::default(),
            }));
            // SAFETY: the callback and its leaked context live for the process.
            let tap = unsafe {
                CGEventTapCreate(
                    kCGSessionEventTap,
                    kCGHeadInsertEventTap,
                    kCGEventTapOptionListenOnly,
                    mask(),
                    on_event,
                    context as *mut c_void,
                )
            };
            if tap.is_null() {
                super::target_input::lose("global event tap unavailable");
                poll_idle(shared);
                return;
            }
            // SAFETY: context outlives the tap; the run loop owns the source.
            unsafe {
                (*context)
                    .tap
                    .store(tap, std::sync::atomic::Ordering::SeqCst);
                let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                if source.is_null() {
                    super::target_input::lose("global event tap run-loop source unavailable");
                    shared.set_ready(false);
                    return;
                }
                CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                CGEventTapEnable(tap, true);
                // Only annotated events carry the event-time destination.
                // A zero/missing destination is never replaced by current focus.
                let target_tap = CGEventTapCreate(
                    kCGAnnotatedSessionEventTap, kCGHeadInsertEventTap,
                    kCGEventTapOptionListenOnly, mask(), on_target_event, context as _,
                );
                if target_tap.is_null() {
                    super::target_input::lose("annotated target event tap unavailable");
                } else {
                    let target_source = CFMachPortCreateRunLoopSource(std::ptr::null(), target_tap, 0);
                    if target_source.is_null() {
                        super::target_input::lose("target event tap run-loop source unavailable");
                    } else {
                        CFRunLoopAddSource(CFRunLoopGetCurrent(), target_source, kCFRunLoopCommonModes);
                        CGEventTapEnable(target_tap, true);
                        super::target_input::start(target_tap);
                    }
                }
            }
            shared.set_ready(true);
            // SAFETY: runs this thread's run loop for the life of the process.
            unsafe { CFRunLoopRun() };
            shared.set_ready(false);
            super::target_input::lose("input observer stopped; restart observer");
        })
        .ok();
}

/// Without a tap: every advance of the HID last-input clock is an input event,
/// this process's own when it falls inside the window it marked.
fn poll_idle(shared: Arc<Shared>) {
    let mut last_seen = 0u64;
    shared.set_ready(true);
    loop {
        // SAFETY: plain HID idle query.
        let idle = unsafe {
            CGEventSourceSecondsSinceLastEventType(
                kCGEventSourceStateHIDSystemState,
                kCGAnyInputEventType,
            )
        };
        let now = now_ms();
        let at = now.saturating_sub((idle.max(0.0) * 1000.0) as u64);
        if at > last_seen + 5 {
            if last_seen != 0 {
                shared.record_untagged(at);
            }
            last_seen = at;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
}
