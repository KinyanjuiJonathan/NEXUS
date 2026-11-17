import { memo } from "react";
import { motion } from "framer-motion";
import { Archive, ArchiveRestore, Check, Clock, GripVertical, ListChecks, Pause, Play, Repeat, RotateCcw, Trash2, Undo2 } from "lucide-react";
import type { Category, Task } from "@/data/types";
import { deadlineInfo, spentVsEstimate, humanDuration } from "@/lib/countdown";
import { formatWithZone, KENYA_ZONE, formatTime, zoneAbbr } from "@/lib/time";
import { nexus } from "@/store";
import { useUI } from "@/store/ui";
import { Badge, IconButton, ProgressBar, cx } from "./ui";
import { CategoryIcon, PRIORITY_META, URGENCY_COLOR, categoryOf } from "./meta";

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
          onClick={() => void s.setTaskDone(t.id, !done)}
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
            {done && !t.archivedAt && <IconButton label="Archive" onClick={() => void s.archiveTask(t.id, true)}><Archive size={15} /></IconButton>}
            {t.archivedAt && <IconButton label="Unarchive" onClick={() => void s.archiveTask(t.id, false)}><ArchiveRestore size={15} /></IconButton>}
            {!done && dl.urgency === "overdue" && (
              <IconButton label="Smart Reschedule" onClick={() => useUI.getState().openReschedule({ kind: "task", id: t.id, title: t.title, at: t.dueAt!, durationMs: (t.estimateMin ?? 30) * 60_000, important: t.priority === "critical", taskId: t.id })}>
                <RotateCcw size={15} />
              </IconButton>
            )}
            <IconButton label="Delete (restorable)" onClick={() => void s.deleteTask(t.id)} className="hover:!text-danger"><Trash2 size={15} /></IconButton>
          </>
        )}
      </div>
    </motion.div>
  );
});
