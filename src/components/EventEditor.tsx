import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, Star, Trash2, TriangleAlert } from "lucide-react";
import type { CalendarEvent } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { findConflicts } from "@/lib/schedule";
import { formatWithZone } from "@/lib/time";
import { humanDuration } from "@/lib/countdown";
import { Button, Field, Input, Modal, Select, Textarea, Toggle } from "./ui";
import { ZonedDateTime } from "./ZonedDateTime";
import { RecurrencePicker } from "./RecurrencePicker";
import { ReminderPicker } from "./ReminderPicker";
import { choose, confirm } from "./Confirm";

type Draft = Pick<CalendarEvent, "title" | "notes" | "startAt" | "endAt" | "tz" | "taskId" | "recurrence" | "important" | "reminders">;

export function EventEditor() {
  const { open, eventId, draft, occurrenceStart } = useUI((s) => s.eventEditor);
  const close = useUI((s) => s.closeEvent);
  const { events, tasks, settings } = useNexus((s) => ({ events: s.events, tasks: s.tasks, settings: s.settings }));
  const existing = eventId ? events.find((e) => e.id === eventId) : undefined;
  const [d, setD] = useState<Draft | null>(null);

  useEffect(() => {
    if (!open) return;
    if (existing) setD({ ...existing });
    else {
      const start = draft?.startAt ?? Math.ceil(Date.now() / 900_000) * 900_000;
      setD({
        title: draft?.title ?? "",
        notes: "",
        startAt: start,
        endAt: draft?.endAt ?? start + 3600_000,
        tz: settings.homeZone,
        taskId: draft?.taskId ?? null,
        recurrence: null,
        important: false,
        reminders: [...settings.defaultReminders],
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, eventId]);

  const conflicts = useMemo(() => (d ? findConflicts(events, { start: d.startAt, end: d.endAt }, existing?.id) : []), [d, events, existing?.id]);
  if (!d) return null;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => (x ? { ...x, [k]: v } : x));
  const duration = d.endAt - d.startAt;
  const valid = d.title.trim() && d.endAt > d.startAt;

  const save = async () => {
    if (!valid) return;
    const s = nexus();
    if (conflicts.length) {
      const ok = await confirm({
        title: "Double-booking warning",
        body: (
          <>
            This overlaps with:
            <ul className="mt-2 list-disc pl-5">
              {conflicts.slice(0, 4).map((c) => (
                <li key={c.event.id + c.start}>
                  <b>{c.event.title}</b> — {formatWithZone(c.start, settings.homeZone, settings.hour12)}
                </li>
              ))}
            </ul>
            <p className="mt-2">Book it anyway?</p>
          </>
        ),
        confirmLabel: "Book anyway",
        danger: true,
      });
      if (!ok) return;
    }
    if (existing) {
      if (existing.important && (existing.startAt !== d.startAt || existing.endAt !== d.endAt)) {
        const ok = await confirm({ title: "Move an important appointment?", body: `“${existing.title}” is marked important. Confirm the new time ${formatWithZone(d.startAt, d.tz, settings.hour12)}.`, confirmLabel: "Move it" });
        if (!ok) return;
      }
      await s.updateEvent(existing.id, { ...d, title: d.title.trim() });
    } else {
      await s.addEvent({ ...d, title: d.title.trim() });
    }
    close();
  };

  const remove = async () => {
    if (!existing) return;
    if (existing.recurrence && occurrenceStart != null) {
      const which = await choose({
        title: "Delete recurring appointment",
        body: `“${existing.title}” repeats. Delete just this occurrence, or the whole series? (Undo is available.)`,
        danger: true,
        choices: [
          { value: "one", label: "Only this one", variant: "soft" },
          { value: "all", label: "Entire series", variant: "danger" },
        ],
      });
      if (!which) return;
      if (which === "one") {
        await nexus().updateEvent(existing.id, { recurrence: { ...existing.recurrence, exdates: [...(existing.recurrence.exdates ?? []), occurrenceStart] } });
        close();
        return;
      }
    }
    await nexus().deleteEvent(existing.id);
    close();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={existing ? "Edit appointment" : "New appointment"}
      icon={<CalendarClock size={18} />}
      width={620}
      footer={
        <>
          {existing && (
            <Button variant="danger" className="mr-auto" icon={<Trash2 size={14} />} onClick={remove}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!valid} icon={<Check size={15} />}>
            {existing ? "Save" : "Schedule"}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Input autoFocus placeholder="Appointment title" value={d.title} onChange={(e) => set("title", e.target.value)} className="!h-11 !text-base font-medium" aria-label="Title" />
        <Field label="Starts">
          <ZonedDateTime
            value={d.startAt}
            zone={d.tz}
            allowEmpty={false}
            onChange={(ms, z) => ms != null && setD((x) => (x ? { ...x, startAt: ms, endAt: ms + (x.endAt - x.startAt), tz: z } : x))}
            homeZone={settings.homeZone}
            texasZone={settings.texasZone}
            hour12={settings.hour12}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Ends" hint={duration > 0 ? `Duration ${humanDuration(duration)}` : "End must be after start"}>
            <ZonedDateTime value={d.endAt} zone={d.tz} allowEmpty={false} showEquivalents={false} onChange={(ms) => ms != null && set("endAt", ms)} homeZone={settings.homeZone} texasZone={settings.texasZone} hour12={settings.hour12} />
          </Field>
          <Field label="Quick duration">
            <div className="flex gap-1">
              {[15, 30, 60, 90, 120].map((m) => (
                <Button key={m} type="button" size="sm" variant={duration === m * 60_000 ? "primary" : "soft"} onClick={() => set("endAt", d.startAt + m * 60_000)}>
                  {m < 60 ? `${m}m` : `${m / 60}h`}
                </Button>
              ))}
            </div>
          </Field>
        </div>
        {conflicts.length > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-[color-mix(in_oklab,var(--warning)_40%,transparent)] bg-[color-mix(in_oklab,var(--warning)_10%,transparent)] px-3 py-2 text-xs text-warning">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              Overlaps {conflicts.map((c) => `“${c.event.title}”`).slice(0, 3).join(", ")}
              {conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : ""}.
            </span>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Linked task (time block)">
            <Select value={d.taskId ?? ""} onChange={(e) => set("taskId", e.target.value || null)}>
              <option value="">None</option>
              {tasks.filter((t) => !t.deletedAt && t.status !== "done").map((t) => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </Select>
          </Field>
          <Field label="Repeat">
            <RecurrencePicker value={d.recurrence} onChange={(r) => set("recurrence", r)} />
          </Field>
        </div>
        <Field label="Reminders">
          <ReminderPicker value={d.reminders} onChange={(v) => set("reminders", v)} />
        </Field>
        <Toggle checked={d.important} onChange={(v) => set("important", v)} label={<span className="inline-flex items-center gap-1.5"><Star size={14} className="text-warning" /> Important</span>} description="Important appointments are never moved without your explicit confirmation." />
        <Field label="Notes">
          <Textarea rows={2} value={d.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Agenda, links, dial-in…" />
        </Field>
        <p className="text-[11px] text-muted">Saved in its original time zone ({d.tz}). Shown everywhere in Kenya and Texas time.</p>
      </form>
    </Modal>
  );
}
