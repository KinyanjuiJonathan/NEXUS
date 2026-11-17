import { useState } from "react";
import { Coffee, Hourglass, Pause, Play, Plus, RotateCcw, SkipForward, Square, Target, Timer as TimerIcon, Trash2 } from "lucide-react";
import type { Timer, TimerKind } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useNow } from "@/lib/ticker";
import { elapsedMs, formatClock, progress, remainingMs, spentVsEstimate } from "@/lib/countdown";
import { Button, Card, CardHeader, EmptyState, Field, Input, ProgressBar, ProgressRing, Segmented, Select, cx } from "@/components/ui";

function TimerCard({ t, now }: { t: Timer; now: number }) {
  const s = nexus();
  const task = useNexus((x) => x.tasks.find((k) => k.id === t.taskId));
  const value = t.kind === "stopwatch" ? elapsedMs(t, now) : remainingMs(t, now);
  const pct = progress(t, now);
  const phaseLabel = t.kind === "pomodoro" ? (t.phase === "focus" ? "Focus" : t.phase === "short_break" ? "Short break" : "Long break") : t.kind === "stopwatch" ? "Stopwatch" : "Countdown";
  const sve = task ? spentVsEstimate(task.spentMs + (t.state === "running" && t.startedAt ? now - t.startedAt : 0), task.estimateMin) : null;
  const tone = t.phase && t.phase !== "focus" ? "var(--success)" : undefined;
  return (
    <Card glow={t.state === "running"} className="p-5 flex flex-col items-center gap-4">
      <div className="w-full flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.14em] font-semibold" style={{ color: tone ?? "var(--accent)" }}>{phaseLabel}{t.kind === "pomodoro" && ` · #${t.cycle + (t.phase === "focus" ? 1 : 0)}`}</span>
        <button aria-label="Remove timer" className="text-muted hover:text-danger" onClick={() => void s.stopTimer(t.id)}><Trash2 size={14} /></button>
      </div>
      <ProgressRing value={t.kind === "stopwatch" ? (value % 60_000) / 60_000 : pct} size={188} stroke={10} gradientId={`ring-${t.id}`} color={tone}>
        <div className="text-center">
          <div className="font-mono tabular text-[38px] font-semibold leading-none">{formatClock(value)}</div>
          <div className="text-xs text-muted mt-1.5">{t.state === "paused" ? "Paused" : t.state === "finished" ? "Finished" : t.state === "idle" ? "Ready" : t.kind === "stopwatch" ? "elapsed" : "remaining"}</div>
        </div>
      </ProgressRing>
      <div className="text-center min-w-0 w-full">
        <p className="font-medium truncate">{t.label}</p>
        {sve && task?.estimateMin && (
          <div className="mt-2">
            <ProgressBar value={sve.ratio} tone={sve.over ? "warning" : "accent"} />
            <p className={cx("text-[11px] mt-1", sve.over ? "text-warning" : "text-muted")}>Time spent vs estimate: {sve.label}</p>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        {t.state === "running" ? (
          <Button variant="soft" icon={<Pause size={15} />} onClick={() => void s.pauseTimer(t.id)}>Pause</Button>
        ) : (
          <Button variant="primary" icon={<Play size={15} />} onClick={() => void s.resumeTimer(t.id)}>{t.state === "paused" ? "Resume" : "Start"}</Button>
        )}
        <Button variant="ghost" icon={<RotateCcw size={15} />} onClick={() => void s.resetTimer(t.id)}>Reset</Button>
        {t.kind === "pomodoro" ? (
          <Button variant="ghost" icon={<SkipForward size={15} />} onClick={() => void s.skipPhase(t.id)}>
            Skip
          </Button>
        ) : (
          <Button variant="ghost" icon={<Square size={14} />} onClick={() => void s.stopTimer(t.id)}>Stop</Button>
        )}
      </div>
    </Card>
  );
}

export default function Focus() {
  const now = useNow();
  const { timers, tasks, settings, focus } = useNexus((s) => ({ timers: s.timers, tasks: s.tasks, settings: s.settings, focus: s.focusSessions }));
  const [kind, setKind] = useState<TimerKind>("pomodoro");
  const [minutes, setMinutes] = useState(25);
  const [taskId, setTaskId] = useState<string>(settings.activeTaskId ?? "");
  const [label, setLabel] = useState("");
  const open = tasks.filter((t) => !t.deletedAt && !t.archivedAt && t.status !== "done");
  const s = nexus();
  const sod = new Date(now).setHours(0, 0, 0, 0);
  const todayFocus = focus.filter((f) => f.startedAt >= sod);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-semibold">Focus & Timers</h1>
          <p className="text-sm text-muted">Timers are computed from saved timestamps — they stay exact through sleep, restarts and closing the window.</p>
        </div>
      </div>

      <Card>
        <CardHeader title="Start a timer" icon={<Plus size={16} />} />
        <div className="px-5 pb-5 grid gap-4 md:grid-cols-[auto_1fr_1fr_1fr_auto] items-end">
          <Field label="Type">
            <Segmented
              value={kind}
              onChange={(k) => { setKind(k); setMinutes(k === "pomodoro" ? settings.pomodoroFocusMin : 15); }}
              options={[
                { value: "pomodoro", label: <><Target size={13} /> Pomodoro</> },
                { value: "countdown", label: <><Hourglass size={13} /> Countdown</> },
                { value: "stopwatch", label: <><TimerIcon size={13} /> Stopwatch</> },
              ]}
            />
          </Field>
          <Field label="Minutes">
            <div className="flex gap-1">
              <Input type="number" min={1} max={600} value={kind === "stopwatch" ? "" : minutes} disabled={kind === "stopwatch"} onChange={(e) => setMinutes(Math.max(1, Math.min(600, Number(e.target.value) || 1)))} className="!w-20" />
              {kind !== "stopwatch" && [5, 15, 25, 50].map((m) => (
                <Button key={m} size="sm" variant={minutes === m ? "primary" : "ghost"} onClick={() => setMinutes(m)} className="!h-9">{m}</Button>
              ))}
            </div>
          </Field>
          <Field label="Link to task (tracks time spent)">
            <Select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">No task</option>
              {open.map((t) => <option key={t.id} value={t.id}>{t.title}{t.estimateMin ? ` (~${t.estimateMin}m)` : ""}</option>)}
            </Select>
          </Field>
          <Field label="Label (optional)">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Deep work" />
          </Field>
          <Button variant="primary" icon={<Play size={15} />} onClick={() => void s.startTimer({ kind, minutes: kind === "stopwatch" ? undefined : minutes, taskId: taskId || null, label })}>Start</Button>
        </div>
      </Card>

      {timers.length === 0 ? (
        <Card>
          <EmptyState icon={<Coffee size={22} />} title="No timers yet" body="Start a Pomodoro, a countdown for a task session, or a stopwatch. Say “Start a 25-minute focus session”." />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {timers.map((t) => <TimerCard key={t.id} t={t} now={now} />)}
        </div>
      )}

      <Card>
        <CardHeader title="Today's focus log" icon={<Target size={16} />} subtitle={`${Math.round(todayFocus.reduce((a, f) => a + f.durationMs, 0) / 60_000)} minutes across ${todayFocus.length} session${todayFocus.length === 1 ? "" : "s"}`} />
        <div className="px-5 pb-4 flex flex-col gap-1.5">
          {todayFocus.length === 0 && <p className="text-sm text-muted">Sessions longer than 30 seconds are logged automatically.</p>}
          {[...todayFocus].reverse().slice(0, 10).map((f) => (
            <div key={f.id} className="flex items-center gap-3 text-sm">
              <span className="text-muted tabular w-28">{new Date(f.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: settings.hour12 })}</span>
              <span className="flex-1 truncate">{tasks.find((t) => t.id === f.taskId)?.title ?? (f.kind === "pomodoro" ? "Focus session" : f.kind)}</span>
              <span className="tabular text-fg-2">{formatClock(f.durationMs)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
