import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { CalendarClock, Clock3, Globe2, Sunrise } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { KENYA_ZONE, formatTime, isValidZone } from "@/lib/time";
import { dayKey, hoursFor, workHours, type WorkWeek } from "@/lib/workPlan";
import { Button, Modal, Select, cx } from "./ui";
import { confirm } from "./Confirm";

/** Zones offered first; any other IANA zone is in the "Other" list. */
export const ZONE_PRESETS: { zone: string; label: string; place: string }[] = [
  { zone: KENYA_ZONE, label: "Kenya", place: "Nairobi" },
  { zone: "America/Chicago", label: "Texas", place: "Central" },
  { zone: "Europe/London", label: "UK", place: "London" },
  { zone: "America/New_York", label: "US East", place: "New York" },
  { zone: "America/Denver", label: "US Mountain", place: "Denver" },
  { zone: "America/Los_Angeles", label: "US West", place: "Los Angeles" },
  { zone: "Australia/Sydney", label: "Australia", place: "Sydney" },
  { zone: "Australia/Perth", label: "Australia", place: "Perth" },
];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const toMin = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const allZones = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};

/**
 * Time zone and working hours, reachable from the top bar at any time.
 * Changing the zone only changes how times are shown and typed: every task
 * and appointment keeps its actual moment. Working hours can differ per
 * weekday; tasks are only moved into new hours when the user asks.
 */
