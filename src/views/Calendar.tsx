import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { Check, ChevronLeft, ChevronRight, Flag, Plus, Repeat, Star, TriangleAlert, Wand2 } from "lucide-react";
import type { CalendarEvent, Occurrence, Task } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { useNow } from "@/lib/ticker";
import { expandEvents, findConflicts, snap } from "@/lib/schedule";
import { formatTime, formatWithZone, KENYA_ZONE, zoneAbbr } from "@/lib/time";
import { Button, Segmented, cx } from "@/components/ui";
import { choose, confirm } from "@/components/Confirm";
import { PRIORITY_META } from "@/components/meta";
import { dueOnDay, isHighPriority, scheduledTasks, taskCalendarState, tasksForDay, unscheduledOpenTasks } from "@/lib/calendarTasks";

type Mode = "day" | "week" | "month";
const HOUR_PX = 52;
const MIN = 60_000;

interface Placed {
  occ: Occurrence;
  top: number;
  height: number;
  col: number;
  cols: number;
}

/** Lay out overlapping blocks side by side within one day column. */
function layoutDay(occ: Occurrence[], dayStart: number, dayEnd: number): Placed[] {
  const items = occ
    .filter((o) => o.end > dayStart && o.start < dayEnd)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const placed: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const n = Math.max(1, ...cluster.map((p) => p.col + 1));
    cluster.forEach((p) => (p.cols = n));
    cluster = [];
  };
  for (const o of items) {
    const s = Math.max(o.start, dayStart);
    const e = Math.min(o.end, dayEnd);
    if (s >= clusterEnd) flush();
    const used = new Set(cluster.filter((p) => p.occ.end > o.start).map((p) => p.col));
    let col = 0;
    while (used.has(col)) col++;
    const p: Placed = { occ: o, top: ((s - dayStart) / 3600_000) * HOUR_PX, height: Math.max(18, ((e - s) / 3600_000) * HOUR_PX - 2), col, cols: 1 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, o.end);
  }
  flush();
  return placed;
}

const DRAG_TYPE = "application/x-nexus";

/** Move a task's due date to another day (same time of day), as when it is dropped there. */
async function moveTaskToDay(taskId: string, day: number, zone: string, hour12: boolean) {
  const s = nexus();
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) return;
  const target = dueOnDay(t, day, zone);
  if (target == null || target === t.dueAt) return;
  await s.updateTask(t.id, { dueAt: target });
  s.toast({ kind: "success", title: "Task rescheduled", body: `${t.title} → ${formatWithZone(target, t.dueTz ?? zone, hour12)}`, ttl: 3000 });
}

/**
 * A To-Do task on the calendar. The tick completes or reopens it, a click opens
 * it for viewing and editing, and it can be dragged to another day.
 * Pending tasks carry their priority colour, overdue ones are red with a warning
 * mark, completed ones are greyed and struck through, and high priority gets a flag.
 */
