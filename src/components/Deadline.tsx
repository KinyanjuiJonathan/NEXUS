import { useMemo } from "react";
import { AlarmClock, Flame, TriangleAlert } from "lucide-react";
import { useNexus } from "@/store";
import { useUI } from "@/store/ui";
import { HEAT_CLASS, HEAT_COLOR, hotTasks, type Heat, type HeatInfo } from "@/lib/deadline";
import { formatWithZone } from "@/lib/time";
import { cx } from "./ui";

export function HeatIcon({ heat, size = 11 }: { heat: Heat; size?: number }) {
  if (heat === "none") return null;
  const Icon = heat === "late" ? TriangleAlert : heat === "close" ? Flame : AlarmClock;
  return <Icon size={size} className="heat-icon shrink-0" style={{ color: HEAT_COLOR[heat] }} aria-hidden />;
}

/** "2 h left" with the level's colour and motion. */
export function HeatChip({ info, className }: { info: HeatInfo; className?: string }) {
  if (info.heat === "none") return null;
  return (
    <span className={cx("heat-chip inline-flex items-center gap-1 rounded-md px-1.5 h-[18px] text-[10px] font-semibold tabular whitespace-nowrap", `heat-${info.heat}`, className)} style={{ color: HEAT_COLOR[info.heat], background: `color-mix(in oklab, ${HEAT_COLOR[info.heat]} 14%, transparent)` }} title={info.atRisk ? "The time reserved for this task ends after its deadline" : undefined}>
      <HeatIcon heat={info.heat} size={10} />
      {info.label}
    </span>
  );
}

/** The fuse along the bottom of a row: it fills as the last day before the deadline runs out. */
export function HeatFuse({ info }: { info: HeatInfo }) {
  if (info.heat === "none") return null;
  return (
    <span className="heat-fuse pointer-events-none absolute left-0 bottom-0 h-[2px] rounded-full" style={{ width: `${Math.max(6, info.burn * 100)}%`, background: `linear-gradient(90deg, transparent, ${HEAT_COLOR[info.heat]})` }} aria-hidden />
  );
}

function Ring({ info }: { info: HeatInfo }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const left = info.heat === "late" ? 0 : 1 - info.burn;
  return (
    <span className="relative inline-flex h-8 w-8 items-center justify-center shrink-0">
      <svg width={32} height={32} className="-rotate-90">
        <circle cx={16} cy={16} r={r} fill="none" stroke="var(--border)" strokeWidth={3} />
        <circle cx={16} cy={16} r={r} fill="none" stroke={HEAT_COLOR[info.heat]} strokeWidth={3} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - left)} style={{ transition: "stroke-dashoffset 1s linear" }} />
      </svg>
      <span className="absolute"><HeatIcon heat={info.heat} size={12} /></span>
    </span>
  );
}

/**
 * Deadline radar: the open tasks that are close to their deadline or past it,
 * most urgent first. Each shows how much of its last day is left as a ring
 * that empties, and glows faster the closer it gets. Hidden when nothing is hot.
 */
export function DeadlineRadar({ now, max = 6, className }: { now: number; max?: number; className?: string }) {
  const { tasks, events, zone, hour12 } = useNexus((s) => ({ tasks: s.tasks, events: s.events, zone: s.settings.homeZone, hour12: s.settings.hour12 }));
  const minute = Math.floor(now / 60_000);
  const hot = useMemo(() => hotTasks(tasks, events, now), [tasks, events, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hot.length) return null;
  const late = hot.filter((x) => x.info.heat === "late").length;
  return (
    <section aria-label="Deadline radar" className={cx("glass rounded-2xl px-4 py-3 flex items-center gap-3 min-w-0", className)}>
      <div className="shrink-0 pr-1">
        <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-muted">Deadline radar</div>
        <div className="text-xs text-fg-2 tabular">{late ? `${late} late · ` : ""}{hot.length - late} coming up</div>
      </div>
      <div className="flex gap-2 min-w-0 overflow-x-auto scroll-x pb-0.5">
        {hot.slice(0, max).map(({ task, info }) => (
          <button key={task.id} type="button" onClick={() => useUI.getState().openTask(task.id)} className={cx("relative overflow-hidden flex items-center gap-2 rounded-xl border border-line bg-[var(--bg-2)] pl-1.5 pr-3 py-1 text-left shrink-0 max-w-[230px]", HEAT_CLASS[info.heat])} title={`${task.title}\nDue ${formatWithZone(task.dueAt!, task.dueTz ?? zone, hour12)}${info.atRisk ? "\nThe time reserved for it ends after the deadline" : ""}\nClick to open`}>
            <Ring info={info} />
            <span className="min-w-0">
              <span className="block text-[12px] font-medium truncate">{task.title}</span>
              <span className="block text-[10px] font-semibold tabular" style={{ color: HEAT_COLOR[info.heat] }}>{info.label}</span>
            </span>
          </button>
        ))}
        {hot.length > max && <span className="self-center text-[11px] text-muted shrink-0">+{hot.length - max} more</span>}
      </div>
    </section>
  );
}
