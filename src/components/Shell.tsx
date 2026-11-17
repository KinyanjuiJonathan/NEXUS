import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { CalendarDays, Globe, LayoutDashboard, ListTodo, Mic, Minus, PanelTop, Plus, Settings, Sparkles, Square, Timer, X } from "lucide-react";
import { useUI, type View } from "@/store/ui";
import { useNexus } from "@/store";
import { closeWindow, minimizeWindow, native, toggleMaximize, toggleOverlay } from "@/lib/platform";
import { DualClock } from "./DualClock";
import { IconButton, Kbd, cx } from "./ui";
import { useNow } from "@/lib/ticker";
import { formatClock, remainingMs, elapsedMs } from "@/lib/countdown";

export const NAV: { view: View; label: string; icon: ReactNode; key: string }[] = [
  { view: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} />, key: "1" },
  { view: "tasks", label: "Tasks", icon: <ListTodo size={18} />, key: "2" },
  { view: "calendar", label: "Calendar", icon: <CalendarDays size={18} />, key: "3" },
  { view: "focus", label: "Focus & Timers", icon: <Timer size={18} />, key: "4" },
  { view: "clocks", label: "World Clocks", icon: <Globe size={18} />, key: "5" },
  { view: "assistant", label: "Assistant", icon: <Sparkles size={18} />, key: "6" },
];

function ActiveTimerPill() {
  const now = useNow();
  const timers = useNexus((s) => s.timers);
  const t = timers.find((x) => x.state === "running") ?? timers.find((x) => x.state === "paused");
  const setView = useUI((s) => s.setView);
  if (!t) return null;
  const val = t.kind === "stopwatch" ? elapsedMs(t, now) : remainingMs(t, now);
  return (
    <button onClick={() => setView("focus")} className="no-drag flex items-center gap-2 h-7 px-2.5 rounded-full glass text-xs hover:border-accent transition" title="Open Focus">
      <span className={cx("h-1.5 w-1.5 rounded-full", t.state === "running" ? "bg-success animate-pulse" : "bg-warning")} />
      <span className="font-mono tabular text-fg">{formatClock(val)}</span>
      <span className="text-muted max-w-[120px] truncate">{t.label}</span>
    </button>
  );
}

export function TitleBar() {
  const settings = useNexus((s) => s.settings);
  const openCommand = useUI((s) => s.openCommand);
  return (
    <header data-tauri-drag-region className="drag-region h-11 shrink-0 flex items-center gap-3 pl-4 pr-1 border-b border-line">
      <div data-tauri-drag-region className="flex items-center gap-2 min-w-[180px]">
        <img src="/logo.svg" alt="" className="h-5 w-5 pointer-events-none" />
        <span data-tauri-drag-region className="font-display font-semibold tracking-[0.25em] text-[13px] text-gradient">NEXUS</span>
      </div>
      <div data-tauri-drag-region className="flex-1 flex items-center justify-center gap-4">
        <div className="no-drag hidden md:block">
          <DualClock compact hour12={settings.hour12} texasZone={settings.texasZone} />
        </div>
        <ActiveTimerPill />
      </div>
      <div className="no-drag flex items-center gap-1">
        <button onClick={() => openCommand(false)} className="hidden lg:flex items-center gap-2 h-7 px-2.5 rounded-lg text-xs text-muted hover:text-fg hover:bg-hover transition">
          Command <Kbd>Ctrl K</Kbd>
        </button>
        <IconButton label="Voice command (Ctrl+Shift+V)" onClick={() => openCommand(true)}>
          <Mic size={16} />
        </IconButton>
        <IconButton label="Toggle floating overlay (Ctrl+Shift+Space)" onClick={() => void toggleOverlay()} disabled={!native}>
          <PanelTop size={16} />
        </IconButton>
        {native && (
          <div className="flex items-center ml-1">
            <IconButton label="Minimize" onClick={() => void minimizeWindow()} size={40} className="!rounded-none h-11">
              <Minus size={15} />
            </IconButton>
            <IconButton label="Maximize" onClick={() => void toggleMaximize()} size={40} className="!rounded-none h-11">
              <Square size={13} />
            </IconButton>
            <IconButton label="Close to tray" onClick={() => void closeWindow()} size={40} className="!rounded-none h-11 hover:!bg-red-600 hover:!text-white">
              <X size={16} />
            </IconButton>
          </div>
        )}
      </div>
    </header>
  );
}

export function Sidebar() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const openTask = useUI((s) => s.openTask);
  const overdue = useNexus((s) => s.tasks.filter((t) => !t.deletedAt && !t.archivedAt && t.status !== "done" && t.dueAt != null && t.dueAt < Date.now()).length);
  return (
    <nav aria-label="Main" className="w-[72px] lg:w-[220px] shrink-0 flex flex-col gap-1 p-3 border-r border-line">
      <button
        onClick={() => openTask(null)}
        className="mb-3 h-10 rounded-xl flex items-center justify-center lg:justify-start gap-2 lg:px-3 font-medium text-white bg-gradient-to-r from-sky-500 via-blue-500 to-violet-500 shadow-[0_6px_24px_-8px_rgba(56,189,248,0.7)] hover:brightness-110 active:scale-[0.98] transition"
        title="New task (N)"
      >
        <Plus size={18} />
        <span className="hidden lg:inline">New task</span>
        <span className="hidden lg:inline ml-auto"><Kbd>N</Kbd></span>
      </button>
      {NAV.map((n) => (
        <button
          key={n.view}
          onClick={() => setView(n.view)}
          aria-current={view === n.view ? "page" : undefined}
          title={`${n.label} (${n.key})`}
          className={cx("relative h-10 rounded-xl flex items-center justify-center lg:justify-start gap-3 lg:px-3 text-sm transition-colors", view === n.view ? "text-fg" : "text-muted hover:text-fg hover:bg-hover")}
        >
          {view === n.view && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl bg-hover border border-line" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
          {view === n.view && <motion.span layoutId="nav-bar" className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-gradient-to-b from-cyan-400 to-violet-500" />}
          <span className={cx("relative", view === n.view && "text-accent")}>{n.icon}</span>
          <span className="relative hidden lg:inline">{n.label}</span>
          {n.view === "tasks" && overdue > 0 && (
            <span className="relative lg:ml-auto absolute lg:static top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center" title={`${overdue} overdue`}>
              {overdue}
            </span>
          )}
        </button>
      ))}
      <div className="flex-1" />
      <button
        onClick={() => setView("settings")}
        aria-current={view === "settings" ? "page" : undefined}
        className={cx("h-10 rounded-xl flex items-center justify-center lg:justify-start gap-3 lg:px-3 text-sm transition-colors", view === "settings" ? "text-fg bg-hover" : "text-muted hover:text-fg hover:bg-hover")}
        title="Settings (,)"
      >
        <Settings size={18} />
        <span className="hidden lg:inline">Settings</span>
      </button>
    </nav>
  );
}
