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
      setSnap({ cpu: 23, ramUsed: 9.4 * 1024 ** 3, ramTotal: 32 * 1024 ** 3, gpu: 41, gpuName: "Preview GPU", vramUsed: 3.2 * 1024 ** 3, vramTotal: 8 * 1024 ** 3, fps: fps ? 144 : null, fpsApp: "game.exe", fpsStatus: fps ? "ok" : "off" });
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

/** Game Bar–style stats row. */
export function PerfStrip({ snap, compact, showFps }: { snap: PerfSnapshot | null; compact?: boolean; showFps: boolean }) {
  const fps = fpsCell(snap);
  const ramPct = snap && snap.ramTotal ? (snap.ramUsed / snap.ramTotal) * 100 : null;
  const vramPct = snap && snap.vramUsed != null && snap.vramTotal ? (snap.vramUsed / snap.vramTotal) * 100 : null;
  const cells: { label: string; value: React.ReactNode; sub?: string; title: string; t?: string }[] = [
    { label: "CPU", value: snap ? pct(snap.cpu) : "—", title: "Total CPU usage", t: tone(snap?.cpu) },
    { label: "GPU", value: pct(snap?.gpu), title: snap?.gpuName ? `${snap.gpuName} — busiest engine` : "GPU usage", t: tone(snap?.gpu) },
    {
      label: "VRAM",
      value: snap?.vramUsed != null ? formatBytes(snap.vramUsed) : "—",
      sub: snap?.vramTotal ? `/ ${formatBytes(snap.vramTotal)}` : undefined,
      title: "Dedicated video memory in use",
      t: tone(vramPct),
    },
    { label: "RAM", value: snap ? formatBytes(snap.ramUsed) : "—", sub: snap ? `/ ${formatBytes(snap.ramTotal)}` : undefined, title: "System memory in use", t: tone(ramPct) },
  ];
  if (showFps) cells.push({ label: "FPS", value: fps.value, title: fps.title });

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
