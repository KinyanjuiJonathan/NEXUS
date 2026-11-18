import { useMemo } from "react";
import type { PerfMetric } from "@/data/types";
import type { PerfSnapshot } from "@/lib/platform";
import { GRAPH_POINTS, METRIC_LABEL, SAMPLE_MS, formatMetric, graphPaths, metricRange, metricValue } from "@/lib/perf";
import { cx } from "./ui";

const W = 100;
const STEP = W / (GRAPH_POINTS - 1);

const COLOR: Record<PerfMetric, string> = {
  cpu: "var(--accent)",
  ram: "var(--accent-2)",
  gpu: "var(--accent-3)",
  vram: "var(--accent-2)",
  fps: "var(--success)",
  temp: "var(--warning)",
};

/**
 * Live graph of one metric over the last minute. A new point arrives every
 * second; in between, the whole line glides left with a compositor-only CSS
 * animation, so it looks continuous without a per-frame render loop.
 */
export function PerfGraph({
  history, metric, metrics, onMetric, unit = "C", height = 56, className,
}: {
  history: PerfSnapshot[];
  metric: PerfMetric;
  /** Metrics the user can switch between. */
  metrics: PerfMetric[];
  onMetric: (m: PerfMetric) => void;
  unit?: "C" | "F";
  height?: number;
  className?: string;
}) {
  const shown = metrics.includes(metric) ? metric : metrics[0] ?? "cpu";
  const values = useMemo(() => history.map((s) => metricValue(s, shown)), [history, shown]);
  const range = metricRange(shown, values);
  const H = 40;
  const { line, area } = useMemo(() => graphPaths(values, range, W, H, STEP), [values, range.min, range.max]); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = values.length ? values[values.length - 1] : null;
  const real = values.filter((v): v is number => v != null);
  const avg = real.length ? real.reduce((a, b) => a + b, 0) / real.length : null;
  const peak = real.length ? Math.max(...real) : null;
  const color = COLOR[shown];
  const stamp = history.length ? history.length + ":" + (history[history.length - 1].cpu ?? 0) + ":" + (history[0].cpu ?? 0) : "0";
  const fmt = (v: number | null) => formatMetric(v, shown, unit);

  return (
    <div className={cx("rounded-xl bg-hover px-2 pt-1.5 pb-1.5 min-w-0", className)} aria-label={`${METRIC_LABEL[shown]} over the last minute`}>
      <div className="flex items-center gap-2 mb-1">
        <div className="no-drag flex items-center gap-0.5 min-w-0 overflow-hidden" role="tablist" aria-label="Metric to graph">
          {metrics.map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={m === shown}
              onClick={() => onMetric(m)}
              title={`Graph ${METRIC_LABEL[m]}`}
              className={cx("h-5 px-1.5 rounded-md text-[9px] font-bold tracking-widest transition-colors", m === shown ? "text-fg bg-[color-mix(in_oklab,var(--accent)_22%,transparent)]" : "text-muted hover:text-fg")}
            >
              {METRIC_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-baseline gap-2 shrink-0 tabular">
          <span className="text-[9px] text-muted">avg {fmt(avg)} · peak {fmt(peak)}</span>
          <span className="font-mono text-[13px] font-semibold" style={{ color }}>{fmt(latest)}{shown === "fps" && latest != null ? " fps" : ""}</span>
        </div>
      </div>
      <div className="relative overflow-hidden rounded-md" style={{ height }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <div key={f} className="absolute left-0 right-0 border-t border-line" style={{ top: `${f * 100}%`, opacity: 0.6 }} />
        ))}
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <linearGradient id={`perf-fill-${shown}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.38" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* Re-keyed on every sample so the slide restarts from one step to the right. */}
          <g key={stamp} className="perf-slide" style={{ ["--perf-step" as string]: `${STEP}px`, animationDuration: `${SAMPLE_MS}ms` }}>
            <path d={area} fill={`url(#perf-fill-${shown})`} />
            <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </g>
        </svg>
        <span className="absolute left-1 top-0.5 text-[8px] text-muted tabular">{fmt(range.max)}</span>
        <span className="absolute left-1 bottom-0.5 text-[8px] text-muted tabular">{fmt(range.min)}</span>
        {real.length < 2 && <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted">Collecting data…</span>}
      </div>
    </div>
  );
}
