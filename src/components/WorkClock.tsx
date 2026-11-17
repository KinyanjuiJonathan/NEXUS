import { useMemo } from "react";
import { DateTime } from "luxon";
import { Clock, Coffee, LogIn, LogOut, Pause, Play } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useNow } from "@/lib/ticker";
import { activeSession, openPause, pausedMs, workedBetween, workedMs } from "@/lib/work";
import { formatClock, hoursMinutes as humanDuration } from "@/lib/countdown";
import { formatTime } from "@/lib/time";
import { Button, Card, CardHeader, cx } from "./ui";

/** Work clock state for any component. */
export function useWorkClock() {
  const now = useNow();
  const { sessions, settings } = useNexus((s) => ({ sessions: s.workSessions, settings: s.settings }));
  const active = activeSession(sessions);
  const pause = openPause(active);
  const dayStart = DateTime.fromMillis(now, { zone: settings.homeZone }).startOf("day").toMillis();
  const todayMs = workedBetween(sessions, dayStart, now + 1, now);
  return { now, active, pause, todayMs, sessionMs: active ? workedMs(active, now) : 0, settings, sessions, dayStart };
}

export function WorkClockCard() {
  const { now, active, pause, todayMs, sessionMs, settings, sessions, dayStart } = useWorkClock();
  const s = nexus();
  const todaySessions = useMemo(() => sessions.filter((w) => (w.endedAt ?? now) >= dayStart).sort((a, b) => b.startedAt - a.startedAt), [sessions, dayStart, now]);
  const idleToday = todaySessions.reduce((a, w) => a + pausedMs(w, now, "idle"), 0);
  return (
    <Card glow={!!active && !pause}>
      <CardHeader
        title="Work clock"
        icon={<Clock size={16} />}
        subtitle={`Auto-pauses after ${settings.idleMinutes} min without keyboard or mouse input`}
        right={
          <span className={cx("text-[11px] font-semibold px-2 py-0.5 rounded-full", !active ? "bg-hover text-muted" : pause ? "bg-[color-mix(in_oklab,var(--warning)_18%,transparent)] text-warning" : "bg-[color-mix(in_oklab,var(--success)_18%,transparent)] text-success")}>
            {!active ? "Clocked out" : pause ? (pause.reason === "idle" ? "Auto-paused" : "Paused") : "Working"}
          </span>
        }
      />
      <div className="px-5 pb-5 flex flex-wrap items-center gap-5">
        <div>
          <div className="font-mono tabular text-[34px] font-semibold leading-none">{formatClock(active ? sessionMs : todayMs)}</div>
          <div className="text-xs text-muted mt-1.5">{active ? "this session" : "worked today"}</div>
        </div>
        <div className="text-xs text-fg-2 space-y-0.5">
          <div>Today: <b className="text-fg tabular">{humanDuration(todayMs)}</b></div>
          {idleToday > 60_000 && <div>Idle not counted: <span className="tabular">{humanDuration(idleToday)}</span></div>}
          {active && <div>Since {formatTime(active.startedAt, settings.homeZone, settings.hour12)}</div>}
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          {!active ? (
            <Button variant="primary" icon={<LogIn size={15} />} onClick={() => void s.clockIn()}>Clock in</Button>
          ) : (
            <>
              {pause ? (
                <Button variant="primary" icon={<Play size={15} />} onClick={() => void s.resumeWork()}>Resume</Button>
              ) : (
                <Button variant="soft" icon={<Pause size={15} />} onClick={() => void s.pauseWork()}>Break</Button>
              )}
              <Button variant="outline" icon={<LogOut size={15} />} onClick={() => void s.clockOut()}>Clock out</Button>
            </>
          )}
        </div>
      </div>
      {todaySessions.length > 0 && (
        <div className="px-5 pb-4 -mt-1 flex flex-wrap gap-2 text-[11px] text-muted">
          {todaySessions.slice(0, 6).map((w) => (
            <span key={w.id} className="rounded-md bg-hover px-2 py-0.5 tabular">
              <Coffee size={10} className="inline mr-1" />
              {formatTime(w.startedAt, settings.homeZone, settings.hour12)}–{w.endedAt ? formatTime(w.endedAt, settings.homeZone, settings.hour12) : "now"} · {humanDuration(workedMs(w, now))}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
