//! Windows keyboard output and focus handling for the Auto Typer.

use std::collections::HashMap;
use std::sync::mpsc;
use std::thread::JoinHandle;

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetKeyState, MapVirtualKeyW, SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_BACK, VK_CAPITAL, VK_CONTROL, VK_DELETE,
    VK_ESCAPE, VK_LEFT, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    HHOOK, MSG, WH_MOUSE_LL, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT,
    WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_XBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

/// How a key was pressed, so the release mirrors it exactly.
#[derive(Clone)]
enum Sent {
    Vk(VIRTUAL_KEY, bool),
    Unicode(Vec<u16>),
}

fn named(key: &str) -> Option<Sent> {
    Some(match key {
        "<shift>" => Sent::Vk(VK_SHIFT, false),
        "<mod>" => Sent::Vk(VK_CONTROL, false),
        "<backspace>" => Sent::Vk(VK_BACK, false),
        "<enter>" => Sent::Vk(VK_RETURN, false),
        "<tab>" => Sent::Vk(VK_TAB, false),
        "<delete>" => Sent::Vk(VK_DELETE, true),
        "<left>" => Sent::Vk(VK_LEFT, true),
        "<right>" => Sent::Vk(VK_RIGHT, true),
        _ => return None,
    })
}

fn send(sent: &Sent, down: bool) {
    let up = if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP };
    let input = |vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
    let inputs: Vec<INPUT> = match sent {
        Sent::Vk(vk, extended) => {
            let scan = unsafe { MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) } as u16;
            let ext = if *extended { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) };
            vec![input(*vk, scan, up | ext)]
        }
        Sent::Unicode(units) => units.iter().map(|u| input(VIRTUAL_KEY(0), *u, KEYEVENTF_UNICODE | up)).collect(),
    };
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Sends planned keys as real keystrokes.
pub struct Keyboard {
    held: HashMap<String, Sent>,
    /// Caps Lock was on when typing began and has been switched off for the run.
    caps_was_on: bool,
}

impl Keyboard {
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        unsafe {
            // Finer sleep granularity, so short key holds and gaps come out as planned.
            timeBeginPeriod(1);
        }
        let caps_was_on = unsafe { GetKeyState(VK_CAPITAL.0 as i32) } & 1 != 0;
        let kb = Self { held: HashMap::new(), caps_was_on };
        if caps_was_on {
            kb.tap_caps();
        }
        kb
    }

    fn tap_caps(&self) {
        send(&Sent::Vk(VK_CAPITAL, false), true);
        send(&Sent::Vk(VK_CAPITAL, false), false);
    }

    fn modifier_held(&self) -> bool {
        self.held.contains_key("<shift>") || self.held.contains_key("<mod>")
    }

    /// Letters, digits and space are sent as real keys, and so is anything typed
    /// with Shift or Ctrl held (the combination needs a real key). Everything else
    /// is sent as the exact character, which works on every keyboard layout.
    fn resolve(&self, key: &str) -> Sent {
        if let Some(s) = named(key) {
            return s;
        }
        let units: Vec<u16> = key.encode_utf16().collect();
        let simple = key.len() == 1 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ');
        if units.len() == 1 && (simple || self.modifier_held()) {
            let scan = unsafe { VkKeyScanW(units[0]) };
            // low byte = virtual key, high byte = modifiers the layout needs for this character
            if scan != -1 && (scan as u16 >> 8) == 0 {
                return Sent::Vk(VIRTUAL_KEY(scan as u16 & 0xff), false);
            }
        }
        Sent::Unicode(units)
    }

    pub fn key(&mut self, key: &str, down: bool) {
        if down {
            let sent = self.resolve(key);
            send(&sent, true);
            self.held.insert(key.to_string(), sent);
        } else if let Some(sent) = self.held.remove(key) {
            send(&sent, false);
        }
    }
}

impl Drop for Keyboard {
    fn drop(&mut self) {
        let held: Vec<Sent> = self.held.drain().map(|(_, s)| s).collect();
        for sent in held {
            send(&sent, false);
        }
        if self.caps_was_on {
            self.tap_caps();
        }
        unsafe {
            timeEndPeriod(1);
        }
    }
}

/// True while the Esc key is physically held: the emergency stop.
pub fn escape_pressed() -> bool {
    (unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } as u16) & 0x8000 != 0
}

/// The window that has keyboard focus, as (handle, belongs to this app).
pub fn foreground() -> Option<(isize, bool)> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    Some((hwnd.0 as isize, pid == std::process::id()))
}

unsafe extern "system" fn swallow_clicks(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam.0 as u32;
        let click = [
            WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP,
            WM_MBUTTONDBLCLK, WM_XBUTTONDOWN, WM_XBUTTONUP, WM_XBUTTONDBLCLK,
        ];
        if click.contains(&msg) {
            return LRESULT(1);
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// While this exists, mouse clicks are ignored system-wide (the pointer still
/// moves), so a stray click can't take the caret out of the target text box.
pub struct ClickBlocker {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl ClickBlocker {
    pub fn start() -> Option<Self> {
        let (tx, rx) = mpsc::channel::<Option<u32>>();
        // A low-level hook is serviced by the message loop of the thread that installed it.
        let thread = std::thread::spawn(move || unsafe {
            let hook = match SetWindowsHookExW(WH_MOUSE_LL, Some(swallow_clicks), HINSTANCE::default(), 0) {
                Ok(h) => h,
                Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            };
            let _ = tx.send(Some(GetCurrentThreadId()));
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).0 > 0 {}
            let _ = UnhookWindowsHookEx(hook);
        });
        match rx.recv().ok().flatten() {
            Some(thread_id) => Some(Self { thread_id, thread: Some(thread) }),
            None => {
                let _ = thread.join();
                None
            }
        }
    }
}

impl Drop for ClickBlocker {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
