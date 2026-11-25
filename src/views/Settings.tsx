import { useEffect, useState, type ReactNode } from "react";
import { CalendarCheck, Clock, Wand2, Bell, Brain, Database, Download, Globe, Info, Keyboard, Mic, Monitor, Moon, PanelTop, Power, RefreshCw, Shield, Sun, Target, Upload } from "lucide-react";
import { DEFAULT_SHORTCUTS, type PerfMetric, type Settings, type Shortcuts } from "@/data/types";
import { BrandBlock } from "@/components/Brand";
import { METRIC_LABEL } from "@/lib/perf";
import { useOverlayState } from "@/lib/useOverlay";
import { useNexus, nexus } from "@/store";
import { DEFAULT_SETTINGS } from "@/store/store";
import { KENYA_ZONE, TEXAS_CENTRAL, TEXAS_MOUNTAIN, isValidZone, localZone } from "@/lib/time";
import {
  aiClearKey, aiHasKey, aiSetKey, applyShortcuts, dataInfo, ensureNotificationPermission, getAutostart, invokeSafe, native, setClickThrough,
  pickOpenPath, pickSavePath, playChime, relaunch, setAutostart, setOverlayVisible, testNotification, type DataInfo,
} from "@/lib/platform";
import { voiceSupported, webSpeechAvailable } from "@/lib/voice/engine";
import { clampOpacity } from "@/lib/overlayGeometry";
import { Button, Card, CardHeader, Field, Input, Kbd, Segmented, Select, Toggle, cx } from "@/components/ui";
import { useUI } from "@/store/ui";
import { AMBIENT_PAGES } from "@/lib/ambient";
import { UpdatesAndFeedback } from "@/components/Updates";
import { ReminderPicker } from "@/components/ReminderPicker";
import { confirm } from "@/components/Confirm";

function Section({ id, title, icon, children }: { id: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card id={id}>
      <CardHeader title={title} icon={icon} />
      <div className="px-5 pb-5 flex flex-col gap-3">{children}</div>
    </Card>
  );
}

const ZONES = ["Africa/Nairobi", "America/Chicago", "America/Denver", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Dubai", "Asia/Kolkata", "UTC"];

function ShortcutInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRec(true)}
      onBlur={() => setRec(false)}
      onKeyDown={(e) => {
        if (!rec) return;
        e.preventDefault();
        if (e.key === "Escape") return setRec(false);
        if (e.key === "Backspace") {
          onChange("");
          return setRec(false);
        }
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        // Global shortcuts need a modifier, except function keys, which are safe on their own.
        if (parts.length === 0 && !/^F([1-9]|1\d|2[0-4])$/.test(e.code)) return;
        const key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.code === "Space" ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.code;
        onChange([...parts, key].join("+"));
        setRec(false);
      }}
      className={cx("h-9 min-w-[220px] rounded-xl border px-3 text-left text-sm font-mono transition", rec ? "border-accent glow-ring text-accent" : "border-line bg-hover text-fg")}
    >
      {rec ? "Press keys… (Esc cancel, ⌫ clear)" : value ? value.replace("CommandOrControl", "Ctrl") : "Not set"}
    </button>
  );
}

