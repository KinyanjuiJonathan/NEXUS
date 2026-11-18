import { useMemo } from "react";
import { DateTime } from "luxon";
import { CalendarCheck, Check, CheckCircle2, Flame, ListTodo, Lock, RotateCcw, TriangleAlert, Undo2 } from "lucide-react";
import type { Task } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { useNow } from "@/lib/ticker";
import { completedToday, dayBounds, focusToday, overdueTasks, todayTasks } from "@/lib/stats";
import { humanDuration } from "@/lib/countdown";
import { formatTime, formatWithZone } from "@/lib/time";
import { dayLabel } from "@/lib/smart/format";
import { PRIORITY_META } from "./meta";
import { confirmComplete } from "./complete";
import { Badge, Button, EmptyState, Modal, cx } from "./ui";

export type StatKind = "today" | "completed" | "overdue" | "focus";

const META: Record<StatKind, { title: string; icon: React.ReactNode }> = {
  today: { title: "Tasks today", icon: <ListTodo size={18} /> },
  completed: { title: "Completed today", icon: <CheckCircle2 size={18} /> },
  overdue: { title: "Overdue", icon: <TriangleAlert size={18} /> },
  focus: { title: "Focus time today", icon: <Flame size={18} /> },
};

/**
 * What is behind each dashboard number. It reads the same tasks, calendar and
 * focus sessions as everything else, so it changes the moment they do.
 */
