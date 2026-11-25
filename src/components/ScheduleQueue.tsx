import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDownUp, CalendarClock, Check, ChevronDown, ChevronRight, ChevronUp, Flag, GripVertical, ListChecks, Lock, ListTodo, Play, CopyPlus, TimerReset } from "lucide-react";
import { askExtend, askRepeat } from "./taskActions";
import type { SchedOrder, Task } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { agenda, untilLabel, type AgendaItem } from "@/lib/smart/agenda";
import { queueUnits, type QueueUnit } from "@/lib/smart/reschedule";
import { formatTime } from "@/lib/time";
import { hoursMinutes } from "@/lib/countdown";
import { EmptyState, cx } from "./ui";

interface Row {
  id: string;
  item: AgendaItem;
  /** Set for a flexible task that can be moved; a split task is one row. */
  unit: QueueUnit | null;
  pos: number;
}

const ARROW = "h-[18px] w-6 flex items-center justify-center rounded text-muted hover:text-accent hover:bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] disabled:opacity-25 disabled:pointer-events-none transition";

const HOUR = 3600_000;
const SHIFTS: [string, number][] = [["+15 min", HOUR / 4], ["+30 min", HOUR / 2], ["+1 hour", HOUR], ["+2 hours", 2 * HOUR], ["−30 min", -HOUR / 2]];

