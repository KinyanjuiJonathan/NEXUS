import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import { CalendarClock, Lock } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { planBulk, type BulkTarget } from "@/lib/smart/reschedule";
import { formatWithZone } from "@/lib/time";
import { Button, Input, Modal, cx } from "./ui";

const HOUR = 3600_000;
const SHIFTS: { label: string; ms: number }[] = [
  { label: "30 min", ms: HOUR / 2 },
  { label: "1 hour", ms: HOUR },
  { label: "2 hours", ms: 2 * HOUR },
  { label: "4 hours", ms: 4 * HOUR },
  { label: "1 day", ms: 24 * HOUR },
  { label: "1 week", ms: 7 * 24 * HOUR },
];

/**
 * Move every open task's reserved time at once: later by a set amount, or
 * starting again from a chosen date and time. Fixed appointments stay where
 * they are; the preview shows exactly what will change before anything does.
 */
export function RescheduleAllDialog() {
  const open = useUI((s) => s.rescheduleAll);
  const close = () => useUI.getState().openRescheduleAll(false);
  const { tasks, events, settings } = useNexus((s) => ({ tasks: s.tasks, events: s.events, settings: s.settings }));
  const zone = settings.homeZone;
  const [mode, setMode] = useState<"shift" | "from">("shift");
  const [byMs, setByMs] = useState(HOUR);
  const [custom, setCustom] = useState("");
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // default "from": tomorrow at the start of the working day
    setAt(DateTime.now().setZone(zone).plus({ days: 1 }).set({ hour: settings.workStartHour, minute: 0, second: 0, millisecond: 0 }).toFormat("yyyy-LL-dd'T'HH:mm"));
    setMode("shift");
    setByMs(HOUR);
    setCustom("");
  }, [open, zone, settings.workStartHour]);

  const atMs = useMemo(() => {
    const d = DateTime.fromISO(at, { zone });
    return d.isValid ? d.toMillis() : null;
  }, [at, zone]);
  const customMs = custom.trim() ? Math.round(Number(custom) * 60_000) : null;
  const shiftMs = customMs != null ? customMs : byMs;
  const target: BulkTarget | null =
    mode === "shift" ? (Number.isFinite(shiftMs) && shiftMs > 0 ? { mode: "shift", byMs: shiftMs } : null) : atMs != null && atMs > Date.now() - 60_000 ? { mode: "from", at: atMs } : null;
  const moves = useMemo(
    () => (open && target ? planBulk(tasks, events, Date.now(), nexus().slotSettings(), target) : []),
    [open, tasks, events, mode, shiftMs, atMs], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const moving = moves.filter((m) => m.to);
  const stuck = moves.length - moving.length;
  const when = (ms: number) => formatWithZone(ms, zone, settings.hour12);

  const apply = async () => {
    if (!target || !moving.length) return;
    setBusy(true);
    try {
      await nexus().rescheduleAll(target);
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Reschedule all tasks"
      icon={<CalendarClock size={18} />}
      width={540}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!target || !moving.length || busy} onClick={() => void apply()}>
            {moving.length ? `Move ${moving.length} task${moving.length === 1 ? "" : "s"}` : "Nothing to move"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How to reschedule">
          {([["shift", "Push everything later", "Each task keeps its place in the order and moves by the same amount."], ["from", "Start again from a date and time", "Tasks before that moment line up from there, in the same order."]] as const).map(([id, label, hint]) => (
            <button
              key={id}
              role="radio"
              aria-checked={mode === id}
              onClick={() => setMode(id)}
              className={cx("rounded-xl border px-3 py-2.5 text-left transition", mode === id ? "border-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line hover:bg-hover")}
            >
              <div className={cx("text-sm font-semibold", mode === id ? "text-accent" : "text-fg")}>{label}</div>
              <div className="text-[11px] text-muted mt-0.5">{hint}</div>
            </button>
          ))}
        </div>

        {mode === "shift" ? (
          <div className="flex flex-wrap items-center gap-2">
            {SHIFTS.map((o) => (
              <button
                key={o.ms}
                onClick={() => { setByMs(o.ms); setCustom(""); }}
                aria-pressed={customMs == null && byMs === o.ms}
                className={cx("h-8 px-3 rounded-lg text-xs font-medium border transition", customMs == null && byMs === o.ms ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_10%,transparent)]" : "border-line text-fg-2 hover:text-fg")}
              >
                {o.label}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-xs text-muted">
              or
              <Input type="number" min={1} placeholder="minutes" value={custom} onChange={(e) => setCustom(e.target.value)} className="w-24 h-8" aria-label="Minutes to push by" />
              min
            </label>
          </div>
        ) : (
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            New start ({zone})
            <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="w-64" aria-label="New start date and time" />
            {atMs != null && atMs <= Date.now() - 60_000 && <span className="text-warning">Pick a time in the future.</span>}
          </label>
        )}

        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] font-semibold text-muted mb-1.5">Preview</p>
          {moves.length === 0 ? (
            <p className="text-sm text-muted">{target ? "No open tasks have time reserved on the calendar, so there is nothing to move." : "Choose how far to move the tasks."}</p>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-line max-h-56 overflow-y-auto scroll-y">
              {moves.map((m) => (
                <div key={m.eventId} className="px-3 py-2 text-sm min-w-0">
                  <div className="font-medium truncate">{m.title}</div>
                  <div className="text-[11px] text-muted tabular truncate">
                    {when(m.from.start)} → {m.to ? <span className="text-accent">{when(m.to.start)}</span> : <span className="text-warning">no free time found, stays where it is</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted mt-2 flex items-center gap-1.5">
            <Lock size={11} className="shrink-0" />
            Fixed appointments are not moved; tasks are fitted around them and your working hours.{stuck > 0 && ` ${stuck} task${stuck === 1 ? "" : "s"} could not be fitted in.`}
          </p>
        </div>
      </div>
    </Modal>
  );
}
