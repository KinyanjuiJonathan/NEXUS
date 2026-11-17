//! Live system performance for the overlay: CPU, RAM, GPU load, VRAM and FPS.
//!
//! * CPU / RAM — `sysinfo` (all platforms).
//! * GPU load / VRAM — Windows performance counters `\GPU Engine(*)\Utilization Percentage`
//!   and `\GPU Adapter Memory(*)\Dedicated Usage` (the same source Task Manager uses,
//!   vendor-independent on WDDM 2.x), restricted to the primary discrete adapter found via DXGI.
//! * FPS — counts DirectX present calls of the foreground app from the
//!   `Microsoft-Windows-DXGI` (D3D10/11/12) and `Microsoft-Windows-D3D9` ETW providers,
//!   like PresentMon / Game Bar. Windows only allows this for administrators or members
//!   of the "Performance Log Users" group; otherwise FPS reports `no_permission`.
//!
//! Sampling happens only when the overlay asks (about once per second while it is
//! visible), and the FPS trace runs only while the overlay shows FPS.

use std::sync::Mutex;

use serde::Serialize;
use sysinfo::System;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerfSnapshot {
    /// Total CPU usage, 0–100.
    pub cpu: f32,
    pub ram_used: u64,
    pub ram_total: u64,
    /// GPU load 0–100 (busiest engine of the main adapter), if available.
    pub gpu: Option<f32>,
    pub gpu_name: Option<String>,
    pub vram_used: Option<u64>,
    pub vram_total: Option<u64>,
    /// Frames per second of the measured app.
    pub fps: Option<f32>,
    /// Executable name of the app the FPS belongs to.
    pub fps_app: Option<String>,
    /// "ok" | "idle" (no app presenting) | "off" | "no_permission" | "unsupported"
    pub fps_status: String,
}

pub struct PerfState {
    sys: Mutex<System>,
    #[cfg(windows)]
    win: Mutex<Option<win::WinPerf>>,
}

impl PerfState {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(System::new()),
            #[cfg(windows)]
            win: Mutex::new(None),
        }
    }

    fn snapshot(&self, want_fps: bool) -> PerfSnapshot {
        let mut snap = PerfSnapshot { fps_status: "unsupported".into(), ..Default::default() };
        if let Ok(mut sys) = self.sys.lock() {
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            snap.cpu = sys.global_cpu_usage().clamp(0.0, 100.0);
            snap.ram_used = sys.used_memory();
            snap.ram_total = sys.total_memory();
        }
        #[cfg(windows)]
        {
            if let Ok(mut guard) = self.win.lock() {
                let w = guard.get_or_insert_with(win::WinPerf::new);
                let g = w.gpu();
                snap.gpu = g.load;
                snap.vram_used = g.vram_used;
                snap.vram_total = w.vram_total();
                snap.gpu_name = w.gpu_name();
                if want_fps {
                    let (fps, pid, status) = w.fps();
                    snap.fps = fps;
                    snap.fps_status = status.into();
                    if let (Some(pid), Ok(mut sys)) = (pid, self.sys.lock()) {
                        let p = sysinfo::Pid::from_u32(pid);
                        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[p]), false);
                        snap.fps_app = sys.process(p).map(|pr| pr.name().to_string_lossy().to_string());
                    }
                } else {
                    w.stop_fps();
                    snap.fps_status = "off".into();
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = want_fps;
        }
        snap
    }

    pub fn stop_fps(&self) {
        #[cfg(windows)]
        if let Ok(mut guard) = self.win.lock() {
            if let Some(w) = guard.as_mut() {
                w.stop_fps();
            }
        }
    }
}

impl Default for PerfState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn perf_snapshot(app: AppHandle, fps: bool) -> PerfSnapshot {
    // PDH/ETW calls can block briefly; keep them off the main thread.
    tauri::async_runtime::spawn_blocking(move || app.state::<PerfState>().snapshot(fps))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn perf_stop(state: State<PerfState>) {
    state.stop_fps();
}

#[cfg(windows)]
mod win {
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::{Arc, Mutex};

    use ferrisetw::provider::Provider;
    use ferrisetw::trace::{stop_trace_by_name, UserTrace};
    use ferrisetw::{EventRecord, SchemaLocator};
    use windows::core::w;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_MORE_DATA,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    const DXGI_PROVIDER: &str = "CA11C036-0102-4A2D-A6AD-F03CFED5D3C9";
    const DXGI_PRESENT_START: u16 = 42;
    const D3D9_PROVIDER: &str = "783ACA0A-790E-4D7F-8451-AA850511C6B9";
    const D3D9_PRESENT_START: u16 = 1;
    /// ETW timestamps are FILETIME (100 ns ticks).
    const ONE_SECOND: i64 = 10_000_000;

