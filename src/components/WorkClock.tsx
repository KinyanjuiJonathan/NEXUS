import { useMemo } from "react";
import { DateTime } from "luxon";
import { Clock, Coffee, LogIn, LogOut, Play } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useNow } from "@/lib/ticker";
import { activeSession, openPause, pausedMs, workedBetween, workedMs } from "@/lib/work";
import { formatClock, hoursMinutes as humanDuration } from "@/lib/countdown";
import { formatTime } from "@/lib/time";
import { Button, Card, cx } from "./ui";
import { useUI } from "@/store/ui";
import { dayKey, hoursFor, workHours } from "@/lib/workPlan";

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
  const plan = hoursFor(dayKey(now, settings.homeZone), workHours(settings));
  // hours and minutes large, seconds small
  const sec = Math.floor(todayMs / 1000);
  const clock = { hm: `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`, s: String(sec % 60).padStart(2, "0") };
  // what the tooltip spells out; the card shows only the two that matter at a glance
  const details = [
    active ? `Clocked in since ${formatTime(active.startedAt, settings.homeZone, settings.hour12)}` : "Not clocked in",
    active && sessionMs !== todayMs ? `This session: ${humanDuration(sessionMs)}` : "",
    idleToday > 60_000 ? `Away ${humanDuration(idleToday)} (not counted)` : "",
  ].filter(Boolean);
  const summary = [active ? `since ${formatTime(active.startedAt, settings.homeZone, settings.hour12)}` : "", idleToday > 60_000 ? `away ${humanDuration(idleToday)}` : ""].filter(Boolean).join(" · ") || "ready when you are";
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
      <div className="px-5 pt-2.5 pb-4 flex flex-col gap-2 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <div className="font-mono tabular font-semibold leading-none whitespace-nowrap" aria-label={`${formatClock(todayMs)} worked today`}>
            <span className="text-[34px]">{clock.hm}</span>
            <span className="text-[15px] text-muted">:{clock.s}</span>
          </div>
          <span className="text-xs text-muted truncate">worked today</span>
        </div>
        {/* one quiet line instead of a column of details; the full breakdown is in the tooltip */}
        <div className="flex items-center gap-2 text-[11px] text-muted tabular min-w-0" title={details.join("\n")}>
          <span className="truncate">{summary}</span>
          <button
            type="button"
            className="ml-auto shrink-0 text-accent hover:underline whitespace-nowrap"
            title="Your working hours today. Click to change them."
            onClick={() => useUI.getState().openWorkPlan(true)}
          >
            {plan ? `${formatTime(plan.start, settings.homeZone, settings.hour12)} – ${formatTime(plan.end, settings.homeZone, settings.hour12)}` : "Set hours"}
          </button>
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
