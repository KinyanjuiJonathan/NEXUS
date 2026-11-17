import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { Brain, CalendarCheck, Clock, Flame, Gauge, Lightbulb, Loader2, Target, Timer } from "lucide-react";
import { useNexus } from "@/store";
import { useNow } from "@/lib/ticker";
import { computeInsights } from "@/lib/insights";
import { hoursMinutes as humanDuration } from "@/lib/countdown";
import { aiRequest } from "@/lib/platform";
import { BarChart } from "@/components/Charts";
import { Button, Card, CardHeader, Segmented, Stat } from "@/components/ui";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One-hue intensity strip for 24 hours (sequential: light → strong). */
function HourStrip({ values, hour12 }: { values: number[]; hour12: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <figure>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
        {values.map((v, h) => (
          <div
            key={h}
            title={`${hour12 ? DateTime.fromObject({ hour: h }).toFormat("h a") : `${h}:00`} — ${v} min of focus/activity`}
            className="h-10 rounded-[4px] border border-line"
            style={{ background: v ? `color-mix(in oklab, var(--accent) ${Math.round(12 + (v / max) * 80)}%, transparent)` : "var(--surface-hover)" }}
          />
        ))}
      </div>
      <div className="grid mt-1 text-[10px] text-muted tabular" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
        {values.map((_, h) => (
          <span key={h} className="text-center">{h % 3 === 0 ? (hour12 ? `${h % 12 || 12}${h < 12 ? "a" : "p"}` : h) : ""}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Activity by hour of day</caption>
        <tbody>{values.map((v, h) => <tr key={h}><th>{h}:00</th><td>{v} min</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

export default function Insights() {
  const now = useNow();
  const { tasks, focus, work, activity, categories, settings } = useNexus((s) => ({
    tasks: s.tasks, focus: s.focusSessions, work: s.workSessions, activity: s.activity, categories: s.categories, settings: s.settings,
  }));
  const [range, setRange] = useState<"7" | "30" | "90">("7");
  const [coach, setCoach] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const minute = Math.floor(now / 60_000);
  const ins = useMemo(
    () => computeInsights({ tasks, focus, work, activity, categories, now, zone: settings.homeZone, days: Number(range) }),
    [tasks, focus, work, activity, categories, settings.homeZone, range, minute], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const maxCat = Math.max(1, ...ins.byCategory.map((c) => c.focusMin));
  const aiOn = settings.aiEnabled && settings.aiConsent;
  const sub = (ms: number) => DateTime.fromMillis(ms, { zone: settings.homeZone }).toFormat("ccc d LLL");

  const askCoach = async () => {
    setBusy(true);
    try {
      const r = await aiRequest<{ text: string }>("plan", "Analyse how I work and give 3–5 specific, actionable recommendations to improve my productivity and planning.", {
        rangeDays: Number(range), totals: ins.totals, onTime: ins.onTime, estimateBias: ins.estimate, peakHour: ins.peakHour,
        hourly: ins.hourly, weekdayCompletions: ins.weekday, categories: ins.byCategory.map(({ name, completed, focusMin }) => ({ name, completed, focusMin })),
        sessions: ins.sessions, streak: ins.streak, findings: ins.findings,
      });
      setCoach(r.text);
    } catch (e) {
      setCoach(`Couldn't reach Claude: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">Insights</h1>
          <p className="text-sm text-muted">How you're working, from your clock-ins, focus sessions and completed tasks.</p>
        </div>
        <Segmented value={range} onChange={setRange} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label="Clocked work" value={humanDuration(ins.totals.workedMin * 60_000)} icon={<Clock size={18} />} sub={ins.totals.activeDays ? `~${humanDuration(ins.totals.avgWorkedMinPerActiveDay * 60_000)} per active day` : "Clock in to track"} />
        <Stat label="Focus time" value={humanDuration(ins.totals.focusMin * 60_000)} icon={<Flame size={18} />} tone="var(--accent-2)" sub={ins.totals.workedMin ? `${Math.round(Math.min(1, ins.totals.focusMin / ins.totals.workedMin) * 100)}% of clocked time` : undefined} />
        <Stat label="Tasks completed" value={ins.totals.completed} icon={<CalendarCheck size={18} />} tone="var(--success)" sub={`${ins.totals.created} created`} />
        <Stat label="On-time rate" value={ins.onTime.rate == null ? "—" : `${Math.round(ins.onTime.rate * 100)}%`} icon={<Target size={18} />} tone={ins.onTime.rate != null && ins.onTime.rate < 0.6 ? "var(--warning)" : "var(--accent)"} sub={ins.onTime.rate == null ? "No deadlines yet" : `${ins.onTime.late} late`} />
      </div>

      <Card glow>
        <CardHeader title="What we noticed" icon={<Lightbulb size={16} />} right={aiOn && <Button size="sm" variant="soft" icon={busy ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />} disabled={busy} onClick={() => void askCoach()}>Coaching from Claude</Button>} />
        <ul className="px-5 pb-5 flex flex-col gap-2">
          {ins.findings.map((f) => (
            <li key={f} className="text-sm text-fg-2 flex gap-2"><span className="text-accent mt-0.5">•</span>{f}</li>
          ))}
        </ul>
        {coach && <div className="mx-5 mb-5 rounded-xl bg-hover p-4 text-sm text-fg-2 whitespace-pre-wrap select-text">{coach}</div>}
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader title="Clocked hours" subtitle="Per day, idle time excluded" icon={<Clock size={16} />} />
          <div className="px-5 pb-4"><BarChart caption="Clocked hours per day" unit="h" data={ins.daily.map((d) => ({ label: d.label, value: Math.round((d.workedMin / 60) * 10) / 10, sub: sub(d.day) }))} height={120} /></div>
        </Card>
        <Card>
          <CardHeader title="Focus minutes" subtitle="Per day" icon={<Flame size={16} />} />
          <div className="px-5 pb-4"><BarChart caption="Focus minutes per day" unit="min" color="var(--accent-2)" data={ins.daily.map((d) => ({ label: d.label, value: d.focusMin, sub: sub(d.day) }))} height={120} /></div>
        </Card>
        <Card>
          <CardHeader title="Tasks completed" subtitle="Per day" icon={<CalendarCheck size={16} />} />
          <div className="px-5 pb-4"><BarChart caption="Tasks completed per day" unit="done" color="var(--accent-3)" data={ins.daily.map((d) => ({ label: d.label, value: d.completed, sub: sub(d.day) }))} height={120} /></div>
        </Card>
      </div>

      <Card>
        <CardHeader title="When you work best" subtitle={`Focus minutes and completions by hour (${settings.homeZone})`} icon={<Gauge size={16} />} />
        <div className="px-5 pb-5"><HourStrip values={ins.hourly} hour12={settings.hour12} /></div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Completions by weekday" icon={<CalendarCheck size={16} />} />
          <div className="px-5 pb-4"><BarChart caption="Tasks completed by weekday" unit="done" data={ins.weekday.map((v, i) => ({ label: WEEKDAYS[i], value: v }))} height={110} /></div>
        </Card>
        <Card>
          <CardHeader title="Where your focus went" subtitle="By category" icon={<Timer size={16} />} />
          <div className="px-5 pb-5 flex flex-col gap-2.5">
            {ins.byCategory.length === 0 && <p className="text-sm text-muted">Link focus sessions to tasks to see this.</p>}
            {ins.byCategory.slice(0, 8).map((c) => (
              <div key={c.id} className="flex items-center gap-3 text-sm">
                <span className="w-28 truncate text-fg-2">{c.name}</span>
                <div className="flex-1 h-2 rounded-full bg-line overflow-hidden">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(c.focusMin / maxCat) * 100}%` }} />
                </div>
                <span className="w-32 text-right tabular text-xs text-muted">{humanDuration(c.focusMin * 60_000)} · {c.completed} done</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label="Estimate accuracy" value={ins.estimate.bias == null ? "—" : `${Math.round(ins.estimate.bias * 100)}%`} icon={<Target size={18} />} sub={ins.estimate.bias == null ? "Need tracked tasks with estimates" : "actual ÷ estimated time"} />
        <Stat label="Work sessions" value={ins.sessions.count} icon={<Clock size={18} />} sub={ins.sessions.count ? `avg ${humanDuration(ins.sessions.avgMin * 60_000)}` : undefined} />
        <Stat label="Idle not counted" value={humanDuration(ins.sessions.idlePausedMin * 60_000)} icon={<Gauge size={18} />} sub={`${ins.sessions.autoPauses} auto-pauses`} />
        <Stat label="Completion streak" value={`${ins.streak} day${ins.streak === 1 ? "" : "s"}`} icon={<Flame size={18} />} tone="var(--warning)" />
      </div>
    </div>
  );
}
