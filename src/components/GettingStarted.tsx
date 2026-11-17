import { CalendarPlus, Check, Hourglass, ListPlus, PanelTop, Rocket, X } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { native, setOverlayVisible } from "@/lib/platform";
import { Button, Card, cx } from "./ui";

/** First-run checklist. Steps tick themselves off from real data; dismissible forever. */
export function GettingStarted() {
  const { tasks, events, timers, focus, onboarded, overlaySeen } = useNexus((s) => ({
    tasks: s.tasks,
    events: s.events,
    timers: s.timers,
    focus: s.focusSessions,
    onboarded: s.settings.onboarded,
    overlaySeen: (s.settings as unknown as Record<string, unknown>).overlayVisible === true || s.settings.overlayOnStartup,
  }));
  if (onboarded) return null;
  const ui = useUI.getState();
  const steps = [
    { done: tasks.length > 0, icon: <ListPlus size={15} />, label: "Add your first task", action: () => ui.openTask(null), cta: "Add task" },
    { done: tasks.some((t) => t.dueAt != null) || events.length > 0, icon: <CalendarPlus size={15} />, label: "Schedule it for the future", action: () => ui.openEvent(null), cta: "Schedule" },
    { done: timers.length > 0 || focus.length > 0, icon: <Hourglass size={15} />, label: "Start a countdown or focus session", action: () => ui.setView("focus"), cta: "Open timers" },
    { done: overlaySeen, icon: <PanelTop size={15} />, label: "Turn on the floating overlay (Ctrl+Shift+Space)", action: () => void setOverlayVisible(true), cta: native ? "Show overlay" : "Desktop only" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <Card glow className="p-5">
      <div className="flex items-start gap-4">
        <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-cyan-400 to-violet-500 text-white flex items-center justify-center shrink-0"><Rocket size={20} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">Welcome to NEXUS — {doneCount}/{steps.length} done</h2>
            <button aria-label="Dismiss getting started" className="text-muted hover:text-fg" onClick={() => void nexus().setSetting("onboarded", true)}><X size={16} /></button>
          </div>
          <p className="text-sm text-muted mt-0.5">Your Kenya & Texas clocks are live above. Everything saves automatically — close and reopen anytime without losing data.</p>
          <div className="grid sm:grid-cols-2 gap-2 mt-3">
            {steps.map((s) => (
              <div key={s.label} className={cx("flex items-center gap-3 rounded-xl border px-3 py-2", s.done ? "border-[color-mix(in_oklab,var(--success)_35%,transparent)]" : "border-line")}>
                <span className={cx("h-6 w-6 rounded-full flex items-center justify-center shrink-0", s.done ? "bg-success text-white" : "bg-hover text-accent")}>{s.done ? <Check size={13} /> : s.icon}</span>
                <span className={cx("text-sm flex-1", s.done && "text-muted line-through")}>{s.label}</span>
                {!s.done && <Button size="sm" variant="soft" onClick={s.action} disabled={s.cta === "Desktop only"}>{s.cta}</Button>}
              </div>
            ))}
          </div>
          {doneCount === steps.length && <Button className="mt-3" size="sm" variant="primary" onClick={() => void nexus().setSetting("onboarded", true)}>All set — hide this</Button>}
        </div>
      </div>
    </Card>
  );
}
