import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import { BriefcaseBusiness, Moon } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { KENYA_ZONE, formatTime, zoneAbbr } from "@/lib/time";
import { dayKey, hoursFor, workHours } from "@/lib/workPlan";
import { hoursMinutes } from "@/lib/countdown";
import { Button, Modal, cx } from "./ui";
import { DateTimePicker } from "./DatePicker";

const HOURS = [4, 6, 8, 10, 12];
const HOUR = 3600_000;

/** One zone's calendar day as a 24-hour track with the working time lit up (wrapping past midnight when it has to). */
function DayTrack({ label, zone, start, end, color, hour12, now }: { label: string; zone: string; start: number; end: number; color: string; hour12: boolean; now: number }) {
  const day0 = DateTime.fromMillis(start, { zone }).startOf("day").toMillis();
  const pct = (ms: number) => ((ms - day0) / (24 * HOUR)) * 100;
  const a = pct(start);
  const b = pct(end);
  const segs = b <= 100 ? [[a, b]] : [[a, 100], [0, Math.min(b - 100, a)]];
  const nowPct = pct(now);
  return (
    <div className="flex items-center gap-3">
      <div className="w-[104px] shrink-0">
        <div className="text-[11px] font-semibold" style={{ color }}>{label}</div>
        <div className="text-[11px] text-fg-2 tabular whitespace-nowrap">{formatTime(start, zone, hour12)} – {formatTime(end, zone, hour12)}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="relative h-5 rounded-md bg-hover overflow-hidden" role="img" aria-label={`${label}: ${formatTime(start, zone, hour12)} to ${formatTime(end, zone, hour12)}`}>
          {[6, 12, 18].map((h) => <span key={h} className="absolute top-0 bottom-0 w-px bg-line" style={{ left: `${(h / 24) * 100}%` }} />)}
          {segs.map(([x, y], i) => (
            <span key={i} className="absolute top-0.5 bottom-0.5 rounded transition-all duration-300" style={{ left: `${x}%`, width: `${Math.max(0, y - x)}%`, background: `linear-gradient(90deg, color-mix(in oklab, ${color} 55%, transparent), ${color})`, boxShadow: `0 0 10px color-mix(in oklab, ${color} 45%, transparent)` }} />
          ))}
          {nowPct >= 0 && nowPct <= 100 && <span className="absolute top-0 bottom-0 w-0.5 bg-fg" style={{ left: `${nowPct}%` }} title="Now" />}
        </div>
        <div className="flex justify-between text-[9px] text-muted tabular mt-0.5"><span>12 AM</span><span>6</span><span>12 PM</span><span>6</span><span>12</span></div>
      </div>
    </div>
  );
}

/**
 * "When do you intend to work?" The answer is that day's working time: a
 * start, in Kenya or Texas time, and a number of hours. Any day of the week,
 * any hour. The schedulers plan inside it; days without an answer follow the
 * latest one.
 */