export default function SettingsView() {
  const settings = useNexus((s) => s.settings);
  const s = nexus();
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => void s.setSetting(k, v);
  const [autostart, setAuto] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [info, setInfo] = useState<DataInfo | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<Shortcuts>(settings.shortcuts);
  const [failed, setFailed] = useState<string[]>([]);
  const [customZone, setCustomZone] = useState("");
  const overlay = useOverlayState();
  const clickThroughOn = overlay.clickThrough;

  useEffect(() => {
    void getAutostart().then(setAuto).catch(() => {});
    void aiHasKey().then(setHasKey).catch(() => {});
    void dataInfo().then(setInfo).catch(() => {});
  }, []);

  const saveShortcuts = async (sc: Shortcuts) => {
    setShortcutDraft(sc);
    await s.setSetting("shortcuts", sc);
    const f = await applyShortcuts(sc);
    setFailed(f);
    if (f.length) s.toast({ kind: "warning", title: "Some shortcuts are in use by another app", body: f.join(", ") });
  };

  const backupNow = async () => {
    const path = await pickSavePath(`nexus-backup-${new Date().toISOString().slice(0, 10)}.db`, "db", "NEXUS database backup");
    if (!path) return;
    try {
      await invokeSafe("backup_create", { path });
      s.toast({ kind: "success", title: "Backup saved", body: path });
    } catch (e) {
      s.toast({ kind: "error", title: "Backup failed", body: String(e) });
    }
  };
  const exportJson = async () => {
    const path = await pickSavePath(`nexus-export-${new Date().toISOString().slice(0, 10)}.json`, "json", "NEXUS JSON export");
    if (!path) return;
    try {
      await invokeSafe("export_json", { path });
      s.toast({ kind: "success", title: "Exported", body: path });
    } catch (e) {
      s.toast({ kind: "error", title: "Export failed", body: String(e) });
    }
  };
  const restore = async (kind: "db" | "json") => {
    const path = await pickOpenPath(kind, kind === "db" ? "NEXUS database backup" : "NEXUS JSON export");
    if (!path) return;
    const ok = await confirm({ title: "Replace all current data?", body: "Your current data will be saved to the backups folder first, so this can be undone. NEXUS will reload afterwards.", confirmLabel: "Restore", danger: true });
    if (!ok) return;
    try {
      const safety = await invokeSafe<string>(kind === "db" ? "backup_restore" : "import_json", { path });
      s.toast({ kind: "success", title: "Restored", body: `Previous data saved to ${safety}` });
      setTimeout(() => void relaunch(), 1200);
    } catch (e) {
      s.toast({ kind: "error", title: "Restore failed — nothing was changed", body: String(e) });
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-4xl">
      <div>
        <h1 className="font-display text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted">Changes save automatically.</p>
      </div>

      <Section id="appearance" title="Appearance" icon={<Moon size={16} />}>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={settings.theme} onChange={(v) => set("theme", v)} options={[{ value: "dark", label: <><Moon size={13} /> Dark</> }, { value: "light", label: <><Sun size={13} /> Light</> }, { value: "system", label: <><Monitor size={13} /> System</> }]} />
          <Segmented value={settings.hour12 ? "12" : "24"} onChange={(v) => set("hour12", v === "12")} options={[{ value: "12", label: "12-hour" }, { value: "24", label: "24-hour" }]} />
        </div>
        <Toggle checked={settings.reducedMotion} onChange={(v) => set("reducedMotion", v)} label="Reduce motion" description="Minimise animations (also follows Windows' animation setting)." />
        <Toggle checked={settings.ambient.enabled} onChange={(v) => set("ambient", { ...settings.ambient, enabled: v })} label="Ambient mode" description="When NEXUS is left alone, it drifts from page to page like a live wallpaper. Moving the mouse or pressing a key brings you straight back to the page you were on. It never starts with a dialog open, while you are typing, or from Accounts, the Auto Typer, the Assistant or Settings." />
        {settings.ambient.enabled && (
          <div className="flex flex-col gap-3 pl-1">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Start after">
                <Select className="!w-36" value={settings.ambient.idleMin} onChange={(e) => set("ambient", { ...settings.ambient, idleMin: Number(e.target.value) })}>
                  {[1, 2, 3, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m} min idle</option>)}
                </Select>
              </Field>
              <Field label="Stay on each page">
                <Select className="!w-36" value={settings.ambient.everySec} onChange={(e) => set("ambient", { ...settings.ambient, everySec: Number(e.target.value) })}>
                  {[15, 20, 30, 45, 60, 120, 300].map((x) => <option key={x} value={x}>{x < 60 ? `${x} seconds` : `${x / 60} min`}</option>)}
                </Select>
              </Field>
              <Button variant="soft" onClick={() => useUI.getState().previewAmbient()}>Preview now</Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted mr-1">Pages:</span>
              {AMBIENT_PAGES.map((p) => {
                const on = settings.ambient.pages.includes(p.view);
                const pages = on ? settings.ambient.pages.filter((v) => v !== p.view) : AMBIENT_PAGES.map((x) => x.view).filter((v) => v === p.view || settings.ambient.pages.includes(v));
                return (
                  <button key={p.view} type="button" aria-pressed={on} disabled={on && settings.ambient.pages.length <= 2} onClick={() => set("ambient", { ...settings.ambient, pages })} className={cx("h-7 px-2.5 rounded-lg border text-xs font-medium transition disabled:opacity-60", on ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-muted hover:text-fg")}>{p.label}</button>
                );
              })}
            </div>
          </div>
        )}
      </Section>

      <Section id="zones" title="Time zones & working hours" icon={<Globe size={16} />}>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Home time zone" hint={`Used when you don't say a zone. Detected: ${localZone()}`}>
            <Select value={settings.homeZone} onChange={(e) => (e.target.value === "__custom" ? setCustomZone(" ") : set("homeZone", e.target.value))}>
              {[...new Set([settings.homeZone, localZone(), ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
              <option value="__custom">Other IANA zone…</option>
            </Select>
          </Field>
          <Field label="Texas clock">
            <Select value={settings.texasZone} onChange={(e) => set("texasZone", e.target.value as Settings["texasZone"])}>
              <option value={TEXAS_CENTRAL}>Central — most of Texas (America/Chicago, CST/CDT)</option>
              <option value={TEXAS_MOUNTAIN}>Mountain — El Paso / West Texas (America/Denver, MST/MDT)</option>
            </Select>
          </Field>
        </div>
        {customZone && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const z = customZone.trim(); if (isValidZone(z)) { set("homeZone", z); setCustomZone(""); } else s.toast({ kind: "error", title: "Unknown time zone", body: "Use an IANA name like Europe/Paris." }); }}>
            <Input autoFocus placeholder="e.g. Europe/Paris" value={customZone.trim()} onChange={(e) => setCustomZone(e.target.value || " ")} />
            <Button type="submit">Use</Button>
          </form>
        )}
        <div className="grid sm:grid-cols-3 gap-3 items-end">
          <Field label="Work starts"><Input type="number" min={0} max={23} value={settings.workStartHour} onChange={(e) => set("workStartHour", Math.min(settings.workEndHour - 1, Math.max(0, Number(e.target.value))))} /></Field>
          <Field label="Work ends"><Input type="number" min={1} max={24} value={settings.workEndHour} onChange={(e) => set("workEndHour", Math.max(settings.workStartHour + 1, Math.min(24, Number(e.target.value))))} /></Field>
          <Field label="Working days">
            <div className="flex gap-1">
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => {
                const wd = i + 1;
                const on = settings.workDays.includes(wd);
                return <button key={wd} type="button" aria-pressed={on} onClick={() => set("workDays", on ? settings.workDays.filter((x) => x !== wd) : [...settings.workDays, wd].sort())} className={cx("h-9 w-9 rounded-lg text-xs font-semibold", on ? "bg-accent text-white" : "bg-hover text-muted")}>{d}</button>;
              })}
            </div>
          </Field>
        </div>
        <p className="text-[11px] text-muted">These fixed hours are only the fallback until you have said when you intend to work. After that, each day uses your answer for it, or your latest answer. Kenya = {KENYA_ZONE} (EAT, no DST).</p>
        <Toggle
          checked={settings.workPlanAsk}
          onChange={(v) => set("workPlanAsk", v)}
          label="Ask when I intend to work"
          description="On the first use of each day NEXUS asks when you plan to work: a start in Kenya or Texas time and roughly how many hours. Any day of the week and any hour is fine; tasks are planned inside your answer."
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => useUI.getState().openRoutine(true)}>Daily routine{settings.routine?.enabled ? " (on)" : ""}…</Button>
          <Button size="sm" variant="outline" onClick={() => useUI.getState().openWorkPlan(true)}>Set working hours for a day…</Button>
          <span className="text-sm">Usual length of a working day</span>
          <Input className="!w-20" type="number" min={1} max={24} step={0.5} aria-label="Hours in a usual working day" value={settings.workDayHours} onChange={(e) => set("workDayHours", Math.max(1, Math.min(24, Number(e.target.value) || 8)))} />
          <span className="text-sm">hours</span>
        </div>
      </Section>

      <Section id="reminders" title="Reminders & notifications" icon={<Bell size={16} />}>
        <Field label="Default reminders for new deadlines & appointments"><ReminderPicker value={settings.defaultReminders} onChange={(v) => set("defaultReminders", v)} /></Field>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Default snooze (minutes)"><Input type="number" min={1} max={240} value={settings.snoozeMinutes} onChange={(e) => set("snoozeMinutes", Math.max(1, Number(e.target.value)))} /></Field>
          <Field label="Deadline warning (minutes before)" hint="Tasks turn amber inside this window."><Input type="number" min={5} max={1440} value={settings.deadlineWarningMin} onChange={(e) => set("deadlineWarningMin", Math.max(5, Number(e.target.value)))} /></Field>
        </div>
        <Toggle checked={settings.notificationSound} onChange={(v) => set("notificationSound", v)} label="Play a chime for reminders" description="In addition to the Windows notification sound." />
        <div className="flex flex-wrap gap-2">
          <Button variant="soft" icon={<Bell size={14} />} onClick={async () => { const ok = await ensureNotificationPermission(); if (ok) await testNotification(); else s.toast({ kind: "warning", title: "Notifications are blocked", body: "Enable NEXUS in Windows Settings → System → Notifications." }); }}>Send test notification</Button>
          <Button variant="ghost" onClick={playChime}>Preview chime</Button>
        </div>
        <p className="text-[11px] text-muted">Reminders are delivered by NEXUS's background scheduler while it runs in the system tray — even with every window closed. Turn on “Launch at startup” so reminders keep working after a reboot. Reminders missed while the PC was off are summarised once on the next start.</p>
      </Section>

      <Section id="workclock" title="Work clock & inactivity" icon={<Clock size={16} />}>
        <Toggle
          checked={settings.workAuto}
          onChange={async (v) => {
            await s.setSetting("workAuto", v);
            // You are clearly active right now: start tracking straight away.
            if (v) await s.handleActivity({ kind: "back", at: Date.now() });
          }}
          label="Track work time automatically"
          description="The clock starts when you use the computer, pauses when you stop, and resumes when you are back. It follows keyboard and mouse activity in any app, and never counts time while the PC is locked, asleep or NEXUS is closed. Clocking out by hand turns it off until the next day."
        />
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Pause after (minutes without keyboard/mouse)" hint="The pause starts at your last input, so idle time is never counted.">
            <Input type="number" min={1} max={120} value={settings.idleMinutes} onChange={(e) => set("idleMinutes", Math.max(1, Math.min(120, Number(e.target.value) || 1)))} />
          </Field>
        </div>
        <Toggle checked={settings.idleAutoResume} onChange={(v) => set("idleAutoResume", v)} label="Resume automatically when I'm back" description="Off: stay paused until you press Resume. Manual breaks are never resumed automatically." />
        <Toggle checked={settings.idlePauseTimers} onChange={(v) => set("idlePauseTimers", v)} label="Also pause running focus timers when idle" description="After 5 minutes without input, or as soon as the PC is locked or goes to sleep." />
      </Section>

      <Section id="smart" title="Smart Scheduling" icon={<CalendarCheck size={16} />}>
        <Toggle
          checked={settings.smartEnabled}
          onChange={(v) => set("smartEnabled", v)}
          label="Enable Smart Scheduling"
          description="Type what you need in plain words (“Repair the phone today, around 3 hours, in the evening Kenya time”) and NEXUS reads it, finds a free time and puts it in the To-Do list and on the calendar. Runs on this PC; no AI service is needed."
        />
        <Toggle
          checked={settings.smartAutoReschedule}
          disabled={!settings.smartEnabled}
          onChange={async (v) => {
            await s.setSetting("smartAutoReschedule", v);
            if (v) void s.autoReschedule();
          }}
          label="Auto-Reschedule Incomplete Tasks"
          description="A flexible task only uses up its time while the work clock is running. When its time passes and it is not marked complete, whatever was not clocked is pushed forward to the next free time, and later flexible tasks move along behind it. Fixed appointments never move, and NEXUS never marks a task complete for you."
        />
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">Scheduling order</span>
          <Select className="!w-56" value={settings.schedOrder} aria-label="Scheduling order" onChange={(e) => set("schedOrder", e.target.value as typeof settings.schedOrder)}>
            <option value="fifo">First in, first out (default)</option>
            <option value="priority">Priority: critical first</option>
            <option value="shortest">Shortest estimated time first</option>
            <option value="deadline">Nearest deadline first</option>
          </Select>
          <Button size="sm" variant="outline" onClick={() => void s.sortQueue()}>Reorganise the queue now</Button>
          <span className="text-xs text-muted basis-full">Used when NEXUS plans tasks (Auto-plan), pushes unfinished ones forward, and when you reorganise the queue. First in, first out keeps tasks in the order you added them.</span>
        </div>
        <Toggle
          checked={settings.smartProtectFixed}
          onChange={(v) => set("smartProtectFixed", v)}
          label="Protect Fixed Appointments"
          description="Fixed appointments are never moved, shortened or overwritten automatically, and you are asked before dragging one. Nothing is ever planned inside a fixed appointment, whatever this is set to."
        />
        <Toggle checked={settings.smartNotify} onChange={(v) => set("smartNotify", v)} label="Rescheduling Notifications" description="Tell me whenever NEXUS moves something. Moves are always recorded in History, and you are always told when NEXUS needs your decision." />
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Preferred Time Zone" hint="Used when a request names no zone. “Kenya time” or “Texas time” in the request always wins.">
            <Select value={settings.smartZone} onChange={(e) => set("smartZone", e.target.value)}>
              <option value="home">Home time zone ({settings.homeZone})</option>
              <option value={KENYA_ZONE}>Kenya ({KENYA_ZONE})</option>
              <option value={settings.texasZone}>Texas ({settings.texasZone})</option>
              {[...new Set([settings.smartZone, ...ZONES])].filter((z) => z !== "home" && z !== KENYA_ZONE && z !== settings.texasZone).map((z) => <option key={z} value={z}>{z}</option>)}
            </Select>
          </Field>
          <Field label="Scheduling Buffer (minutes)" hint="Free time kept before and after every appointment.">
            <Input type="number" min={0} max={60} value={settings.planBufferMin} onChange={(e) => set("planBufferMin", Math.max(0, Math.min(60, Number(e.target.value) || 0)))} />
          </Field>
        </div>
        <div>
          <span className="text-xs font-medium text-fg-2">Preferred Working Hours</span>
          <div className="grid sm:grid-cols-3 gap-3 items-end mt-1.5">
            <Field label="From (hour)"><Input type="number" min={0} max={23} value={settings.workStartHour} onChange={(e) => set("workStartHour", Math.min(settings.workEndHour - 1, Math.max(0, Number(e.target.value))))} /></Field>
            <Field label="To (hour)"><Input type="number" min={1} max={24} value={settings.workEndHour} onChange={(e) => set("workEndHour", Math.max(settings.workStartHour + 1, Math.min(24, Number(e.target.value))))} /></Field>
            <p className="text-[11px] text-muted pb-2">In your home zone, on your working days (set under Time zones & working hours). Tasks with no day or time given are placed here.</p>
          </div>
        </div>
        <div>
          <span className="text-xs font-medium text-fg-2">Scheduling Preferences — what morning, afternoon and evening mean (hours)</span>
          <div className="grid grid-cols-3 gap-3 mt-1.5">
            {(["morning", "afternoon", "evening"] as const).map((p) => (
              <Field key={p} label={p[0].toUpperCase() + p.slice(1)}>
                <div className="flex items-center gap-1.5">
                  <Input type="number" min={0} max={23} aria-label={`${p} from`} value={settings.smartPeriods[p][0]} onChange={(e) => set("smartPeriods", { ...settings.smartPeriods, [p]: [Math.max(0, Math.min(settings.smartPeriods[p][1] - 1, Number(e.target.value) || 0)), settings.smartPeriods[p][1]] })} />
                  <span className="text-muted text-xs">to</span>
                  <Input type="number" min={1} max={24} aria-label={`${p} to`} value={settings.smartPeriods[p][1]} onChange={(e) => set("smartPeriods", { ...settings.smartPeriods, [p]: [settings.smartPeriods[p][0], Math.max(settings.smartPeriods[p][0] + 1, Math.min(24, Number(e.target.value) || 24))] })} />
                </div>
              </Field>
            ))}
          </div>
          <p className="text-[11px] text-muted mt-1.5">These hours are read in the zone of the request, so “evening Kenya time” is evening in Nairobi wherever this PC is.</p>
        </div>
      </Section>

      <Section id="planning" title="Auto-placement" icon={<Wand2 size={16} />}>
        <Toggle checked={settings.autoPlaceNewTasks} onChange={(v) => set("autoPlaceNewTasks", v)} label="Schedule new tasks automatically" description="A new task with no start time gets the soonest free time in your working hours, before its deadline (an hour when it has no estimate). If your working hours have no room before the deadline, the soonest free time at any hour is used. Every placement can be undone, and existing appointments are never moved." />
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Buffer around blocks (minutes)"><Input type="number" min={0} max={60} value={settings.planBufferMin} onChange={(e) => set("planBufferMin", Math.max(0, Math.min(60, Number(e.target.value) || 0)))} /></Field>
          <Field label="Longest single block (minutes)" hint="Longer tasks are split across several blocks."><Input type="number" min={30} max={480} value={settings.planChunkMaxMin} onChange={(e) => set("planChunkMaxMin", Math.max(30, Math.min(480, Number(e.target.value) || 120)))} /></Field>
        </div>
      </Section>

      <Section id="focus" title="Focus (Pomodoro)" icon={<Target size={16} />}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Focus (min)"><Input type="number" min={1} value={settings.pomodoroFocusMin} onChange={(e) => set("pomodoroFocusMin", Math.max(1, Number(e.target.value)))} /></Field>
          <Field label="Short break"><Input type="number" min={1} value={settings.pomodoroShortBreakMin} onChange={(e) => set("pomodoroShortBreakMin", Math.max(1, Number(e.target.value)))} /></Field>
          <Field label="Long break"><Input type="number" min={1} value={settings.pomodoroLongBreakMin} onChange={(e) => set("pomodoroLongBreakMin", Math.max(1, Number(e.target.value)))} /></Field>
          <Field label="Long break every"><Input type="number" min={1} value={settings.pomodoroLongEvery} onChange={(e) => set("pomodoroLongEvery", Math.max(1, Number(e.target.value)))} /></Field>
        </div>
      </Section>

      <Section id="overlay" title="Floating overlay" icon={<PanelTop size={16} />}>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={settings.overlayMode} onChange={(v) => set("overlayMode", v)} options={[{ value: "mini", label: "Mini" }, { value: "standard", label: "Standard" }, { value: "expanded", label: "Expanded" }]} />
        </div>
        <Toggle
          checked={overlay.visible}
          disabled={!native}
          onChange={(v) => void setOverlayVisible(v)}
          label="Show the floating overlay"
          description={`Closing the overlay only hides it; NEXUS keeps running. Bring it back here, from the Overlay switch in the sidebar, the tray menu, or with ${settings.shortcuts.toggleOverlay.replace("CommandOrControl", "Ctrl")}.`}
        />
        <Field label={`Opacity — ${Math.round(settings.overlayOpacity * 100)}%`}>
          <input type="range" min={25} max={100} value={Math.round(settings.overlayOpacity * 100)} onChange={(e) => set("overlayOpacity", clampOpacity(Number(e.target.value) / 100))} className="accent-sky-500" />
        </Field>
        <Toggle checked={settings.overlayOnStartup} onChange={(v) => set("overlayOnStartup", v)} label="Show the overlay when NEXUS starts" />
        <Toggle checked={settings.overlayPerf} onChange={(v) => set("overlayPerf", v)} label="Show system performance (CPU, GPU, VRAM, RAM)" description="Sampled about once a second, only while the overlay is visible. CPU matches Task Manager; RAM is shown as a percentage with used / total." />
        <Toggle checked={settings.overlayGraph} disabled={!settings.overlayPerf} onChange={(v) => set("overlayGraph", v)} label="Show a live performance graph" description="An animated graph of one metric over the last minute (Standard and Expanded modes). Click any stat in the overlay to graph it." />
        <div className={cx("flex items-center gap-3", !(settings.overlayPerf && settings.overlayGraph) && "opacity-50")}>
          <span className="text-sm">Graph shows</span>
          <Select className="!w-40" value={settings.perfGraphMetric} disabled={!(settings.overlayPerf && settings.overlayGraph)} onChange={(e) => set("perfGraphMetric", e.target.value as PerfMetric)}>
            {(Object.keys(METRIC_LABEL) as PerfMetric[]).map((m) => <option key={m} value={m}>{m === "temp" ? "Temperature" : METRIC_LABEL[m]}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">Usage colour: yellow from</span>
          <Input className="!w-20" type="number" min={1} max={98} aria-label="Elevated CPU threshold" value={settings.perfThresholds.cpu.elevated} onChange={(e) => set("perfThresholds", { cpu: { elevated: Math.max(1, Math.min(settings.perfThresholds.cpu.high - 1, Number(e.target.value) || 60)), high: settings.perfThresholds.cpu.high } })} />
          <span className="text-sm">%, red from</span>
          <Input className="!w-20" type="number" min={2} max={100} aria-label="High CPU threshold" value={settings.perfThresholds.cpu.high} onChange={(e) => set("perfThresholds", { cpu: { elevated: settings.perfThresholds.cpu.elevated, high: Math.max(settings.perfThresholds.cpu.elevated + 1, Math.min(100, Number(e.target.value) || 80)) } })} />
          <span className="text-sm">%</span>
          <span className="text-xs text-muted">Green below that. Used for the CPU, RAM, GPU and VRAM figures and their graphs, in the overlay and on the dashboard.</span>
        </div>
        <Toggle checked={settings.dashboardPerf} onChange={(v) => set("dashboardPerf", v)} label="Show the system monitor on the dashboard" description="The same live readings in the main window, sampled only while the dashboard is open." />
        <Toggle
          checked={settings.overlayFps}
          disabled={!settings.overlayPerf}
          onChange={(v) => set("overlayFps", v)}
          label="Show FPS of the foreground game/app"
          description="Counts DirectX frames like Game Bar. Windows only allows this for administrators or members of the “Performance Log Users” group — a lock icon means permission is missing (see README → FPS)."
        />
        <Toggle checked={settings.overlayTemp} disabled={!settings.overlayPerf} onChange={(v) => set("overlayTemp", v)} label="Show temperature gauge (GPU & CPU)" description="GPU temperature works on most modern graphics drivers. CPU temperature is only available when the PC's firmware exposes it to Windows (often requires running as administrator)." />
        <div className="flex items-center gap-3">
          <span className="text-sm">Temperature unit</span>
          <Segmented size="sm" value={settings.tempUnit} onChange={(v) => set("tempUnit", v)} options={[{ value: "C", label: "°C" }, { value: "F", label: "°F" }]} />
        </div>
        <div className="h-px bg-line my-1" />
        <Toggle
          checked={settings.overlayAllowClickThrough}
          onChange={async (v) => {
            await s.setSetting("overlayAllowClickThrough", v);
            if (!v) await setClickThrough(false);
          }}
          label="Allow click-through"
          description="Turn off to disable click-through completely: the overlay button, the global shortcut and the tray option will no longer enable it."
        />
        <Toggle
          checked={clickThroughOn}
          disabled={!native || !settings.overlayAllowClickThrough}
          onChange={(v) => void setClickThrough(v)}
          label="Click-through is on"
          description="When on, mouse clicks pass through the overlay to the app underneath."
        />
        <p className="text-[11px] text-muted">
          The overlay stays above normal windows and remembers its position, size and monitor. Click-through lets clicks pass to the app underneath — press {settings.shortcuts.toggleClickThrough.replace("CommandOrControl", "Ctrl")} to turn it off again. Like any desktop overlay it can't appear over exclusive-fullscreen games, the lock/UAC screen, or protected content; use borderless/windowed mode in games.
        </p>
      </Section>

      <Section id="typer" title="Auto Typer" icon={<Keyboard size={16} />}>
        <Toggle
          checked={settings.typerIdleReturn}
          onChange={(v) => set("typerIdleReturn", v)}
          label="Return to Dashboard After Inactivity"
          description="When the Auto Typer screen is left open with no keyboard or mouse activity, NEXUS goes back to the Dashboard. It never does this while the Auto Typer is typing, and your text and settings are kept."
        />
        <div className={cx("grid sm:grid-cols-2 gap-3", !settings.typerIdleReturn && "opacity-50")}>
          <Field label="After (minutes without activity)">
            <Input type="number" min={1} max={120} disabled={!settings.typerIdleReturn} value={settings.typerIdleReturnMin} onChange={(e) => set("typerIdleReturnMin", Math.max(1, Math.min(120, Number(e.target.value) || 5)))} />
          </Field>
        </div>
      </Section>

      <Section id="shortcuts" title="Global keyboard shortcuts" icon={<Keyboard size={16} />}>
        <p className="text-xs text-muted -mt-1">Work system-wide, even when NEXUS is in the background. Click a field and press a combination with Ctrl/Alt/Shift.</p>
        {(
          [
            ["toggleOverlay", "Show / hide overlay"],
            ["toggleClickThrough", "Toggle overlay click-through"],
            ["quickAdd", "Quick add task"],
            ["voice", "Voice command"],
            ["showMain", "Show NEXUS window"],
            ["toggleTyper", "Start / stop Auto Typer (while its screen is open)"],
          ] as [keyof Shortcuts, string][]
        ).map(([k, label]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <span className={cx("text-sm", failed.includes(shortcutDraft[k]) && "text-warning")}>{label}{failed.includes(shortcutDraft[k]) && " (in use by another app)"}</span>
            <ShortcutInput value={shortcutDraft[k]} onChange={(v) => void saveShortcuts({ ...shortcutDraft, [k]: v })} />
          </div>
        ))}
        <Button variant="ghost" size="sm" className="self-start" icon={<RefreshCw size={13} />} onClick={() => void saveShortcuts(DEFAULT_SHORTCUTS)}>Reset to defaults</Button>
      </Section>

      <Section id="startup" title="Startup & tray" icon={<Power size={16} />}>
        <Toggle checked={autostart} disabled={!native} onChange={async (v) => { try { await setAutostart(v); setAuto(v); } catch (e) { s.toast({ kind: "error", title: "Couldn't change startup setting", body: String(e) }); } }} label="Launch NEXUS when Windows starts" description="Starts quietly in the tray so reminders and the overlay are always available." />
        <Toggle checked={settings.startMinimized} onChange={(v) => set("startMinimized", v)} label="Start minimized to tray (when launched at startup)" />
        <Toggle checked={settings.closeToTray} onChange={(v) => set("closeToTray", v)} label="Closing the window keeps NEXUS running in the tray" description="Recommended — reminders need NEXUS running. Quit from the tray menu." />
      </Section>

      <Section id="voice" title="Voice input" icon={<Mic size={16} />}>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Speech engine" hint={native ? "Native = Windows speech recognition (requires 'Online speech recognition' in Windows privacy settings)." : webSpeechAvailable() ? "This browser supports Web Speech." : "Speech isn't available in this browser — keyboard only."}>
            <Select value={settings.voiceEngine} onChange={(e) => set("voiceEngine", e.target.value as Settings["voiceEngine"])}>
              <option value="auto">Automatic</option>
              {native && <option value="native">Windows speech recognition</option>}
              <option value="web">WebView speech API</option>
              <option value="keyboard">Off — keyboard only</option>
            </Select>
          </Field>
          <Field label="Language"><Select value={settings.voiceLanguage} onChange={(e) => set("voiceLanguage", e.target.value)}>{["en-US", "en-GB", "en-KE", "sw-KE"].map((l) => <option key={l}>{l}</option>)}</Select></Field>
        </div>
        <p className="text-[11px] text-muted">The microphone is used only while you hold a listening session (one command). NEXUS never records continuously. Status: {voiceSupported(settings.voiceEngine) ? "available" : "unavailable — type commands instead"}.</p>
      </Section>

      <Section id="ai" title="AI assistant (optional)" icon={<Brain size={16} />}>
        <Toggle checked={settings.aiEnabled} onChange={(v) => set("aiEnabled", v)} label="Enable Claude-powered suggestions" description="NEXUS works fully without this. When on, task/appointment titles and times (not notes) are sent to Anthropic only when you ask for an AI action." />
        <Toggle checked={settings.aiConsent} disabled={!settings.aiEnabled} onChange={(v) => set("aiConsent", v)} label="I consent to sending this data to Anthropic's API" />
        <div className="grid sm:grid-cols-[1fr_auto] gap-2 items-end">
          <Field label={hasKey ? "API key saved in Windows Credential Manager ✓" : "Anthropic API key"} hint="Stored by the Rust backend in the OS credential vault; the UI can never read it back.">
            <Input type="password" placeholder={hasKey ? "•••••••• (replace)" : "sk-ant-…"} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" disabled={!native} />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" disabled={!key.trim() || !native} onClick={async () => { try { await aiSetKey(key); setKey(""); setHasKey(true); s.toast({ kind: "success", title: "API key saved securely" }); } catch (e) { s.toast({ kind: "error", title: "Couldn't save key", body: String(e) }); } }}>Save key</Button>
            {hasKey && <Button variant="danger" onClick={async () => { await aiClearKey(); setHasKey(false); }}>Remove</Button>}
          </div>
        </div>
        <Field label="Model"><Input value={settings.aiModel} onChange={(e) => set("aiModel", e.target.value)} placeholder={DEFAULT_SETTINGS.aiModel} /></Field>
      </Section>

      <Section id="data" title="Data, backup & privacy" icon={<Database size={16} />}>
        {info ? (
          <div className="text-xs text-muted space-y-1 select-text">
            <p>Database: <span className="font-mono text-fg-2">{info.dbPath}</span> (schema v{info.schemaVersion})</p>
            <p>Backups: <span className="font-mono text-fg-2">{info.backupsDir}</span> — a rolling daily backup is kept automatically (7 days), plus one before every migration, restore and import.</p>
            {info.backups.length > 0 && <p>Latest: <span className="font-mono">{info.backups[0].split(/[\\/]/).pop()}</span> ({info.backups.length} total)</p>}
          </div>
        ) : (
          <p className="text-xs text-muted">Running in browser preview — data is stored in this browser's localStorage. The desktop app stores everything in a local SQLite database.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="soft" disabled={!native} icon={<Download size={14} />} onClick={() => void backupNow()}>Back up database…</Button>
          <Button variant="soft" disabled={!native} icon={<Download size={14} />} onClick={() => void exportJson()}>Export JSON…</Button>
          <Button variant="outline" disabled={!native} icon={<Upload size={14} />} onClick={() => void restore("db")}>Restore backup…</Button>
          <Button variant="outline" disabled={!native} icon={<Upload size={14} />} onClick={() => void restore("json")}>Import JSON…</Button>
        </div>
        <p className="text-[11px] text-muted flex items-start gap-1.5"><Shield size={12} className="mt-0.5 shrink-0" /> All data stays on this PC. Nothing is uploaded anywhere unless you explicitly use the AI assistant. Backups are never committed to Git.</p>
      </Section>

      <Section id="keys" title="Keyboard reference" icon={<Keyboard size={16} />}>
        <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
          {[
            ["Ctrl K", "Command center"], ["N / Ctrl N", "New task"], ["E", "New appointment"], ["V", "Voice command"], ["/", "Search tasks"],
            ["1 – 9", "Switch views"], [",", "Settings"], ["Esc", "Close dialog"], ["← / →, T", "Calendar: previous/next, today"], ["D / W / M", "Calendar: day/week/month"],
            [settings.shortcuts.toggleOverlay.replace("CommandOrControl", "Ctrl"), "Show/hide overlay (global)"], [settings.shortcuts.toggleClickThrough.replace("CommandOrControl", "Ctrl"), "Overlay click-through (global)"],
            [settings.shortcuts.quickAdd.replace("CommandOrControl", "Ctrl"), "Quick add (global)"], [settings.shortcuts.voice.replace("CommandOrControl", "Ctrl"), "Voice (global)"],
            [settings.shortcuts.toggleTyper.replace("CommandOrControl", "Ctrl"), "Start / stop Auto Typer (global)"], ["Esc", "Stop Auto Typer while it types"],
          ].map(([k, d]) => (
            <div key={k + d} className="flex items-center justify-between gap-3"><span className="text-fg-2">{d}</span><Kbd>{k}</Kbd></div>
          ))}
        </div>
      </Section>

      <Section id="about" title="About" icon={<Info size={16} />}>
        <BrandBlock />
        <p className="text-[11px] text-muted text-center">NEXUS {__APP_VERSION__} · An AI Maverix product</p>
        <UpdatesAndFeedback />
      </Section>
    </div>
  );
}
