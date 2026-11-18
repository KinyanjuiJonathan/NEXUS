import { useMemo } from "react";
import { DateTime } from "luxon";
import { Clock, Coffee, LogIn, LogOut, Play } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useNow } from "@/lib/ticker";
import { activeSession, openPause, pausedMs, workedBetween, workedMs } from "@/lib/work";
import { formatClock, hoursMinutes as humanDuration } from "@/lib/countdown";
import { formatTime } from "@/lib/time";
import { Button, Card, cx } from "./ui";

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

/**
 * Compact dashboard card. With automatic tracking on, the clock starts, pauses
 * and resumes by itself from keyboard/mouse activity; the buttons are for
 * taking a break or ending the day by hand.
 */
export function WorkClockCard({ className }: { className?: string }) {
  const { now, active, pause, todayMs, sessionMs, settings, sessions, dayStart } = useWorkClock();
  const s = nexus();
  const idleToday = useMemo(
    () => sessions.filter((w) => (w.endedAt ?? now) >= dayStart).reduce((a, w) => a + pausedMs(w, now, "idle"), 0),
    [sessions, dayStart, now],
  );
  const held = settings.workAuto && settings.workAutoHoldDay === DateTime.fromMillis(now, { zone: settings.homeZone }).toISODate();
  const working = !!active && !pause;
  const status = !active
    ? settings.workAuto
      ? held ? "Off for today" : "Waiting for activity"
      : "Clocked out"
    : pause
      ? pause.reason === "idle" ? "Paused · away" : "On break"
      : settings.workAuto ? "Tracking" : "Working";
  return (
    <Card glow={working} className={cx("flex flex-col min-w-0", className)}>
      <div className="flex items-center justify-between gap-2 px-5 pt-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <Clock size={16} className="text-accent shrink-0" />
          <h3 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-fg-2 truncate">Work clock</h3>
        </div>
        <span
          role="status"
          className={cx(
            "inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap",
            !active ? "bg-hover text-muted" : pause ? "bg-[color-mix(in_oklab,var(--warning)_18%,transparent)] text-warning" : "bg-[color-mix(in_oklab,var(--success)_18%,transparent)] text-success",
          )}
        >
          <span className={cx("h-1.5 w-1.5 rounded-full bg-current", working && "animate-pulse")} />
          {status}
        </span>
      </div>
      <div className="px-5 pt-3 pb-4 flex flex-col gap-3 flex-1">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="font-mono tabular text-[34px] font-semibold leading-none">{formatClock(todayMs)}</div>
            <div className="text-xs text-muted mt-1.5">worked today</div>
          </div>
          <div className="text-[11px] text-fg-2 text-right space-y-0.5 tabular">
            {active && <div>Since {formatTime(active.startedAt, settings.homeZone, settings.hour12)}</div>}
            {active && sessionMs !== todayMs && <div>This session {humanDuration(sessionMs)}</div>}
            {idleToday > 60_000 && <div className="text-muted">Away {humanDuration(idleToday)}, not counted</div>}
          </div>
        </div>
        <div className="flex gap-2 mt-auto">
          {!active ? (
            <Button size="sm" variant="primary" className="flex-1" icon={<LogIn size={14} />} onClick={() => void s.clockIn()}>{held ? "Resume tracking" : "Clock in"}</Button>
          ) : (
            <>
              {pause ? (
                <Button size="sm" variant="primary" className="flex-1" icon={<Play size={14} />} onClick={() => void s.resumeWork()}>Resume</Button>
              ) : (
                <Button size="sm" variant="soft" className="flex-1" icon={<Coffee size={14} />} onClick={() => void s.pauseWork()}>Break</Button>
              )}
              <Button size="sm" variant="outline" className="flex-1" icon={<LogOut size={14} />} onClick={() => void s.clockOut()}>Clock out</Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