function TaskChip({ task, now, zone, hour12 }: { task: Task; now: number; zone: string; hour12: boolean }) {
  const state = taskCalendarState(task, now);
  const high = isHighPriority(task);
  const color = state === "done" ? "var(--muted)" : state === "overdue" ? "var(--danger)" : PRIORITY_META[task.priority].color;
  const label = state === "done" ? "Completed" : state === "overdue" ? "Overdue" : "Pending";
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = nexus();
    await s.setTaskDone(task.id, state !== "done");
    if (state !== "done") s.toast({ kind: "success", title: "Completed ✓", body: task.title, action: { label: "Undo", run: () => void nexus().setTaskDone(task.id, false) }, ttl: 5000 });
  };
  return (
    <div
      draggable={state !== "done"}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: "task", id: task.id }));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cx("group flex items-center gap-1 rounded pl-1 pr-1.5 py-0.5 text-[11px] leading-tight min-w-0 shrink-0", state !== "done" && "cursor-grab")}
      style={{ background: `color-mix(in oklab, ${color} ${state === "done" ? 8 : high || state === "overdue" ? 22 : 13}%, transparent)`, borderLeft: `2px solid ${color}` }}
      title={`${label}${high ? ` · ${PRIORITY_META[task.priority].label} priority` : ""} · due ${formatTime(task.dueAt!, zone, hour12)}\n${task.title}\nClick to open · tick to ${state === "done" ? "reopen" : "complete"} · drag to another day to reschedule`}
    >
      <button
        type="button"
        onClick={(e) => void toggle(e)}
        aria-label={state === "done" ? `Reopen “${task.title}”` : `Mark “${task.title}” complete`}
        className={cx("h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center transition-colors", state === "done" ? "bg-success border-success text-white" : "border-current hover:bg-success hover:border-success hover:text-white")}
        style={state === "done" ? undefined : { color }}
      >
        <Check size={9} strokeWidth={3.5} className={cx(state !== "done" && "opacity-0 group-hover:opacity-100")} />
      </button>
      <button type="button" onClick={() => useUI.getState().openTask(task.id)} className="flex items-center gap-1 min-w-0 flex-1 text-left hover:brightness-125" aria-label={`${task.title}, ${label.toLowerCase()}, due ${formatTime(task.dueAt!, zone, hour12)}. Open task`}>
        {state === "overdue" && <TriangleAlert size={10} className="shrink-0 text-danger" aria-hidden />}
        {high && state !== "done" && <Flag size={10} className="shrink-0" style={{ color: PRIORITY_META[task.priority].color }} fill="currentColor" aria-hidden />}
        <span className="tabular shrink-0 text-muted">{formatTime(task.dueAt!, zone, hour12)}</span>
        <span className={cx("truncate", state === "done" ? "line-through text-muted" : state === "overdue" ? "text-danger font-medium" : "text-fg", high && state !== "done" && "font-semibold")}>{task.title}</span>
      </button>
    </div>
  );
}

function Legend() {
  const item = (swatch: React.ReactNode, text: string) => (
    <span className="inline-flex items-center gap-1.5">{swatch}{text}</span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted" aria-label="Task colours">
      <span className="font-medium text-fg-2">Tasks:</span>
      {item(<span className="h-3 w-1 rounded-full" style={{ background: PRIORITY_META.medium.color }} />, "pending (priority colour)")}
      {item(<Flag size={11} style={{ color: PRIORITY_META.high.color }} fill="currentColor" />, "high priority")}
      {item(<TriangleAlert size={11} className="text-danger" />, "overdue")}
      {item(<span className="h-3 w-3 rounded-full bg-success text-white flex items-center justify-center"><Check size={8} strokeWidth={4} /></span>, "completed")}
    </div>
  );
}

async function commitMove(occ: Occurrence, newStart: number, newEnd: number, zone: string, hour12: boolean) {
  const s = nexus();
  if (newStart === occ.start && newEnd === occ.end) return;
  if (occ.event.important) {
    const ok = await confirm({ title: "Move an important appointment?", body: `“${occ.event.title}” → ${formatWithZone(newStart, zone, hour12)}`, confirmLabel: "Move it" });
    if (!ok) return;
  }
  let scope: "single" | "series" = "series";
  if (occ.recurring) {
    const c = await choose({
      title: "Reschedule recurring appointment",
      body: `Move only this occurrence of “${occ.event.title}”, or every occurrence?`,
      choices: [
        { value: "single", label: "Only this one", variant: "soft" },
        { value: "series", label: "Whole series", variant: "primary" },
      ],
    });
    if (!c) return;
    scope = c as "single" | "series";
  }
  const conflicts = findConflicts(s.events, { start: newStart, end: newEnd }, occ.event.id);
  if (conflicts.length) {
    const ok = await confirm({
      title: "Double-booking warning",
      body: `The new time overlaps “${conflicts[0].event.title}”${conflicts.length > 1 ? ` and ${conflicts.length - 1} more` : ""}. Move anyway?`,
      confirmLabel: "Move anyway",
      danger: true,
    });
    if (!ok) return;
  }
  await s.moveOccurrence(occ, newStart, newEnd, scope);
  s.toast({ kind: "success", title: "Rescheduled", body: `${occ.event.title} → ${formatWithZone(newStart, zone, hour12)}`, ttl: 3000 });
}

