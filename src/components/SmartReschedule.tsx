import { useMemo } from "react";
import { CalendarClock, Wand2 } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { smartRescheduleOptions } from "@/lib/schedule";
import { formatTime, formatWithZone, KENYA_ZONE, zoneAbbr } from "@/lib/time";
import { humanDuration } from "@/lib/countdown";
import { Button, Modal } from "./ui";
import { confirm } from "./Confirm";

/**
 * Smart Reschedule: offers free future slots (working hours, existing calendar)
 * for a missed task or time block. Nothing changes until the user picks one.
 */
export function SmartReschedule() {
  const item = useUI((s) => s.reschedule);
  const close = () => useUI.getState().openReschedule(null);
  const { events, settings } = useNexus((s) => ({ events: s.events, settings: s.settings }));
  const options = useMemo(
    () =>
      item
        ? smartRescheduleOptions(item, events, { zone: settings.homeZone, startHour: settings.workStartHour, endHour: settings.workEndHour, days: settings.workDays }, Date.now(), 6)
        : [],
    [item, events, settings],
  );

  const apply = async (start: number, end: number) => {
    if (!item) return;
    const s = nexus();
    if (item.important) {
      const ok = await confirm({ title: "Reschedule important item?", body: `“${item.title}” is marked important. Move it to ${formatWithZone(start, settings.homeZone, settings.hour12)}?`, confirmLabel: "Move it" });
      if (!ok) return;
    }
    if (item.kind === "event") {
      await s.updateEvent(item.id, { startAt: start, endAt: end });
    } else {
      await s.updateTask(item.id, { dueAt: end, dueTz: settings.homeZone });
      // Also reserve the time so it doesn't get double-booked.
      await s.addEvent({ title: item.title, startAt: start, endAt: end, taskId: item.id, tz: settings.homeZone, reminders: [5] });
    }
    s.toast({ kind: "success", title: "Rescheduled", body: `${item.title} → ${formatWithZone(start, settings.homeZone, settings.hour12)}` });
    close();
  };

  return (
    <Modal open={!!item} onClose={close} title="Smart Reschedule" icon={<Wand2 size={18} />} width={520} footer={<Button variant="ghost" onClick={close}>Not now</Button>}>
      {item && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-2">
            <b className="text-fg">{item.title}</b> was planned for {formatWithZone(item.at, settings.homeZone, settings.hour12)} ({humanDuration(item.durationMs)}). Pick a new slot — based on your working hours ({settings.workStartHour}:00–{settings.workEndHour}:00) and existing calendar:
          </p>
          {options.length === 0 && <p className="text-sm text-muted">No free slots in the next two weeks within working hours. Try adjusting working hours in Settings.</p>}
          {options.map((o) => (
            <button key={o.start} onClick={() => apply(o.start, o.end)} className="group flex items-center gap-3 rounded-xl border border-line px-3.5 py-2.5 text-left hover:border-accent hover:bg-hover transition">
              <CalendarClock size={16} className="text-accent" />
              <div className="flex-1">
                <div className="text-sm font-medium text-fg">{formatWithZone(o.start, settings.homeZone, settings.hour12)} – {formatTime(o.end, settings.homeZone, settings.hour12)}</div>
                <div className="text-[11px] text-muted">
                  KE {formatTime(o.start, KENYA_ZONE, settings.hour12)} {zoneAbbr(KENYA_ZONE, o.start)} · TX {formatTime(o.start, settings.texasZone, settings.hour12)} {zoneAbbr(settings.texasZone, o.start)}
                </div>
              </div>
              <span className="text-xs text-accent opacity-0 group-hover:opacity-100">Use this slot →</span>
            </button>
          ))}
          <p className="text-[11px] text-muted">NEXUS never moves appointments automatically.</p>
        </div>
      )}
    </Modal>
  );
}
