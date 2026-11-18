import { useMemo, useState } from "react";
import { StatDetails, type StatKind } from "@/components/StatDetails";
import { DateTime } from "luxon";
import { AlarmClock, CalendarClock, CheckCircle2, Flame, Hourglass, ListTodo, Pause, Play, Plus, RotateCcw, Sparkles, Target, TriangleAlert, Wand2 } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { useNow } from "@/lib/ticker";
import { dayStats, history, nextAppointment } from "@/lib/stats";
import { findMissed } from "@/lib/schedule";
import { suggestNext, openTasks, scoreTask } from "@/lib/assistant";
import { eventStatus, formatClock, humanDuration, progress, remainingMs, elapsedMs } from "@/lib/countdown";
import { formatTime, formatWithZone, KENYA_ZONE, zoneAbbr } from "@/lib/time";
import { DualClock } from "@/components/DualClock";
import { GettingStarted } from "@/components/GettingStarted";
import { WorkClockCard } from "@/components/WorkClock";
import { SystemMonitor } from "@/components/SystemMonitor";
import { AiScheduleButton } from "@/components/AiScheduler";
import { BarChart } from "@/components/Charts";
import { TaskRow } from "@/components/TaskRow";
import { Button, Card, CardHeader, EmptyState, ProgressBar, ProgressRing, Stat } from "@/components/ui";

