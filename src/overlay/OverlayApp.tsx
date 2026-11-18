import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CalendarCheck, CalendarClock, Check, CheckCircle2, Flag, Lock, RotateCcw, ChevronDown, Expand, LogIn, LogOut, Mic, MousePointerClick, Pause, Pin, PinOff, Play, Plus, Shrink, X } from "lucide-react";
import { useWorkClock } from "@/components/WorkClock";
import type { OverlayMode, PerfMetric, ReminderItem } from "@/data/types";
import { useNexus, nexus, getBackend } from "@/store";
import { useNow } from "@/lib/ticker";
import { useTheme } from "@/lib/useTheme";
import { clockFor, KENYA_ZONE, formatTime } from "@/lib/time";
import { deadlineInfo, elapsedMs, formatClock, humanDuration, progress, remainingMs } from "@/lib/countdown";
import { findMissed } from "@/lib/schedule";
import { agenda, untilLabel, type AgendaItem } from "@/lib/smart/agenda";
import { dayLabel } from "@/lib/smart/format";
import { openTasks, scoreTask } from "@/lib/assistant";
import { parseCommand } from "@/lib/voice/parser";
import { clampOpacity, ensureVisible, nextMode, sizeForMode } from "@/lib/overlayGeometry";
import { getOverlayState, listenTo, native, onOverlayState, playChime, setClickThrough, setOverlayVisible, setPinned, type OverlayState } from "@/lib/platform";
import { CommandPanel } from "@/components/CommandBar";
import { PerfStrip } from "./PerfStrip";
import { PerfGraph } from "@/components/PerfGraph";
import { AiMaverix, Flags, PoweredBy } from "@/components/Brand";
import { availableMetrics, usePerf, usePerfHistory } from "@/lib/perf";
import { Toasts } from "@/components/Toasts";
import { ProgressBar, cx } from "@/components/ui";
import { URGENCY_COLOR } from "@/components/meta";

/** Show the main window and open something there. */
async function openInMain(event: "nexus://quick-add" | "nexus://voice" | null) {
  if (!native) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const { emitTo } = await import("@tauri-apps/api/event");
  const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
  const main = (await getAllWebviewWindows()).find((w) => w.label === "main");
  await main?.show();
  await main?.unminimize();
  await main?.setFocus();
  if (event) await emitTo("main", event, null);
  void invoke;
}

function MiniClock({ zone, tag, hour12, color }: { zone: string; tag: string; hour12: boolean; color: string }) {
  const now = useNow();
  const c = clockFor(zone, now, hour12);
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-bold tracking-widest" style={{ color }}>{tag}</span>
        <span className="text-[9px] text-muted">{c.abbr} · {c.weekday.slice(0, 3)} {c.date.split(" ").slice(0, 2).join(" ")}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-display tabular text-[24px] leading-none font-light text-fg">{c.time}</span>
        <span className="font-mono tabular text-[11px] text-muted">{c.seconds}</span>
        {c.meridiem && <span className="text-[10px] font-semibold text-fg-2">{c.meridiem}</span>}
      </div>
    </div>
  );
}

function Btn({ label, onClick, active, children, className }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cx("h-6 w-6 rounded-md flex items-center justify-center transition shrink-0", active ? "text-accent bg-[color-mix(in_oklab,var(--accent)_18%,transparent)]" : "text-muted hover:text-fg hover:bg-hover", className)}>
      {children}
    </button>
  );
}

