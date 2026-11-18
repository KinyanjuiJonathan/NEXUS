//! Windows session state for the activity monitor: time since the last
//! keyboard/mouse input anywhere in Windows, and whether the session is locked.

use windows::core::PWSTR;
use windows::Win32::System::RemoteDesktop::{
    WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

/// `WTSINFOEX_LEVEL1_W::SessionFlags` value while the workstation is locked.
const WTS_SESSIONSTATE_LOCK: u32 = 0;

/// Milliseconds since the last keyboard or mouse input in this Windows session.
pub fn idle_ms() -> Option<u64> {
    let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        // dwTime is a 32-bit tick count; wrapping arithmetic handles the 49-day rollover.
        let now = unsafe { GetTickCount64() } as u32;
        return Some(now.wrapping_sub(info.dwTime) as u64);
    }
    None
}

/// True while the workstation is locked (Win+L, lock on sleep, switched user).
pub fn session_locked() -> bool {
    let mut buffer = PWSTR::null();
    let mut bytes = 0u32;
    unsafe {
        if WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSSessionInfoEx, &mut buffer, &mut bytes).is_err()
            || buffer.is_null()
        {
            return false;
        }
        let info = buffer.0 as *const WTSINFOEXW;
        let locked = bytes as usize >= std::mem::size_of::<WTSINFOEXW>()
            && (*info).Level == 1
            && (*info).Data.WTSInfoExLevel1.SessionFlags as u32 == WTS_SESSIONSTATE_LOCK;
        WTSFreeMemory(buffer.0 as *mut core::ffi::c_void);
        locked
    }
}