function greeting(hour: number) {
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

export default function Dashboard() {
  const now = useNow();
  const { tasks, events, focusSessions, categories, settings, timers } = useNexus((s) => ({
    tasks: s.tasks, events: s.events, focusSessions: s.focusSessions, categories: s.categories, settings: s.settings, timers: s.timers,
  }));
  const zone = settings.homeZone;
  const minute = Math.floor(now / 60_000);
  const [detail, setDetail] = useState<StatKind | null>(null);
  const stats = useMemo(() => dayStats(tasks, focusSessions, now, zone, events), [tasks, focusSessions, events, minute, zone]); // eslint-disable-line react-hooks/exhaustive-deps
  const week = useMemo(() => history(tasks, focusSessions, now, zone, 7), [tasks, focusSessions, minute, zone]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = useMemo(() => nextAppointment(events, now), [events, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const missed = useMemo(() => findMissed(tasks, events, now).slice(0, 4), [tasks, events, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const upNext = useMemo(() => openTasks(tasks).sort((a, b) => scoreTask(b, now) - scoreTask(a, now)).slice(0, 5), [tasks, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggestion = useMemo(() => suggestNext(tasks, now), [tasks, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const timer = timers.find((t) => t.state === "running") ?? timers.find((t) => t.state === "paused");
  const active = tasks.find((t) => t.id === settings.activeTaskId);
  const ui = useUI.getState();
  const s = nexus();
  const hour = DateTime.fromMillis(now, { zone }).hour;

  return (
    <div className="flex flex-col gap-4">
      {/* Level 1: greeting and the main actions on one line. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="font-display text-[26px] font-semibold tracking-tight leading-tight" title={DateTime.fromMillis(now, { zone }).toFormat("cccc, d LLLL")}>
          {greeting(hour)}. <span className="text-gradient">Let's make today count.</span>
        </h1>
        <div className="flex flex-wrap gap-2">
          <AiScheduleButton />
          <Button variant="outline" icon={<Wand2 size={15} />} onClick={() => ui.openAutoPlan(true)} title="Fit open tasks into your free working time">Auto-plan</Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => ui.openTask(null)}>New task</Button>
        </div>
      </div>

      {/* Level 2: Kenya and Texas time. */}
      <DualClock dense hour12={settings.hour12} texasZone={settings.texasZone} />

      {/* Level 3: work clock, next appointment and today's progress on one line. */}
      <div className="grid gap-4 md:grid-cols-3">
        <WorkClockCard />
        <div className="contents">
          {/* Next appointment */}
          <Card>
            <CardHeader title="Next appointment" icon={<AlarmClock size={16} />} />
            <div className="px-5 pb-5">
              {next ? (
                (() => {
                  const st = eventStatus(next.start, next.end, now);
                  return (
                    <button className="w-full text-left" onClick={() => ui.openEvent(next.event.id, undefined, next.seriesStart)}>
                      <p className="text-lg font-semibold truncate">{next.event.important && <span className="text-warning">★ </span>}{next.event.title}</p>
                      <p className="text-sm font-medium mt-1" style={{ color: st.live ? "var(--success)" : "var(--accent)" }}>{st.label}</p>
                      {st.live && <ProgressBar value={st.progress} className="mt-2" tone="success" />}
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs" title={`${formatWithZone(next.start, next.event.tz, settings.hour12)} (original zone)`}>
                        <div className="rounded-lg bg-hover px-2.5 py-1.5"><span className="text-cyan-400 font-semibold">KE</span> {formatTime(next.start, KENYA_ZONE, settings.hour12)} {zoneAbbr(KENYA_ZONE, next.start)}</div>
                        <div className="rounded-lg bg-hover px-2.5 py-1.5"><span className="text-violet-400 font-semibold">TX</span> {formatTime(next.start, settings.texasZone, settings.hour12)} {zoneAbbr(settings.texasZone, next.start)}</div>
                      </div>
  
                    </button>
                  );
                })()
              ) : (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-lg font-semibold text-fg-2">Nothing scheduled</p>
                  <p className="text-sm text-muted">Reserve time for what matters.</p>
                  <Button size="sm" icon={<CalendarClock size={14} />} onClick={() => ui.openEvent(null)}>Schedule</Button>
                </div>
              )}
            </div>
          </Card>

          {/* Completion ring + suggestion */}
          <Card>
            <CardHeader title="Today's progress" icon={<Target size={16} />} />
            <div className="px-5 pb-5 flex items-center gap-5">
              <ProgressRing value={stats.completionRate} size={92} stroke={8} gradientId="dash-day">
                <div className="text-center">
                  <div className="text-2xl font-semibold tabular font-display">{Math.round(stats.completionRate * 100)}%</div>
                  <div className="text-[10px] text-muted">{stats.completedToday}/{stats.totalToday}</div>
                </div>
              </ProgressRing>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wider text-muted flex items-center gap-1"><Sparkles size={12} /> Suggested next</p>
                {suggestion ? (
                  <>
                    <button className="text-sm font-semibold mt-1 text-left hover:text-accent" onClick={() => ui.openTask(suggestion.task.id)}>{suggestion.task.title}</button>
                    <p className="text-xs text-muted mt-0.5">{suggestion.reason}</p>
                    <Button size="sm" variant="soft" className="mt-2" icon={<Play size={13} />} onClick={() => void s.setActiveTask(suggestion.task.id)}>Start</Button>
                  </>
                ) : (
                  <p className="text-sm text-muted mt-1">Inbox zero. Enjoy it.</p>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>

      <GettingStarted />

      {/* Level 3: system performance. */}
      <SystemMonitor />

      {/* Level 4: the day's numbers; each opens its details. */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <Stat label="Tasks today" value={stats.totalToday} icon={<ListTodo size={18} />} sub={`${stats.pendingToday} pending`} onClick={() => setDetail("today")} />
        <Stat label="Completed today" value={stats.completedToday} icon={<CheckCircle2 size={18} />} tone="var(--success)" onClick={() => setDetail("completed")} />
        <Stat label="Overdue" value={stats.overdue} icon={<TriangleAlert size={18} />} tone={stats.overdue ? "var(--danger)" : "var(--muted)"} sub={stats.overdue ? "Needs attention" : "All on track"} onClick={() => setDetail("overdue")} />
        <Stat label="Focus time today" value={humanDuration(stats.focusMsToday).replace(" sec", "s")} icon={<Flame size={18} />} tone="var(--accent-2)" onClick={() => setDetail("focus")} />
      </div>
      <StatDetails kind={detail} onClose={() => setDetail(null)} />

      {/* Level 5: what is next, and the last seven days. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 items-stretch">
        <Card className="lg:col-span-2 xl:col-span-1">
          <CardHeader title="Up next" icon={<ListTodo size={16} />} right={<Button size="sm" variant="ghost" onClick={() => ui.setView("tasks")}>All tasks</Button>} />
          <div className="px-4 pb-4 flex flex-col gap-2">
            {upNext.length ? (
              upNext.map((t) => (
                <TaskRow key={t.id} task={t} categories={categories} now={now} hour12={settings.hour12} texasZone={settings.texasZone} warnMin={settings.deadlineWarningMin} active={t.id === settings.activeTaskId} />
              ))
            ) : (
              <EmptyState icon={<ListTodo size={22} />} title="No open tasks" body="Press N to add one, or say “Add a task…”" />
            )}
          </div>
        </Card>
          <Card>
            <CardHeader title="Tasks completed" subtitle="Last 7 days" icon={<CheckCircle2 size={16} />} />
            <div className="px-5 pb-4">
              <BarChart caption="Tasks completed per day, last 7 days" unit="done" data={week.map((d) => ({ label: d.label, value: d.completed, sub: DateTime.fromMillis(d.day, { zone }).toFormat("ccc d LLL") }))} color="var(--accent)" height={110} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Focus minutes" subtitle={`Last 7 days · ${week.reduce((a, d) => a + d.focusMin, 0)} min total`} icon={<Flame size={16} />} />
            <div className="px-5 pb-4">
              <BarChart caption="Focus minutes per day, last 7 days" unit="min" data={week.map((d) => ({ label: d.label, value: d.focusMin, sub: DateTime.fromMillis(d.day, { zone }).toFormat("ccc d LLL") }))} color="var(--accent-2)" height={110} />
            </div>
          </Card>
      </div>

      {/* The running timer. */}
      <div className="grid gap-4">
        {/* Active countdown / current task */}
        <Card glow={!!timer}>
          <CardHeader title="Active countdown" icon={<Hourglass size={16} />} />
          <div className="px-5 pb-5">
            {timer ? (
              <div className="flex items-center gap-5">
                <ProgressRing value={timer.kind === "stopwatch" ? 0 : progress(timer, now)} size={112} stroke={8} gradientId="dash-timer">
                  <div className="text-center">
                    <div className="font-mono tabular text-xl font-semibold">{formatClock(timer.kind === "stopwatch" ? elapsedMs(timer, now) : remainingMs(timer, now))}</div>
                    <div className="text-[10px] uppercase tracking-wider text-muted">{timer.kind === "stopwatch" ? "elapsed" : "left"}</div>
                  </div>
                </ProgressRing>
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{timer.label}</p>
                  <p className="text-xs text-muted mt-0.5">{timer.kind === "pomodoro" ? `Pomodoro · ${timer.phase?.replace("_", " ")}` : timer.kind}{timer.state === "paused" && " · paused"}</p>
                  <div className="flex gap-2 mt-3">
                    {timer.state === "running" ? (
                      <Button size="sm" variant="soft" icon={<Pause size={14} />} onClick={() => void s.pauseTimer(timer.id)}>Pause</Button>
                    ) : (
                      <Button size="sm" variant="primary" icon={<Play size={14} />} onClick={() => void s.resumeTimer(timer.id)}>Resume</Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => void s.resetTimer(timer.id)}>Reset</Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted">{active ? <>Working on <b className="text-fg">{active.title}</b>.</> : "No timer running."}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" icon={<Target size={14} />} onClick={() => void s.startTimer({ kind: "pomodoro", taskId: settings.activeTaskId })}>Focus {settings.pomodoroFocusMin}m</Button>
                  {active?.estimateMin && <Button size="sm" variant="soft" icon={<Hourglass size={14} />} onClick={() => void s.startTimer({ kind: "countdown", taskId: active.id, minutes: active.estimateMin! })}>Task session {active.estimateMin}m</Button>}
                  <Button size="sm" variant="ghost" onClick={() => ui.setView("focus")}>More timers</Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {missed.length > 0 && (
        <Card>
          <CardHeader title="Missed — Smart Reschedule" icon={<Wand2 size={16} />} subtitle="Pick a new time. Nothing moves without your OK." />
          <div className="px-4 pb-4 grid sm:grid-cols-2 gap-2">
            {missed.map((m) => (
              <div key={m.kind + m.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                <TriangleAlert size={15} className="text-danger shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{m.title}</p>
                  <p className="text-[11px] text-muted">Was due {formatWithZone(m.at, zone, settings.hour12)}</p>
                </div>
                <Button size="sm" variant="soft" onClick={() => ui.openReschedule(m)}>Reschedule</Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
