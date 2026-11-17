import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import {
  CalendarClock, CalendarPlus, CalendarX, CheckCircle2, Flame, History as HistoryIcon, LogIn, LogOut, Pause, Play, Plus, RotateCcw, Search, Trash2, Undo2, Wand2,
} from "lucide-react";
import type { ActivityEntry, ActivityKind } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { formatTime } from "@/lib/time";
import { Button, Card, EmptyState, Input, cx } from "@/components/ui";

const META: Record<ActivityKind, { icon: React.ReactNode; color: string; group: Filter }> = {
  task_completed: { icon: <CheckCircle2 size={15} />, color: "var(--success)", group: "completed" },
  task_reopened: { icon: <RotateCcw size={15} />, color: "var(--warning)", group: "tasks" },
  task_created: { icon: <Plus size={15} />, color: "var(--accent)", group: "tasks" },
  task_deleted: { icon: <Trash2 size={15} />, color: "var(--danger)", group: "tasks" },
  task_restored: { icon: <Undo2 size={15} />, color: "var(--accent)", group: "tasks" },
  task_rescheduled: { icon: <CalendarClock size={15} />, color: "var(--accent-2)", group: "schedule" },
  event_created: { icon: <CalendarPlus size={15} />, color: "var(--accent-2)", group: "schedule" },
  event_moved: { icon: <CalendarClock size={15} />, color: "var(--accent-2)", group: "schedule" },
  event_deleted: { icon: <CalendarX size={15} />, color: "var(--danger)", group: "schedule" },
  auto_planned: { icon: <Wand2 size={15} />, color: "var(--accent-3)", group: "schedule" },
  focus: { icon: <Flame size={15} />, color: "var(--accent-2)", group: "focus" },
  clock_in: { icon: <LogIn size={15} />, color: "var(--success)", group: "clock" },
  clock_out: { icon: <LogOut size={15} />, color: "var(--muted)", group: "clock" },
  auto_paused: { icon: <Pause size={15} />, color: "var(--warning)", group: "clock" },
  paused: { icon: <Pause size={15} />, color: "var(--warning)", group: "clock" },
  resumed: { icon: <Play size={15} />, color: "var(--success)", group: "clock" },
};

type Filter = "all" | "completed" | "focus" | "clock" | "schedule" | "tasks";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "completed", label: "Completed" },
  { id: "focus", label: "Focus" },
  { id: "clock", label: "Work clock" },
  { id: "schedule", label: "Scheduling" },
  { id: "tasks", label: "Task changes" },
];

export default function History() {
  const { activity, settings, tasks } = useNexus((s) => ({ activity: s.activity, settings: s.settings, tasks: s.tasks }));
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(200);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return activity
      .filter((a) => META[a.kind] && (filter === "all" || META[a.kind].group === filter))
      .filter((a) => !needle || a.title.toLowerCase().includes(needle) || a.detail.toLowerCase().includes(needle));
  }, [activity, filter, q]);

  const groups = useMemo(() => {
    const m = new Map<string, ActivityEntry[]>();
    for (const a of list.slice(0, limit)) {
      const d = DateTime.fromMillis(a.at, { zone: settings.homeZone });
      const today = DateTime.now().setZone(settings.homeZone);
      const k = d.hasSame(today, "day") ? "Today" : d.hasSame(today.minus({ days: 1 }), "day") ? "Yesterday" : d.toFormat("cccc d LLLL yyyy");
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return [...m.entries()];
  }, [list, limit, settings.homeZone]);

  const completedCount = activity.filter((a) => a.kind === "task_completed").length;

  return (
    <div className="flex flex-col gap-5 max-w-4xl">
      <div>
        <h1 className="font-display text-2xl font-semibold">History</h1>
        <p className="text-sm text-muted">Everything you've done: completed tasks, focus sessions, clock-ins, auto-pauses and schedule changes. {completedCount} tasks completed in total.</p>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id} className={cx("h-8 px-3 rounded-lg text-xs font-medium border transition", filter === f.id ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-muted hover:text-fg")}>
            {f.label}
          </button>
        ))}
        <div className="relative ml-auto w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
        </div>
      </div>
      {groups.length === 0 ? (
        <Card><EmptyState icon={<HistoryIcon size={22} />} title="No history yet" body="Complete tasks, run focus sessions or clock in and they'll show up here." /></Card>
      ) : (
        groups.map(([day, entries]) => (
          <section key={day}>
            <h2 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-muted mb-2">{day}</h2>
            <Card className="divide-y divide-[var(--border)]">
              {entries.map((a) => {
                const m = META[a.kind];
                const task = a.kind === "task_completed" && a.refId ? tasks.find((t) => t.id === a.refId) : undefined;
                return (
                  <div key={a.id} className="group flex items-center gap-3 px-4 py-2.5">
                    <span className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0" style={{ color: m.color, background: `color-mix(in oklab, ${m.color} 14%, transparent)` }}>{m.icon}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-fg truncate">{a.title}</p>
                      {a.detail && <p className="text-[11px] text-muted truncate">{a.detail}</p>}
                    </div>
                    {task && task.status === "done" && !task.deletedAt && (
                      <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100" onClick={() => void nexus().setTaskDone(task.id, false)}>Reopen</Button>
                    )}
                    <span className="text-xs text-muted tabular shrink-0">{formatTime(a.at, settings.homeZone, settings.hour12)}</span>
                  </div>
                );
              })}
            </Card>
          </section>
        ))
      )}
      {list.length > limit && <Button variant="soft" className="self-center" onClick={() => setLimit((l) => l + 200)}>Show more</Button>}
    </div>
  );
}
