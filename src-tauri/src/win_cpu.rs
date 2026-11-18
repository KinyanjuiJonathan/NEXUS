//! Windows CPU usage, read the way Task Manager does.
//!
//! Task Manager on Windows 10/11 shows `% Processor Utility` (it accounts for
//! turbo and frequency scaling), so that counter is preferred. `GetSystemTimes`
//! gives the classic busy-time share and is the fallback where the counter is
//! missing (older Windows, some virtual machines).

use windows::core::w;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT_COUNTERVALUE,
    PDH_FMT_DOUBLE,
};
use windows::Win32::System::Threading::GetSystemTimes;

pub struct CpuCounter {
    query: isize,
    utility: isize,
    ok: bool,
}

// PDH handles are plain integers owned exclusively by this struct (behind a Mutex).
unsafe impl Send for CpuCounter {}

impl CpuCounter {
    pub fn new() -> Self {
        let mut query = 0isize;
        let mut utility = 0isize;
        let ok = unsafe {
            PdhOpenQueryW(None, 0, &mut query) == 0
                && PdhAddEnglishCounterW(query, w!("\\Processor Information(_Total)\\% Processor Utility"), 0, &mut utility) == 0
                && PdhCollectQueryData(query) == 0
        };
        Self { query, utility, ok }
    }

    /// Average utility since the previous call, 0–100. `None` when the counter
    /// is unavailable or has no second sample yet.
    pub fn utility(&mut self) -> Option<f32> {
        if !self.ok || unsafe { PdhCollectQueryData(self.query) } != 0 {
            return None;
        }
        let mut value = PDH_FMT_COUNTERVALUE::default();
        let status = unsafe { PdhGetFormattedCounterValue(self.utility, PDH_FMT_DOUBLE, None, &mut value) };
        // CStatus 0 = valid data, 1 = new data
        if status != 0 || value.CStatus > 1 {
            return None;
        }
        let v = unsafe { value.Anonymous.doubleValue };
        // Utility can exceed 100 under turbo boost; Task Manager caps it the same way.
        v.is_finite().then(|| v.clamp(0.0, 100.0) as f32)
    }
}

impl Default for CpuCounter {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CpuCounter {
    fn drop(&mut self) {
        if self.query != 0 {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }
}

fn ticks(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// Cumulative (idle, kernel, user) processor time; kernel includes idle.
pub fn system_times() -> Option<(u64, u64, u64)> {
    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.ok()?;
    Some((ticks(idle), ticks(kernel), ticks(user)))
}
