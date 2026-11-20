import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ListOrdered, Wand2, Archive, CalendarClock, CalendarDays, CheckCircle2, Inbox, ListTodo, Plus, Search, Sun, Trash2, TriangleAlert, CalendarRange, History } from "lucide-react";
import type { Priority } from "@/data/types";
import { PRIORITIES } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { useNow } from "@/lib/ticker";
import { parseCommand } from "@/lib/voice/parser";
import { TaskRow } from "@/components/TaskRow";
import { ScheduleQueue } from "@/components/ScheduleQueue";
import { filterTasks, taskCounts, type TaskView as TV } from "@/lib/taskViews";
import { queueUnits } from "@/lib/smart/reschedule";
import { Button, Card, EmptyState, Input, Select, cx } from "@/components/ui";
import { PRIORITY_META } from "@/components/meta";
import { confirm } from "@/components/Confirm";

type TaskView = TV | "queue";

const VIEWS: { id: TaskView; label: string; icon: React.ReactNode }[] = [
  { id: "today", label: "Today", icon: <Sun size={15} /> },
  { id: "queue", label: "Queue", icon: <ListOrdered size={15} /> },
  { id: "upcoming", label: "Upcoming", icon: <CalendarRange size={15} /> },
  { id: "week", label: "This Week", icon: <CalendarDays size={15} /> },
  { id: "overdue", label: "Overdue", icon: <TriangleAlert size={15} /> },
  { id: "all", label: "All Tasks", icon: <Inbox size={15} /> },
  { id: "completed", label: "Completed", icon: <CheckCircle2 size={15} /> },
  { id: "archive", label: "Archive", icon: <Archive size={15} /> },
  { id: "trash", label: "Trash", icon: <Trash2 size={15} /> },
];

function SortableRow(props: React.ComponentProps<typeof TaskRow>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.task.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.85 : 1 }}>
      <TaskRow {...props} dragHandle={{ ...attributes, ...listeners } as React.HTMLAttributes<HTMLButtonElement>} />
    </div>
  );
}