    pub struct GpuSample {
        pub load: Option<f32>,
        pub vram_used: Option<u64>,
    }

    struct Adapter {
        name: String,
        dedicated: u64,
        /// Matches the "luid_0x…_0x…" part of PDH instance names.
        luid: String,
    }

    #[derive(Default)]
    struct Presents {
        per_pid: HashMap<u32, VecDeque<i64>>,
    }

    struct FpsTracer {
        trace: UserTrace,
        data: Arc<Mutex<Presents>>,
        latest: Arc<AtomicI64>,
        name: String,
    }

    enum FpsState {
        Off,
        Running(FpsTracer),
        /// Could not start (almost always: missing permission). Retry after a while.
        Failed(std::time::Instant),
    }

    pub struct WinPerf {
        query: isize,
        engine: isize,
        memory: isize,
        pdh_ok: bool,
        adapter: Option<Adapter>,
        fps: FpsState,
    }

    // PDH handles are plain integers owned exclusively by this struct (behind a Mutex).
    unsafe impl Send for WinPerf {}

    fn primary_adapter() -> Option<Adapter> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
        let mut best: Option<Adapter> = None;
        let mut i = 0;
        while let Ok(a) = unsafe { factory.EnumAdapters1(i) } {
            i += 1;
            let Ok(d) = (unsafe { a.GetDesc1() }) else { continue };
            if d.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                continue;
            }
            let len = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
            let name = String::from_utf16_lossy(&d.Description[..len]).trim().to_string();
            let dedicated = d.DedicatedVideoMemory as u64;
            let luid = format!("luid_0x{:08x}_0x{:08x}", d.AdapterLuid.HighPart as u32, d.AdapterLuid.LowPart);
            if best.as_ref().map_or(true, |b| dedicated > b.dedicated) {
                best = Some(Adapter { name, dedicated, luid });
            }
        }
        best
    }

    /// Read a wildcard counter as (instance name, value) pairs.
    fn read_array(counter: isize) -> Vec<(String, f64)> {
        let mut size = 0u32;
        let mut count = 0u32;
        let status = unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None) };
        if status != PDH_MORE_DATA || size == 0 {
            return vec![];
        }
        // Buffer must be 8-byte aligned and hold `size` bytes (items + their name strings).
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        let status = unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items)) };
        if status != 0 {
            return vec![];
        }
        let slice = unsafe { std::slice::from_raw_parts(items, count as usize) };
        slice
            .iter()
            .filter(|it| it.FmtValue.CStatus == 0)
            .map(|it| {
                let name = unsafe { it.szName.to_string() }.unwrap_or_default();
                (name, unsafe { it.FmtValue.Anonymous.doubleValue })
            })
            .collect()
    }

    impl WinPerf {
        pub fn new() -> Self {
            let mut query = 0isize;
            let mut engine = 0isize;
            let mut memory = 0isize;
            let pdh_ok = unsafe {
                PdhOpenQueryW(None, 0, &mut query) == 0
                    && PdhAddEnglishCounterW(query, w!("\\GPU Engine(*)\\Utilization Percentage"), 0, &mut engine) == 0
                    && PdhAddEnglishCounterW(query, w!("\\GPU Adapter Memory(*)\\Dedicated Usage"), 0, &mut memory) == 0
                    && PdhCollectQueryData(query) == 0
            };
            Self { query, engine, memory, pdh_ok, adapter: primary_adapter(), fps: FpsState::Off }
        }

        pub fn gpu_name(&self) -> Option<String> {
            self.adapter.as_ref().map(|a| a.name.clone())
        }

        pub fn vram_total(&self) -> Option<u64> {
            self.adapter.as_ref().map(|a| a.dedicated).filter(|&v| v > 0)
        }

        pub fn gpu(&mut self) -> GpuSample {
            if !self.pdh_ok || unsafe { PdhCollectQueryData(self.query) } != 0 {
                return GpuSample { load: None, vram_used: None };
            }
            let luid = self.adapter.as_ref().map(|a| a.luid.as_str());
            let on_adapter = |name: &str| luid.map_or(true, |l| name.to_ascii_lowercase().contains(l));

            // Task Manager's "GPU %": sum utilisation per engine type across processes, take the busiest engine.
            let mut per_engine: HashMap<String, f64> = HashMap::new();
            for (name, v) in read_array(self.engine) {
                if !on_adapter(&name) {
                    continue;
                }
                let key = name.rsplit_once("engtype_").map(|(_, t)| t.to_string()).unwrap_or_default();
                *per_engine.entry(key).or_default() += v;
            }
            let load = per_engine.values().cloned().fold(None, |m: Option<f64>, v| Some(m.map_or(v, |m| m.max(v))));

            let mut vram: Option<f64> = None;
            for (name, v) in read_array(self.memory) {
                if on_adapter(&name) {
                    vram = Some(vram.map_or(v, |m: f64| m.max(v)));
                }
            }
            GpuSample { load: load.map(|l| l.clamp(0.0, 100.0) as f32), vram_used: vram.map(|v| v as u64) }
        }

        fn start_fps(&mut self) {
            let data = Arc::new(Mutex::new(Presents::default()));
            let latest = Arc::new(AtomicI64::new(0));
            let make_cb = |event: u16| {
                let data = Arc::clone(&data);
                let latest = Arc::clone(&latest);
                move |r: &EventRecord, _: &SchemaLocator| {
                    if r.event_id() != event {
                        return;
                    }
                    let ts = r.raw_timestamp();
                    latest.fetch_max(ts, Ordering::Relaxed);
                    if let Ok(mut d) = data.lock() {
                        let q = d.per_pid.entry(r.process_id()).or_default();
                        q.push_back(ts);
                        while q.front().is_some_and(|&f| f < ts - 2 * ONE_SECOND) {
                            q.pop_front();
                        }
                    }
                }
            };
            let dxgi = Provider::by_guid(DXGI_PROVIDER).add_callback(make_cb(DXGI_PRESENT_START)).build();
            let d3d9 = Provider::by_guid(D3D9_PROVIDER).add_callback(make_cb(D3D9_PRESENT_START)).build();
            let name = format!("NEXUS-FPS-{}", std::process::id());
            // A crashed previous run may have left a session with this name.
            let _ = stop_trace_by_name(&name);
            match UserTrace::new().named(name.clone()).enable(dxgi).enable(d3d9).start_and_process() {
                Ok(trace) => self.fps = FpsState::Running(FpsTracer { trace, data, latest, name }),
                Err(e) => {
                    log::warn!("FPS trace unavailable: {e:?}");
                    self.fps = FpsState::Failed(std::time::Instant::now());
                }
            }
        }

        pub fn stop_fps(&mut self) {
            if let FpsState::Running(t) = std::mem::replace(&mut self.fps, FpsState::Off) {
                let name = t.name.clone();
                if t.trace.stop().is_err() {
                    let _ = stop_trace_by_name(&name);
                }
            }
        }

        /// (fps, pid, status)
        pub fn fps(&mut self) -> (Option<f32>, Option<u32>, &'static str) {
            match &self.fps {
                FpsState::Off => self.start_fps(),
                FpsState::Failed(at) if at.elapsed().as_secs() > 60 => self.start_fps(),
                _ => {}
            }
            let FpsState::Running(t) = &self.fps else { return (None, None, "no_permission") };
            let now = t.latest.load(Ordering::Relaxed);
            if now == 0 {
                return (None, None, "idle");
            }
            let own = std::process::id();
            let fg = unsafe {
                let mut pid = 0u32;
                GetWindowThreadProcessId(GetForegroundWindow(), Some(&mut pid));
                pid
            };
            let Ok(d) = t.data.lock() else { return (None, None, "idle") };
            let count = |q: &VecDeque<i64>| q.iter().filter(|&&ts| ts > now - ONE_SECOND).count();
            // Prefer the foreground app; otherwise the busiest presenting app (not NEXUS itself).
            let pick = d
                .per_pid
                .get(&fg)
                .filter(|_| fg != own)
                .map(|q| (fg, count(q)))
                .filter(|(_, c)| *c > 0)
                .or_else(|| {
                    d.per_pid
                        .iter()
                        .filter(|(pid, _)| **pid != own)
                        .map(|(pid, q)| (*pid, count(q)))
                        .filter(|(_, c)| *c > 0)
                        .max_by_key(|(_, c)| *c)
                });
            match pick {
                Some((pid, frames)) => (Some(frames as f32), Some(pid), "ok"),
                None => (None, None, "idle"),
            }
        }
    }

    impl Drop for WinPerf {
        fn drop(&mut self) {
            self.stop_fps();
            if self.query != 0 {
                unsafe {
                    PdhCloseQuery(self.query);
                }
            }
        }
    }
}
