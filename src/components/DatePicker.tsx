import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DateTime } from "luxon";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cx } from "./ui";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const POP_W = 292;

/**
 * Date (and time) field with a calendar popup: click a day, set the time
 * underneath, done. The value is an instant; `zone` is the zone the calendar
 * days and the time are read in.
 */
export function DateTimePicker({
  value, zone, onChange, hour12, withTime = true, allowEmpty = false, min, placeholder = "Pick a date", className, ariaLabel, format,
}: {
  /** Custom text for the button (the calendar still opens on the value). */
  format?: () => string;
  value: number | null;
  zone: string;
  onChange: (ms: number | null) => void;
  hour12: boolean;
  withTime?: boolean;
  allowEmpty?: boolean;
  /** Days before this instant's day cannot be picked. */
  min?: number;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const selected = value != null ? DateTime.fromMillis(value, { zone }) : null;
  const today = DateTime.now().setZone(zone);
  const [month, setMonth] = useState<DateTime>(() => (selected ?? today).startOf("month"));

  useEffect(() => {
    if (open) setMonth((selected ?? today).startOf("month"));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const place = () => {
      const r = btn.current!.getBoundingClientRect();
      const h = pop.current?.offsetHeight ?? 360;
      const below = r.bottom + 6;
      const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
      setPos({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, month]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const days = useMemo(() => {
    const first = month.startOf("month");
    const start = first.minus({ days: first.weekday - 1 });
    return Array.from({ length: 42 }, (_, i) => start.plus({ days: i }));
  }, [month]);

  const minDay = min != null ? DateTime.fromMillis(min, { zone }).startOf("day") : null;
  const timeOf = selected ?? today.set({ hour: 9, minute: 0 });
  const pick = (d: DateTime) => {
    onChange(d.set({ hour: timeOf.hour, minute: timeOf.minute, second: 0, millisecond: 0 }).toMillis());
    if (!withTime) setOpen(false);
  };
  const setTime = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    onChange((selected ?? today).set({ hour: h, minute: m, second: 0, millisecond: 0 }).toMillis());
  };
  const label = format ? format() : selected ? selected.toFormat(withTime ? (hour12 ? "ccc d LLL yyyy · h:mm a" : "ccc d LLL yyyy · HH:mm") : "ccc d LLL yyyy") : placeholder;
  const quick: [string, DateTime][] = [["Today", today], ["Tomorrow", today.plus({ days: 1 })], ["In a week", today.plus({ days: 7 })]];

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "h-9 px-3 rounded-xl border bg-hover text-sm text-left inline-flex items-center gap-2 min-w-0 transition",
          open ? "border-accent" : "border-line hover:border-[color-mix(in_oklab,var(--accent)_50%,var(--border))]",
          className,
        )}
      >
        <CalendarDays size={15} className="text-accent shrink-0" />
        <span className={cx("truncate tabular", selected ? "text-fg" : "text-muted")}>{label}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            data-popover
            role="dialog"
            aria-label="Choose a date"
            className="fixed z-[80] glass-strong rounded-2xl shadow-2xl border border-line p-3 select-none"
            style={{ width: POP_W, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          >
            <div className="flex items-center justify-between mb-2">
              <button type="button" aria-label="Previous month" className="h-7 w-7 rounded-lg hover:bg-hover flex items-center justify-center text-fg-2" onClick={() => setMonth((m) => m.minus({ months: 1 }))}><ChevronLeft size={16} /></button>
              <div className="text-sm font-semibold font-display">{month.toFormat("LLLL yyyy")}</div>
              <button type="button" aria-label="Next month" className="h-7 w-7 rounded-lg hover:bg-hover flex items-center justify-center text-fg-2" onClick={() => setMonth((m) => m.plus({ months: 1 }))}><ChevronRight size={16} /></button>
            </div>
            <div className="grid grid-cols-7 text-center text-[10px] uppercase tracking-wider text-muted mb-1">
              {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
            </div>
            <div className="grid grid-cols-7 gap-0.5" role="grid">
              {days.map((d) => {
                const out = d.month !== month.month;
                const isToday = d.hasSame(today, "day");
                const isSel = !!selected && d.hasSame(selected, "day");
                const disabled = !!minDay && d < minDay;
                return (
                  <button
                    key={d.toISODate()}
                    type="button"
                    disabled={disabled}
                    aria-label={d.toFormat("cccc d LLLL yyyy")}
                    aria-pressed={isSel}
                    onClick={() => pick(d)}
                    className={cx(
                      "h-8 rounded-lg text-[12px] tabular transition",
                      isSel ? "bg-accent text-white font-semibold shadow-[0_0_12px_color-mix(in_oklab,var(--accent)_55%,transparent)]" : "hover:bg-hover",
                      !isSel && (out ? "text-muted/50" : d.weekday > 5 ? "text-fg-2" : "text-fg"),
                      !isSel && isToday && "ring-1 ring-accent text-accent font-semibold",
                      disabled && "opacity-30 pointer-events-none",
                    )}
                  >
                    {d.day}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {quick.map(([name, d]) => (
                <button key={name} type="button" onClick={() => { setMonth(d.startOf("month")); pick(d); }} className="h-7 px-2.5 rounded-lg border border-line text-[11px] font-medium text-fg-2 hover:text-accent hover:border-accent transition">{name}</button>
              ))}
              {allowEmpty && value != null && (
                <button type="button" onClick={() => { onChange(null); setOpen(false); }} className="h-7 px-2 rounded-lg text-[11px] font-medium text-muted hover:text-danger inline-flex items-center gap-1 ml-auto"><X size={12} />Clear</button>
              )}
            </div>
            {withTime && (
              <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-line">
                <span className="text-[11px] text-muted">Time</span>
                <input
                  type="time"
                  aria-label="Time"
                  value={timeOf.toFormat("HH:mm")}
                  onChange={(e) => setTime(e.target.value)}
                  className="h-8 px-2 rounded-lg border border-line bg-hover text-sm tabular text-fg outline-none focus:border-accent"
                />
                <button type="button" onClick={() => setOpen(false)} className="ml-auto h-8 px-3 rounded-lg bg-accent text-white text-xs font-semibold hover:brightness-110">Done</button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
