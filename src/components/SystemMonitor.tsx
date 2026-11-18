import { useState } from "react";
import { Cpu } from "lucide-react";
import type { PerfMetric } from "@/data/types";
import { useNexus } from "@/store";
import { native } from "@/lib/platform";
import { LEVEL_COLOR, LEVEL_LABEL, availableMetrics, formatMetric, metricValue, usePerf, usePerfHistory, useUsageLevel } from "@/lib/perf";
import { formatBytes } from "@/lib/overlayGeometry";
import { PerfGraph } from "./PerfGraph";
import { Card, CardHeader, cx } from "./ui";

function Tile({ label, value, sub, hot, active, onClick, color, percent }: { label: string; value: string; sub?: string; hot?: boolean; active: boolean; onClick: () => void; color?: string; percent?: number | null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Graph ${label}`}
      className={cx("rounded-xl bg-hover px-3 py-2 text-left min-w-0 transition-colors hover:bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]", active && "ring-1 ring-[color-mix(in_oklab,var(--accent)_55%,transparent)]")}
    >
      <div className={cx("text-[10px] font-bold tracking-widest", active ? "text-accent" : "text-muted")}>{label}</div>
      <div className={cx("font-mono tabular text-xl font-semibold leading-tight transition-colors duration-700", hot ? "text-warning" : "text-fg")} style={color ? { color } : undefined}>{value}</div>
      <div className="text-[11px] text-muted tabular truncate h-4">{sub}</div>
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
  if (!on || !available) return null;
  const metrics = availableMetrics(snap, false, true);
  const shown = metrics.includes(metric) ? metric : "cpu";
  const v = (m: PerfMetric) => metricValue(snap, m);
  const hot = (m: PerfMetric) => (v(m) ?? 0) >= 90;
  const subs: Partial<Record<PerfMetric, string | undefined>> = {
    cpu: cpuLevel ? `${LEVEL_LABEL[cpuLevel]} · all cores` : "of all cores",
    ram: snap ? `${formatBytes(snap.ramUsed)} of ${formatBytes(snap.ramTotal)}` : undefined,
    gpu: snap?.gpuName ?? undefined,
    vram: snap?.vramUsed != null ? `${formatBytes(snap.vramUsed)} of ${formatBytes(snap.vramTotal)}` : undefined,
    temp: snap?.gpuTemp != null ? "GPU" : "CPU",
  };
  return (
    <Card>
      <CardHeader title="System monitor" icon={<Cpu size={16} />} subtitle="Live, updated every second — the same readings as the floating overlay" />
      <div className="px-5 pb-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-stretch">
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(metrics.length, 3)}, minmax(0, 1fr))` }}>
          {metrics.map((m) => (
            <Tile key={m} label={m === "temp" ? "TEMP" : m.toUpperCase()} value={formatMetric(v(m), m, unit)} sub={subs[m]} hot={m !== "temp" && m !== "cpu" && hot(m)} active={m === shown} onClick={() => setMetric(m)} color={m === "cpu" && cpuLevel ? LEVEL_COLOR[cpuLevel] : undefined} percent={m === "cpu" ? v(m) : undefined} />
          ))}
        </div>
        <PerfGraph history={history} metric={shown} metrics={metrics} onMetric={setMetric} unit={unit} height={96} thresholds={thresholds} />
      </div>
    </Card>
  );
}