function QueueRow({ row, n, total, now, zone, hour12, task, open: expanded, onToggle }: { row: Row; n: number; total: number; now: number; zone: string; hour12: boolean; task: Task | undefined; open: boolean; onToggle: () => void }) {
  const { item: i, unit } = row;
  const subs = task?.subtasks ?? [];
  const doneSubs = subs.filter((x) => x.done).length;
  const toggleSub = (id: string) => task && void nexus().updateTask(task.id, { subtasks: task.subtasks.map((x) => (x.id === id ? { ...x, done: !x.done } : x)) });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: !unit });
  const today = DateTime.fromMillis(now, { zone });
  const d = DateTime.fromMillis(i.start, { zone });
  const day = d.hasSame(today, "day") ? "" : d.hasSame(today.plus({ days: 1 }), "day") ? "Tomorrow " : `${d.toFormat("ccc d")} `;
  const end = unit ? unit.end : i.end;
  const color = i.status === "overdue" ? "var(--danger)" : i.status === "now" ? "var(--success)" : i.kind === "fixed" ? "var(--accent-2)" : "var(--accent)";
  // A task opens as the task (title, notes, subtasks and checklist); a fixed appointment opens as the appointment.
  const open = () => (i.taskId ? useUI.getState().openTask(i.taskId) : i.eventId ? useUI.getState().openEvent(i.eventId) : undefined);
  const canExpand = !!task && (subs.length > 0 || !!unit);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 20 : undefined }}
      className={cx("rounded-xl border border-line bg-[var(--bg-2)] min-w-0 transition-[border-color,box-shadow]", "hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]", i.status === "now" && "bg-[color-mix(in_oklab,var(--success)_8%,var(--bg-2))]", isDragging && "border-accent shadow-[0_8px_30px_rgba(0,0,0,0.45),0_0_0_1px_var(--accent)]")}
    >
    <div
      className={cx(
        "group flex items-center gap-2 pl-1.5 pr-1.5 py-1.5 min-w-0",
      )}
    >
      {unit ? (
        <button type="button" {...attributes} {...listeners} aria-label={`Drag ${i.title} to another place in the queue`} title="Drag to reorder" className="h-8 w-5 shrink-0 flex items-center justify-center text-muted hover:text-accent cursor-grab active:cursor-grabbing touch-none">
          <GripVertical size={14} />
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}
      <span className="w-4 text-center text-[11px] font-mono font-semibold tabular shrink-0" style={{ color }}>{n}</span>
      <span className="shrink-0" style={{ color }} title={i.kind === "fixed" ? "Fixed appointment: it does not move" : i.kind === "deadline" ? "Task due" : i.status === "now" ? "Under way" : "Flexible task: drag it or use the arrows"}>
        {i.kind === "fixed" ? <Lock size={13} /> : i.kind === "deadline" ? <Flag size={13} /> : <CalendarClock size={13} />}
      </span>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={open}>
        <div className="text-[13px] font-medium truncate group-hover:text-accent">{unit?.title ?? i.title}</div>
        <div className="text-[11px] text-muted tabular truncate">
          {day}{formatTime(i.start, zone, hour12)}{end > i.start ? ` – ${formatTime(end, zone, hour12)}` : ""}
          {unit && unit.blocks.length > 1 ? ` · ${unit.blocks.length} parts, ${hoursMinutes(unit.durationMs)}` : ""} · <span style={{ color: i.status === "upcoming" ? undefined : color }}>{untilLabel(i, now)}</span>
        </div>
      </button>
      {canExpand && (
        <button type="button" onClick={onToggle} aria-expanded={expanded} title={subs.length ? `${doneSubs} of ${subs.length} subtasks done · show checklist and actions` : "Show actions"} className={cx("shrink-0 h-6 px-1.5 rounded-lg flex items-center gap-1 text-[11px] tabular transition", expanded ? "text-accent bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]" : "text-muted hover:text-fg hover:bg-hover")}>
          {subs.length > 0 && <><ListChecks size={12} />{doneSubs}/{subs.length}</>}
          <ChevronRight size={12} className={cx("transition-transform", expanded && "rotate-90")} />
        </button>
      )}
      {task && (unit || i.kind === "deadline") && i.status !== "now" && i.start - now > 90_000 && (
        <button
          type="button"
          onClick={() => void nexus().startTaskNow(task.id)}
          aria-label={`Start ${task.title} now`}
          title="Start now: it begins in the next minute and the work clock counts. Tasks in the way follow it in order."
          className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-accent bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] hover:bg-accent hover:text-white hover:shadow-[0_0_12px_color-mix(in_oklab,var(--accent)_60%,transparent)] transition"
        >
          <Play size={13} fill="currentColor" />
        </button>
      )}
      {unit ? (
        <div className="flex flex-col shrink-0" role="group" aria-label={`Move ${i.title}`}>
          <button type="button" className={ARROW} disabled={row.pos === 0} aria-label="Move up the queue" title="Move up: do this one earlier" onClick={() => void nexus().moveInQueue(unit.blocks[0].id, -1)}><ChevronUp size={14} /></button>
          <button type="button" className={ARROW} disabled={row.pos === total - 1} aria-label="Move down the queue" title="Move down: do this one later" onClick={() => void nexus().moveInQueue(unit.blocks[0].id, 1)}><ChevronDown size={14} /></button>
        </div>
      ) : (
        <span className="w-6 shrink-0" />
      )}
    </div>
    {expanded && task && (
      <div className="px-3 pb-2.5 pt-0.5 ml-[52px] flex flex-col gap-2 border-t border-line/60">
        {subs.length > 0 && (
          <ul className="flex flex-col gap-0.5 pt-2" aria-label={`Checklist for ${task.title}`}>
            {subs.map((x) => (
              <li key={x.id}>
                <button type="button" onClick={() => toggleSub(x.id)} aria-pressed={x.done} className="group/sub flex items-center gap-2 w-full text-left text-[12px] py-0.5">
                  <span className={cx("h-3.5 w-3.5 shrink-0 rounded border flex items-center justify-center transition-colors", x.done ? "bg-success border-success text-white" : "border-line group-hover/sub:border-accent")}>{x.done && <Check size={10} strokeWidth={3.5} />}</span>
                  <span className={cx("truncate", x.done ? "line-through text-muted" : "text-fg-2 group-hover/sub:text-fg")}>{x.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {task.notes && <p className="text-[11px] text-muted line-clamp-2 whitespace-pre-line">{task.notes}</p>}
        {unit && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <button type="button" onClick={() => void nexus().startTaskNow(task.id)} title="Start this now. The task under way continues straight after it." className="h-6 px-2 rounded-lg text-[11px] font-semibold flex items-center gap-1 text-white bg-accent hover:brightness-110"><Play size={11} />Start now</button>
            {SHIFTS.map(([label, ms]) => (
              <button key={label} type="button" onClick={() => void nexus().shiftTask(unit.blocks[0].id, ms)} title={`Move it exactly ${label.replace(/^[+−]/, "")} ${ms > 0 ? "later" : "earlier"}; the tasks after it follow`} className="h-6 px-2 rounded-lg border border-line text-[11px] font-medium text-fg-2 hover:text-accent hover:border-accent transition tabular">{label}</button>
            ))}
            <button type="button" onClick={() => void askExtend(unit.blocks[unit.blocks.length - 1].id, task.title)} title="Give this task more time; the tasks after it move along" className="h-6 px-2 rounded-lg border border-line text-[11px] font-medium text-fg-2 hover:text-accent hover:border-accent transition flex items-center gap-1"><TimerReset size={11} />Extend</button>
            <button type="button" onClick={() => void askRepeat(task.id, task.title, false)} title="Add one more session of this task" className="h-6 px-2 rounded-lg border border-line text-[11px] font-medium text-fg-2 hover:text-accent hover:border-accent transition flex items-center gap-1"><CopyPlus size={11} />Repeat</button>
          </div>
        )}
      </div>
    )}
    </li>
  );
}

const ORDERS: { id: SchedOrder; label: string }[] = [
  { id: "fifo", label: "First in, first out" },
  { id: "priority", label: "Priority" },
  { id: "shortest", label: "Shortest first" },
  { id: "deadline", label: "Nearest deadline" },
];

/** Reorganise the whole queue by a rule. The rule is remembered and also used when NEXUS reschedules by itself. */
export function QueueOrder() {
  const order = useNexus((s) => s.settings.schedOrder);
  return (
    <div className="flex items-center gap-1.5">
      <select
        value={order}
        aria-label="Scheduling order"
        title="The order NEXUS uses when it schedules or reorganises tasks"
        onChange={(e) => void nexus().setSetting("schedOrder", e.target.value as SchedOrder)}
        className="h-7 rounded-lg border border-line bg-hover px-1.5 text-[11px] text-fg-2 outline-none focus:border-accent"
      >
        {ORDERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <button type="button" onClick={() => void nexus().sortQueue()} title="Put the queue in this order now" className="h-7 px-2 rounded-lg border border-line text-[11px] font-medium text-fg-2 hover:text-accent hover:border-accent transition flex items-center gap-1"><ArrowDownUp size={12} />Reorganise</button>
    </div>
  );
}

/**
 * What is coming up, in order. A flexible task can be dragged (or moved with
 * its arrows) to another place: it takes over that place's start time and the
 * tasks after it follow. Fixed appointments carry a lock and stay put.
 */
export function ScheduleQueue({ now, limit = 6 }: { now: number; limit?: number }) {
  const { tasks, events, settings } = useNexus((s) => ({ tasks: s.tasks, events: s.events, settings: s.settings }));
  const minute = Math.floor(now / 60_000);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const byTask = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const { rows, units } = useMemo(() => {
    const units = queueUnits(tasks, events, now);
    const byEvent = new Map(units.flatMap((u, pos) => u.blocks.map((b) => [b.id, { u, pos }] as const)));
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const item of agenda(tasks, events, now, { limit: limit * 3 })) {
      const q = item.eventId && item.status === "upcoming" ? byEvent.get(item.eventId) : undefined;
      if (q) {
        if (seen.has(q.u.taskId)) continue; // later parts of a split task
        seen.add(q.u.taskId);
      }
      rows.push({ id: item.key, item, unit: q?.u ?? null, pos: q?.pos ?? -1 });
      if (rows.length >= limit) break;
    }
    return { rows, units };
  }, [tasks, events, minute, limit]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows.length) return <EmptyState icon={<ListTodo size={22} />} title="Nothing in the queue" body="Schedule a task or an appointment and it lines up here." />;

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = rows.map((r) => r.id);
    const moved = arrayMove(rows, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    const order = moved.filter((r) => r.unit).map((r) => r.unit!.taskId);
    void nexus().reorderQueue(order);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        <ol className="flex flex-col gap-1.5" aria-label="Schedule queue">
          {rows.map((r, n) => {
            const key = r.item.taskId ?? r.id;
            return <QueueRow key={r.id} row={r} n={n + 1} total={units.length} now={now} zone={settings.homeZone} hour12={settings.hour12} task={r.item.taskId ? byTask.get(r.item.taskId) : undefined} open={openRow === key} onToggle={() => setOpenRow((o) => (o === key ? null : key))} />;
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