export function StatDetails({ kind, onClose }: { kind: StatKind | null; onClose: () => void }) {
  const tick = useNow();
  const now = Math.floor(tick / 30_000) * 30_000;
  const { tasks, events, focus, settings } = useNexus((s) => ({ tasks: s.tasks, events: s.events, focus: s.focusSessions, settings: s.settings }));
  const zone = settings.homeZone;
  const h12 = settings.hour12;
  const ui = useUI.getState();
  const open = (t: Task) => {
    onClose();
    ui.openTask(t.id);
  };

  /** The time reserved for a task that is running or comes next. */
  const blockOf = useMemo(() => {
    const map = new Map<string, { start: number; end: number; fixed: boolean; tz: string }>();
    for (const e of [...events].sort((a, b) => a.startAt - b.startAt)) {
      if (e.deletedAt || !e.taskId || e.recurrence || e.endAt <= now || map.has(e.taskId)) continue;
      map.set(e.taskId, { start: e.startAt, end: e.endAt, fixed: e.fixed, tz: e.tz });
    }
    return map;
  }, [events, now]);
  const when = (t: Task) => {
    const b = blockOf.get(t.id);
    if (b) return `${dayLabel(b.start, zone, now)} ${formatTime(b.start, zone, h12)}–${formatTime(b.end, zone, h12)}`;
    return t.dueAt != null ? `Due ${dayLabel(t.dueAt, zone, now)} ${formatTime(t.dueAt, zone, h12)}` : "No time set";
  };

  const today = useMemo(() => {
    const start = dayBounds(now, zone).start;
    const at = (t: Task) => blockOf.get(t.id)?.start ?? t.dueAt ?? (t.completedAt ?? start);
    return todayTasks(tasks, events, now, zone).sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || at(a) - at(b));
  }, [tasks, events, now, zone, blockOf]);
  const done = useMemo(() => completedToday(tasks, now, zone), [tasks, now, zone]);
  const overdue = useMemo(() => overdueTasks(tasks, now), [tasks, now]);
  const sessions = useMemo(() => focusToday(focus, now, zone), [focus, now, zone]);
  const focusTotal = sessions.reduce((a, f) => a + f.durationMs, 0);
  const titleOf = (id: string | null) => (id ? tasks.find((t) => t.id === id)?.title : undefined);

  const Row = ({ t, children, right }: { t: Task; children: React.ReactNode; right?: React.ReactNode }) => {
    const isDone = t.status === "done";
    return (
      <li className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 hover:border-line-strong transition-colors">
        <button
          onClick={() => void (isDone ? nexus().setTaskDone(t.id, false) : confirmComplete(t.id))}
          aria-label={isDone ? `Mark “${t.title}” as not done` : `Mark “${t.title}” complete`}
          title={isDone ? "Mark as not done" : "Mark complete"}
          className={cx("h-5 w-5 shrink-0 rounded-full border-2 flex items-center justify-center transition", isDone ? "bg-success border-success text-white" : "border-line-strong hover:border-success")}
        >
          {isDone && <Check size={12} strokeWidth={3} />}
        </button>
        <button className="min-w-0 flex-1 text-left" onClick={() => open(t)} title="Open to view or edit">
          <span className={cx("block text-sm font-medium truncate", isDone ? "line-through text-muted" : "text-fg")}>{t.title}</span>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 mt-0.5 text-[11px] text-muted">{children}</span>
        </button>
        {right}
      </li>
    );
  };
  const priority = (t: Task) => <span style={{ color: PRIORITY_META[t.priority].color }}>{PRIORITY_META[t.priority].label}</span>;

  let body: React.ReactNode = null;
  if (kind === "today") {
    body = today.length ? (
      <ul className="flex flex-col gap-2">
        {today.map((t) => {
          const late = t.status !== "done" && t.dueAt != null && t.dueAt < now;
          return (
            <Row key={t.id} t={t} right={<Badge color={t.status === "done" ? "var(--success)" : late ? "var(--danger)" : t.status === "in_progress" ? "var(--accent)" : "var(--muted)"}>{t.status === "done" ? "Completed" : late ? "Overdue" : t.status === "in_progress" ? "In progress" : "Pending"}</Badge>}>
              <span className="inline-flex items-center gap-1 tabular">{blockOf.get(t.id)?.fixed ? <Lock size={10} /> : <CalendarCheck size={10} />}{when(t)}</span>
              {priority(t)}
            </Row>
          );
        })}
      </ul>
    ) : (
      <EmptyState icon={<ListTodo size={22} />} title="Nothing scheduled for today" body="Tasks due today, in progress, or with time reserved today appear here." />
    );
  } else if (kind === "completed") {
    body = done.length ? (
      <ul className="flex flex-col gap-2">
        {done.map((t) => (
          <Row key={t.id} t={t} right={<Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => void nexus().setTaskDone(t.id, false)} title="Marked complete by mistake? Put it back in the To-Do list.">Restore</Button>}>
            <span className="tabular text-success">Completed {formatTime(t.completedAt!, zone, h12)}</span>
            {t.dueAt != null && <span>{t.completedAt! <= t.dueAt ? "on time" : `${humanDuration(t.completedAt! - t.dueAt)} late`}</span>}
            {priority(t)}
          </Row>
        ))}
      </ul>
    ) : (
      <EmptyState icon={<CheckCircle2 size={22} />} title="Nothing completed yet today" body="Tasks you confirm as completed today are listed here, with the time." />
    );
  } else if (kind === "overdue") {
    body = overdue.length ? (
      <ul className="flex flex-col gap-2">
        {overdue.map((t) => {
          const b = blockOf.get(t.id);
          const urgent = t.priority === "critical" || t.priority === "high" || now - t.dueAt! > 24 * 3600_000;
          return (
            <Row
              key={t.id}
              t={t}
              right={
                <Button size="sm" variant="soft" icon={<RotateCcw size={13} />} onClick={() => { onClose(); ui.openReschedule({ kind: "task", id: t.id, title: t.title, at: t.dueAt!, durationMs: (t.estimateMin ?? 30) * 60_000, important: t.priority === "critical", taskId: t.id }); }} title="Smart Reschedule: pick a free time">
                  Reschedule
                </Button>
              }
            >
              <span className="tabular text-danger">Was due {formatWithZone(t.dueAt!, t.dueTz ?? zone, h12)} · {humanDuration(now - t.dueAt!)} ago</span>
              {priority(t)}
              <span className="tabular">{b ? `Rescheduled to ${dayLabel(b.start, zone, now)} ${formatTime(b.start, zone, h12)}` : "No time reserved"}</span>
              {urgent && <Badge color="var(--danger)"><TriangleAlert size={10} /> Needs attention</Badge>}
            </Row>
          );
        })}
      </ul>
    ) : (
      <EmptyState icon={<CheckCircle2 size={22} />} title="Nothing is overdue" body="Every open task is still inside its deadline." />
    );
  } else if (kind === "focus") {
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex items-end justify-between gap-3 rounded-xl bg-hover px-4 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted">Total today</div>
            <div className="font-display text-2xl font-semibold tabular">{humanDuration(focusTotal)}</div>
          </div>
          <div className="text-xs text-muted">{sessions.length} session{sessions.length === 1 ? "" : "s"}</div>
        </div>
        {sessions.length ? (
          <ul className="flex flex-col gap-2">
            {sessions.map((f) => (
              <li key={f.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                <Flame size={15} className="text-accent-2 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{titleOf(f.taskId) ?? (f.kind === "pomodoro" ? "Focus session" : f.kind === "stopwatch" ? "Stopwatch" : "Countdown")}</div>
                  <div className="text-[11px] text-muted tabular">{formatTime(f.startedAt, zone, h12)} – {formatTime(f.endedAt, zone, h12)} · {f.kind}</div>
                </div>
                <span className="font-mono tabular text-sm font-semibold">{humanDuration(f.durationMs)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<Flame size={22} />} title="No focus sessions yet today" body="Start a focus timer and it is recorded here when it ends or is paused." />
        )}
      </div>
    );
  }

  const count = kind === "today" ? today.length : kind === "completed" ? done.length : kind === "overdue" ? overdue.length : sessions.length;
  return (
    <Modal
      open={!!kind}
      onClose={onClose}
      width={640}
      icon={kind ? META[kind].icon : undefined}
      title={kind ? <span>{META[kind].title} <span className="text-muted font-normal">· {count} · {DateTime.fromMillis(now, { zone }).toFormat("ccc d LLL")}</span></span> : ""}
      footer={
        <>
          {kind === "focus" && <Button variant="ghost" className="mr-auto" onClick={() => { onClose(); ui.setView("insights"); }}>Focus history</Button>}
          {kind === "overdue" && overdue.length > 0 && <span className="mr-auto text-xs text-muted">Reschedule opens Smart Reschedule for that task.</span>}
          {(kind === "today" || kind === "completed") && <Button variant="ghost" className="mr-auto" onClick={() => { onClose(); ui.setView("tasks"); }}>Open To-Do list</Button>}
          <Button variant="soft" onClick={onClose}>Close</Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}
