import { useMemo } from "react";
import { DateTime } from "luxon";
import { BedDouble, Briefcase, Coffee, Dumbbell, Sunrise, Utensils, ClipboardList, AlarmClock } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { KENYA_ZONE, formatTime } from "@/lib/time";
import { MAX_WORK_MIN, MIN_SLEEP_MIN, normalizeRoutine, routineDay, workMinutes, type Routine, type RoutineKind } from "@/lib/routine";
import { hoursMinutes } from "@/lib/countdown";
import { Button, Modal, Toggle, cx } from "./ui";

const hhmm = (min: number) => `${String(Math.floor((((min % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String(((min % 1440) + 1440) % 1440 % 60).padStart(2, "0")}`;
const toMin = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

export const ROUTINE_STYLE: Record<RoutineKind, { color: string; icon: React.ReactNode }> = {
  sleep: { color: "#6366f1", icon: <BedDouble size={12} /> },
  wake: { color: "#f59e0b", icon: <Sunrise size={12} /> },
  exercise: { color: "#22c55e", icon: <Dumbbell size={12} /> },
  prepare: { color: "#f59e0b", icon: <AlarmClock size={12} /> },
  breakfast: { color: "#f97316", icon: <Utensils size={12} /> },
  admin: { color: "#a78bfa", icon: <ClipboardList size={12} /> },
  work: { color: "#22d3ee", icon: <Briefcase size={12} /> },
  break: { color: "#94a3b8", icon: <Coffee size={12} /> },
  lunch: { color: "#f97316", icon: <Utensils size={12} /> },
  gym: { color: "#22c55e", icon: <Dumbbell size={12} /> },
};

function Minutes({ label, value, onChange, min = 0, max = 240, step = 5 }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted">
      {label}
      <span className="flex items-center gap-1.5">
        <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-8 w-20 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent" />
        min
      </span>
    </label>
  );
}

/**
 * The daily routine: sleep, the morning, work sessions with breaks and lunch,
 * admin time and the gym. Tasks are planned inside the work sessions and never
 * over sleep, meals, the morning routine or the gym.
 */
