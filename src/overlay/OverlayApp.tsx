import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, ChevronDown, Expand, Mic, MousePointerClick, Pause, Pin, PinOff, Play, Plus, Shrink, X } from "lucide-react";
import type { OverlayMode, ReminderItem } from "@/data/types";
import { useNexus, nexus, getBackend } from "@/store";
import { useNow } from "@/lib/ticker";
import { useTheme } from "@/lib/useTheme";
import { clockFor, KENYA_ZONE, formatTime } from "@/lib/time";
import { deadlineInfo, elapsedMs, eventStatus, formatClock, humanDuration, progress, remainingMs } from "@/lib/countdown";
import { expandEvents, findMissed } from "@/lib/schedule";
import { openTasks, scoreTask } from "@/lib/assistant";
import { parseCommand } from "@/lib/voice/parser";
import { clampOpacity, ensureVisible, nextMode, sizeForMode } from "@/lib/overlayGeometry";
import { getOverlayState, listenTo, native, onOverlayState, playChime, setClickThrough, setOverlayVisible, setPinned, type OverlayState } from "@/lib/platform";
import { CommandPanel } from "@/components/CommandBar";
import { PerfStrip, usePerf } from "./PerfStrip";
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
      const size = sizeForMode(mode, nexus().settings.overlaySizes, nexus().settings.overlayPerf);
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
          const cur = sizeForMode(modeRef.current, nexus().settings.overlaySizes, nexus().settings.overlayPerf);
          if (Math.abs(cur.w - logical.w) > 2 || Math.abs(cur.h - logical.h) > 2) {
            await nexus().setSetting("overlaySizes", { ...nexus().settings.overlaySizes, [modeRef.current]: logical });
          }
        }, 400);
      });
    })();
    return () => off?.();
  }, [mode, perfOn]);

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
  const upcoming = useMemo(() => expandEvents(events, now - 3600_000, now + 7 * 86_400_000).filter((o) => o.end > now).slice(0, 3), [events, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = useMemo(() => openTasks(tasks).sort((a, b) => scoreTask(b, now) - scoreTask(a, now)).slice(0, 8), [tasks, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const missed = useMemo(() => findMissed(tasks, events, now).length, [tasks, events, minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = upcoming[0];
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
      <span data-tauri-drag-region className="text-[10px] font-bold tracking-[0.3em] text-gradient mr-auto">NEXUS</span>
      <div className="no-drag flex items-center gap-0.5">
        {ov.clickThrough && <span className="text-[9px] text-accent mr-1">CLICK-THROUGH</span>}
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
          {perfOn && <PerfStrip snap={perf} compact showFps={settings.overlayFps} />}
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
            {perfOn && <PerfStrip snap={perf} showFps={settings.overlayFps} />}
            <div className="rounded-xl bg-hover px-2.5 py-2">
              {TimerLine}
              {timer && timer.kind !== "stopwatch" && <ProgressBar value={progress(timer, now)} className="mt-1.5 !h-1" />}
              {!timer && subProgress != null && <ProgressBar value={subProgress} className="mt-1.5 !h-1" />}
            </div>
            {next && (
              <div className="flex items-center gap-2 text-[11px] min-w-0">
                <CalendarClock size={12} className="text-accent-2 shrink-0" />
                <span className="truncate text-fg-2 flex-1">{next.event.title}</span>
                <span className="shrink-0 tabular" style={{ color: eventStatus(next.start, next.end, now).live ? "var(--success)" : "var(--muted)" }}>
                  {eventStatus(next.start, next.end, now).label.replace("Starts in ", "in ")}
                </span>
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
                        <button aria-label="Complete" onClick={() => void s.setTaskDone(t.id, true)} className="h-3.5 w-3.5 rounded-full border border-line-strong hover:border-success hover:bg-success/30 shrink-0 flex items-center justify-center">
                          <Check size={8} className="opacity-0 group-hover:opacity-100" />
                        </button>
                        <span className="flex-1 truncate">{t.title}</span>
                        {t.dueAt != null && <span className="shrink-0 tabular text-[10px]" style={{ color: URGENCY_COLOR[dl.urgency] }}>{dl.urgency === "overdue" ? "overdue" : humanDuration(dl.remaining)}</span>}
                        <button aria-label="Make active" title="Work on this" onClick={() => void s.setActiveTask(t.id)} className="opacity-0 group-hover:opacity-100 text-accent"><Play size={11} /></button>
                      </div>
                    );
                  })}
                  {top.length === 0 && <p className="text-[11px] text-muted">No open tasks.</p>}
                </div>
                {upcoming.length > 1 && (
                  <>
                    <p className="text-[9px] uppercase tracking-widest text-muted">Schedule</p>
                    {upcoming.map((o) => (
                      <div key={o.event.id + o.start} className="flex items-center gap-2 text-[11px]">
                        <span className="tabular text-muted w-16 shrink-0">{formatTime(o.start, settings.homeZone, settings.hour12)}</span>
                        <span className="truncate">{o.event.title}</span>
                      </div>
                    ))}
                  </>
                )}
                <button onClick={() => void openInMain(null)} className="text-[10px] text-accent self-start hover:underline">Open full calendar & scheduling →</button>
              </div>
            )}
          </div>
        </>
      )}
      {/* resize grip */}
      <div onPointerDown={() => void startResize()} className="no-drag absolute right-0 bottom-0 h-3.5 w-3.5 cursor-se-resize opacity-40 hover:opacity-100" aria-hidden>
        <svg viewBox="0 0 10 10" className="h-full w-full text-muted"><path d="M9 3L3 9M9 6L6 9" stroke="currentColor" strokeWidth="1.2" /></svg>
      </div>
      <Toasts position="top" />
    </div>
  );
}
