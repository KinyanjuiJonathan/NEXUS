import { CheckCircle2, LogIn, Play } from "lucide-react";
import type { CalendarEvent, Task } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { AWAY_MIN, blockClock, clockState, countableMs, type ClockState } from "@/lib/taskClock";
import { hoursMinutes } from "@/lib/countdown";
import { formatTime } from "@/lib/time";
import { confirmComplete } from "./complete";
import { Button, ProgressBar, cx } from "./ui";

const TONE: Record<ClockState, { color: string; bar: "success" | "warning" | "accent" }> = {
  working: { color: "var(--success)", bar: "success" },
  away: { color: "var(--warning)", bar: "warning" },
  break: { color: "var(--warning)", bar: "warning" },
  off: { color: "var(--muted)", bar: "accent" },
};

/** One-line description of whether the work clock is counting towards the task right now. */
export function clockLabel(state: ClockState, since: number | null, zone: string, hour12: boolean): string {
  if (state === "working") return "Working · time is counting";
  if (state === "away") return `Away${since ? ` since ${formatTime(since, zone, hour12)}` : ""} · not counted`;
  if (state === "break") return "On break · not counted";
  return "Not clocked in · not counted";
}

/**
 * The task whose reserved time is under way: whether the work clock is
 * counting, how much of the planned time has been clocked, and the two things
 * the user can say about it: "I was working" (count the time the clock
 * skipped) and "it is complete".
 */
export function CurrentTaskStatus({ event, task, now, compact }: { event: CalendarEvent; task: Task; now: number; compact?: boolean }) {
  const { sessions, settings } = useNexus((s) => ({ sessions: s.workSessions, settings: s.settings }));
  const clock = blockClock(event, sessions, now);
  const { state, since } = clockState(sessions);
  const countable = countableMs(event, sessions, now);
  const tone = TONE[state];
  const s = nexus();
  return (
    <div className="flex flex-col min-w-0">
      <button className={cx("text-left font-semibold truncate hover:text-accent", compact ? "text-[13px]" : "text-base")} onClick={() => useUI.getState().openEvent(event.id)} title={task.title}>
        {task.title}
      </button>
      <p role="status" className={cx("font-medium flex items-center gap-1.5 min-w-0", compact ? "text-[11px] mt-0.5" : "text-sm mt-1")} style={{ color: tone.color }}>
        <span className={cx("h-1.5 w-1.5 rounded-full bg-current shrink-0", state === "working" && "animate-pulse")} />
        <span className="truncate">{clockLabel(state, since, settings.homeZone, settings.hour12)}</span>
      </p>
      <ProgressBar value={clock.targetMs ? clock.workedMs / clock.targetMs : 0} tone={tone.bar} className="mt-2" />
      <p className="text-[11px] text-fg-2 mt-1.5 tabular truncate" title={`Ends ${formatTime(event.endAt, settings.homeZone, settings.hour12)}. Only clocked time counts; what is left when this block ends is moved forward automatically.`}>
        {hoursMinutes(clock.workedMs)} of {hoursMinutes(clock.targetMs)} clocked · {clock.done ? "planned time done" : countable >= AWAY_MIN ? `${hoursMinutes(countable)} not counted` : `${hoursMinutes(clock.remainingMs)} to go`}
      </p>
      <div className="flex flex-wrap gap-2 mt-2">
        {state === "off" && (
          <Button size="sm" variant="primary" icon={<LogIn size={13} />} onClick={() => void s.clockIn()}>Clock in</Button>
        )}
        {countable >= AWAY_MIN && state !== "away" && (
          <Button size="sm" variant="soft" icon={<Play size={13} />} onClick={() => void s.countAway(event.id)} title={`Count the ${hoursMinutes(countable)} the clock skipped during this task as work`}>
            I was working
          </Button>
        )}
        <Button size="sm" variant="outline" icon={<CheckCircle2 size={13} />} onClick={() => void confirmComplete(task.id)}>Complete</Button>
      </div>
    </div>
  );
}
