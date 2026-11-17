import { lazy, Suspense, useEffect } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useNexus, nexus, getBackend } from "@/store";
import { useUI, type View } from "@/store/ui";
import { Sidebar, TitleBar, NAV } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { ConfirmHost } from "@/components/Confirm";
import { TaskEditor } from "@/components/TaskEditor";
import { EventEditor } from "@/components/EventEditor";
import { CommandPalette } from "@/components/CommandBar";
import { SmartReschedule } from "@/components/SmartReschedule";
import { AutoPlanDialog } from "@/components/AutoPlanDialog";
import { useTheme } from "@/lib/useTheme";
import { onTick } from "@/lib/ticker";
import { idleSeconds, listenTo, playChime, signalReady } from "@/lib/platform";
import type { ReminderItem } from "@/data/types";
import Dashboard from "@/views/Dashboard";

const Tasks = lazy(() => import("@/views/Tasks"));
const Calendar = lazy(() => import("@/views/Calendar"));
const Focus = lazy(() => import("@/views/Focus"));
const Clocks = lazy(() => import("@/views/Clocks"));
const Assistant = lazy(() => import("@/views/Assistant"));
const SettingsView = lazy(() => import("@/views/Settings"));
const Insights = lazy(() => import("@/views/Insights"));
const History = lazy(() => import("@/views/History"));

const VIEWS: Record<View, React.ComponentType> = {
  dashboard: Dashboard,
  tasks: Tasks,
  calendar: Calendar,
  focus: Focus,
  clocks: Clocks,
  assistant: Assistant,
  insights: Insights,
  history: History,
  settings: SettingsView,
};

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function anyModalOpen() {
  const u = useUI.getState();
  return u.taskEditor.open || u.eventEditor.open || u.command.open || !!u.reschedule || u.autoPlan || !!document.querySelector("[role=dialog]");
}

export default function App() {
  const { theme, reducedMotion, error } = useNexus((s) => ({ theme: s.settings.theme, reducedMotion: s.settings.reducedMotion, error: s.error }));
  const view = useUI((s) => s.view);
  useTheme(theme, reducedMotion);

  // Reveal the native window once the first frame is ready.
  useEffect(() => {
    requestAnimationFrame(() => void signalReady());
  }, []);

  // Data changes from the overlay window, reminders, global-shortcut events.
  useEffect(() => {
    const be = getBackend();
    const offs: (() => void)[] = [];
    offs.push(be.onDataChanged(() => void nexus().reload()));
    offs.push(
      be.onReminder((r: ReminderItem) => {
        if (nexus().settings.notificationSound) playChime();
        nexus().toast({ kind: "reminder", title: r.title, body: r.body, reminder: r, ttl: 0 });
      }),
    );
    let un1: (() => void) | undefined;
    let un2: (() => void) | undefined;
    listenTo("nexus://quick-add", () => useUI.getState().openTask(null)).then((u) => (un1 = u));
    listenTo("nexus://voice", () => useUI.getState().openCommand(true)).then((u) => (un2 = u));
    return () => {
      offs.forEach((o) => o());
      un1?.();
      un2?.();
    };
  }, []);

  // Timer expiry processing + periodic reminder horizon refresh (main window only).
  useEffect(() => {
    let last = 0;
    const off = onTick(() => {
      void nexus().processTimers();
      const now = Date.now();
      if (now - last > 3600_000) {
        last = now;
        void nexus().resyncAllReminders();
      }
    });
    return off;
  }, []);

  // Idle detection for the work clock / focus timers (main window only, so it runs once).
  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (!alive) return;
      try {
        await nexus().handleIdle(await idleSeconds());
      } catch {
        /* ignore */
      }
    };
    const iv = setInterval(() => void check(), 15_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);

  // In-app keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUI.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ui.openCommand(false);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        ui.openTask(null);
        return;
      }
      if (isTyping(e) || anyModalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
      const nav = NAV.find((n) => n.key === e.key);
      if (nav) return ui.setView(nav.view);
      if (e.key === ",") return ui.setView("settings");
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        return ui.openTask(null);
      }
      if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        return ui.openEvent(null);
      }
      if (e.key.toLowerCase() === "v") return ui.openCommand(true);
      if (e.key === "/") {
        e.preventDefault();
        ui.setView("tasks");
        setTimeout(() => document.querySelector<HTMLInputElement>("#task-search")?.focus(), 50);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const Current = VIEWS[view];
  return (
    <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
      <div className="app-bg h-full flex flex-col text-fg">
        <div className="pointer-events-none fixed inset-0 grid-bg opacity-60" />
        <TitleBar />
        {error && (
          <div role="alert" className="mx-4 mt-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
            Could not load your data: {error}. Nothing was overwritten. See Settings → Data for backups.
          </div>
        )}
        <div className="relative flex-1 flex min-h-0">
          <Sidebar />
          <main className="flex-1 min-w-0 scroll-y" id="main">
            <AnimatePresence mode="wait">
              <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }} className="p-5 lg:p-7 max-w-[1500px] mx-auto">
                <Suspense fallback={<div className="h-40 rounded-2xl shimmer" />}>
                  <Current />
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
        <TaskEditor />
        <EventEditor />
        <CommandPalette />
        <SmartReschedule />
        <AutoPlanDialog />
        <ConfirmHost />
        <Toasts />
      </div>
    </MotionConfig>
  );
}
