import { useMemo, useRef, useState } from "react";
import { CalendarCheck, Clock, Globe, Hourglass, Lock, Sparkles, Sun, TriangleAlert, Undo2 } from "lucide-react";
import type { CalendarEvent, Task } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { useNow } from "@/lib/ticker";
import type { Interval } from "@/lib/schedule";
import { KENYA_ZONE } from "@/lib/time";
import { fmtMinutes, parseScheduleRequest, type Clarification } from "@/lib/smart/parse";
import { resolveRequest } from "@/lib/smart/slots";
import { slotElsewhere, slotLabel } from "@/lib/smart/format";
import { Button, Card, cx } from "./ui";

function Chip({ icon, children, tone }: { icon: React.ReactNode; children: React.ReactNode; tone?: "accent" | "warning" }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs", tone === "warning" ? "bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-warning" : tone === "accent" ? "bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-accent" : "bg-hover text-fg-2")}>
      {icon}
      {children}
    </span>
  );
}

/**
 * "Tell NEXUS what to schedule": type a request in plain words, see how it was
 * understood and which free time was chosen, and press Enter to put it in the
 * To-Do list and on the calendar. Works fully offline.
 */
export function SmartScheduleBar({ className }: { className?: string }) {
  const { events, settings } = useNexus((s) => ({ events: s.events, settings: s.settings }));
  const tick = useNow();
  // Re-evaluate once a minute, not every second.
  const now = Math.floor(tick / 60_000) * 60_000;
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<Partial<Record<Clarification["id"], string>>>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ task: Task | null; event: CalendarEvent } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const zone = settings.smartZone === "home" ? settings.homeZone : settings.smartZone;
  const req = useMemo(() => (text.trim() ? parseScheduleRequest(text, { now, defaultZone: zone, texasZone: settings.texasZone }, answers) : null), [text, answers, now, zone, settings.texasZone]);
  const res = useMemo(
    () => (req && req.title && !req.questions.length ? resolveRequest(req, events, nexus().slotSettings(), now) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [req, events, now, settings.planBufferMin, settings.smartPeriods, settings.workStartHour, settings.workEndHour, settings.workDays],
  );
  if (!settings.smartEnabled) return null;

  const otherZone = req && req.zone === settings.texasZone ? KENYA_ZONE : settings.texasZone;
  const describe = (slot: Interval) => (req ? `${slotLabel(slot, req.zone, settings.hour12, now)} · ${slotElsewhere(slot, otherZone, req.zone, settings.hour12)}` : "");

  const schedule = async (slot: Interval) => {
    if (!req || !res || busy) return;
    setBusy(true);
    try {
      const made = await nexus().smartCreate(req, slot, Math.round((slot.end - slot.start) / 60_000));
      setCreated(made);
      setText("");
      setAnswers({});
    } catch (e) {
      nexus().toast({ kind: "error", title: "Couldn't schedule that", body: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const undo = async () => {
    if (!created) return;
    await nexus().deleteEvent(created.event.id);
    if (created.task) await nexus().deleteTask(created.task.id);
    setCreated(null);
  };

  const ready = !!res && res.status === "ok" && !!res.slot;
  const showInCalendar = () => {
    useUI.getState().setView("calendar");
  };

  return (
    <Card className={cx("p-4 flex flex-col gap-3", className)}>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void schedule(res!.slot!);
        }}
      >
        <div className="h-9 w-9 shrink-0 rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 text-white flex items-center justify-center" aria-hidden>
          <Sparkles size={17} />
        </div>
        <input
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setAnswers({});
            if (created) setCreated(null);
          }}
          aria-label="Describe what to schedule"
          placeholder="Tell NEXUS what to schedule — e.g. “Repairing Mineh's phone today, around 3 hours, preferably in the evening Kenya time”"
          className="flex-1 min-w-0 h-10 rounded-xl bg-hover border border-line px-3 text-sm text-fg placeholder:text-muted outline-none focus:border-accent focus:ring-2 focus:ring-[var(--glow)] transition"
        />
        <Button type="submit" variant="primary" disabled={!ready || busy} icon={<CalendarCheck size={15} />}>Schedule</Button>
      </form>

      {req && (
        <div className="flex flex-col gap-2.5" aria-live="polite">
          <div className="flex flex-wrap items-center gap-1.5">
            {req.title ? <span className="text-sm font-semibold text-fg mr-1">{req.title}</span> : <span className="text-sm text-muted">Say what it is, then when — for example “Write report tomorrow morning for 2 hours”.</span>}
            {req.fixed && <Chip icon={<Lock size={12} />} tone="accent">Fixed appointment</Chip>}
            {req.window && <Chip icon={<CalendarCheck size={12} />}>{req.window.label}</Chip>}
            {req.period && <Chip icon={<Sun size={12} />}>{req.later ? "later, " : ""}{req.period}</Chip>}
            {req.startAt != null && !req.questions.some((q) => q.id === "meridiem") && <Chip icon={<Clock size={12} />}>{req.startApprox ? "around " : "at "}{slotLabel({ start: req.startAt, end: req.startAt }, req.zone, settings.hour12, now).split(" – ")[0].replace(/^\S+\s/, "")}</Chip>}
            {(req.durationMin != null || res) && <Chip icon={<Hourglass size={12} />}>{req.durationApprox ? "about " : ""}{fmtMinutes(req.durationMin ?? res!.durationMin)}{req.durationMin == null ? " (assumed)" : ""}</Chip>}
            {req.deadlineLabel && <Chip icon={<TriangleAlert size={12} />} tone="warning">by {req.deadlineLabel}</Chip>}
            {req.beforeNextMeeting && <Chip icon={<TriangleAlert size={12} />} tone="warning">before the next meeting</Chip>}
            {req.priority && <Chip icon={<TriangleAlert size={12} />}>{req.priority} priority</Chip>}
            <Chip icon={<Globe size={12} />}>{req.zoneLabel ?? req.zone}</Chip>
          </div>

          {req.questions.map((q) => (
            <div key={q.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-[color-mix(in_oklab,var(--accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)] px-3 py-2">
              <span className="text-sm text-fg">{q.question}</span>
              {q.options.map((o) => (
                <Button key={o.value} size="sm" variant="soft" onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.value }))}>{o.label}</Button>
              ))}
            </div>
          ))}

          {res && res.status === "ok" && res.slot && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5 font-medium text-success"><CalendarCheck size={15} /> {describe(res.slot)}</span>
              <span className="text-xs text-muted">{res.message} Press Enter to schedule{res.late ? " — this ends after the deadline" : ""}.</span>
            </div>
          )}

          {res && res.status !== "ok" && (
            <div className="flex flex-col gap-2 rounded-xl border border-[color-mix(in_oklab,var(--warning)_40%,transparent)] bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] px-3 py-2.5">
              <span className="inline-flex items-start gap-1.5 text-sm text-warning"><TriangleAlert size={15} className="mt-0.5 shrink-0" /> {res.message}</span>
              {res.alternatives.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {res.alternatives.map((a) => (
                    <Button key={a.start} size="sm" variant="soft" disabled={busy} onClick={() => void schedule(a)} title="Schedule at this time instead">{slotLabel(a, req.zone, settings.hour12, now)}</Button>
                  ))}
                  {res.status === "conflict" && res.slot && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void schedule(res.slot!)} title="Book it at the requested time even though it overlaps">Book anyway</Button>
                  )}
                </div>
              )}
            </div>
          )}

          {[...req.notes, ...(res?.notes ?? [])].length > 0 && <p className="text-[11px] text-muted">{[...req.notes, ...(res?.notes ?? [])].join(" ")}</p>}
        </div>
      )}

      {created && !req && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-[color-mix(in_oklab,var(--success)_10%,transparent)] border border-[color-mix(in_oklab,var(--success)_35%,transparent)] px-3 py-2" role="status">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
            {created.event.fixed ? <Lock size={14} /> : <CalendarCheck size={15} />} Scheduled: {created.event.title}
          </span>
          <span className="text-sm text-fg-2 tabular">
            {slotLabel({ start: created.event.startAt, end: created.event.endAt }, created.event.tz, settings.hour12, now)} · {slotElsewhere({ start: created.event.startAt, end: created.event.endAt }, created.event.tz === settings.texasZone ? KENYA_ZONE : settings.texasZone, created.event.tz, settings.hour12)}
          </span>
          <span className="text-xs text-muted">{created.task ? "In your To-Do list and on the calendar." : "Fixed appointment on the calendar."}</span>
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={showInCalendar}>Open calendar</Button>
            <Button size="sm" variant="ghost" icon={<Undo2 size={13} />} onClick={() => void undo()}>Undo</Button>
          </span>
        </div>
      )}
    </Card>
  );
}