export function RoutineDialog() {
  const open = useUI((s) => s.routine);
  const close = () => useUI.getState().openRoutine(false);
  const { r, hour12, texasZone } = useNexus((s) => ({ r: s.settings.routine, hour12: s.settings.hour12, texasZone: s.settings.texasZone }));
  const set = (patch: Partial<Routine>) => void nexus().setSetting("routine", normalizeRoutine({ ...r, ...patch }));
  const today = DateTime.now().setZone(r.zone);
  // a day that has the gym on it, so the preview shows everything
  const sample = useMemo(() => {
    let d = today;
    for (let i = 0; i < 7 && r.gymDays.length && !r.gymDays.includes(d.weekday); i++) d = d.plus({ days: 1 });
    return routineDay(d.toISODate()!, r);
  }, [r]); // eslint-disable-line react-hooks/exhaustive-deps
  const work = workMinutes(r);
  const first = sample.find((b) => b.kind === "wake" || b.kind === "work");
  const lastWork = [...sample].reverse().find((b) => b.kind === "work");
  const time = (ms: number) => formatTime(ms, r.zone, hour12);
  const maxSessions = Math.floor(MAX_WORK_MIN / r.sessionMin);

  return (
    <Modal open={open} onClose={close} title="Daily routine" icon={<Sunrise size={18} />} width={720} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <div className="flex flex-col gap-4">
        <Toggle checked={r.enabled} onChange={(v) => set({ enabled: v })} label="Plan my days around this routine" description="Every day of the week. Tasks go into the work sessions only; sleep, the morning routine, admin time, lunch and the gym are never scheduled over. A day you give hours for by hand follows those hours instead." />
        <div className={cx("grid md:grid-cols-[minmax(0,1fr)_260px] gap-5", !r.enabled && "opacity-50 pointer-events-none")}>
          <div className="flex flex-col gap-4">
            <section className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                Routine is in
                <span className="flex gap-1.5">
                  {[[KENYA_ZONE, "Kenya time"], [texasZone, "Texas time"]].map(([z, label]) => (
                    <button key={z} type="button" aria-pressed={r.zone === z} onClick={() => set({ zone: z })} className={cx("h-8 px-2.5 rounded-lg border text-xs font-medium transition", r.zone === z ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-fg-2 hover:text-fg")}>{label}</button>
                  ))}
                </span>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                Wake up at
                <input type="time" value={hhmm(r.wake)} onChange={(e) => { const m = toMin(e.target.value); if (m != null) set({ wake: m }); }} className="h-8 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent" />
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                Sleep (at least 6 h)
                <span className="flex items-center gap-1.5">
                  <input type="number" min={6} max={12} step={0.5} value={r.sleepMin / 60} onChange={(e) => set({ sleepMin: Math.max(MIN_SLEEP_MIN, Number(e.target.value) * 60) })} className="h-8 w-16 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent" />
                  hours, from {hhmm(r.wake - r.sleepMin)}
                </span>
              </label>
            </section>
            <section>
              <h4 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted mb-2">Morning</h4>
              <div className="flex flex-wrap gap-3">
                <Minutes label="Waking up" value={r.wakeUpMin} onChange={(v) => set({ wakeUpMin: v })} max={120} />
                <Minutes label="Exercise" value={r.exerciseMin} onChange={(v) => set({ exerciseMin: v })} max={120} />
                <Minutes label="Getting ready" value={r.prepareMin} onChange={(v) => set({ prepareMin: v })} max={120} />
                <Minutes label="Breakfast" value={r.breakfastMin} onChange={(v) => set({ breakfastMin: v })} max={120} />
                <Minutes label="Admin & planning" value={r.adminMin} onChange={(v) => set({ adminMin: v })} max={120} />
              </div>
            </section>
            <section>
              <h4 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted mb-2">Work</h4>
              <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1 text-[11px] text-muted">
                  Sessions
                  <input type="number" min={1} max={maxSessions} value={r.sessions} onChange={(e) => set({ sessions: Number(e.target.value) })} className="h-8 w-16 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent" />
                </label>
                <Minutes label="Each session" value={r.sessionMin} onChange={(v) => set({ sessionMin: v })} min={15} />
                <Minutes label="Break between" value={r.breakMin} onChange={(v) => set({ breakMin: v })} max={120} />
                <Minutes label="Lunch" value={r.lunchMin} onChange={(v) => set({ lunchMin: v })} max={180} />
                <label className="flex flex-col gap-1 text-[11px] text-muted">
                  Lunch after session
                  <input type="number" min={1} max={r.sessions} value={r.lunchAfter} onChange={(e) => set({ lunchAfter: Number(e.target.value) })} className="h-8 w-16 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent" />
                </label>
              </div>
              <p className={cx("text-[11px] mt-2", work >= MAX_WORK_MIN ? "text-warning" : "text-muted")}>
                {hoursMinutes(work * 60_000)} of work a day (the limit is 12 hours{work >= MAX_WORK_MIN ? ", reached" : ""}). The rest of the day is yours: {hoursMinutes((24 * 60 - work) * 60_000)} for sleep, meals, exercise and rest.
              </p>
            </section>
            <section>
              <h4 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted mb-2">Gym</h4>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex gap-1" role="group" aria-label="Gym days">
                  {DAYS.map((d, i) => {
                    const wd = i + 1;
                    const on = r.gymDays.includes(wd);
                    return <button key={wd} type="button" aria-pressed={on} aria-label={["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]} onClick={() => set({ gymDays: on ? r.gymDays.filter((x) => x !== wd) : [...r.gymDays, wd] })} className={cx("h-8 w-8 rounded-lg text-xs font-semibold", on ? "bg-accent text-white" : "bg-hover text-muted")}>{d}</button>;
                  })}
                </div>
                <label className="flex flex-col gap-1 text-[11px] text-muted">
                  Starts
                  <input type="time" value={hhmm(r.gymStart)} onChange={(e) => { const m = toMin(e.target.value); if (m != null) set({ gymStart: m }); }} className="h-8 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent" />
                </label>
                <Minutes label="Length" value={r.gymMin} onChange={(v) => set({ gymMin: v })} min={15} />
              </div>
            </section>
          </div>
          <aside className="rounded-xl border border-line p-3 flex flex-col gap-1 self-start">
            <h4 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted mb-1">A day, in order</h4>
            {sample.map((b) => {
              const st = ROUTINE_STYLE[b.kind];
              return (
                <div key={b.kind + b.start} className="flex items-center gap-2 text-[11px] min-w-0">
                  <span className="shrink-0" style={{ color: st.color }}>{st.icon}</span>
                  <span className="tabular text-muted shrink-0 w-[104px]">{time(b.start)} – {time(b.end)}</span>
                  <span className={cx("truncate", b.kind === "work" ? "text-fg font-medium" : "text-fg-2")}>{b.label}</span>
                </div>
              );
            })}
            {first && lastWork && <p className="text-[10px] text-muted mt-1.5">Up at {time(first.start)}, last session ends {time(lastWork.end)}. The computer should be off or asleep during sleep; NEXUS reminds you if it is still in use.</p>}
          </aside>
        </div>
      </div>
    </Modal>
  );
}
