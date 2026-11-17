import { useState } from "react";
import { DateTime } from "luxon";
import type { Occurrence, Task } from "@/data/types";
import { formatTime } from "@/lib/time";

/**
 * Single-series bar chart (one measure per chart — never dual-axis).
 * Bars are thin, anchored to the baseline with rounded data-ends, hover shows a
 * tooltip, and an sr-only table carries the same data for assistive tech.
 */
export function BarChart({ data, unit, color = "var(--accent)", height = 140, caption }: { data: { label: string; value: number; sub?: string }[]; unit: string; color?: string; height?: number; caption: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 100 / data.length;
  const ticks = [0, Math.ceil(max / 2), max];
  return (
    <figure className="relative">
      <div className="relative flex" style={{ height }}>
        {/* y-axis labels */}
        <div className="w-7 shrink-0 relative text-[10px] text-muted tabular">
          {ticks.map((t) => (
            <span key={t} className="absolute right-1.5 -translate-y-1/2" style={{ top: `${(1 - t / max) * 100}%` }}>{t}</span>
          ))}
        </div>
        <div className="relative flex-1">
          {ticks.map((t) => (
            <div key={t} className="absolute left-0 right-0 border-t border-line" style={{ top: `${(1 - t / max) * 100}%`, opacity: t === 0 ? 1 : 0.5 }} />
          ))}
          <div className="absolute inset-0 flex items-end">
            {data.map((d, i) => (
              <div
                key={i}
                className="relative h-full flex items-end justify-center"
                style={{ width: `${W}%` }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <div
                  className="w-[46%] max-w-[22px] rounded-t-[4px] transition-[height,opacity] duration-500 ease-out"
                  style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value ? 3 : 0, background: color, opacity: hover == null || hover === i ? 1 : 0.45 }}
                />
                {hover === i && (
                  <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 z-10 whitespace-nowrap rounded-lg glass-strong px-2 py-1 text-[11px] shadow-lg pointer-events-none">
                    <span className="text-fg font-semibold tabular">{d.value} {unit}</span>
                    <span className="text-muted ml-1">{d.sub ?? d.label}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex pl-7 mt-1.5">
        {data.map((d, i) => (
          <span key={i} className="text-[10px] text-muted text-center" style={{ width: `${W}%` }}>{d.label}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}><th>{d.sub ?? d.label}</th><td>{d.value} {unit}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Daily timeline: appointments as blocks and deadlines as markers along working hours. */
export function DayTimeline({ occurrences, tasks, now, zone, hour12, startHour = 7, endHour = 21, onSelect }: { occurrences: Occurrence[]; tasks: Task[]; now: number; zone: string; hour12: boolean; startHour?: number; endHour?: number; onSelect?: (o: Occurrence) => void }) {
  const day = DateTime.fromMillis(now, { zone }).startOf("day");
  const s0 = Math.min(startHour, ...occurrences.map((o) => DateTime.fromMillis(Math.max(o.start, day.toMillis()), { zone }).hour));
  const e0 = Math.max(endHour, ...occurrences.map((o) => Math.min(24, DateTime.fromMillis(o.end, { zone }).hour + 1)));
  const from = day.set({ hour: s0 }).toMillis();
  const to = e0 >= 24 ? day.plus({ days: 1 }).toMillis() : day.set({ hour: e0 }).toMillis();
  const pct = (ms: number) => ((Math.min(Math.max(ms, from), to) - from) / (to - from)) * 100;
  const hours: number[] = [];
  for (let h = s0; h <= e0; h += 2) hours.push(h);
  const nowPct = now >= from && now <= to ? pct(now) : null;
  // Simple lane assignment so overlapping blocks don't hide each other.
  const lanes: number[] = [];
  const placed = occurrences.map((o) => {
    let lane = lanes.findIndex((end) => end <= o.start);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(o.end);
    } else lanes[lane] = o.end;
    return { o, lane };
  });
  const laneCount = Math.max(1, lanes.length);
  const dueToday = tasks.filter((t) => t.dueAt != null && t.dueAt >= from && t.dueAt <= to && t.status !== "done" && !t.deletedAt);
  return (
    <div className="relative">
      <div className="relative rounded-xl bg-hover overflow-hidden" style={{ height: 28 + laneCount * 34 }}>
        {hours.map((h) => (
          <div key={h} className="absolute top-0 bottom-0 border-l border-line" style={{ left: `${pct(day.set({ hour: Math.min(h, 23) }).toMillis() + (h === 24 ? 3600_000 : 0))}%` }} />
        ))}
        {placed.map(({ o, lane }) => (
          <button
            key={o.event.id + o.start}
            onClick={() => onSelect?.(o)}
            className="absolute rounded-lg px-2 text-left text-[11px] font-medium text-fg overflow-hidden whitespace-nowrap text-ellipsis border hover:brightness-125 transition"
            title={`${o.event.title} · ${formatTime(o.start, zone, hour12)}–${formatTime(o.end, zone, hour12)}`}
            style={{
              left: `${pct(o.start)}%`,
              width: `calc(${Math.max(pct(o.end) - pct(o.start), 1.5)}% - 2px)`,
              top: 6 + lane * 34,
              height: 28,
              background: `color-mix(in oklab, ${o.event.color ?? "var(--accent)"} 22%, transparent)`,
              borderColor: `color-mix(in oklab, ${o.event.color ?? "var(--accent)"} 45%, transparent)`,
            }}
          >
            {o.event.important && "★ "}
            {o.event.title}
          </button>
        ))}
        {dueToday.map((t) => (
          <div key={t.id} className="absolute bottom-1 -translate-x-1/2 flex flex-col items-center" style={{ left: `${pct(t.dueAt!)}%` }} title={`Due: ${t.title} at ${formatTime(t.dueAt!, zone, hour12)}`}>
            <span className="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-accent-2 ring-2 ring-[var(--bg)]" />
          </div>
        ))}
        {nowPct != null && (
          <div className="absolute top-0 bottom-0 w-[2px] bg-danger" style={{ left: `${nowPct}%` }}>
            <span className="absolute -top-0.5 -left-[3px] h-2 w-2 rounded-full bg-danger" />
          </div>
        )}
      </div>
      <div className="relative h-4 mt-1">
        {hours.map((h) => (
          <span key={h} className="absolute -translate-x-1/2 text-[10px] text-muted tabular" style={{ left: `${pct(day.set({ hour: Math.min(h, 23) }).toMillis() + (h === 24 ? 3600_000 : 0))}%` }}>
            {hour12 ? `${h % 12 || 12}${h < 12 || h === 24 ? "a" : "p"}` : `${String(h).padStart(2, "0")}`}
          </span>
        ))}
      </div>
    </div>
  );
}
