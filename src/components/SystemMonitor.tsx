import { useState } from "react";
import { Cpu } from "lucide-react";
import type { PerfMetric } from "@/data/types";
import { useNexus } from "@/store";
import { native } from "@/lib/platform";
import { LEVEL_COLOR, LEVEL_LABEL, availableMetrics, formatMetric, metricValue, usePerf, usePerfHistory, useUsageLevel, type UsageLevel } from "@/lib/perf";
import { formatBytes } from "@/lib/overlayGeometry";
import { PerfGraph } from "./PerfGraph";
import { Card, cx } from "./ui";

function Tile({ label, value, sub, hot, active, onClick, color, percent }: { label: string; value: string; sub?: string; hot?: boolean; active: boolean; onClick: () => void; color?: string; percent?: number | null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Graph ${label}`}
      className={cx("rounded-xl bg-hover px-2.5 py-2 text-left min-w-0 flex flex-col justify-center transition-colors hover:bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]", active && "ring-1 ring-[color-mix(in_oklab,var(--accent)_55%,transparent)]")}
    >
      <div className={cx("text-[9px] font-bold tracking-widest", active ? "text-accent" : "text-muted")}>{label}</div>
      <div className={cx("font-mono tabular text-[17px] font-semibold leading-tight transition-colors duration-700", hot ? "text-warning" : "text-fg")} style={color ? { color } : undefined}>{value}</div>
      <div className="text-[10px] text-muted tabular truncate h-3.5 leading-tight" title={sub}>{sub}</div>
      {color && percent != null && (
        <div className="mt-1 h-1 rounded-full bg-line overflow-hidden" aria-hidden>
          <div className="h-full rounded-full transition-[width,background-color] duration-700 ease-out" style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: color }} />
        </div>
      )}
    </button>
  );
}

/**
 * Dashboard card with the same live figures as the floating overlay. Both
 * windows read one shared native sample, so the numbers always agree.
 */
export function SystemMonitor() {
  const { on, unit, thresholds } = useNexus((s) => ({ on: s.settings.dashboardPerf, unit: s.settings.tempUnit, thresholds: s.settings.perfThresholds }));
  const available = native || import.meta.env.DEV;
  const snap = usePerf(on && available);
  const history = usePerfHistory();
  const [metric, setMetric] = useState<PerfMetric>("cpu");
  const cpuLevel = useUsageLevel(snap?.cpu, thresholds.cpu);
  // RAM, GPU and VRAM use the same green / yellow / red levels as the CPU.
  const levels: Partial<Record<PerfMetric, UsageLevel | null>> = {
    cpu: cpuLevel,
    ram: useUsageLevel(metricValue(snap, "ram"), thresholds.cpu),
    gpu: useUsageLevel(metricValue(snap, "gpu"), thresholds.cpu),
    vram: useUsageLevel(metricValue(snap, "vram"), thresholds.cpu),
  };
  if (!on || !available) return null;
  const metrics = availableMetrics(snap, false, true);
  const shown = metrics.includes(metric) ? metric : "cpu";
  const v = (m: PerfMetric) => metricValue(snap, m);
  const hot = (m: PerfMetric) => (v(m) ?? 0) >= 90;
  const subs: Partial<Record<PerfMetric, string | undefined>> = {
    cpu: cpuLevel ? LEVEL_LABEL[cpuLevel] : "all cores",
    ram: snap ? `${formatBytes(snap.ramUsed).replace(" GB", "")} / ${formatBytes(snap.ramTotal)}` : undefined,
    gpu: snap?.gpuName ?? undefined,
    vram: snap?.vramUsed != null ? `${formatBytes(snap.vramUsed).replace(" GB", "")} / ${formatBytes(snap.vramTotal)}` : undefined,
    temp: snap?.gpuTemp != null ? "GPU" : "CPU",
  };
  return (
    <Card>
      {/* Readings on the left under the title; the graph on the right starts level with the title, so it gets the extra height without the card growing. */}
      <div className="px-4 pt-3.5 pb-4 grid gap-2.5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
        <div className="flex flex-col gap-2.5 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Cpu size={15} className="text-accent shrink-0" />
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-fg-2 whitespace-nowrap">System monitor</h3>
            <span className="text-[11px] text-muted truncate">live · same readings as the floating overlay</span>
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}>
            {metrics.map((m) => (
              <Tile key={m} label={m === "temp" ? "TEMP" : m.toUpperCase()} value={formatMetric(v(m), m, unit)} sub={subs[m]} hot={m !== "temp" && !levels[m] && hot(m)} active={m === shown} onClick={() => setMetric(m)} color={levels[m] ? LEVEL_COLOR[levels[m]!] : undefined} percent={levels[m] ? v(m) : undefined} />
            ))}
          </div>
        </div>
        <PerfGraph history={history} metric={shown} metrics={metrics} onMetric={setMetric} unit={unit} height={112} thresholds={thresholds} />
      </div>
    </Card>
  );
}
