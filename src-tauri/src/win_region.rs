//! The reading region's mouse watcher.
//!
//! The region's frame is a see-through window. Inside the region the mouse
//! must reach the app underneath (so it can be scrolled and clicked), while a
//! right-click there means "capture this". A low-level mouse hook does both:
//! it reports when the pointer enters or leaves the inside of the region (so
//! the frame can let input through there and take it on its border), and it
//! takes right-clicks inside the region for itself, so the app underneath
//! never shows its context menu.
//!
//! Nothing is read from the screen here, and nothing is reported unless the
//! region is open.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
};

/// What the watcher reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    /// The pointer moved into (true) or out of (false) the inside of the region.
    Inside(bool),
    /// A right-click inside the region: capture now.
    Capture,
}

// The inside of the region, in physical pixels of the virtual desktop.
static LEFT: AtomicI32 = AtomicI32::new(0);
static TOP: AtomicI32 = AtomicI32::new(0);
static RIGHT: AtomicI32 = AtomicI32::new(0);
static BOTTOM: AtomicI32 = AtomicI32::new(0);
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Whether the pointer was last seen inside.
static WAS_INSIDE: AtomicBool = AtomicBool::new(false);
/// The left button is down: the frame may be being dragged or resized, so "inside" is not re-judged until it is released.
static DRAGGING: AtomicBool = AtomicBool::new(false);
/// The release that belongs to a right-click this watcher took.
static TAKE_UP: AtomicBool = AtomicBool::new(false);
static THREAD: AtomicU32 = AtomicU32::new(0);
/// Where signals go. The hook only drops them here; a separate thread acts on them,
/// so the hook itself never waits for anything (Windows drops hooks that are slow).
static OUT: Mutex<Option<Sender<Signal>>> = Mutex::new(None);

fn tell(signal: Signal) {
    if let Ok(guard) = OUT.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(signal);
        }
    }
}

fn inside(x: i32, y: i32) -> bool {
    x >= LEFT.load(Ordering::Relaxed) && x < RIGHT.load(Ordering::Relaxed) && y >= TOP.load(Ordering::Relaxed) && y < BOTTOM.load(Ordering::Relaxed)
}

/// Set (or move) the inside of the region.
pub fn set_region(x: i32, y: i32, w: i32, h: i32) {
    LEFT.store(x, Ordering::Relaxed);
    TOP.store(y, Ordering::Relaxed);
    RIGHT.store(x + w, Ordering::Relaxed);
    BOTTOM.store(y + h, Ordering::Relaxed);
}

unsafe extern "system" fn watch(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && ACTIVE.load(Ordering::Relaxed) {
        // SAFETY: for WH_MOUSE_LL with code >= 0, lparam points to an MSLLHOOKSTRUCT for the duration of the call.
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let (x, y) = (info.pt.x, info.pt.y);
        match wparam.0 as u32 {
            WM_LBUTTONDOWN => DRAGGING.store(true, Ordering::Relaxed),
            WM_LBUTTONUP => DRAGGING.store(false, Ordering::Relaxed),
            WM_RBUTTONDOWN if inside(x, y) && !DRAGGING.load(Ordering::Relaxed) => {
                TAKE_UP.store(true, Ordering::Relaxed);
                tell(Signal::Capture);
                return LRESULT(1);
            }
            WM_RBUTTONUP if TAKE_UP.swap(false, Ordering::Relaxed) => return LRESULT(1),
            _ => {}
        }
        if matches!(wparam.0 as u32, WM_MOUSEMOVE | WM_LBUTTONUP) && !DRAGGING.load(Ordering::Relaxed) {
            let now = inside(x, y);
            if WAS_INSIDE.swap(now, Ordering::Relaxed) != now {
                tell(Signal::Inside(now));
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// Start watching the region. `on_signal` is called on a thread of its own, one signal at a time.
/// Calling it again while running only replaces the region and the callback.
pub fn start(x: i32, y: i32, w: i32, h: i32, on_signal: impl Fn(Signal) + Send + 'static) {
    set_region(x, y, w, h);
    let (tx, rx) = mpsc::channel::<Signal>();
    if let Ok(mut guard) = OUT.lock() {
        *guard = Some(tx); // the previous sender is dropped, which ends its thread
    }
    std::thread::spawn(move || {
        for signal in rx {
            on_signal(signal);
        }
    });
    WAS_INSIDE.store(false, Ordering::Relaxed);
    DRAGGING.store(false, Ordering::Relaxed);
    TAKE_UP.store(false, Ordering::Relaxed);
    if ACTIVE.swap(true, Ordering::SeqCst) && THREAD.load(Ordering::SeqCst) != 0 {
        return; // already running
    }
    std::thread::spawn(|| {
        // SAFETY: a low-level hook installed and removed on this thread, which pumps messages until told to quit.
        unsafe {
            let me = GetCurrentThreadId();
            THREAD.store(me, Ordering::SeqCst);
            let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(watch), HINSTANCE::default(), 0) {
                Ok(h) => h,
                Err(_) => {
                    ACTIVE.store(false, Ordering::SeqCst);
                    THREAD.store(0, Ordering::SeqCst);
                    return;
                }
            };
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).0 > 0 {}
            let _ = UnhookWindowsHookEx(hook);
            // only clear the slot if a newer watcher has not taken it
            let _ = THREAD.compare_exchange(me, 0, Ordering::SeqCst, Ordering::SeqCst);
        }
    });
}

/// Stop watching: the hook is removed and nothing more is reported.
pub fn stop() {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = OUT.lock() {
        *guard = None;
    }
    let thread = THREAD.load(Ordering::SeqCst);
    if thread != 0 {
        // SAFETY: posting a quit message to the watcher thread's queue.
        unsafe {
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}
