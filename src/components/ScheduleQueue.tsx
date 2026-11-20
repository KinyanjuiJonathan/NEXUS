import { useMemo } from "react";
import { DateTime } from "luxon";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CalendarClock, ChevronDown, ChevronUp, Flag, GripVertical, Lock, ListTodo } from "lucide-react";
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

function QueueRow({ row, n, total, now, zone, hour12 }: { row: Row; n: number; total: number; now: number; zone: string; hour12: boolean }) {
  const { item: i, unit } = row;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: !unit });
  const today = DateTime.fromMillis(now, { zone });
  const d = DateTime.fromMillis(i.start, { zone });
  const day = d.hasSame(today, "day") ? "" : d.hasSame(today.plus({ days: 1 }), "day") ? "Tomorrow " : `${d.toFormat("ccc d")} `;
  const end = unit ? unit.end : i.end;
  const color = i.status === "overdue" ? "var(--danger)" : i.status === "now" ? "var(--success)" : i.kind === "fixed" ? "var(--accent-2)" : "var(--accent)";
  const open = () => (i.eventId ? useUI.getState().openEvent(i.eventId) : i.taskId ? useUI.getState().openTask(i.taskId) : undefined);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 20 : undefined }}
      className={cx(
        "group flex items-center gap-2 rounded-xl border border-line pl-1.5 pr-1.5 py-1.5 min-w-0 bg-[var(--bg-2)] transition-[border-color,box-shadow]",
        "hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]",
        i.status === "now" && "bg-[color-mix(in_oklab,var(--success)_8%,var(--bg-2))]",
        isDragging && "border-accent shadow-[0_8px_30px_rgba(0,0,0,0.45),0_0_0_1px_var(--accent)]",
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
      {unit ? (
        <div className="flex flex-col shrink-0" role="group" aria-label={`Move ${i.title}`}>
          <button type="button" className={ARROW} disabled={row.pos === 0} aria-label="Move up the queue" title="Move up: do this one earlier" onClick={() => void nexus().moveInQueue(unit.blocks[0].id, -1)}><ChevronUp size={14} /></button>
          <button type="button" className={ARROW} disabled={row.pos === total - 1} aria-label="Move down the queue" title="Move down: do this one later" onClick={() => void nexus().moveInQueue(unit.blocks[0].id, 1)}><ChevronDown size={14} /></button>
        </div>
      ) : (
        <span className="w-6 shrink-0" />
      )}
    </li>
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
          {rows.map((r, n) => <QueueRow key={r.id} row={r} n={n + 1} total={units.length} now={now} zone={settings.homeZone} hour12={settings.hour12} />)}
        </ol>
      </SortableContext>
    </DndContext>
  );
}