export function TimeHoursDialog() {
  const open = useUI((s) => s.timeHours);
  const close = () => useUI.getState().openTimeHours(false);
  const settings = useNexus((s) => s.settings);
  const zone = settings.homeZone;
  const [now] = useState(() => Date.now());
  const others = useMemo(() => allZones().filter((z) => !ZONE_PRESETS.some((p) => p.zone === z)), []);
  const s = nexus();
  const week: WorkWeek = settings.workWeek ?? {};
  const wh = workHours(settings);

  const setZone = async (z: string) => {
    if (!isValidZone(z) || z === zone) return;
    await s.setSetting("homeZone", z);
    // the calendar follows the scheduling zone unless it was pinned to Kenya or Texas on purpose
    if (settings.calendarDisplayZone !== "local") await s.setSetting("calendarDisplayZone", "local");
    s.toast({ kind: "success", title: `Times now shown in ${z.split("/").pop()!.replace(/_/g, " ")}`, body: "Nothing was moved: every task and appointment keeps its actual moment.", ttl: 6000 });
  };
  const setDay = (wd: number, v: [number, number] | "off" | null) => {
    const next = { ...week };
    if (v == null) delete next[wd];
    else next[wd] = v;
    void s.setSetting("workWeek", next);
  };
  const refit = async () => {
    const ok = await confirm({
      title: "Reschedule tasks into these hours?",
      body: "Every open flexible task is fitted again from now on, in the same order, inside your working hours. Fixed appointments are not moved. You can undo it from the notice that follows.",
      confirmLabel: "Reschedule",
    });
    if (ok) await s.rescheduleAll({ mode: "from", at: Date.now(), strict: true });
  };

  return (
    <Modal open={open} onClose={close} title="Time zone & working hours" icon={<Globe2 size={18} />} width={620} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted">Scheduling time zone</h4>
            <span className="text-[11px] text-fg-2 tabular">{DateTime.fromMillis(now, { zone }).toFormat("ccc d LLL")} · {formatTime(now, zone, settings.hour12)} · {DateTime.fromMillis(now, { zone }).toFormat("ZZZZ")}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="radiogroup" aria-label="Scheduling time zone">
            {ZONE_PRESETS.map((p) => {
              const on = p.zone === zone;
              return (
                <button key={p.zone} type="button" role="radio" aria-checked={on} onClick={() => void setZone(p.zone)} title={p.zone} className={cx("rounded-xl border px-3 py-2 text-left transition", on ? "border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line hover:bg-hover")}>
                  <div className={cx("text-sm font-semibold", on ? "text-accent" : "text-fg")}>{p.label}</div>
                  <div className="text-[11px] text-muted tabular">{p.place} · {formatTime(now, p.zone, settings.hour12)}</div>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted shrink-0">Other</span>
            <Select value={ZONE_PRESETS.some((p) => p.zone === zone) ? "" : zone} onChange={(e) => e.target.value && void setZone(e.target.value)} aria-label="Other time zone" className="!w-72">
              <option value="">Choose another time zone…</option>
              {!ZONE_PRESETS.some((p) => p.zone === zone) && !others.includes(zone) && <option value={zone}>{zone}</option>}
              {others.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
            </Select>
          </div>
          <p className="text-[11px] text-muted">Switching zones changes how times are shown and typed everywhere (Dashboard, Tasks, Calendar). Tasks and appointments keep their actual moment, and daylight-saving changes are handled for you.</p>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h4 className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted">Working hours by day</h4>
            <span className="text-[11px] text-muted">in {zone.split("/").pop()!.replace(/_/g, " ")} time</span>
          </div>
          <div className="rounded-xl border border-line divide-y divide-[var(--border)]">
            {DAYS.map((name, i) => {
              const wd = i + 1;
              const v = week[wd];
              const mode = v === "off" ? "off" : v ? "set" : "flex";
              // what "flexible" currently means for the next such weekday
              let d = DateTime.fromMillis(now, { zone }).startOf("day");
              while (d.weekday !== wd) d = d.plus({ days: 1 });
              const eff = hoursFor(d.toISODate()!, wh);
              return (
                <div key={wd} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
                  <span className={cx("w-24 text-sm", wd > 5 ? "text-fg-2" : "text-fg")}>{name}</span>
                  <Select value={mode} aria-label={`${name}: kind of day`} className="!w-36 !h-8" onChange={(e) => setDay(wd, e.target.value === "off" ? "off" : e.target.value === "set" ? (Array.isArray(v) ? v : [9 * 60, 17 * 60]) : null)}>
                    <option value="flex">Flexible</option>
                    <option value="set">Set hours</option>
                    <option value="off">Day off</option>
                  </Select>
                  {Array.isArray(v) ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted">
                      <input type="time" aria-label={`${name} start`} value={hhmm(v[0])} onChange={(e) => { const m = toMin(e.target.value); if (m != null) setDay(wd, [m, v[1]]); }} className="h-8 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent" />
                      to
                      <input type="time" aria-label={`${name} end`} value={hhmm(v[1])} onChange={(e) => { const m = toMin(e.target.value); if (m != null) setDay(wd, [v[0], m]); }} className="h-8 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent" />
                      {v[1] <= v[0] && <span className="text-accent">next day</span>}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted tabular">
                      {mode === "off" ? "Nothing is scheduled automatically" : eff ? `${settings.routine?.enabled ? "Daily routine" : Object.values(settings.workPlans ?? {}).some((p) => !("off" in p)) ? "Follows your latest answer" : "Default hours"}: ${formatTime(eff.start, zone, settings.hour12)} – ${formatTime(eff.end, zone, settings.hour12)}` : "No hours yet"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted">“Flexible” days use the hours you give when NEXUS asks, or your latest answer. An answer for a particular date always wins over this table.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" icon={<Clock3 size={14} />} onClick={() => { close(); useUI.getState().openWorkPlan(true); }}>
              Set hours for {settings.workPlans?.[dayKey(now, zone)] ? "a day" : "today"}…
            </Button>
            <Button size="sm" variant="outline" icon={<Sunrise size={14} />} onClick={() => { close(); useUI.getState().openRoutine(true); }}>Daily routine{settings.routine?.enabled ? " (on)" : ""}…</Button>
            <Button size="sm" variant="soft" icon={<CalendarClock size={14} />} onClick={() => void refit()}>Reschedule tasks into these hours</Button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
