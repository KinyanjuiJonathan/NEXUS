import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { CalendarClock, Check, ChevronLeft, ChevronRight, Flag, Globe2, Lock, Plus, Repeat, RotateCcw, Search, Star, TriangleAlert, Wand2 } from "lucide-react";
import type { CalendarEvent, Occurrence, Task } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { useNow } from "@/lib/ticker";
import { expandEvents, findConflicts, snap } from "@/lib/schedule";
import { formatTime, formatWithZone, KENYA_ZONE, zoneAbbr } from "@/lib/time";
import { Button, Input, Segmented, cx } from "@/components/ui";
import { DateTimePicker } from "@/components/DatePicker";
import { occStatus, snapEdge, snapMove, type OccStatus } from "@/lib/calendarSnap";
import { taskTimes } from "@/lib/taskViews";
import { workHours, workWindows, type WorkHours } from "@/lib/workPlan";
import { choose, confirm } from "@/components/Confirm";
import { PRIORITY_META } from "@/components/meta";
import { confirmComplete } from "@/components/complete";
import { AiScheduleButton } from "@/components/AiScheduler";
import { autoBadge, moveHistory } from "@/lib/smart/format";
import { dueOnDay, isHighPriority, scheduledTasks, taskCalendarState, tasksForDay, unscheduledOpenTasks } from "@/lib/calendarTasks";

type Mode = "day" | "week" | "month" | "agenda";
const HOUR_PX = 56;
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
    if (state === "done") await nexus().setTaskDone(task.id, false);
    else await confirmComplete(task.id);
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
      <span className="font-medium text-fg-2 ml-2">Blocks:</span>
      {item(<Lock size={11} className="text-fg-2" />, "fixed appointment")}
      {item(<span className="h-3 w-4 rounded-sm border border-dashed border-accent" />, "flexible")}
      {item(<RotateCcw size={11} className="text-warning" />, "auto-rescheduled")}
    </div>
  );
}