export default function Tasks() {
  const now = useNow();
  const { tasks, categories, settings, events } = useNexus((s) => ({ tasks: s.tasks, categories: s.categories, settings: s.settings, events: s.events }));
  const [view, setView] = useState<TaskView>("today");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [pri, setPri] = useState<Priority | "all">("all");
  const [quick, setQuick] = useState("");
  const minute = Math.floor(now / 60_000);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const counts = useMemo<Record<TaskView, number>>(() => ({ ...taskCounts(tasks, now, settings.homeZone, events), queue: queueUnits(tasks, events, now).length }), [tasks, events, minute, settings.homeZone]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    if (view === "queue") return [];
    let l = filterTasks(tasks, view, now, settings.homeZone, events);
    const needle = q.trim().toLowerCase();
    if (needle) l = l.filter((t) => t.title.toLowerCase().includes(needle) || t.notes.toLowerCase().includes(needle) || t.subtasks.some((s) => s.title.toLowerCase().includes(needle)));
    if (cat !== "all") l = l.filter((t) => t.categoryId === cat);
    if (pri !== "all") l = l.filter((t) => t.priority === pri);
    return l;
  }, [tasks, events, view, q, cat, pri, minute, settings.homeZone]); // eslint-disable-line react-hooks/exhaustive-deps

  const sortable = (view === "all" || view === "today") && !q && cat === "all" && pri === "all";
  const s = nexus();

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = list.map((t) => t.id);
    const moved = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    // Merge the visible order back into the global order, keeping hidden tasks in place.
    const all = [...tasks].sort((a, b) => a.sortOrder - b.sortOrder).map((t) => t.id);
    const slots = all.map((id, i) => (ids.includes(id) ? i : -1)).filter((i) => i >= 0);
    slots.forEach((slot, k) => (all[slot] = moved[k]));
    void s.reorderTasks(all);
  };

  const quickAdd = async () => {
    const text = quick.trim();
    if (!text) return;
    const p = parseCommand(/^(add|create|remind)/i.test(text) ? text : `add ${text}`, { now: Date.now(), homeZone: settings.homeZone, texasZone: settings.texasZone });
    if (p.intent.type === "add_task") {
      await s.addTask({
        title: p.intent.title,
        dueAt: p.intent.dueAt,
        dueTz: p.intent.tz,
        estimateMin: p.intent.estimateMin,
        priority: p.intent.priority ?? undefined,
        categoryId: p.intent.categoryId ?? (cat !== "all" ? cat : undefined),
        reminders: p.intent.reminderAtTime ? [0] : undefined,
      });
    } else {
      await s.addTask({ title: text, categoryId: cat !== "all" ? cat : undefined });
    }
    setQuick("");
  };

  const rowProps = { categories, now, hour12: settings.hour12, texasZone: settings.texasZone, warnMin: settings.deadlineWarningMin };

  return (
    <div className="flex flex-col lg:flex-row gap-5">
      <aside className="lg:w-[210px] shrink-0 flex lg:flex-col gap-1 overflow-x-auto">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            aria-current={view === v.id ? "true" : undefined}
            className={cx("flex items-center gap-2.5 h-9 px-3 rounded-xl text-sm whitespace-nowrap transition", view === v.id ? "bg-hover text-fg border border-line" : "text-muted hover:text-fg hover:bg-hover")}
          >
            <span className={cx(view === v.id && "text-accent", v.id === "overdue" && counts.overdue > 0 && "text-danger")}>{v.icon}</span>
            {v.label}
            <span className="ml-auto text-[11px] tabular text-muted">{counts[v.id] || ""}</span>
          </button>
        ))}
        <button onClick={() => useUI.getState().setView("calendar")} className="flex items-center gap-2.5 h-9 px-3 rounded-xl text-sm text-muted hover:text-fg hover:bg-hover whitespace-nowrap">
          <CalendarDays size={15} /> Calendar
        </button>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-2xl font-semibold mr-auto">{VIEWS.find((v) => v.id === view)!.label}</h1>
          {view !== "trash" && view !== "archive" && view !== "completed" && (
            <>
              <Button size="sm" variant="outline" icon={<Wand2 size={14} />} onClick={() => useUI.getState().openAutoPlan(true)}>Auto-plan</Button>
              <Button size="sm" variant="outline" icon={<CalendarClock size={14} />} onClick={() => useUI.getState().openRescheduleAll(true)} title="Move every open task to a later date or time">Reschedule all</Button>
            </>
          )}
          {view === "completed" && counts.completed > 0 && (
            <Button size="sm" variant="soft" icon={<Archive size={14} />} onClick={async () => { const n = await s.archiveCompleted(); s.toast({ kind: "success", title: `Archived ${n} completed task${n === 1 ? "" : "s"}` }); }}>
              Archive all completed
            </Button>
          )}
          {view === "trash" && counts.trash > 0 && (
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={async () => { if (await confirm({ title: "Empty trash?", body: "These tasks will be permanently deleted. This cannot be undone.", confirmLabel: "Delete forever", danger: true })) await s.emptyTrash(); }}>
              Empty trash
            </Button>
          )}
        </div>

        {view !== "trash" && view !== "archive" && view !== "completed" && view !== "queue" && (
          <form onSubmit={(e) => { e.preventDefault(); void quickAdd(); }}>
            <Card className="flex items-center gap-2 px-3 py-1.5 focus-within:border-accent transition">
              <Plus size={16} className="text-accent" />
              <input
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                placeholder="Quick add — try “Pay rent Friday 5pm high priority” or “Call Amina tomorrow 10am Texas time”"
                className="flex-1 h-10 bg-transparent outline-none text-sm placeholder:text-muted"
                aria-label="Quick add task"
              />
              <Button type="submit" size="sm" variant="primary" disabled={!quick.trim()}>Add</Button>
            </Card>
          </form>
        )}

        {view === "queue" && (
          <Card className="p-4 flex flex-col gap-3">
            <p className="text-[12px] text-muted">Everything scheduled, in order. Drag a task (or use its arrows) to change the order: it takes over the start time of the place it lands in, and the tasks after it follow. Fixed appointments stay where they are.</p>
            <ScheduleQueue now={now} limit={60} />
          </Card>
        )}

        <div className={cx("flex flex-wrap gap-2", view === "queue" && "hidden")}>
          <div className="relative flex-1 min-w-[200px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input id="task-search" placeholder="Search tasks, notes, subtasks  ( / )" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <Select value={cat} onChange={(e) => setCat(e.target.value)} className="!w-40" aria-label="Category filter">
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select value={pri} onChange={(e) => setPri(e.target.value as Priority | "all")} className="!w-36" aria-label="Priority filter">
            <option value="all">All priorities</option>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p].label}</option>)}
          </Select>
        </div>

        {view === "queue" ? null : list.length === 0 ? (
          <Card>
            <EmptyState
              icon={view === "trash" ? <Trash2 size={22} /> : view === "completed" ? <History size={22} /> : <ListTodo size={22} />}
              title={q || cat !== "all" || pri !== "all" ? "No tasks match your filters" : view === "trash" ? "Trash is empty" : view === "overdue" ? "Nothing overdue 🎉" : "Nothing here yet"}
              body={view === "trash" ? "Deleted tasks stay here for 30 days." : view === "today" ? "Add a task above, press N, or use your voice (V)." : undefined}
            />
          </Card>
        ) : sortable ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={list.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <div className="flex flex-col gap-2">
                {list.map((t) => <SortableRow key={t.id} task={t} active={t.id === settings.activeTaskId} {...rowProps} />)}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {list.map((t) => <TaskRow key={t.id} task={t} active={t.id === settings.activeTaskId} {...rowProps} />)}
            </AnimatePresence>
          </div>
        )}
        {sortable && list.length > 1 && <p className="text-[11px] text-muted">Tip: drag the handle (or focus it and use Space + arrow keys) to reorder.</p>}
      </div>
    </div>
  );
}