export default function OverlayApp() {
  const now = useNow();
  const { tasks, events, timers, settings } = useNexus((s) => ({ tasks: s.tasks, events: s.events, timers: s.timers, settings: s.settings }));
  const [ov, setOv] = useState<OverlayState>({ visible: true, clickThrough: false, pinned: true });
  const [mode, setMode] = useState<OverlayMode>(settings.overlayMode);
  const [voice, setVoice] = useState(false);
  const [quick, setQuick] = useState("");
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useTheme(settings.theme, true);
  const perfOn = settings.overlayPerf;
  const allowCT = settings.overlayAllowClickThrough;
  const perf = usePerf(perfOn && (ov.visible || !native), settings.overlayFps);
  const perfHistory = usePerfHistory();
  const graphOn = perfOn && settings.overlayGraph;
  const graphMetrics = availableMetrics(perf, settings.overlayFps, settings.overlayTemp);
  /** Clicking a stat graphs it; clicking the one already graphed closes the graph. */
  const pickMetric = (m: PerfMetric) => {
    if (graphOn && settings.perfGraphMetric === m) return void nexus().setSetting("overlayGraph", false);
    void nexus().setSetting("perfGraphMetric", m);
    if (!settings.overlayGraph) void nexus().setSetting("overlayGraph", true);
  };
  const work = useWorkClock();
  // Completing always asks first, here too: the question covers the overlay until answered.
  const [confirming, setConfirming] = useState<{ id: string; title: string } | null>(null);
  const [completing, setCompleting] = useState(false);
  const completeTask = (id: string, title: string) => setConfirming({ id, title });
  const confirmCompletion = async () => {
    if (!confirming || completing) return;
    setCompleting(true);
    const { id, title } = confirming;
    try {
      await nexus().setTaskDone(id, true);
      nexus().toast({ kind: "success", title: "Completed ✓", body: title, action: { label: "Undo", run: () => void nexus().setTaskDone(id, false) }, ttl: 6000 });
    } finally {
      setCompleting(false);
      setConfirming(null);
    }
  };
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setConfirming(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  // Sync with the native window state & other windows.
  useEffect(() => {
    const offs: (() => void)[] = [];
    void getOverlayState().then(setOv);
    void onOverlayState(setOv).then((u) => offs.push(u));
    offs.push(getBackend().onDataChanged(() => void nexus().reload()));
    offs.push(
      getBackend().onReminder((r: ReminderItem) => {
        if (settings.notificationSound) playChime();
        nexus().toast({ kind: "reminder", title: r.title, body: r.body, reminder: r, ttl: 60_000 });
      }),
    );
    void listenTo("nexus://voice", () => {
      setVoice(true);
      setMode((m) => (m === "mini" ? "standard" : m));
    }).then((u) => offs.push(u));
    return () => offs.forEach((o) => o());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow mode changes made from the main window's settings.
  useEffect(() => setMode(settings.overlayMode), [settings.overlayMode]);

  // Apply size for the mode, keep the window on a connected monitor, and remember resizes.
  useEffect(() => {
    if (!native) return;
    let off: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow, availableMonitors, primaryMonitor, PhysicalPosition, LogicalSize } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      const size = sizeForMode(mode, nexus().settings.overlaySizes, nexus().settings.overlayPerf, nexus().settings.overlayGraph);
      await w.setSize(new LogicalSize(size.w, size.h));
      const [pos, outer, mons, prim, scale] = await Promise.all([w.outerPosition(), w.outerSize(), availableMonitors(), primaryMonitor(), w.scaleFactor()]);
      const rects = mons.map((m) => ({ x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height }));
      const primaryIndex = prim ? Math.max(0, mons.findIndex((m) => m.name === prim.name)) : 0;
      const fixed = ensureVisible({ x: pos.x, y: pos.y, w: outer.width, h: outer.height }, rects, primaryIndex, Math.round(16 * scale));
      if (fixed.x !== pos.x || fixed.y !== pos.y) await w.setPosition(new PhysicalPosition(fixed.x, fixed.y));
      off = await w.onResized(({ payload }) => {
        if (resizeTimer.current) clearTimeout(resizeTimer.current);
        resizeTimer.current = setTimeout(async () => {
          const sf = await w.scaleFactor();
          const logical = { w: Math.round(payload.width / sf), h: Math.round(payload.height / sf) };
          const cur = sizeForMode(modeRef.current, nexus().settings.overlaySizes, nexus().settings.overlayPerf, nexus().settings.overlayGraph);
          if (Math.abs(cur.w - logical.w) > 2 || Math.abs(cur.h - logical.h) > 2) {
            await nexus().setSetting("overlaySizes", { ...nexus().settings.overlaySizes, [modeRef.current]: logical });
          }
        }, 400);
      });
    })();
    return () => off?.();
  }, [mode, perfOn, graphOn]);

  const switchMode = (m: OverlayMode) => {
    setMode(m);
    void nexus().setSetting("overlayMode", m);
  };

  const startResize = async () => {
    if (!native) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startResizeDragging("SouthEast");
  };

  const timer = timers.find((t) => t.state === "running") ?? timers.find((t) => t.state === "paused") ?? null;
  const active = tasks.find((t) => t.id === settings.activeTaskId && !t.deletedAt) ?? null;
  const minute = Math.floor(now / 60_000);
  // The same tasks and calendar entries every other screen reads: an entry goes the moment
  // its task or appointment is deleted, cancelled or completed, in whichever window that happens.
  const schedule = useMemo(() => agenda(tasks, events, now, { limit: 6 }), [tasks, events, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = useMemo(() => openTasks(tasks).sort((a, b) => scoreTask(b, now) - scoreTask(a, now)).slice(0, 8), [tasks, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const missed = useMemo(() => findMissed(tasks, events, now).length, [tasks, events, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneToday = useMemo(
    () => tasks.filter((t) => t.status === "done" && !t.deletedAt && t.completedAt != null && t.completedAt >= work.dayStart).sort((a, b) => b.completedAt! - a.completedAt!),
    [tasks, work.dayStart],
  );
  const next = schedule.find((i) => i.status !== "overdue") ?? null;
  const overdueCount = schedule.filter((i) => i.status === "overdue").length;
  const itemColor = (i: AgendaItem) => (i.status === "overdue" ? "var(--danger)" : i.status === "now" ? "var(--success)" : i.start - now < 3600_000 ? "var(--warning)" : "var(--muted)");
  const itemIcon = (i: AgendaItem, size = 11) =>
    i.kind === "fixed" ? <Lock size={size} className="shrink-0 text-accent-2" aria-label="Fixed appointment" /> : i.kind === "deadline" ? <Flag size={size} className="shrink-0 text-warning" aria-label="Due" /> : <CalendarCheck size={size} className="shrink-0 text-accent" aria-label="Flexible task" />;
  const itemWhen = (i: AgendaItem) => {
    const zone = settings.homeZone;
    const day = dayLabel(i.start, zone, now);
    return `${day === "Today" ? "" : `${day} `}${formatTime(i.start, zone, settings.hour12)}`;
  };
  const s = nexus();
  const opacity = clampOpacity(settings.overlayOpacity);

  const timerValue = timer ? (timer.kind === "stopwatch" ? elapsedMs(timer, now) : remainingMs(timer, now)) : 0;
  const activeDl = active ? deadlineInfo(active.dueAt, now, settings.deadlineWarningMin) : null;
  const subProgress = active && active.subtasks.length ? active.subtasks.filter((x) => x.done).length / active.subtasks.length : null;

  const quickAdd = async () => {
    const t = quick.trim();
    if (!t) return;
    const p = parseCommand(/^(add|create|remind)/i.test(t) ? t : `add ${t}`, { now: Date.now(), homeZone: settings.homeZone, texasZone: settings.texasZone });
    if (p.intent.type === "add_task") {
      await s.addTask({ title: p.intent.title, dueAt: p.intent.dueAt, dueTz: p.intent.tz, estimateMin: p.intent.estimateMin, priority: p.intent.priority ?? undefined, categoryId: p.intent.categoryId ?? undefined, reminders: p.intent.reminderAtTime ? [0] : undefined });
    } else await s.addTask({ title: t });
    s.toast({ kind: "success", title: "Task added", body: p.intent.type === "add_task" ? p.intent.title : t, ttl: 2500 });
    setQuick("");
  };

  const Header = (
    <div data-tauri-drag-region className="drag-region flex items-center gap-1 h-7 px-2 shrink-0">
      <span data-tauri-drag-region className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-violet-500" />
      <span data-tauri-drag-region className="text-[10px] font-bold tracking-[0.3em] text-gradient">NEXUS</span>
      <AiMaverix className="text-[8px] pointer-events-none" />
      <Flags height={8} className="pointer-events-none mr-auto opacity-90" />
      <div className="no-drag flex items-center gap-0.5">
        {ov.clickThrough && <span className="text-[9px] text-accent mr-1">CLICK-THROUGH</span>}
        {perfOn && (
          <Btn label={graphOn ? "Hide the live performance graph" : "Show a live performance graph"} active={graphOn} onClick={() => void nexus().setSetting("overlayGraph", !settings.overlayGraph)}>
            <Activity size={12} />
          </Btn>
        )}
        <Btn label={ov.pinned ? "Unpin (stop staying on top)" : "Pin on top"} active={ov.pinned} onClick={() => void setPinned(!ov.pinned)}>
          {ov.pinned ? <Pin size={12} /> : <PinOff size={12} />}
        </Btn>
        {allowCT && (
          <Btn label={`Click-through (${settings.shortcuts.toggleClickThrough.replace("CommandOrControl", "Ctrl")} to undo)`} active={ov.clickThrough} onClick={() => void setClickThrough(!ov.clickThrough)}>
            <MousePointerClick size={12} />
          </Btn>
        )}
        <Btn label={mode === "expanded" ? "Collapse to mini" : "Expand"} onClick={() => switchMode(nextMode(mode))}>
          {mode === "expanded" ? <Shrink size={12} /> : <Expand size={12} />}
        </Btn>
        <Btn label="Hide overlay (to tray)" onClick={() => void setOverlayVisible(false)} className="hover:!text-danger">
          <X size={13} />
        </Btn>
      </div>
    </div>
  );

  const TimerLine = (
    <div className="flex items-center gap-2 min-w-0">
      {timer ? (
        <>
          <button aria-label={timer.state === "running" ? "Pause" : "Resume"} onClick={() => void (timer.state === "running" ? s.pauseTimer(timer.id) : s.resumeTimer(timer.id))} className="no-drag h-7 w-7 shrink-0 rounded-full flex items-center justify-center bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-accent hover:brightness-125">
            {timer.state === "running" ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <span className={cx("font-mono tabular font-semibold text-fg", mode === "mini" ? "text-[20px]" : "text-[22px]")}>{formatClock(timerValue)}</span>
        </>
      ) : (
        <button aria-label="Start focus session" onClick={() => void s.startTimer({ kind: "pomodoro", taskId: active?.id ?? null })} className="no-drag h-7 px-2.5 shrink-0 rounded-full flex items-center gap-1 text-[11px] font-medium bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-accent hover:brightness-125">
          <Play size={12} /> Focus {settings.pomodoroFocusMin}m
        </button>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-fg truncate">{active?.title ?? timer?.label ?? "No active task"}</p>
        <p className="text-[10px] truncate" style={{ color: activeDl ? URGENCY_COLOR[activeDl.urgency] : "var(--muted)" }}>
          {timer ? `${timer.kind === "stopwatch" ? "elapsed" : timer.state === "paused" ? "paused" : "remaining"}${activeDl && activeDl.urgency !== "none" ? ` · ${activeDl.label}` : ""}` : activeDl && activeDl.urgency !== "none" ? activeDl.label : "Pick a task with ▶ in NEXUS"}
        </p>
      </div>
      {active && active.status !== "done" && (
        <button
          aria-label={`Mark “${active.title}” complete`}
          title="Mark the active task complete"
          onClick={() => completeTask(active.id, active.title)}
          className="no-drag h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-success bg-[color-mix(in_oklab,var(--success)_16%,transparent)] hover:bg-success hover:text-white transition"
        >
          <Check size={14} strokeWidth={3} />
        </button>
      )}
    </div>
  );

  return (
    <div
      className={cx("h-screen w-screen overflow-hidden rounded-[14px] border border-line-strong flex flex-col text-fg", ov.clickThrough && "ring-1 ring-accent/40")}
      style={{ background: `rgba(var(--overlay-bg), ${opacity})`, backdropFilter: opacity < 1 ? "blur(10px)" : undefined }}
      onDoubleClick={(e) => (e.target as HTMLElement).dataset.tauriDragRegion !== undefined && switchMode(nextMode(mode))}
    >
      {mode === "mini" ? (
        <div data-tauri-drag-region className="drag-region flex-1 flex flex-col justify-center gap-1 px-2.5">
          <div data-tauri-drag-region className="flex items-center gap-2">
            <div className="no-drag flex-1 min-w-0">{TimerLine}</div>
            <div className="no-drag flex items-center">
              <Btn label="Expand" onClick={() => switchMode("standard")}><ChevronDown size={13} /></Btn>
              <Btn label="Hide overlay" onClick={() => void setOverlayVisible(false)}><X size={12} /></Btn>
            </div>
          </div>
          {perfOn && <PerfStrip snap={perf} compact showFps={settings.overlayFps} showTemp={settings.overlayTemp} unit={settings.tempUnit} thresholds={settings.perfThresholds} />}
          {work.active && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted">
              <span className={cx("h-1.5 w-1.5 rounded-full", work.pause ? "bg-warning" : "bg-success")} />
              <span className="font-mono tabular text-fg-2">{formatClock(work.sessionMs)}</span> {work.pause ? "paused" : "clocked in"}
            </div>
          )}
        </div>
      ) : (
        <>
          {Header}
          <div className="flex-1 min-h-0 flex flex-col gap-2 px-3 pb-3 overflow-hidden">
            <div className="flex gap-3">
              <MiniClock zone={KENYA_ZONE} tag="KENYA" hour12={settings.hour12} color="#22d3ee" />
              <div className="w-px bg-line" />
              <MiniClock zone={settings.texasZone} tag={settings.texasZone === "America/Denver" ? "EL PASO" : "TEXAS"} hour12={settings.hour12} color="#a78bfa" />
            </div>
            {perfOn && <PerfStrip snap={perf} showFps={settings.overlayFps} showTemp={settings.overlayTemp} unit={settings.tempUnit} picked={graphOn ? settings.perfGraphMetric : null} onPick={pickMetric} thresholds={settings.perfThresholds} />}
            {graphOn && <PerfGraph history={perfHistory} metric={settings.perfGraphMetric} metrics={graphMetrics} onMetric={(m) => void nexus().setSetting("perfGraphMetric", m)} unit={settings.tempUnit} height={50} className="shrink-0" thresholds={settings.perfThresholds} />}
            <div className="rounded-xl bg-hover px-2.5 py-2">
              {TimerLine}
              {timer && timer.kind !== "stopwatch" && <ProgressBar value={progress(timer, now)} className="mt-1.5 !h-1" />}
              {!timer && subProgress != null && <ProgressBar value={subProgress} className="mt-1.5 !h-1" />}
            </div>
            {next && (
              <div className="flex items-center gap-2 text-[11px] min-w-0" title={`${next.kind === "fixed" ? "Fixed appointment" : next.kind === "deadline" ? "Due" : "Flexible task"} · ${itemWhen(next)}`}>
                {itemIcon(next, 12)}
                <span className="truncate text-fg-2 flex-1">{next.title}</span>
                <span className="shrink-0 tabular" style={{ color: itemColor(next) }}>{untilLabel(next, now)}</span>
              </div>
            )}
            <div className="no-drag flex items-center gap-1.5">
              <button onClick={() => { setVoice(true); if (mode === "standard") switchMode("expanded"); }} className="flex-1 h-7 rounded-lg text-[11px] font-medium flex items-center justify-center gap-1.5 bg-hover hover:text-accent transition" aria-label="Voice command">
                <Mic size={12} /> Voice
              </button>
              <button onClick={() => (mode === "expanded" ? document.getElementById("ov-quick")?.focus() : void openInMain("nexus://quick-add"))} className="flex-1 h-7 rounded-lg text-[11px] font-medium flex items-center justify-center gap-1.5 bg-hover hover:text-accent transition" aria-label="Quick add task">
                <Plus size={12} /> Add task
              </button>
              {missed > 0 && (
                <button onClick={() => void openInMain(null)} className="h-7 px-2 rounded-lg text-[10px] font-semibold text-danger bg-[color-mix(in_oklab,var(--danger)_14%,transparent)]" title="Missed items — open Smart Reschedule">
                  {missed} missed
                </button>
              )}
            </div>
            <div className="no-drag flex items-center gap-1.5 text-[11px]">
              {!work.active ? (
                <button onClick={() => void s.clockIn()} className="flex-1 h-7 rounded-lg font-medium flex items-center justify-center gap-1.5 bg-hover hover:text-success transition" aria-label="Clock in">
                  <LogIn size={12} /> Clock in <span className="text-muted tabular">· {formatClock(work.todayMs)} today</span>
                </button>
              ) : (
                <>
                  <span className={cx("h-2 w-2 rounded-full shrink-0", work.pause ? "bg-warning" : "bg-success animate-pulse")} />
                  <span className="tabular font-mono font-semibold text-fg">{formatClock(work.sessionMs)}</span>
                  <span className="text-muted truncate flex-1">{work.pause ? (work.pause.reason === "idle" ? "auto-paused (idle)" : "on break") : "working"}</span>
                  <button onClick={() => void (work.pause ? s.resumeWork() : s.pauseWork())} className="h-6 px-2 rounded-md bg-hover hover:text-accent" aria-label={work.pause ? "Resume work" : "Take a break"}>
                    {work.pause ? <Play size={11} /> : <Pause size={11} />}
                  </button>
                  <button onClick={() => void s.clockOut()} className="h-6 px-2 rounded-md bg-hover hover:text-danger inline-flex items-center gap-1" aria-label="Clock out">
                    <LogOut size={11} /> Out
                  </button>
                </>
              )}
            </div>

            {mode === "expanded" && (
              <div className="no-drag flex-1 min-h-0 flex flex-col gap-2 overflow-hidden">
                {voice ? (
                  <div className="rounded-xl bg-hover p-2">
                    <CommandPanel compact autoListen onDone={() => setVoice(false)} />
                    <button className="text-[10px] text-muted mt-1" onClick={() => setVoice(false)}>Close voice</button>
                  </div>
                ) : (
                  <form onSubmit={(e) => { e.preventDefault(); void quickAdd(); }} className="flex gap-1">
                    <input id="ov-quick" value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Quick add: “Call Amina 3pm Texas time”" className="flex-1 h-7 rounded-lg bg-hover border border-line px-2 text-[11px] outline-none focus:border-accent" />
                    <button type="submit" className="h-7 w-7 rounded-lg bg-accent text-white flex items-center justify-center" aria-label="Add"><Plus size={13} /></button>
                  </form>
                )}
                <p className="text-[9px] uppercase tracking-widest text-muted mt-1">Up next</p>
                <div className="flex-1 min-h-0 overflow-y-auto scroll-y flex flex-col gap-1 pr-1">
                  {top.map((t) => {
                    const dl = deadlineInfo(t.dueAt, now, settings.deadlineWarningMin);
                    return (
                      <div key={t.id} className={cx("group flex items-center gap-2 rounded-lg px-1.5 py-1 text-[11px]", t.id === settings.activeTaskId ? "bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]" : "hover:bg-hover")}>
                        <button aria-label={`Complete “${t.title}”`} title="Mark complete" onClick={() => completeTask(t.id, t.title)} className="h-4 w-4 rounded-full border-2 border-line-strong hover:border-success hover:bg-success/30 shrink-0 flex items-center justify-center text-success">
                          <Check size={9} strokeWidth={3} className="opacity-30 group-hover:opacity-100" />
                        </button>
                        <span className="flex-1 truncate">{t.title}</span>
                        {t.dueAt != null && <span className="shrink-0 tabular text-[10px]" style={{ color: URGENCY_COLOR[dl.urgency] }}>{dl.urgency === "overdue" ? "overdue" : humanDuration(dl.remaining)}</span>}
                        <button aria-label="Make active" title="Work on this" onClick={() => void s.setActiveTask(t.id)} className="opacity-0 group-hover:opacity-100 text-accent"><Play size={11} /></button>
                      </div>
                    );
                  })}
                  {top.length === 0 && <p className="text-[11px] text-muted">No open tasks.</p>}
                </div>
                {doneToday.length > 0 && (
                  <>
                    <p className="text-[9px] uppercase tracking-widest text-muted">Done today · {doneToday.length}</p>
                    <div className="flex flex-col gap-0.5 max-h-20 overflow-y-auto scroll-y pr-1">
                      {doneToday.map((t) => (
                        <div key={t.id} className="group flex items-center gap-2 text-[11px] text-muted">
                          <CheckCircle2 size={12} className="text-success shrink-0" />
                          <span className="flex-1 truncate line-through">{t.title}</span>
                          <button className="opacity-0 group-hover:opacity-100 text-[10px] text-accent" onClick={() => void s.setTaskDone(t.id, false)}>undo</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <p className="text-[9px] uppercase tracking-widest text-muted flex items-center gap-2">
                  Schedule
                  {overdueCount > 0 && <span className="normal-case tracking-normal font-semibold text-danger">{overdueCount} overdue</span>}
                </p>
                {schedule.length === 0 ? (
                  <p className="text-[11px] text-muted rounded-lg bg-hover px-2 py-1.5">
                    <CalendarClock size={11} className="inline mr-1 -mt-0.5" />
                    Nothing scheduled for the next 7 days. Add something from the dashboard and it shows up here.
                  </p>
                ) : (
                  <div className="flex flex-col gap-0.5 max-h-[104px] overflow-y-auto scroll-y pr-1 shrink-0" aria-label="Schedule">
                    {schedule.map((i) => (
                      <div
                        key={i.key}
                        className={cx("flex items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[11px] min-w-0", i.status === "overdue" ? "bg-[color-mix(in_oklab,var(--danger)_12%,transparent)]" : i.status === "now" ? "bg-[color-mix(in_oklab,var(--success)_12%,transparent)]" : "")}
                        title={`${i.title}\n${i.kind === "fixed" ? "Fixed appointment — never moved automatically" : i.kind === "deadline" ? "Task due" : "Flexible task — NEXUS may re-plan it"}${i.moved ? " · auto-rescheduled" : ""}\n${itemWhen(i)}${i.end > i.start ? ` – ${formatTime(i.end, settings.homeZone, settings.hour12)}` : ""}`}
                      >
                        {itemIcon(i)}
                        <span className="tabular text-muted shrink-0">{itemWhen(i)}</span>
                        <span className={cx("truncate flex-1", i.status === "overdue" ? "text-danger" : "text-fg")}>{i.title}</span>
                        {i.moved && <RotateCcw size={9} className="shrink-0 text-warning" aria-label="Auto-rescheduled" />}
                        <span className="shrink-0 tabular font-medium" style={{ color: itemColor(i) }}>{untilLabel(i, now)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between gap-2">
                  <button onClick={() => void openInMain(null)} className="text-[10px] text-accent hover:underline truncate">Open full calendar & scheduling →</button>
                  <PoweredBy className="text-[9px] shrink-0" flagHeight={8} />
                </div>
              </div>
            )}
          </div>
        </>
      )}
      {/* resize grip */}
      <div onPointerDown={() => void startResize()} className="no-drag absolute right-0 bottom-0 h-3.5 w-3.5 cursor-se-resize opacity-40 hover:opacity-100" aria-hidden>
        <svg viewBox="0 0 10 10" className="h-full w-full text-muted"><path d="M9 3L3 9M9 6L6 9" stroke="currentColor" strokeWidth="1.2" /></svg>
      </div>
      {confirming && (
        <div role="alertdialog" aria-modal="true" aria-label="Confirm completion" className="no-drag absolute inset-0 z-40 flex items-center justify-center rounded-[14px] bg-[rgba(var(--overlay-bg),0.94)] backdrop-blur-sm px-3">
          <div className={cx("flex gap-2 w-full", mode === "mini" ? "items-center" : "flex-col items-stretch max-w-[300px]")}>
            <p className={cx("text-fg min-w-0", mode === "mini" ? "text-[11px] flex-1 truncate" : "text-[13px] text-center leading-snug")} title={confirming.title}>
              {mode === "mini" ? <>Mark <b>“{confirming.title}”</b> completed?</> : <>Are you sure you want to mark <b>“{confirming.title}”</b> as completed?</>}
            </p>
            <div className={cx("flex gap-1.5 shrink-0", mode !== "mini" && "justify-center")}>
              <button autoFocus disabled={completing} onClick={() => void confirmCompletion()} className="h-7 px-2.5 rounded-lg text-[11px] font-semibold text-white bg-success hover:brightness-110 disabled:opacity-60 inline-flex items-center gap-1">
                <Check size={12} strokeWidth={3} /> {mode === "mini" ? "Confirm" : "Confirm Completion"}
              </button>
              <button onClick={() => setConfirming(null)} className="h-7 px-2.5 rounded-lg text-[11px] font-medium bg-hover text-fg-2 hover:text-fg">Cancel</button>
            </div>
          </div>
        </div>
      )}
      <Toasts position="top" />
    </div>
  );
}