async function commitMove(occ: Occurrence, newStart: number, newEnd: number, zone: string, hour12: boolean) {
  const s = nexus();
  if (newStart === occ.start && newEnd === occ.end) return;
  if (occ.event.fixed && s.settings.smartProtectFixed) {
    const ok = await confirm({ title: "Move a fixed appointment?", body: `“${occ.event.title}” is fixed (Do Not Reschedule). Move it yourself to ${formatWithZone(newStart, zone, hour12)}?`, confirmLabel: "Move it" });
    if (!ok) return;
  } else if (occ.event.important) {
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

type DragKind = "move" | "resize-end" | "resize-start";
interface DragState {
  occ: Occurrence;
  kind: DragKind;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  /** Scroll position when the drag began (the grid may scroll under the pointer). */
  scroll0: number;
  /** Days added by flipping to another week (or day) while dragging. */
  extra: number;
  /** Alt held: no snapping. */
  free: boolean;
  moved: boolean;
}

const STATUS_LABEL: Record<OccStatus, string> = { done: "Completed", overdue: "Overdue", worked: "Time clocked, not marked complete", now: "Under way", past: "Past", upcoming: "Upcoming" };

function TimeGrid({
  days, zone, occ, tasks, allTasks, now, hour12, texasZone, match, onStep, wh,
}: {
  days: number[]; zone: string; occ: Occurrence[]; tasks: Task[]; allTasks: Task[]; now: number; hour12: boolean; texasZone: string;
  match: (o: Occurrence) => boolean; onStep: (dir: number) => void; wh: WorkHours;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const [overDay, setOverDay] = useState<number | null>(null);
  const ui = useUI.getState();
  const byTask = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);

  useEffect(() => {
    if (dragRef.current) return; // do not jump while a block is being carried to another week
    const h = DateTime.fromMillis(now, { zone }).hour;
    scrollRef.current?.scrollTo({ top: Math.max(0, (Math.min(h, 8) - 1) * HOUR_PX) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0], zone]);

  const colWidth = () => (colsRef.current ? colsRef.current.clientWidth / days.length : 1);

  /** Where the dragged block would land right now, and the boundary it snapped to. */
  const preview = (d: DragState): { start: number; end: number; guide: number | null } => {
    const dy = d.dy + ((scrollRef.current?.scrollTop ?? d.scroll0) - d.scroll0);
    const deltaMs = (dy / HOUR_PX) * 3600_000;
    const dur = d.occ.end - d.occ.start;
    const dayShift = d.kind === "move" ? Math.round(d.dx / colWidth()) + d.extra : 0;
    const base = DateTime.fromMillis(d.occ.start, { zone }).plus({ days: dayShift });
    const rawStart = d.kind === "resize-end" ? d.occ.start : base.toMillis() + deltaMs;
    const dayStart = DateTime.fromMillis(d.kind === "move" ? rawStart : d.occ.start, { zone }).startOf("day").toMillis();
    const others = occ.filter((o) => !(o.event.id === d.occ.event.id && o.start === d.occ.start));
    const opts = { boundaries: others.flatMap((o) => [o.start, o.end]), starts: others.map((o) => o.start), ends: others.map((o) => o.end), dayStart, free: d.free };
    if (d.kind === "move") return snapMove(rawStart, dur, opts);
    if (d.kind === "resize-end") {
      const e = snapEdge(d.occ.end + deltaMs, opts);
      return { start: d.occ.start, end: Math.max(d.occ.start + 15 * MIN, e.t), guide: e.guide };
    }
    const st = snapEdge(d.occ.start + deltaMs, opts);
    return { start: Math.min(d.occ.end - 15 * MIN, st.t), end: d.occ.end, guide: st.guide };
  };

  const onPointerDown = (e: React.PointerEvent, o: Occurrence, kind: DragKind) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setDrag({ occ: o, kind, dx: 0, dy: 0, x0: e.clientX, y0: e.clientY, scroll0: scrollRef.current?.scrollTop ?? 0, extra: 0, free: e.altKey, moved: false });
  };

  // While dragging, the pointer is followed on the window: the block's own element can disappear when the week flips.
  const active = !!drag;
  useEffect(() => {
    if (!active) return;
    let edgeTimer: ReturnType<typeof setTimeout> | null = null;
    let edgeDir = 0;
    let pointer = { x: 0, y: 0 };
    const clearEdge = () => {
      if (edgeTimer) clearTimeout(edgeTimer);
      edgeTimer = null;
      edgeDir = 0;
    };
    const armEdge = (dir: number) => {
      if (edgeDir === dir) return;
      clearEdge();
      edgeDir = dir;
      const fire = () => {
        const d = dragRef.current;
        if (!d || d.kind !== "move") return;
        onStep(dir);
        setDrag({ ...d, extra: d.extra + dir * days.length });
        edgeTimer = setTimeout(fire, 900); // keep flipping while the pointer stays at the edge
      };
      edgeTimer = setTimeout(fire, 650);
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      pointer = { x: e.clientX, y: e.clientY };
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;
      setDrag({ ...d, dx, dy, free: e.altKey, moved: d.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3 });
      const r = colsRef.current?.getBoundingClientRect();
      if (r && d.kind === "move" && (d.moved || Math.abs(dx) > 3)) {
        if (e.clientX > r.right - 28) armEdge(1);
        else if (e.clientX < r.left + 28) armEdge(-1);
        else clearEdge();
      }
    };
    const key = (e: KeyboardEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (e.key === "Escape") setDrag(null);
      else if (e.key === "Alt") {
        e.preventDefault();
        setDrag({ ...d, free: e.type === "keydown" });
      }
    };
    // Scroll the day up or down when the block is held near the top or bottom edge.
    const scroller = setInterval(() => {
      const el = scrollRef.current;
      const d = dragRef.current;
      if (!el || !d || !d.moved) return;
      const r = el.getBoundingClientRect();
      const step = pointer.y > r.bottom - 36 ? 14 : pointer.y < r.top + 36 && pointer.y > 0 ? -14 : 0;
      if (step) {
        el.scrollTop += step;
        setDrag({ ...d });
      }
    }, 40);
    const up = () => {
      const d = dragRef.current;
      clearEdge();
      if (!d) return;
      setDrag(null);
      if (!d.moved) {
        ui.openEvent(d.occ.event.id, undefined, d.occ.seriesStart);
        return;
      }
      const p = preview(d);
      void commitMove(d.occ, p.start, p.end, zone, hour12);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    return () => {
      clearEdge();
      clearInterval(scroller);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, days.length, zone, hour12, occ]);

  const createAt = (e: React.MouseEvent, dayStart: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mins = snap(((e.clientY - rect.top) / HOUR_PX) * 60 * MIN, 30 * MIN);
    const start = DateTime.fromMillis(dayStart, { zone }).plus({ milliseconds: mins }).toMillis();
    ui.openEvent(null, { startAt: start, endAt: start + 60 * MIN });
  };

  const nowTop = ((now - DateTime.fromMillis(now, { zone }).startOf("day").toMillis()) / 3600_000) * HOUR_PX;
  const live = drag?.moved ? preview(drag) : null;
  const y = (ms: number, dayStart: number) => ((ms - dayStart) / 3600_000) * HOUR_PX;
  const range = (a: number, b: number) => `${formatTime(a, zone, hour12)} – ${formatTime(b, zone, hour12)}`;
  const working = useMemo(() => workWindows(days[0], DateTime.fromMillis(days[days.length - 1], { zone }).plus({ days: 1 }).toMillis(), wh), [days, zone, wh]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cx("glass rounded-2xl overflow-hidden flex flex-col min-h-0", drag?.moved && "select-none")} style={{ height: "calc(100vh - 250px)", minHeight: 420 }}>
      {/* header */}
      <div className="flex border-b border-line">
        <div className="w-16 shrink-0 flex items-end justify-end pr-2 pb-1.5 text-[9px] uppercase tracking-wider text-muted">{DateTime.fromMillis(days[0], { zone }).toFormat("ZZZZ")}</div>
        <div className="flex-1 grid" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((d) => {
            const dt = DateTime.fromMillis(d, { zone });
            const isToday = dt.hasSame(DateTime.fromMillis(now, { zone }), "day");
            const due = tasksForDay(tasks, d, dt.plus({ days: 1 }).toMillis());
            return (
              <div
                key={d}
                className={cx("px-2 py-2 border-l border-line min-w-0 transition-colors", isToday && "bg-[color-mix(in_oklab,var(--accent)_6%,transparent)]", overDay === d && "bg-[color-mix(in_oklab,var(--accent)_14%,transparent)]")}
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
                <div className="flex items-center gap-2">
                  <span className={cx("text-[11px] uppercase tracking-[0.14em]", isToday ? "text-accent font-semibold" : dt.weekday > 5 ? "text-muted" : "text-fg-2")}>{dt.toFormat("ccc")}</span>
                  <span className={cx("h-7 min-w-7 px-1.5 rounded-full flex items-center justify-center text-[15px] font-semibold font-display leading-none tabular", isToday ? "bg-accent text-white shadow-[0_0_14px_color-mix(in_oklab,var(--accent)_55%,transparent)]" : "text-fg")}>{dt.toFormat("d")}</span>
                </div>
                {/* Every task due this day; scrolls when there are many. */}
                {due.length > 0 && (
                  <div className={cx("flex flex-col gap-0.5 mt-1.5 overflow-y-auto scroll-y pr-0.5", days.length === 1 ? "max-h-[168px]" : "max-h-[64px]")} aria-label={`Tasks due ${dt.toFormat("cccc d LLLL")}`}>
                    {due.map((t) => <TaskChip key={t.id} task={t} now={now} zone={zone} hour12={hour12} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {/* body */}
      <div ref={scrollRef} className="flex-1 scroll-y relative">
        <div className="flex relative" style={{ height: 24 * HOUR_PX }}>
          <div className="w-16 shrink-0 relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-2 text-[10px] text-muted tabular -translate-y-1/2" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : hour12 ? `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}` : `${String(h).padStart(2, "0")}:00`}
              </div>
            ))}
            {live && (() => {
              // the time under the dragged block's top edge, on the hour rail
              const ds = DateTime.fromMillis(drag!.kind === "resize-end" ? live.end : live.start, { zone });
              const top = ((ds.toMillis() - ds.startOf("day").toMillis()) / 3600_000) * HOUR_PX;
              return <div className="absolute right-1 -translate-y-1/2 z-30 rounded-md bg-accent text-white text-[10px] font-semibold tabular px-1.5 py-0.5 shadow-lg" style={{ top }}>{formatTime(ds.toMillis(), zone, hour12)}</div>;
            })()}
          </div>
          <div ref={colsRef} className="flex-1 grid relative" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d) => {
              const dayEnd = DateTime.fromMillis(d, { zone }).plus({ days: 1 }).toMillis();
              const placed = layoutDay(occ, d, dayEnd);
              const isToday = now >= d && now < dayEnd;
              const work = working.filter((w) => w.end > d && w.start < dayEnd);
              const ghost = live && live.end > d && live.start < dayEnd ? live : null;
              const guide = live?.guide != null && live.guide >= d && live.guide <= dayEnd && ghost ? live.guide : null;
              return (
                <div key={d} className={cx("relative border-l border-line", isToday && "bg-[color-mix(in_oklab,var(--accent)_3%,transparent)]")} onDoubleClick={(e) => e.target === e.currentTarget && createAt(e, d)} onClick={(e) => e.detail === 1 && e.target === e.currentTarget && createAt(e, d)}>
                  {/* working time is slightly lit, so the hours tasks are planned in stand out */}
                  {work.map((w) => (
                    <div key={w.start} className="absolute left-0 right-0 pointer-events-none bg-[color-mix(in_oklab,var(--accent)_5%,transparent)] border-y border-[color-mix(in_oklab,var(--accent)_16%,transparent)]" style={{ top: y(Math.max(w.start, d), d), height: y(Math.min(w.end, dayEnd), d) - y(Math.max(w.start, d), d) }} />
                  ))}
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="pointer-events-none">
                      <div className="absolute left-0 right-0 border-t border-line" style={{ top: h * HOUR_PX, opacity: 0.6 }} />
                      <div className="absolute left-0 right-0 border-t border-dashed border-line" style={{ top: (h + 0.5) * HOUR_PX, opacity: 0.25 }} />
                    </div>
                  ))}
                  {isToday && (
                    <div className="absolute left-0 right-0 h-[2px] bg-danger z-20 pointer-events-none" style={{ top: nowTop }}>
                      <span className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-danger" />
                    </div>
                  )}
                  {placed.map((p) => {
                    const isDrag = !!drag?.moved && drag.occ.event.id === p.occ.event.id && drag.occ.start === p.occ.start;
                    const ev = p.occ.event;
                    const status = occStatus(p.occ, ev.taskId ? byTask.get(ev.taskId) : undefined, now);
                    const base = ev.color ?? (ev.important ? "#f59e0b" : "var(--accent)");
                    const color = status === "done" ? "var(--muted)" : status === "overdue" ? "var(--danger)" : status === "now" ? "var(--success)" : base;
                    const fixed = ev.fixed;
                    const badge = autoBadge(ev);
                    const history = moveHistory(ev, hour12);
                    const dim = !match(p.occ);
                    return (
                      <div
                        key={ev.id + p.occ.start}
                        role="button"
                        tabIndex={0}
                        aria-label={`${ev.title}, ${range(p.occ.start, p.occ.end)}, ${STATUS_LABEL[status].toLowerCase()}`}
                        onKeyDown={(e) => e.key === "Enter" && ui.openEvent(ev.id, undefined, p.occ.seriesStart)}
                        onPointerDown={(e) => onPointerDown(e, p.occ, "move")}
                        className={cx(
                          "group/blk absolute rounded-lg border px-1.5 py-1 overflow-hidden cursor-grab select-none text-[11px] leading-tight touch-none",
                          "transition-[top,height,opacity,box-shadow,transform] duration-200 ease-out z-10 hover:z-20 hover:shadow-lg hover:-translate-y-px",
                          isDrag && "opacity-30",
                          dim && "opacity-20 saturate-50",
                          status === "now" && "shadow-[0_0_16px_color-mix(in_oklab,var(--success)_35%,transparent)]",
                        )}
                        style={{
                          top: p.top,
                          height: p.height,
                          left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
                          width: `calc(${100 / p.cols}% - 4px)`,
                          background: `color-mix(in oklab, ${color} ${status === "done" || status === "past" ? 8 : fixed ? 24 : 14}%, var(--bg-2))`,
                          borderColor: `color-mix(in oklab, ${color} ${fixed ? 60 : 45}%, transparent)`,
                          borderLeft: `3px ${fixed ? "solid" : "dashed"} ${color}`,
                          // fixed appointments are solid; flexible blocks are dashed
                          borderStyle: fixed ? "solid" : "dashed",
                        }}
                        title={`${ev.title}\n${STATUS_LABEL[status]} · ${fixed ? "Fixed appointment — never moved automatically" : "Flexible — NEXUS may re-plan it"}\n${formatWithZone(p.occ.start, KENYA_ZONE, hour12)}\n${formatWithZone(p.occ.start, texasZone, hour12)}\nOriginal zone: ${ev.tz}${badge ? `\n${badge.text}${history.length ? `:\n${history.join("\n")}` : ""}` : ""}\nDrag to move (hold Alt for exact minutes) · drag an edge to change its length`}
                      >
                        <div onPointerDown={(e) => onPointerDown(e, p.occ, "resize-start")} className="absolute left-0 right-0 top-0 h-1.5 cursor-ns-resize" aria-hidden />
                        <div className={cx("font-semibold truncate flex items-center gap-1", status === "done" ? "text-muted line-through" : status === "overdue" ? "text-danger" : "text-fg")}>
                          {status === "done" && <Check size={10} className="shrink-0 text-success" strokeWidth={3.5} aria-label="Completed" />}
                          {status === "overdue" && <TriangleAlert size={10} className="shrink-0 text-danger" aria-label="Overdue" />}
                          {fixed && <Lock size={10} className="shrink-0 text-fg-2" aria-label="Fixed appointment" />}
                          {badge && status !== "done" && (badge.attention ? <TriangleAlert size={10} className="shrink-0 text-danger" aria-label={badge.text} /> : <RotateCcw size={10} className="shrink-0 text-warning" aria-label={badge.text} />)}
                          {ev.important && <Star size={10} className="text-warning shrink-0" fill="currentColor" />}
                          {p.occ.recurring && <Repeat size={10} className="text-muted shrink-0" />}
                          <span className="truncate">{ev.title}</span>
                        </div>
                        {p.height > 30 && <div className="text-fg-2 tabular truncate">{range(p.occ.start, p.occ.end)}</div>}
                        {p.height > 46 && (
                          <div className="text-muted tabular truncate">
                            KE {formatTime(p.occ.start, KENYA_ZONE, hour12)} · TX {formatTime(p.occ.start, texasZone, hour12)}
                          </div>
                        )}
                        <div onPointerDown={(e) => onPointerDown(e, p.occ, "resize-end")} className="absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize flex items-end justify-center" aria-hidden>
                          <span className="h-[3px] w-6 rounded-full bg-current opacity-0 group-hover/blk:opacity-40 mb-px" />
                        </div>
                      </div>
                    );
                  })}
                  {/* the block being dragged, where it would land */}
                  {ghost && drag && (
                    <div
                      className="absolute left-0.5 right-0.5 z-30 rounded-lg border-2 border-accent bg-[color-mix(in_oklab,var(--accent)_26%,var(--bg-2))] shadow-[0_10px_30px_rgba(0,0,0,0.5),0_0_18px_color-mix(in_oklab,var(--accent)_45%,transparent)] px-1.5 py-1 text-[11px] leading-tight pointer-events-none overflow-hidden transition-[top,height] duration-75 ease-out"
                      style={{ top: y(Math.max(ghost.start, d), d), height: Math.max(18, y(Math.min(ghost.end, dayEnd), d) - y(Math.max(ghost.start, d), d) - 2) }}
                    >
                      <div className="font-semibold text-fg truncate">{drag.occ.event.title}</div>
                      <div className="text-accent font-semibold tabular truncate">{range(ghost.start, ghost.end)}{drag.free ? " · exact" : ""}</div>
                    </div>
                  )}
                  {guide != null && (
                    <div className="absolute -left-1 -right-1 z-40 pointer-events-none flex items-center" style={{ top: y(guide, d) - 1 }}>
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-2)]" />
                      <span className="flex-1 border-t-2 border-dashed border-[var(--accent-2)]" />
                      <span className="rounded bg-[var(--accent-2)] text-white text-[9px] font-semibold px-1 tabular">{formatTime(guide, zone, hour12)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A plain list: what is overdue, then every day with something on it. */
function AgendaList({ from, zone, events, tasks, allTasks, now, hour12, match, matchTask }: { from: number; zone: string; events: CalendarEvent[]; tasks: Task[]; allTasks: Task[]; now: number; hour12: boolean; match: (o: Occurrence) => boolean; matchTask: (t: Task) => boolean }) {
  const ui = useUI.getState();
  const start = DateTime.fromMillis(from, { zone }).startOf("day");
  const end = start.plus({ days: 30 });
  const byTask = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  const minute = Math.floor(now / 60_000);
  const { groups, overdue } = useMemo(() => {
    const occ = expandEvents(events, start.toMillis(), end.toMillis()).filter(match);
    const groups: { day: DateTime; occ: Occurrence[]; due: Task[] }[] = [];
    for (let d = start; d < end; d = d.plus({ days: 1 })) {
      const s0 = d.toMillis();
      const e0 = d.plus({ days: 1 }).toMillis();
      const dayOcc = occ.filter((o) => o.start >= s0 && o.start < e0);
      const due = tasksForDay(tasks, s0, e0).filter(matchTask);
      if (dayOcc.length || due.length) groups.push({ day: d, occ: dayOcc, due });
    }
    const times = taskTimes(allTasks, events, now);
    const overdue = allTasks.filter((t) => !t.deletedAt && !t.archivedAt && t.status !== "done" && times.get(t.id)?.overdue && matchTask(t));
    return { groups, overdue };
  }, [events, tasks, allTasks, minute, from, zone, match, matchTask]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = DateTime.fromMillis(now, { zone });

  const pill = (status: OccStatus) => {
    const c = status === "done" ? "var(--success)" : status === "overdue" ? "var(--danger)" : status === "now" ? "var(--success)" : status === "worked" ? "var(--warning)" : "var(--muted)";
    return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ color: c, background: `color-mix(in oklab, ${c} 14%, transparent)` }}>{status === "worked" ? "Awaiting completion" : STATUS_LABEL[status]}</span>;
  };

  return (
    <div className="glass rounded-2xl overflow-hidden flex flex-col" style={{ maxHeight: "calc(100vh - 250px)", minHeight: 320 }}>
      <div className="flex-1 scroll-y p-3 flex flex-col gap-4">
        {overdue.length > 0 && (
          <section>
            <h3 className="text-[11px] uppercase tracking-[0.14em] font-semibold text-danger mb-1.5 flex items-center gap-1.5"><TriangleAlert size={12} /> Overdue · {overdue.length}</h3>
            <div className="flex flex-col gap-1">
              {overdue.map((t) => (
                <div key={t.id} className="flex items-center gap-2.5 rounded-xl border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)] px-3 py-1.5">
                  <button type="button" onClick={() => void confirmComplete(t.id)} aria-label={`Mark “${t.title}” complete`} className="h-4 w-4 shrink-0 rounded-full border border-danger hover:bg-success hover:border-success transition-colors" />
                  <button type="button" className="min-w-0 flex-1 text-left text-sm font-medium truncate hover:text-accent" onClick={() => ui.openTask(t.id)}>{t.title}</button>
                  <Button size="sm" variant="soft" onClick={() => ui.openReschedule({ kind: "task", id: t.id, title: t.title, at: t.dueAt ?? now, durationMs: (t.estimateMin ?? 30) * MIN, important: t.priority === "critical", taskId: t.id })}>Reschedule</Button>
                </div>
              ))}
            </div>
          </section>
        )}
        {groups.length === 0 && overdue.length === 0 && <p className="text-sm text-muted px-2 py-6 text-center">Nothing scheduled in the 30 days from {start.toFormat("d LLL")}.</p>}
        {groups.map((g) => {
          const isToday = g.day.hasSame(today, "day");
          return (
            <section key={g.day.toISODate()} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3">
              <div className="pt-1">
                <div className={cx("text-[11px] uppercase tracking-[0.14em]", isToday ? "text-accent font-semibold" : "text-muted")}>{isToday ? "Today" : g.day.hasSame(today.plus({ days: 1 }), "day") ? "Tomorrow" : g.day.toFormat("cccc")}</div>
                <div className="text-lg font-semibold font-display leading-tight">{g.day.toFormat("d LLL")}</div>
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                {g.due.map((t) => <TaskChip key={t.id} task={t} now={now} zone={zone} hour12={hour12} />)}
                {g.occ.map((o) => {
                  const task = o.event.taskId ? byTask.get(o.event.taskId) : undefined;
                  const status = occStatus(o, task, now);
                  const color = status === "done" ? "var(--muted)" : status === "overdue" ? "var(--danger)" : status === "now" ? "var(--success)" : o.event.color ?? "var(--accent)";
                  return (
                    <div key={o.event.id + o.start} className="group flex items-center gap-2.5 rounded-xl border border-line px-3 py-1.5 min-w-0 hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] transition-colors" style={{ borderLeft: `3px ${o.event.fixed ? "solid" : "dashed"} ${color}` }}>
                      <span className="w-[124px] shrink-0 text-[11px] tabular text-fg-2">{formatTime(o.start, zone, hour12)} – {formatTime(o.end, zone, hour12)}</span>
                      {o.event.fixed ? <Lock size={12} className="shrink-0 text-fg-2" aria-label="Fixed appointment" /> : <CalendarClock size={12} className="shrink-0 text-accent" aria-label="Flexible task" />}
                      <button type="button" className={cx("min-w-0 flex-1 text-left text-sm font-medium truncate hover:text-accent", status === "done" && "line-through text-muted")} onClick={() => ui.openEvent(o.event.id, undefined, o.seriesStart)}>{o.event.title}</button>
                      {pill(status)}
                      {task && task.status !== "done" && (
                        <button type="button" onClick={() => void confirmComplete(task.id)} title="Mark the task complete" aria-label={`Mark “${task.title}” complete`} className="h-6 w-6 shrink-0 rounded-lg flex items-center justify-center text-muted hover:text-success hover:bg-hover opacity-0 group-hover:opacity-100 focus:opacity-100 transition"><Check size={14} /></button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
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
          const items: ({ k: string; at: number } & ({ task: Task } | { task?: undefined; label: string; fixed: boolean; moved: boolean; color: string; drag: { kind: string; id: string; start: number }; open: () => void }))[] = [
            ...dayOcc.map((o) => ({ k: `e${o.event.id}${o.start}`, at: o.start, label: o.event.title, fixed: o.event.fixed, moved: !!autoBadge(o.event), color: o.event.color ?? (o.event.important ? "#f59e0b" : "var(--accent)"), drag: { kind: "event", id: o.event.id, start: o.start }, open: () => ui.openEvent(o.event.id, undefined, o.seriesStart) })),
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
                  style={{ color: "var(--text)", background: `color-mix(in oklab, ${it.color} 18%, transparent)`, borderLeft: `2px ${it.fixed ? "solid" : "dashed"} ${it.color}` }}
                  title={`${formatTime(it.at, zone, hour12)} ${it.label} — ${it.fixed ? "fixed appointment" : "flexible"}${it.moved ? ", auto-rescheduled" : ""}`}
                >
                  {it.fixed && <Lock size={9} className="inline mr-1 -mt-0.5 text-fg-2" aria-label="Fixed" />}
                  {it.moved && <RotateCcw size={9} className="inline mr-1 -mt-0.5 text-warning" aria-label="Auto-rescheduled" />}
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

type Kind = "all" | "tasks" | "fixed" | "overdue" | "done";
const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tasks", label: "Tasks" },
  { id: "fixed", label: "Appointments" },
  { id: "overdue", label: "Overdue" },
  { id: "done", label: "Completed" },
];

export default function Calendar() {
  const now = useNow();
  const { events, tasks, settings } = useNexus((s) => ({ events: s.events, tasks: s.tasks, settings: s.settings }));
  const [mode, setMode] = useState<Mode>("week");
  const [anchor, setAnchor] = useState(() => Date.now());
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const zone = settings.calendarDisplayZone === "kenya" ? KENYA_ZONE : settings.calendarDisplayZone === "texas" ? settings.texasZone : settings.homeZone;
  const a = DateTime.fromMillis(anchor, { zone });
  const days =
    mode === "day" ? [a.startOf("day").toMillis()] : Array.from({ length: 7 }, (_, i) => a.startOf("week").plus({ days: i }).toMillis());
  const rangeStart = mode === "month" ? a.startOf("month").startOf("week").toMillis() : days[0];
  const rangeEnd = mode === "month" ? a.endOf("month").endOf("week").toMillis() : DateTime.fromMillis(days[days.length - 1], { zone }).plus({ days: 1 }).toMillis();
  const occ = useMemo(() => expandEvents(events, rangeStart, rangeEnd), [events, rangeStart, rangeEnd]);
  const openTasks = useMemo(() => scheduledTasks(tasks), [tasks]);
  const unscheduled = useMemo(() => unscheduledOpenTasks(tasks).length, [tasks]);
  const wh = useMemo(() => workHours(settings), [settings]);
  const step = (dir: number) => setAnchor((cur) => DateTime.fromMillis(cur, { zone }).plus(mode === "day" ? { days: dir } : mode === "week" ? { weeks: dir } : mode === "month" ? { months: dir } : { days: 14 * dir }).toMillis());
  const label =
    mode === "day" ? a.toFormat("cccc, d LLLL yyyy") : mode === "week" ? `${DateTime.fromMillis(days[0], { zone }).toFormat("d LLL")} – ${DateTime.fromMillis(days[6], { zone }).toFormat("d LLL yyyy")}` : mode === "month" ? a.toFormat("LLLL yyyy") : `From ${a.toFormat("d LLL yyyy")}`;

  // Search and the filter chips: blocks that do not match are dimmed in the grids and left out of the agenda.
  const needle = q.trim().toLowerCase();
  const minute = Math.floor(now / 60_000);
  const byTask = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const match = useMemo(
    () => (o: Occurrence) => {
      const task = o.event.taskId ? byTask.get(o.event.taskId) : undefined;
      if (needle && !`${o.event.title} ${o.event.notes} ${task?.notes ?? ""}`.toLowerCase().includes(needle)) return false;
      if (kind === "all") return true;
      const st = occStatus(o, task, now);
      return kind === "tasks" ? !!o.event.taskId : kind === "fixed" ? o.event.fixed : kind === "overdue" ? st === "overdue" : st === "done";
    },
    [needle, kind, byTask, minute], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const matchTask = useMemo(
    () => (t: Task) => {
      if (needle && !`${t.title} ${t.notes}`.toLowerCase().includes(needle)) return false;
      if (kind === "all" || kind === "tasks") return true;
      const st = taskCalendarState(t, now);
      return kind === "overdue" ? st === "overdue" : kind === "done" ? st === "done" : false;
    },
    [needle, kind, minute], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const shownTasks = useMemo(() => openTasks.filter(matchTask), [openTasks, matchTask]);
  const filtering = !!needle || kind !== "all";
  const hits = useMemo(() => (filtering ? occ.filter(match).length + shownTasks.filter((t) => t.dueAt! >= rangeStart && t.dueAt! < rangeEnd).length : 0), [filtering, occ, match, shownTasks, rangeStart, rangeEnd]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || document.querySelector("[role=dialog]")) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
      if (e.key.toLowerCase() === "t") setAnchor(Date.now());
      if (e.key.toLowerCase() === "d") setMode("day");
      if (e.key.toLowerCase() === "w") setMode("week");
      if (e.key.toLowerCase() === "m") setMode("month");
      if (e.key.toLowerCase() === "a") setMode("agenda");
      if (e.key === "/") {
        e.preventDefault();
        document.getElementById("cal-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="font-display text-2xl font-semibold">Calendar</h1>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => step(-1)} aria-label="Previous"><ChevronLeft size={16} /></Button>
          <Button size="sm" variant="soft" onClick={() => setAnchor(Date.now())}>Today</Button>
          <Button size="sm" variant="ghost" onClick={() => step(1)} aria-label="Next"><ChevronRight size={16} /></Button>
        </div>
        <DateTimePicker value={anchor} zone={zone} hour12={settings.hour12} withTime={false} onChange={(ms) => ms != null && setAnchor(ms)} ariaLabel="Go to a date" className="!h-8 !border-transparent !bg-transparent hover:!bg-hover font-medium" format={() => label} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "agenda", label: "Agenda" }]} />
          <Button size="sm" variant="outline" icon={<Wand2 size={14} />} onClick={() => useUI.getState().openAutoPlan(true)} title="Fit open tasks into free working time">Auto-plan</Button>
          <Button size="sm" variant="outline" icon={<CalendarClock size={14} />} onClick={() => useUI.getState().openRescheduleAll(true)} title="Move every open task to a later date or time">Reschedule all</Button>
          <AiScheduleButton size="sm" />
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => useUI.getState().openEvent(null)}>New</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input id="cal-search" placeholder="Search the calendar  ( / )" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 !h-8" aria-label="Search the calendar" />
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Show">
          {KINDS.map((k) => (
            <button key={k.id} type="button" aria-pressed={kind === k.id} onClick={() => setKind(k.id)} className={cx("h-8 px-2.5 rounded-lg text-xs font-medium border transition", kind === k.id ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-muted hover:text-fg")}>
              {k.label}
            </button>
          ))}
        </div>
        {filtering && <span className="text-[11px] text-muted tabular">{hits} match{hits === 1 ? "" : "es"} in view</span>}
        <div className="ml-auto flex items-center gap-2">
          <Segmented
            size="sm"
            value={settings.calendarDisplayZone}
            onChange={(v) => void nexus().setSetting("calendarDisplayZone", v)}
            options={[
              { value: "local", label: settings.homeZone.split("/").pop()!.replace(/_/g, " "), title: `Your scheduling zone: ${settings.homeZone}` },
              { value: "kenya", label: "Kenya EAT", title: KENYA_ZONE },
              { value: "texas", label: `Texas ${zoneAbbr(settings.texasZone, now)}`, title: settings.texasZone },
            ]}
          />
          <Button size="sm" variant="ghost" icon={<Globe2 size={14} />} onClick={() => useUI.getState().openTimeHours(true)} title="Time zone & working hours">Hours</Button>
        </div>
      </div>
      {mode === "month" ? (
        <MonthGrid month={anchor} zone={zone} events={filtering ? events.filter((e) => expandEvents([e], rangeStart, rangeEnd).some(match)) : events} tasks={shownTasks} now={now} hour12={settings.hour12} onOpenDay={(d) => { setAnchor(d); setMode("day"); }} />
      ) : mode === "agenda" ? (
        <AgendaList from={anchor} zone={zone} events={events} tasks={shownTasks} allTasks={tasks} now={now} hour12={settings.hour12} match={match} matchTask={matchTask} />
      ) : (
        <TimeGrid days={days} zone={zone} occ={occ} tasks={shownTasks} allTasks={tasks} now={now} hour12={settings.hour12} texasZone={settings.texasZone} match={match} onStep={step} wh={wh} />
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
        Times in <b>{zone}</b>; lit bands are your working hours. Drag a block to move it, to another day, or hold it at the left or right edge to carry it to another week. It snaps to neighbouring blocks and quarter hours (hold <b>Alt</b> for exact minutes); drag its top or bottom edge to change its length; Esc cancels. Click an empty slot to add. Keys: ←/→, T, D/W/M/A, /.
      </p>
    </div>
  );
}
