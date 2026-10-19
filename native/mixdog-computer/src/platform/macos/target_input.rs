//! Public Quartz annotated-event attribution; never infer a past destination
//! from current focus, cursor position, or an input-idle timestamp.
use super::{ffi::*, windows};
use core_foundation::base::CFRelease;
use crate::platform::{parse_window_id, Wid};
use crate::protocol::Req;
use crate::target_input::{Family, Held, Ledger, Process, UNAVAILABLE};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::{Mutex, OnceLock};

static LEDGER: OnceLock<Mutex<Ledger>> = OnceLock::new();
static TAP: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

fn ledger() -> std::sync::MutexGuard<'static, Ledger> {
    LEDGER.get_or_init(|| Mutex::new(Ledger::new(crate::observer::Observer::new().generation)))
        .lock().unwrap_or_else(|poisoned| {
            let mut ledger = poisoned.into_inner();
            ledger.lose("target observer lock poisoned");
            ledger
        })
}

fn process(pid: i32) -> Option<(Process, i32)> {
    if pid <= 0 { return None; }
    // SAFETY: public libproc API writes only the supplied BSD-info buffer.
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of_val(&info) as i32;
        if libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as _, size) != size
            || info.pbi_pid != pid as u32
        {
            return None;
        }
        Some((Process { pid, seconds: info.pbi_start_tvsec, micros: info.pbi_start_tvusec }, info.pbi_ppid as i32))
    }
}

fn family(pid: i32) -> Option<Family> {
    let (identity, parent) = process(pid)?;
    let parent = if parent > 0 { Some(process(parent)?.0) } else { None };
    Some(Family { process: identity, parent })
}

fn target(window: Wid) -> Result<Family, String> {
    windows::one(window).and_then(|window| family(window.pid))
        .ok_or_else(|| format!("{UNAVAILABLE}: exact target window or process identity is unavailable"))
}

pub fn start(tap: CFMachPortRef) {
    TAP.store(tap, Ordering::SeqCst);
    ledger().start();
}

pub fn lose(reason: &str) { ledger().lose(reason); }

pub fn record(own: bool, pid: i64) {
    let destination = if own { None } else {
        i32::try_from(pid).ok().and_then(family)
    };
    ledger().record(own, destination);
}

fn check_tap() {
    // Secure input can hide keyboard events even while the tap stays enabled.
    // Never advertise usable target proof while that public state is active.
    if unsafe { IsSecureEventInputEnabled() } {
        lose("secure event input prevents target observation; restart observer");
    }
    let tap = TAP.load(Ordering::SeqCst);
    // SAFETY: the tap and context live until process exit.
    if !tap.is_null() && !unsafe { CGEventTapIsEnabled(tap) } {
        lose("target event tap disabled; restart observer");
    }
}

pub fn observation(window_id: &str) -> Value {
    check_tap();
    let value = target(parse_window_id(window_id)).and_then(|family| ledger().observe(family));
    match value {
        Ok((monitor, sequence)) => json!({
            "ready": true, "monitor": monitor, "sequence": sequence, "window_id": window_id,
        }),
        Err(reason) => json!({
            "ready": false, "monitor": "", "sequence": 0, "window_id": window_id, "reason": reason,
        }),
    }
}

struct Active {
    window: Wid,
    family: Family,
    monitor: String,
    sequence: i64,
    held: Held<CGEventRef>,
    failure: RefCell<Option<String>>,
}

impl Active {
    fn check(&self) -> Result<(), String> {
        if let Some(error) = self.failure.borrow().as_ref() {
            return Err(error.clone());
        }
        check_tap();
        if target(self.window)? != self.family {
            return Err(format!("{UNAVAILABLE}: target process identity changed"));
        }
        ledger().check(self.family, &self.monitor, self.sequence)
    }
}

thread_local! { static ACTIVE: RefCell<Vec<Active>> = const { RefCell::new(Vec::new()) }; }

pub struct Guard {
    active: bool,
}

impl Guard {
    pub fn begin(req: &Req) -> Result<Self, String> {
        let window = parse_window_id(&req.text("window_id"));
        let monitor = req.str("observed_target_input_monitor_id")
            .ok_or_else(|| format!("{UNAVAILABLE}: missing expected target monitor"))?;
        let sequence = req.int("observed_target_input_user_sequence")
            .ok_or_else(|| format!("{UNAVAILABLE}: missing expected target sequence"))?;
        let active = Active { window, family: target(window)?, monitor, sequence, held: Held::default(), failure: RefCell::new(None) };
        active.check()?;
        ACTIVE.with(|stack| stack.borrow_mut().push(active));
        Ok(Self { active: true })
    }

