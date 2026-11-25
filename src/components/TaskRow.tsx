import { memo } from "react";
import { motion } from "framer-motion";
import { Archive, ArchiveRestore, CalendarCheck, Check, Clock, CopyPlus, TimerReset, GripVertical, ListChecks, Lock, Pause, Play, Repeat, RotateCcw, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import type { Category, Task } from "@/data/types";
import { deadlineInfo, spentVsEstimate, humanDuration } from "@/lib/countdown";
import { formatWithZone, KENYA_ZONE, formatTime, zoneAbbr } from "@/lib/time";
import { nexus, useNexus } from "@/store";
import { autoBadge, dayLabel, moveHistory } from "@/lib/smart/format";
import { useUI } from "@/store/ui";
import { Badge, IconButton, ProgressBar, cx } from "./ui";
import { CategoryIcon, PRIORITY_META, URGENCY_COLOR, categoryOf } from "./meta";
import { choose } from "./Confirm";
import { confirmComplete } from "./complete";
import { askMoreTime, askRepeat } from "./taskActions";

/** The time reserved on the calendar for a task, and whether NEXUS has moved it. */
function PlannedTime({ taskId, now, hour12 }: { taskId: string; now: number; hour12: boolean }) {
  // the block that is running or comes next; otherwise the most recent one (it may need a new time)
  const block = useNexus((s) => {
    const mine = s.events.filter((e) => e.taskId === taskId && !e.deletedAt && !e.recurrence);
    return mine.filter((e) => e.endAt > now).sort((a, b) => a.startAt - b.startAt)[0] ?? mine.filter((e) => e.sched?.attention).sort((a, b) => b.endAt - a.endAt)[0] ?? null;
  });
  if (!block) return null;
  const badge = autoBadge(block);
  const history = moveHistory(block, hour12);
  return (
    <>
      <span className="inline-flex items-center gap-1 text-accent" title={`Time reserved on the calendar (${block.fixed ? "fixed" : "flexible"})`}>
        {block.fixed ? <Lock size={11} /> : <CalendarCheck size={11} />}
        {dayLabel(block.startAt, block.tz, now)} {formatTime(block.startAt, block.tz, hour12)}–{formatTime(block.endAt, block.tz, hour12)} {zoneAbbr(block.tz, block.startAt)}
      </span>
      {badge && (
        <span className={cx("inline-flex items-center gap-1 rounded px-1 font-medium", badge.attention ? "text-danger bg-[color-mix(in_oklab,var(--danger)_14%,transparent)]" : "text-warning bg-[color-mix(in_oklab,var(--warning)_14%,transparent)]")} title={history.length ? `Moved automatically:\n${history.join("\n")}` : undefined}>
          {badge.attention ? <TriangleAlert size={10} /> : <RotateCcw size={10} />} {badge.text}
        </span>
      )}
    </>
  );
}

interface Props {
  task: Task;
  categories: Category[];
  now: number;
  hour12: boolean;
  texasZone: string;
  warnMin: number;
  active: boolean;
  dragHandle?: React.HTMLAttributes<HTMLButtonElement>;
  compact?: boolean;
}

export const TaskRow = memo(function TaskRow({ task: t, categories, now, hour12, texasZone, warnMin, active, dragHandle, compact }: Props) {
  const s = nexus();
  const done = t.status === "done";
  const cat = categoryOf(categories, t.categoryId);
  const dl = deadlineInfo(t.dueAt, now, warnMin);
  const subDone = t.subtasks.filter((x) => x.done).length;
  const sve = spentVsEstimate(t.spentMs, t.estimateMin);
  const openTask = useUI.getState().openTask;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className={cx(
        "group relative flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors",
        active ? "border-accent bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]" : "border-line bg-surface hover:border-line-strong",
        t.deletedAt && "opacity-70",
      )}
    >
      <span className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full" style={{ background: PRIORITY_META[t.priority].color }} />
      {dragHandle && (
        <button {...dragHandle} aria-label="Drag to reorder" className="mt-1 -ml-1 cursor-grab active:cursor-grabbing text-muted opacity-0 group-hover:opacity-60 hover:!opacity-100 touch-none">
          <GripVertical size={14} />
        </button>
      )}
      {!t.deletedAt && (
        <button
          onClick={() => void (done ? s.setTaskDone(t.id, false) : confirmComplete(t.id))}
          aria-label={done ? "Mark as not done" : "Mark as done"}
          className={cx("mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 flex items-center justify-center transition", done ? "bg-success border-success text-white" : "border-line-strong hover:border-accent")}
        >
          {done && <Check size={12} strokeWidth={3} />}
        </button>
      )}
      <button className="min-w-0 flex-1 text-left" onClick={() => !t.deletedAt && openTask(t.id)}>
        <div className="flex items-center gap-2 min-w-0">
          <span className={cx("text-sm font-medium truncate", done ? "line-through text-muted" : "text-fg")}>{t.title}</span>
          {t.recurrence && <Repeat size={12} className="text-muted shrink-0" aria-label="Repeats" />}
          {active && <Badge color="var(--accent)">ACTIVE</Badge>}
        </div>
        {!compact && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1" style={{ color: cat.color }}>
              <CategoryIcon icon={cat.icon} size={11} /> {cat.name}
            </span>
            <span style={{ color: PRIORITY_META[t.priority].color }}>{PRIORITY_META[t.priority].label}</span>
            {t.dueAt != null && (
              <span
                className="inline-flex items-center gap-1 font-medium"
                style={{ color: done ? undefined : URGENCY_COLOR[dl.urgency] }}
                title={`${formatWithZone(t.dueAt, t.dueTz ?? KENYA_ZONE, hour12)} · KE ${formatTime(t.dueAt, KENYA_ZONE, hour12)} · TX ${formatTime(t.dueAt, texasZone, hour12)} ${zoneAbbr(texasZone, t.dueAt)}`}
              >
                <Clock size={11} />
                {done ? formatWithZone(t.dueAt, t.dueTz ?? KENYA_ZONE, hour12) : dl.label}
              </span>
            )}
            {!done && !t.deletedAt && <PlannedTime taskId={t.id} now={Math.floor(now / 60_000) * 60_000} hour12={hour12} />}
            {t.estimateMin != null && (
              <span className={cx(sve.over && "text-warning")} title="Time spent vs estimate">
                {t.spentMs > 0 ? sve.label : `~${humanDuration(t.estimateMin * 60_000)}`}
              </span>
            )}
            {t.subtasks.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <ListChecks size={11} /> {subDone}/{t.subtasks.length}
              </span>
            )}
          </div>
        )}
        {!compact && t.subtasks.length > 0 && !done && <ProgressBar value={subDone / t.subtasks.length} className="mt-2 max-w-[240px] !h-1" />}
      </button>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {t.deletedAt ? (
          <>
            <IconButton label="Restore" onClick={() => void s.restoreTask(t.id)}><Undo2 size={15} /></IconButton>
            <IconButton label="Delete forever" onClick={() => void s.purgeTask(t.id)} className="hover:!text-danger"><Trash2 size={15} /></IconButton>
          </>
        ) : (
          <>
            {!done && (
              <IconButton label={active ? "Stop working on this" : "Work on this now (sets active task)"} active={active} onClick={() => void s.setActiveTask(active ? null : t.id)}>
                {active ? <Pause size={15} /> : <Play size={15} />}
              </IconButton>
            )}
            <IconButton label={done ? "Repeat: do this task again" : "Repeat: add one more session"} onClick={() => void askRepeat(t.id, t.title, done)}><CopyPlus size={15} /></IconButton>
            {done && !t.archivedAt && <IconButton label="Archive" onClick={() => void s.archiveTask(t.id, true)}><Archive size={15} /></IconButton>}
            {t.archivedAt && <IconButton label="Unarchive" onClick={() => void s.archiveTask(t.id, false)}><ArchiveRestore size={15} /></IconButton>}
            {!done && dl.urgency === "overdue" && (
              <IconButton label="Extend: give it more time, starting now" onClick={() => void askMoreTime(t.id, t.title)}><TimerReset size={15} /></IconButton>
            )}
            {!done && dl.urgency === "overdue" && (
              <IconButton label="Smart Reschedule" onClick={() => useUI.getState().openReschedule({ kind: "task", id: t.id, title: t.title, at: t.dueAt!, durationMs: (t.estimateMin ?? 30) * 60_000, important: t.priority === "critical", taskId: t.id })}>
                <RotateCcw size={15} />
              </IconButton>
            )}
            <IconButton
              label="Delete (restorable)"
              onClick={async () => {
                if (!t.recurrence || t.dueAt == null) return void s.deleteTask(t.id);
                // A repeating task: remove just this one, or stop it repeating?
                const which = await choose({
                  title: "Delete repeating task",
                  body: `“${t.title}” repeats. Delete only this occurrence (the next one is scheduled), or the whole series? Either can be restored from the Trash.`,
                  danger: true,
                  choices: [
                    { value: "occurrence", label: "Only this one", variant: "soft" },
                    { value: "series", label: "Entire series", variant: "danger" },
                  ],
                });
                if (which) void s.deleteTask(t.id, which as "occurrence" | "series");
              }}
              className="hover:!text-danger"
            >
              <Trash2 size={15} />
            </IconButton>
          </>
        )}
      </div>
    </motion.div>
  );
});
