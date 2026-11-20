import { useMemo } from "react";
import { CalendarClock, ChevronDown, ChevronUp, Flag, Lock, ListTodo } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { agenda, untilLabel, type AgendaItem } from "@/lib/smart/agenda";
import { queueOf } from "@/lib/smart/reschedule";
import { formatTime } from "@/lib/time";
import { DateTime } from "luxon";
import { EmptyState, cx } from "./ui";

/**
 * What is coming up, in order, with arrows to move a flexible task one place
 * up or down. Fixed appointments are shown with a lock and cannot be moved
 * from here; a task trades places with its neighbour and nothing else changes.
 */
export function ScheduleQueue({ now, limit = 6 }: { now: number; limit?: number }) {
  const { tasks, events, settings } = useNexus((s) => ({ tasks: s.tasks, events: s.events, settings: s.settings }));
  const minute = Math.floor(now / 60_000);
  const items = useMemo(() => agenda(tasks, events, now, { limit }), [tasks, events, minute, limit]); // eslint-disable-line react-hooks/exhaustive-deps
  const queue = useMemo(() => queueOf(tasks, events, now).map((e) => e.id), [tasks, events, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const zone = settings.homeZone;
  const today = DateTime.fromMillis(now, { zone });

  if (!items.length) return <EmptyState icon={<ListTodo size={22} />} title="Nothing in the queue" body="Schedule a task or an appointment and it lines up here." />;

  const when = (i: AgendaItem) => {
    const d = DateTime.fromMillis(i.start, { zone });
    const day = d.hasSame(today, "day") ? "" : d.hasSame(today.plus({ days: 1 }), "day") ? "Tomorrow " : `${d.toFormat("ccc d")} `;
    return `${day}${formatTime(i.start, zone, settings.hour12)}`;
  };
  const open = (i: AgendaItem) => (i.eventId ? useUI.getState().openEvent(i.eventId) : i.taskId ? useUI.getState().openTask(i.taskId) : undefined);
  const arrow = "h-[18px] w-6 flex items-center justify-center rounded text-muted hover:text-accent hover:bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] disabled:opacity-25 disabled:pointer-events-none transition";

  return (
    <ol className="flex flex-col gap-1.5" aria-label="Schedule queue">
      {items.map((i, n) => {
        const pos = i.eventId ? queue.indexOf(i.eventId) : -1;
        const movable = pos >= 0 && i.status === "upcoming";
        const color = i.status === "overdue" ? "var(--danger)" : i.status === "now" ? "var(--success)" : i.kind === "fixed" ? "var(--accent-2)" : "var(--accent)";
        return (
          <li key={i.key} className={cx("group flex items-center gap-2.5 rounded-xl border border-line pl-2.5 pr-1.5 py-1.5 min-w-0 transition-colors hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]", i.status === "now" && "bg-[color-mix(in_oklab,var(--success)_8%,transparent)]")}>
            <span className="w-5 text-center text-[11px] font-mono font-semibold tabular shrink-0" style={{ color }}>{n + 1}</span>
            <span className="shrink-0" style={{ color }} title={i.kind === "fixed" ? "Fixed appointment: it does not move" : i.kind === "deadline" ? "Task due" : "Flexible task: use the arrows to move it"}>
              {i.kind === "fixed" ? <Lock size={13} /> : i.kind === "deadline" ? <Flag size={13} /> : <CalendarClock size={13} />}
            </span>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => open(i)}>
              <div className="text-[13px] font-medium truncate group-hover:text-accent">{i.title}</div>
              <div className="text-[11px] text-muted tabular truncate">
                {when(i)}{i.end > i.start ? ` – ${formatTime(i.end, zone, settings.hour12)}` : ""} · <span style={{ color: i.status === "upcoming" ? undefined : color }}>{untilLabel(i, now)}</span>
              </div>
            </button>
            {movable ? (
              <div className="flex flex-col shrink-0" role="group" aria-label={`Move ${i.title}`}>
                <button type="button" className={arrow} disabled={pos === 0} aria-label="Move up the queue" title="Move up: do this one earlier" onClick={() => void nexus().moveInQueue(i.eventId!, -1)}><ChevronUp size={14} /></button>
                <button type="button" className={arrow} disabled={pos === queue.length - 1} aria-label="Move down the queue" title="Move down: do this one later" onClick={() => void nexus().moveInQueue(i.eventId!, 1)}><ChevronDown size={14} /></button>
              </div>
            ) : (
              <span className="w-6 shrink-0" />
            )}
          </li>
        );
      })}
    </ol>
  );
}