function TimeGrid({ days, zone, occ, tasks, now, hour12, texasZone }: { days: number[]; zone: string; occ: Occurrence[]; tasks: Task[]; now: number; hour12: boolean; texasZone: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ occ: Occurrence; kind: "move" | "resize"; dy: number; dx: number; x0: number; y0: number } | null>(null);
  const [overDay, setOverDay] = useState<number | null>(null);
  const ui = useUI.getState();

  useEffect(() => {
    const h = DateTime.fromMillis(now, { zone }).hour;
    scrollRef.current?.scrollTo({ top: Math.max(0, (Math.min(h, 8) - 1) * HOUR_PX) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0], zone]);

  const colWidth = () => (colsRef.current ? colsRef.current.clientWidth / days.length : 1);

  const onPointerDown = (e: React.PointerEvent, o: Occurrence, kind: "move" | "resize") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ occ: o, kind, dx: 0, dy: 0, x0: e.clientX, y0: e.clientY });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    setDrag({ ...drag, dx: e.clientX - drag.x0, dy: e.clientY - drag.y0 });
  };
  const deltaFor = (d: NonNullable<typeof drag>) => {
    const minutes = snap((d.dy / HOUR_PX) * 60 * MIN, 15 * MIN);
    const dayShift = d.kind === "move" ? Math.round(d.dx / colWidth()) : 0;
    return { minutes, dayShift };
  };
  const onPointerUp = async () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const moved = Math.abs(d.dx) > 3 || Math.abs(d.dy) > 3;
    if (!moved) {
      ui.openEvent(d.occ.event.id, undefined, d.occ.seriesStart);
      return;
    }
    const { minutes, dayShift } = deltaFor(d);
    if (d.kind === "resize") {
      const end = Math.max(d.occ.start + 15 * MIN, d.occ.end + minutes);
      await commitMove(d.occ, d.occ.start, end, zone, hour12);
    } else {
      const start = DateTime.fromMillis(d.occ.start, { zone }).plus({ days: dayShift }).toMillis() + minutes;
      await commitMove(d.occ, start, start + (d.occ.end - d.occ.start), zone, hour12);
    }
  };

  const createAt = (e: React.MouseEvent, dayStart: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mins = snap(((e.clientY - rect.top) / HOUR_PX) * 60 * MIN, 30 * MIN);
    const start = DateTime.fromMillis(dayStart, { zone }).plus({ milliseconds: mins }).toMillis();
    ui.openEvent(null, { startAt: start, endAt: start + 60 * MIN });
  };

  const nowTop = ((now - DateTime.fromMillis(now, { zone }).startOf("day").toMillis()) / 3600_000) * HOUR_PX;

  return (
    <div className="glass rounded-2xl overflow-hidden flex flex-col min-h-0" style={{ height: "calc(100vh - 220px)" }}>
      {/* header */}
      <div className="flex border-b border-line">
        <div className="w-16 shrink-0" />
        <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
          {days.map((d) => {
            const dt = DateTime.fromMillis(d, { zone });
            const isToday = dt.hasSame(DateTime.fromMillis(now, { zone }), "day");
            const due = tasksForDay(tasks, d, dt.plus({ days: 1 }).toMillis());
            return (
              <div
                key={d}
                className={cx("px-2 py-2 border-l border-line min-w-0 transition-colors", overDay === d && "bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]")}
                onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setOverDay(d); } }}
                onDragLeave={() => setOverDay((o) => (o === d ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverDay(null);
                  const raw = e.dataTransfer.getData(DRAG_TYPE);
                  const data = raw ? (JSON.parse(raw) as { kind: string; id: string }) : null;
                  if (data?.kind === "task") void moveTaskToDay(data.id, d, zone, hour12);
                }}
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11px] uppercase tracking-wider text-muted">{dt.toFormat("ccc")}</span>
                  <span className={cx("text-lg font-semibold font-display leading-none", isToday && "text-accent")}>{dt.toFormat("d")}</span>
                </div>
                {/* Every task due this day; scrolls when there are many. */}
                <div className={cx("flex flex-col gap-0.5 mt-1 overflow-y-auto scroll-y pr-0.5", days.length === 1 ? "max-h-[168px]" : "max-h-[76px]")} aria-label={`Tasks due ${dt.toFormat("cccc d LLLL")}`}>
                  {due.map((t) => <TaskChip key={t.id} task={t} now={now} zone={zone} hour12={hour12} />)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {/* body */}
      <div ref={scrollRef} className="flex-1 scroll-y relative" onPointerMove={onPointerMove} onPointerUp={() => void onPointerUp()}>
        <div className="flex relative" style={{ height: 24 * HOUR_PX }}>
          <div className="w-16 shrink-0 relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] text-muted tabular -translate-y-1/2" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : hour12 ? `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}` : `${String(h).padStart(2, "0")}:00`}
              </div>
            ))}
          </div>
          <div ref={colsRef} className="flex-1 grid relative" style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}>
            {days.map((d) => {
              const dayEnd = DateTime.fromMillis(d, { zone }).plus({ days: 1 }).toMillis();
              const placed = layoutDay(occ, d, dayEnd);
              const isToday = now >= d && now < dayEnd;
              return (
                <div key={d} className="relative border-l border-line" onDoubleClick={(e) => createAt(e, d)} onClick={(e) => e.detail === 1 && e.target === e.currentTarget && createAt(e, d)}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="absolute left-0 right-0 border-t border-line pointer-events-none" style={{ top: h * HOUR_PX, opacity: 0.6 }} />
                  ))}
                  {isToday && (
                    <div className="absolute left-0 right-0 h-[2px] bg-danger z-20 pointer-events-none" style={{ top: nowTop }}>
                      <span className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-danger" />
                    </div>
                  )}
                  {placed.map((p) => {
                    const isDrag = drag?.occ === p.occ;
                    let top = p.top;
                    let height = p.height;
                    let tx = 0;
                    if (isDrag && drag) {
                      const { minutes, dayShift } = deltaFor(drag);
                      if (drag.kind === "move") {
                        top += (minutes / 3600_000) * HOUR_PX;
                        tx = dayShift * colWidth();
                      } else height = Math.max(18, height + (minutes / 3600_000) * HOUR_PX);
                    }
                    const color = p.occ.event.color ?? (p.occ.event.important ? "#f59e0b" : "var(--accent)");
                    return (
                      <div
                        key={p.occ.event.id + p.occ.start}
                        role="button"
                        tabIndex={0}
                        aria-label={`${p.occ.event.title}, ${formatTime(p.occ.start, zone, hour12)} to ${formatTime(p.occ.end, zone, hour12)}`}
                        onKeyDown={(e) => e.key === "Enter" && ui.openEvent(p.occ.event.id, undefined, p.occ.seriesStart)}
                        onPointerDown={(e) => onPointerDown(e, p.occ, "move")}
                        className={cx("absolute rounded-lg border px-1.5 py-1 overflow-hidden cursor-grab select-none text-[11px] leading-tight transition-shadow", isDrag ? "z-30 shadow-2xl cursor-grabbing ring-2 ring-accent" : "z-10 hover:z-20 hover:shadow-lg")}
                        style={{
                          top,
                          height,
                          left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                          width: `calc(${100 / p.cols}% - 4px)`,
                          transform: tx ? `translateX(${tx}px)` : undefined,
                          background: `color-mix(in oklab, ${color} 20%, var(--bg-2))`,
                          borderColor: `color-mix(in oklab, ${color} 50%, transparent)`,
                        }}
                        title={`${p.occ.event.title}\n${formatWithZone(p.occ.start, KENYA_ZONE, hour12)}\n${formatWithZone(p.occ.start, texasZone, hour12)}\nOriginal zone: ${p.occ.event.tz}`}
                      >
                        <div className="font-semibold text-fg truncate flex items-center gap-1">
                          {p.occ.event.important && <Star size={10} className="text-warning shrink-0" fill="currentColor" />}
                          {p.occ.recurring && <Repeat size={10} className="text-muted shrink-0" />}
                          <span className="truncate">{p.occ.event.title}</span>
                        </div>
                        {height > 30 && (
                          <div className="text-fg-2 tabular truncate">
                            {formatTime(p.occ.start, zone, hour12)}–{formatTime(p.occ.end, zone, hour12)}
                          </div>
                        )}
                        {height > 46 && (
                          <div className="text-muted tabular truncate">
                            KE {formatTime(p.occ.start, KENYA_ZONE, hour12)} · TX {formatTime(p.occ.start, texasZone, hour12)}
                          </div>
                        )}
                        <div onPointerDown={(e) => onPointerDown(e, p.occ, "resize")} className="absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize" aria-hidden />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function MonthGrid({ month, zone, events, tasks, now, hour12, onOpenDay }: { month: number; zone: string; events: CalendarEvent[]; tasks: Task[]; now: number; hour12: boolean; onOpenDay: (day: number) => void }) {
  const first = DateTime.fromMillis(month, { zone }).startOf("month");
  const gridStart = first.startOf("week");
  const cells = Array.from({ length: 42 }, (_, i) => gridStart.plus({ days: i }));
  const occ = useMemo(() => expandEvents(events, cells[0].toMillis(), cells[41].plus({ days: 1 }).toMillis()), [events, month, zone]); // eslint-disable-line react-hooks/exhaustive-deps
  const [over, setOver] = useState<string | null>(null);
  const ui = useUI.getState();

  const onDrop = async (e: React.DragEvent, day: DateTime) => {
    e.preventDefault();
    setOver(null);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    const data = JSON.parse(raw) as { kind: "event" | "task"; id: string; start?: number };
    if (data.kind === "event") {
      const o = occ.find((x) => x.event.id === data.id && x.start === data.start);
      if (!o) return;
      const orig = DateTime.fromMillis(o.start, { zone });
      const start = day.set({ hour: orig.hour, minute: orig.minute }).toMillis();
      await commitMove(o, start, start + (o.end - o.start), zone, hour12);
    } else {
      await moveTaskToDay(data.id, day.toMillis(), zone, hour12);
    }
  };

  return (
    <div className="glass rounded-2xl overflow-hidden">
      <div className="grid grid-cols-7 border-b border-line">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-2 py-2 text-[11px] uppercase tracking-wider text-muted">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 grid-rows-6" style={{ height: "calc(100vh - 260px)", minHeight: 480 }}>
        {cells.map((day) => {
          const s0 = day.toMillis();
          const e0 = day.plus({ days: 1 }).toMillis();
          const dayOcc = occ.filter((o) => o.start < e0 && o.end > s0);
          const due = tasksForDay(tasks, s0, e0);
          const inMonth = day.month === first.month;
          const isToday = day.hasSame(DateTime.fromMillis(now, { zone }), "day");
          const key = day.toISODate()!;
          const items: ({ k: string; at: number } & ({ task: Task } | { task?: undefined; label: string; color: string; drag: { kind: string; id: string; start: number }; open: () => void }))[] = [
            ...dayOcc.map((o) => ({ k: `e${o.event.id}${o.start}`, at: o.start, label: o.event.title, color: o.event.important ? "#f59e0b" : "var(--accent)", drag: { kind: "event", id: o.event.id, start: o.start }, open: () => ui.openEvent(o.event.id, undefined, o.seriesStart) })),
            ...due.map((t) => ({ k: `t${t.id}`, at: t.dueAt!, task: t })),
          ].sort((a, b) => a.at - b.at);
          return (
            <div
              key={key}
              onDragOver={(e) => { e.preventDefault(); setOver(key); }}
              onDragLeave={() => setOver((o) => (o === key ? null : o))}
              onDrop={(e) => void onDrop(e, day)}
              onDoubleClick={() => { const st = day.set({ hour: 9 }).toMillis(); ui.openEvent(null, { startAt: st, endAt: st + 3600_000 }); }}
              className={cx("border-l border-t border-line p-1 flex flex-col gap-0.5 min-h-0 overflow-hidden transition-colors", !inMonth && "opacity-45", over === key && "bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]")}
            >
              <span className={cx("text-xs font-semibold h-6 w-6 flex items-center justify-center rounded-full shrink-0", isToday ? "bg-accent text-white" : "text-fg-2")}>{day.day}</span>
              {items.slice(0, items.length > 4 ? 3 : 4).map((it) => it.task ? (
                <TaskChip key={it.k} task={it.task} now={now} zone={zone} hour12={hour12} />
              ) : (
                <button
                  key={it.k}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(it.drag))}
                  onClick={it.open}
                  className="text-left text-[11px] truncate rounded px-1.5 py-0.5 hover:brightness-125 shrink-0"
                  style={{ color: "var(--text)", background: `color-mix(in oklab, ${it.color} 18%, transparent)`, borderLeft: `2px solid ${it.color}` }}
                  title={`${formatTime(it.at, zone, hour12)} ${it.label}`}
                >
                  <span className="text-muted tabular mr-1">{formatTime(it.at, zone, hour12)}</span>
                  {it.label}
                </button>
              ))}
              {items.length > 4 && (
                <button type="button" onClick={() => onOpenDay(s0)} className="text-left text-[10px] text-accent px-1 hover:underline" title="Open this day to see everything">
                  +{items.length - 3} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Calendar() {
  const now = useNow();
  const { events, tasks, settings } = useNexus((s) => ({ events: s.events, tasks: s.tasks, settings: s.settings }));
  const [mode, setMode] = useState<Mode>("week");
  const [anchor, setAnchor] = useState(() => Date.now());
  const zone = settings.calendarDisplayZone === "kenya" ? KENYA_ZONE : settings.calendarDisplayZone === "texas" ? settings.texasZone : settings.homeZone;
  const a = DateTime.fromMillis(anchor, { zone });
  const days =
    mode === "day" ? [a.startOf("day").toMillis()] : Array.from({ length: 7 }, (_, i) => a.startOf("week").plus({ days: i }).toMillis());
  const rangeStart = mode === "month" ? a.startOf("month").startOf("week").toMillis() : days[0];
  const rangeEnd = mode === "month" ? a.endOf("month").endOf("week").toMillis() : DateTime.fromMillis(days[days.length - 1], { zone }).plus({ days: 1 }).toMillis();
  const occ = useMemo(() => expandEvents(events, rangeStart, rangeEnd), [events, rangeStart, rangeEnd]);
  const openTasks = useMemo(() => scheduledTasks(tasks), [tasks]);
  const unscheduled = useMemo(() => unscheduledOpenTasks(tasks).length, [tasks]);
  const step = (dir: number) => setAnchor(a.plus(mode === "day" ? { days: dir } : mode === "week" ? { weeks: dir } : { months: dir }).toMillis());
  const label =
    mode === "day" ? a.toFormat("cccc, d LLLL yyyy") : mode === "week" ? `${DateTime.fromMillis(days[0], { zone }).toFormat("d LLL")} – ${DateTime.fromMillis(days[6], { zone }).toFormat("d LLL yyyy")}` : a.toFormat("LLLL yyyy");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || document.querySelector("[role=dialog]")) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
      if (e.key.toLowerCase() === "t") setAnchor(Date.now());
      if (e.key.toLowerCase() === "d") setMode("day");
      if (e.key.toLowerCase() === "w") setMode("week");
      if (e.key.toLowerCase() === "m") setMode("month");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-semibold">Calendar</h1>
        <div className="flex items-center gap-1 ml-2">
          <Button size="sm" variant="ghost" onClick={() => step(-1)} aria-label="Previous"><ChevronLeft size={16} /></Button>
          <Button size="sm" variant="soft" onClick={() => setAnchor(Date.now())}>Today</Button>
          <Button size="sm" variant="ghost" onClick={() => step(1)} aria-label="Next"><ChevronRight size={16} /></Button>
        </div>
        <span className="text-sm font-medium text-fg-2">{label}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            value={settings.calendarDisplayZone}
            onChange={(v) => void nexus().setSetting("calendarDisplayZone", v)}
            options={[
              { value: "local", label: "Local", title: settings.homeZone },
              { value: "kenya", label: "Kenya EAT", title: KENYA_ZONE },
              { value: "texas", label: `Texas ${zoneAbbr(settings.texasZone, now)}`, title: settings.texasZone },
            ]}
          />
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
          <Button size="sm" variant="outline" icon={<Wand2 size={14} />} onClick={() => useUI.getState().openAutoPlan(true)} title="Fit open tasks into free working time">Auto-plan</Button>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => useUI.getState().openEvent(null)}>New</Button>
        </div>
      </div>
      {mode === "month" ? (
        <MonthGrid month={anchor} zone={zone} events={events} tasks={openTasks} now={now} hour12={settings.hour12} onOpenDay={(d) => { setAnchor(d); setMode("day"); }} />
      ) : (
        <TimeGrid days={days} zone={zone} occ={occ} tasks={openTasks} now={now} hour12={settings.hour12} texasZone={settings.texasZone} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <Legend />
        {unscheduled > 0 && (
          <button type="button" onClick={() => useUI.getState().setView("tasks")} className="text-[11px] text-accent hover:underline">
            {unscheduled} task{unscheduled === 1 ? "" : "s"} without a date {unscheduled === 1 ? "is" : "are"} in the To-Do list →
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted">
        Showing times in <b>{zone}</b>. Tasks from the To-Do list appear on the day they are due: click one to open it, tick it to complete it, drag it to another day to reschedule. Click an empty slot to create an appointment · drag blocks to move · drag the bottom edge to change duration. Keys: ←/→, T, D/W/M.
      </p>
    </div>
  );
}
