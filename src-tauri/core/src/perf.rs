//! Small, testable pieces of the system-performance maths.

/// Cumulative processor times since boot, in any one unit (Windows: 100 ns ticks).
/// As reported by `GetSystemTimes`, `kernel` includes idle time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CpuTimes {
    pub idle: u64,
    pub kernel: u64,
    pub user: u64,
}

/// Share of processor time spent doing work between two readings, 0–100.
/// `None` when no time passed (the readings are too close together).
pub fn cpu_percent(prev: CpuTimes, now: CpuTimes) -> Option<f32> {
    let idle = now.idle.wrapping_sub(prev.idle);
    let total = now.kernel.wrapping_sub(prev.kernel) + now.user.wrapping_sub(prev.user);
    if total == 0 || idle > total {
        return None;
    }
    Some((((total - idle) as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as f32)
}

/// `used / total` as a percentage, 0–100 (0 when the total is unknown).
pub fn percent(used: u64, total: u64) -> f32 {
    if total == 0 {
        return 0.0;
    }
    ((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_percent_is_busy_share_of_elapsed_time() {
        let a = CpuTimes { idle: 1_000, kernel: 1_500, user: 500 };
        // 1000 ticks pass on a 4-core PC (4000 core-ticks): 3000 idle, 1000 busy.
        let b = CpuTimes { idle: 4_000, kernel: 4_800, user: 1_200 };
        assert_eq!(cpu_percent(a, b), Some(25.0));
        // fully idle and fully busy
        assert_eq!(cpu_percent(a, CpuTimes { idle: 5_000, kernel: 5_500, user: 500 }), Some(0.0));
        assert_eq!(cpu_percent(a, CpuTimes { idle: 1_000, kernel: 2_500, user: 3_500 }), Some(100.0));
    }

    #[test]
    fn cpu_percent_rejects_unusable_readings() {
        let a = CpuTimes { idle: 10, kernel: 20, user: 5 };
        assert_eq!(cpu_percent(a, a), None);
        assert_eq!(cpu_percent(a, CpuTimes { idle: 100, kernel: 21, user: 5 }), None);
    }

    #[test]
    fn percent_handles_edges() {
        assert_eq!(percent(8, 32), 25.0);
        assert_eq!(percent(0, 0), 0.0);
        assert_eq!(percent(40, 32), 100.0);
    }
}