    /// Explicit completion is required: Drop cannot return cleanup uncertainty
    /// to the caller. A cleanup error takes precedence over interruption.
    pub fn finish(mut self) -> Result<(), String> {
        let checked = require(None);
        let cleanup = cleanup_active();
        self.active = false;
        cleanup.and(checked)
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if self.active {
            // Unwinding/early-return fallback still releases owned input and
            // latches unavailable evidence, but never claims confirmation.
            let _ = cleanup_active();
        }
    }
}

fn cleanup_active() -> Result<(), String> {
        if let Some(active) = ACTIVE.with(|stack| stack.borrow_mut().pop()) {
            // Cleanup is the sole exception to the failed guard. It only sends
            // owned releases to the original process incarnation, never HID.
            let same_process = process(active.family.process.pid)
                .is_some_and(|(identity, _)| identity == active.family.process);
            let cleanup = active.held.cleanup(|(up, _), event| {
                unsafe {
                    if same_process {
                        CGEventSetType(event, up);
                        CGEventSetFlags(event, 0);
                        CGEventPostToPid(active.family.process.pid, event);
                    }
                    CFRelease(event as _);
                }
            });
            if cleanup.is_err() {
                // CGEventPostToPid is void: neither an attempted release nor
                // a vanished/reused process proves that owned input cleared.
                lose("owned input cleanup is unconfirmed; restart observer after manual recovery");
            }
            return cleanup;
        }
        Ok(())
}

fn require(pid: Option<i32>) -> Result<(), String> {
    ACTIVE.with(|stack| {
        let stack = stack.borrow();
        let active = stack.last().ok_or_else(|| format!("{UNAVAILABLE}: no target dispatch scope"))?;
        active.check()?;
        if pid.is_some_and(|pid| pid != active.family.process.pid) {
            let error = format!("{UNAVAILABLE}: dispatch process differs from observed target");
            *active.failure.borrow_mut() = Some(error.clone());
            return Err(error);
        }
        Ok(())
    })
}

/// Called by host authorization and ref resolution, including AX dispatch.
pub fn require_window(window: Wid) -> Result<(), String> {
    require(None)?;
    check_window(window)
}

/// Reads may resolve references without an active dispatch scope. Mutating
/// platform entry points use `require_window` instead.
pub fn check_window(window: Wid) -> Result<(), String> {
    ACTIVE.with(|stack| {
        let stack = stack.borrow();
        if let Some(active) = stack.last() {
            active.check()?;
            if window != 0 && target(window)?.process != active.family.process {
                let error = format!("{UNAVAILABLE}: dispatch window differs from observed app");
                *active.failure.borrow_mut() = Some(error.clone());
                return Err(error);
            }
        }
        Ok(())
    })
}

/// Check every posted event, and retain only owned downs for scoped cleanup.
/// `event` is live and stamped with the helper's marker before this call.
pub fn before_post(pid: i32, event: CGEventRef) -> Result<(), String> {
    require(Some(pid))?;
    unsafe {
        let kind = CGEventGetType(event);
        let (up, key) = match kind {
            kCGEventKeyDown => (kCGEventKeyUp, CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode)),
            kCGEventLeftMouseDown => (kCGEventLeftMouseUp, 0),
            kCGEventRightMouseDown => (kCGEventRightMouseUp, 0),
            kCGEventOtherMouseDown => (kCGEventOtherMouseUp, CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber)),
            _ => return Ok(()),
        };
        let copy = CGEventCreateCopy(event);
        if copy.is_null() {
            return Err(format!("{UNAVAILABLE}: cannot retain owned release for interruption cleanup"));
        }
        ACTIVE.with(|stack| stack.borrow_mut().last_mut().unwrap().held.down((up, key), copy));
    }
    Ok(())
}

pub fn after_post(pid: i32, event: CGEventRef) -> Result<(), String> {
    // An interrupted release is not evidence of successful cleanup. Retain
    // its owned down so explicit scope completion reports the uncertainty.
    require(Some(pid))?;
    unsafe {
        let kind = CGEventGetType(event);
        let key = match kind {
            kCGEventKeyUp => CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode),
            kCGEventOtherMouseUp => CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber),
            _ => 0,
        };
        ACTIVE.with(|stack| {
            if let Some(active) = stack.borrow_mut().last_mut() {
                if let Some(copy) = active.held.up((kind, key)) {
                    CFRelease(copy as _);
                }
            }
        });
    }
    require(Some(pid))
}
