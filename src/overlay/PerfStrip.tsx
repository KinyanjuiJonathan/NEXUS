import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { perfSnapshot, perfStop, native, type PerfSnapshot } from "@/lib/platform";
import { formatBytes } from "@/lib/overlayGeometry";
import { cx } from "@/components/ui";

/**
 * Polls system performance about once a second while enabled and visible.
 * Stops polling (and the FPS trace) when hidden or disabled.
 */
export function usePerf(enabled: boolean, fps: boolean): PerfSnapshot | null {
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  useEffect(() => {
    if (enabled && !native && import.meta.env.DEV) {
      // Browser dev server only (never in production builds): sample numbers so the layout can be designed.
      setSnap({ cpu: 23, ramUsed: 9.4 * 1024 ** 3, ramTotal: 32 * 1024 ** 3, gpu: 41, gpuName: "Preview GPU", vramUsed: 3.2 * 1024 ** 3, vramTotal: 8 * 1024 ** 3, fps: fps ? 144 : null, fpsApp: "game.exe", fpsStatus: fps ? "ok" : "off", gpuTemp: 64, cpuTemp: 58 });
      return;
    }
    if (!enabled || !native) {
      setSnap(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!alive) return;
      if (!document.hidden) {
        try {
          const s = await perfSnapshot(fps);
          if (alive) setSnap(s);
        } catch {
          /* keep last value */
        }
      }
      if (alive) timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      void perfStop();
    };
  }, [enabled, fps]);
  return snap;
}

const short = (s: string) => s.replace(" GB", "G").replace(" MB", "M");
const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}%`);
const tone = (v: number | null | undefined) => (v != null && v >= 90 ? "text-warning" : "text-fg");

function fpsCell(s: PerfSnapshot | null): { value: React.ReactNode; title: string } {
  if (!s) return { value: "—", title: "Performance stats are available in the desktop app" };
  switch (s.fpsStatus) {
    case "ok":
      return { value: Math.round(s.fps ?? 0), title: `${s.fpsApp ?? "Foreground app"} — frames presented in the last second` };
    case "idle":
      return { value: "—", title: "No DirectX app is presenting frames right now" };
    case "no_permission":
      return {
        value: <Lock size={11} className="inline" />,
        title: "Measuring FPS needs permission. Run NEXUS as administrator once, or add your account to the “Performance Log Users” group (see README), then restart NEXUS.",
      };
    default:
      return { value: "—", title: "FPS measurement is unavailable on this system" };
  }
}

export const tempTone = (c: number | null | undefined) => (c == null ? "var(--muted)" : c >= 85 ? "var(--danger)" : c >= 70 ? "var(--warning)" : "var(--accent)");
export const fmtTemp = (c: number | null | undefined, unit: "C" | "F") => (c == null ? "—" : unit === "F" ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`);

/** Small semicircle temperature gauge (20–100 °C scale); the colour reflects state. */
export function TempGauge({ celsius, size = 30 }: { celsius: number | null | undefined; size?: number }) {
  const r = size / 2 - 3;
  const v = celsius == null ? 0 : Math.min(1, Math.max(0, (celsius - 20) / 80));
  const len = Math.PI * r;
  const d = `M 3 ${size / 2} A ${r} ${r} 0 0 1 ${size - 3} ${size / 2}`;
  return (
    <svg width={size} height={size / 2 + 3} aria-hidden className="shrink-0">
      <path d={d} fill="none" stroke="var(--border-strong)" strokeWidth={3.5} strokeLinecap="round" />
      <path d={d} fill="none" stroke={tempTone(celsius)} strokeWidth={3.5} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - v)} style={{ transition: "stroke-dashoffset .6s ease" }} />
    </svg>
  );
}

/** Game Bar–style stats row. */
export function PerfStrip({ snap, compact, showFps, showTemp = false, unit = "C" }: { snap: PerfSnapshot | null; compact?: boolean; showFps: boolean; showTemp?: boolean; unit?: "C" | "F" }) {
  const fps = fpsCell(snap);
  const mainTemp = snap?.gpuTemp ?? snap?.cpuTemp ?? null;
  const tempTitle = `GPU ${fmtTemp(snap?.gpuTemp, unit)}${unit} · CPU ${fmtTemp(snap?.cpuTemp, unit)}${unit}` +
    (snap && snap.cpuTemp == null ? " — CPU temperature isn't exposed by this PC's firmware without admin rights (see README)" : "");
  const ramPct = snap && snap.ramTotal ? (snap.ramUsed / snap.ramTotal) * 100 : null;
  const vramPct = snap && snap.vramUsed != null && snap.vramTotal ? (snap.vramUsed / snap.vramTotal) * 100 : null;
  const cells: { label: string; value: React.ReactNode; sub?: string; title: string; t?: string }[] = [
    { label: "CPU", value: snap ? pct(snap.cpu) : "—", title: "Total CPU usage", t: tone(snap?.cpu) },
    { label: "GPU", value: pct(snap?.gpu), title: snap?.gpuName ? `${snap.gpuName} — busiest engine` : "GPU usage", t: tone(snap?.gpu) },
    {
      label: "VRAM",
      value: snap?.vramUsed != null ? short(formatBytes(snap.vramUsed)) : "—",
      sub: snap?.vramTotal ? `/ ${short(formatBytes(snap.vramTotal))}` : undefined,
      title: "Dedicated video memory in use",
      t: tone(vramPct),
    },
    { label: "RAM", value: snap ? short(formatBytes(snap.ramUsed)) : "—", sub: snap ? `/ ${short(formatBytes(snap.ramTotal))}` : undefined, title: "System memory in use", t: tone(ramPct) },
  ];
  if (showFps) cells.push({ label: "FPS", value: fps.value, title: fps.title });
  if (showTemp) {
    cells.push({
      label: "TEMP",
      value: (
        <span className="inline-flex items-end gap-1" style={{ color: mainTemp != null && mainTemp >= 70 ? tempTone(mainTemp) : undefined }}>
          {!compact && <TempGauge celsius={mainTemp} size={18} />}
          {fmtTemp(mainTemp, unit)}
        </span>
      ),
      sub: snap?.gpuTemp != null && snap?.cpuTemp != null ? `CPU ${fmtTemp(snap.cpuTemp, unit)}` : snap?.gpuTemp != null ? "GPU" : snap?.cpuTemp != null ? "CPU" : undefined,
      title: tempTitle,
    });
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-[10px] tabular whitespace-nowrap overflow-hidden" aria-label="System performance">
        {cells.map((c) => (
          <span key={c.label} title={c.title} className="inline-flex items-baseline gap-1">
            <span className="text-muted font-semibold tracking-wide">{c.label}</span>
            <span className={cx("font-mono font-semibold", c.t ?? "text-fg")}>{typeof c.value === "string" ? c.value.replace(" GB", "G").replace(" MB", "M") : c.value}</span>
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))` }} aria-label="System performance">
      {cells.map((c) => (
        <div key={c.label} title={c.title} className="rounded-lg bg-hover px-1.5 py-1 min-w-0">
          <div className="text-[9px] font-bold tracking-widest text-muted">{c.label}</div>
          <div className={cx("font-mono tabular text-[13px] font-semibold leading-tight truncate", c.t ?? "text-fg")}>{c.value}</div>
          {c.sub && <div className="text-[9px] text-muted tabular truncate">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}