export function WorkPlanDialog() {
  const open = useUI((s) => s.workPlan);
  const close = () => useUI.getState().openWorkPlan(false);
  const settings = useNexus((s) => s.settings);
  const home = settings.homeZone;
  const [day, setDay] = useState<number>(() => Date.now());
  const [zone, setZone] = useState<string>(KENYA_ZONE);
  const [startMin, setStartMin] = useState(9 * 60);
  const [hours, setHours] = useState(8);
  const [now, setNow] = useState(() => Date.now());

  const key = dayKey(day, home);
  const isToday = key === dayKey(now, home);

  // Start from what is already planned for that day, otherwise from now (today) or the usual start.
  useEffect(() => {
    if (!open) return;
    const ts = Date.now();
    setNow(ts);
    const cur = hoursFor(key, workHours(settings));
    const own = settings.workPlans?.[key];
    const z = own && !("off" in own) ? own.zone : zone;
    setZone(z);
    const today = key === dayKey(ts, home);
    let start = cur?.start ?? DateTime.fromISO(key, { zone: home }).set({ hour: 9 }).toMillis();
    // Today, hours that have not been confirmed start from now rather than from a time already gone.
    if (today && !cur?.planned && start < ts) start = Math.ceil(ts / (15 * 60_000)) * 15 * 60_000;
    const d = DateTime.fromMillis(start, { zone: z });
    setStartMin(d.hour * 60 + d.minute);
    setHours(cur?.planned ? Math.max(0.5, Math.round(((cur.end - cur.start) / HOUR) * 2) / 2) : settings.workDayHours || 8);
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const { start, end } = useMemo(() => {
    // the chosen clock time on the chosen day, read in the chosen zone
    const base = DateTime.fromISO(key, { zone: home }).set({ hour: 12 }).setZone(zone).startOf("day");
    let s = base.plus({ minutes: startMin }).toMillis();
    // keep the start inside the home-zone day it was asked for
    const dayStart = DateTime.fromISO(key, { zone: home }).startOf("day").toMillis();
    if (s < dayStart) s += 24 * HOUR;
    else if (s >= dayStart + 24 * HOUR) s -= 24 * HOUR;
    return { start: s, end: s + Math.max(0.25, hours) * HOUR };
  }, [key, home, zone, startMin, hours]);

  const switchZone = (z: string) => {
    // the same moment, shown in the other zone
    const d = DateTime.fromMillis(start, { zone: z });
    setStartMin(d.hour * 60 + d.minute);
    setZone(z);
  };
  const fromNow = () => {
    const d = DateTime.fromMillis(Math.ceil(Date.now() / (5 * 60_000)) * 5 * 60_000, { zone });
    setStartMin(d.hour * 60 + d.minute);
  };

  const s = nexus();
  const dayName = isToday ? "today" : DateTime.fromISO(key, { zone: home }).toFormat("cccc d LLL");
  const save = async () => {
    await s.setWorkPlan(key, { start, end, zone });
    if (settings.workDayHours !== hours) await s.setSetting("workDayHours", hours);
    s.toast({ kind: "success", title: `Working hours set for ${dayName}`, body: `${formatTime(start, KENYA_ZONE, settings.hour12)} – ${formatTime(end, KENYA_ZONE, settings.hour12)} EAT · ${formatTime(start, settings.texasZone, settings.hour12)} – ${formatTime(end, settings.texasZone, settings.hour12)} ${zoneAbbr(settings.texasZone, start)}`, ttl: 6000 });
    close();
  };
  const off = async () => {
    await s.setWorkPlan(key, { off: true });
    s.toast({ kind: "info", title: `No work planned for ${dayName}`, body: "Nothing will be scheduled on that day automatically.", ttl: 5000 });
    close();
  };
  const later = () => {
    useUI.getState().snoozeWorkPlan(Date.now() + HOUR);
    close();
  };

  const zones: [string, string, string][] = [[KENYA_ZONE, "Kenya time", "#22d3ee"], [settings.texasZone, "Texas time", "#a78bfa"]];
  const hh = String(Math.floor(startMin / 60)).padStart(2, "0");
  const mm = String(startMin % 60).padStart(2, "0");

  return (
    <Modal
      open={open}
      onClose={later}
      title={`When do you intend to work ${dayName}?`}
      icon={<BriefcaseBusiness size={18} />}
      width={560}
      footer={
        <>
          <Button variant="ghost" icon={<Moon size={14} />} onClick={() => void off()} className="mr-auto">Not working {isToday ? "today" : "that day"}</Button>
          <Button variant="ghost" onClick={later}>Ask me later</Button>
          <Button variant="primary" onClick={() => void save()}>Set hours</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-2">
          Tasks are planned inside these hours. Any day, any time: evenings and weekends are fine. Days you have not answered for follow your latest answer.
        </p>

        <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 text-sm">
          <span className="text-xs text-muted">Day</span>
          <DateTimePicker value={day} zone={home} hour12={settings.hour12} withTime={false} min={Date.now()} onChange={(ms) => ms != null && setDay(ms)} className="w-56" ariaLabel="Day to plan" />

          <span className="text-xs text-muted">I'm on</span>
          <div className="flex gap-2" role="radiogroup" aria-label="Time zone">
            {zones.map(([z, label, color]) => (
              <button
                key={z}
                type="button"
                role="radio"
                aria-checked={zone === z}
                onClick={() => switchZone(z)}
                className={cx("h-9 px-3.5 rounded-xl border text-sm font-medium transition", zone === z ? "bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-fg-2 hover:text-fg")}
                style={zone === z ? { borderColor: color, color } : undefined}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="text-xs text-muted">Start</span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="time"
              aria-label="Start time"
              value={`${hh}:${mm}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) setStartMin(h * 60 + m);
              }}
              className="h-9 px-2.5 rounded-xl border border-line bg-hover text-sm tabular text-fg outline-none focus:border-accent"
            />
            {isToday && <button type="button" onClick={fromNow} className="h-8 px-3 rounded-lg border border-line text-xs font-medium text-fg-2 hover:text-accent hover:border-accent transition">Now</button>}
            {[6, 9, 14, 20].map((h) => (
              <button key={h} type="button" onClick={() => setStartMin(h * 60)} className="h-8 px-2.5 rounded-lg border border-line text-xs font-medium text-fg-2 hover:text-accent hover:border-accent transition tabular">
                {DateTime.fromObject({ hour: h }).toFormat(settings.hour12 ? "h a" : "HH:mm")}
              </button>
            ))}
          </div>

          <span className="text-xs text-muted">For about</span>
          <div className="flex flex-wrap items-center gap-2">
            {HOURS.map((h) => (
              <button
                key={h}
                type="button"
                aria-pressed={hours === h}
                onClick={() => setHours(h)}
                className={cx("h-8 px-3 rounded-lg border text-xs font-medium transition tabular", hours === h ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-fg-2 hover:text-fg")}
              >
                {h} h
              </button>
            ))}
            <input
              type="number"
              min={0.5}
              max={24}
              step={0.5}
              aria-label="Hours of work"
              value={hours}
              onChange={(e) => setHours(Math.max(0.5, Math.min(24, Number(e.target.value) || 8)))}
              className="h-8 w-16 px-2 rounded-lg border border-line bg-hover text-xs tabular text-fg outline-none focus:border-accent"
            />
            <span className="text-xs text-muted">hours</span>
          </div>
        </div>

        <div className="rounded-xl border border-line px-3.5 py-3 flex flex-col gap-2.5">
          <DayTrack label="Kenya · EAT" zone={KENYA_ZONE} start={start} end={end} color="#22d3ee" hour12={settings.hour12} now={now} />
          <DayTrack label={`Texas · ${zoneAbbr(settings.texasZone, start)}`} zone={settings.texasZone} start={start} end={end} color="#a78bfa" hour12={settings.hour12} now={now} />
          <p className="text-[11px] text-muted">{hoursMinutes(end - start)} of work{end <= now ? " — this time has already passed" : start < now && isToday ? `, ${hoursMinutes(end - now)} still ahead` : ""}.</p>
        </div>

        <label className="flex items-center gap-2 text-xs text-fg-2 cursor-pointer">
          <input type="checkbox" checked={settings.workPlanAsk} onChange={(e) => void s.setSetting("workPlanAsk", e.target.checked)} className="accent-[var(--accent)]" />
          Ask me this on the first use of each day
        </label>
      </div>
    </Modal>
  );
}
