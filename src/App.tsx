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
import { AiSchedulerPanel } from "@/components/AiScheduler";
import { useTheme } from "@/lib/useTheme";
import { onTick } from "@/lib/ticker";
import { activityConfigure, activityState, idleSeconds, listenTo, playChime, signalReady } from "@/lib/platform";
import { initTyper } from "@/lib/typer/controller";
import type { ActivityEvent, ReminderItem } from "@/data/types";
import Dashboard from "@/views/Dashboard";

const Tasks = lazy(() => import("@/views/Tasks"));
const Calendar = lazy(() => import("@/views/Calendar"));
const Focus = lazy(() => import("@/views/Focus"));
const Clocks = lazy(() => import("@/views/Clocks"));
const Assistant = lazy(() => import("@/views/Assistant"));
const SettingsView = lazy(() => import("@/views/Settings"));
const Insights = lazy(() => import("@/views/Insights"));
const History = lazy(() => import("@/views/History"));
const Typer = lazy(() => import("@/views/Typer"));

const VIEWS: Record<View, React.ComponentType> = {
  dashboard: Dashboard,
  tasks: Tasks,
  calendar: Calendar,
  focus: Focus,
  clocks: Clocks,
  assistant: Assistant,
  insights: Insights,
  history: History,
  typer: Typer,
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
  const { theme, reducedMotion, error, idleMinutes } = useNexus((s) => ({ theme: s.settings.theme, reducedMotion: s.settings.reducedMotion, error: s.error, idleMinutes: s.settings.idleMinutes }));
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
    // Status updates and the global start/stop shortcut work from every screen.
    initTyper();
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
    let lastSweep = 0;
    const off = onTick(() => {
      void nexus().processTimers();
      const now = Date.now();
      // Unfinished flexible blocks are re-planned once a minute (and straight away at start-up).
      if (now - lastSweep > 60_000) {
        lastSweep = now;
        void nexus().autoReschedule().catch(() => {});
      }
      if (now - last > 3600_000) {
        last = now;
        void nexus().resyncAllReminders();
      }
    });
    return off;
  }, []);

  // Work clock / focus timers follow real activity (main window only, so it runs once).
  // The desktop app's native monitor reports going away and coming back with exact
  // timestamps, so this stays accurate while the window is minimised or hidden and
  // across lock and sleep. A plain browser can only poll idle time inside the page.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    let iv: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      const state = await activityState();
      if (!alive) return;
      if (state?.supported) {
        const un = await listenTo<ActivityEvent>("nexus://activity", (ev) => {
          void nexus()
            .handleActivity(ev)
            // back from sleep, lock or a long absence: catch up on blocks that ended meanwhile
            .then(() => (ev.kind === "back" ? nexus().autoReschedule() : undefined))
            .catch(() => {});
        });
        if (!alive) return un();
        off = un;
        // Catch up with whatever happened before this window was listening.
        if (state.away && state.since != null) void nexus().handleActivity({ kind: "away", since: state.since, reason: state.locked ? "locked" : "idle" });
        else void nexus().handleActivity({ kind: "back", at: Date.now() - (state.idleSeconds ?? 0) * 1000 });
        return;
      }
      const check = async () => {
        try {
          await nexus().handleIdle(await idleSeconds());
        } catch {
          /* ignore */
        }
      };
      void check();
      iv = setInterval(() => void check(), 15_000);
    })();
    return () => {
      alive = false;
      off?.();
      if (iv) clearInterval(iv);
    };
  }, []);

  // The monitor uses the same idle limit as the work-clock setting.
  useEffect(() => {
    void activityConfigure(Math.max(1, idleMinutes) * 60);
  }, [idleMinutes]);

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
        <AiSchedulerPanel />
        <ConfirmHost />
        <Toasts />
      </div>
    </MotionConfig>
  );
}
