import { DateTime } from "luxon";
import type { CalendarEvent } from "@/data/types";
import type { Interval } from "@/lib/schedule";
import { formatTime, zoneAbbr } from "@/lib/time";

/** "Today", "Tomorrow" or "Fri 20 Nov", as seen in `zone`. */
export function dayLabel(ms: number, zone: string, now: number): string {
  const d = DateTime.fromMillis(ms, { zone });
  const today = DateTime.fromMillis(now, { zone });
  if (d.hasSame(today, "day")) return "Today";
  if (d.hasSame(today.plus({ days: 1 }), "day")) return "Tomorrow";
  if (d.hasSame(today.minus({ days: 1 }), "day")) return "Yesterday";
  return d.toFormat(d.year === today.year ? "ccc d LLL" : "ccc d LLL yyyy");
}

/** "Today 5:00 PM – 8:00 PM EAT" */
export function slotLabel(slot: Interval, zone: string, hour12: boolean, now: number): string {
  return `${dayLabel(slot.start, zone, now)} ${formatTime(slot.start, zone, hour12)} – ${formatTime(slot.end, zone, hour12)} ${zoneAbbr(zone, slot.start)}`;
}

/** The same slot in another zone, with the day when it differs: "8:00 AM – 11:00 AM CST". */
export function slotElsewhere(slot: Interval, zone: string, fromZone: string, hour12: boolean): string {
  const here = DateTime.fromMillis(slot.start, { zone: fromZone });
  const there = DateTime.fromMillis(slot.start, { zone });
  const day = here.hasSame(there.setZone(fromZone, { keepLocalTime: true }), "day") ? "" : `${there.toFormat("ccc")} `;
  return `${day}${formatTime(slot.start, zone, hour12)} – ${formatTime(slot.end, zone, hour12)} ${zoneAbbr(zone, slot.start)}`;
}

/** One line per automatic move, newest first, for tooltips. */
export function moveHistory(e: CalendarEvent, hour12: boolean): string[] {
  return [...(e.sched?.history ?? [])]
    .reverse()
    .map((h) => {
      const f = DateTime.fromMillis(h.from[0], { zone: e.tz });
      const t = DateTime.fromMillis(h.to[0], { zone: e.tz });
      const fmt = (d: DateTime) => `${d.toFormat("ccc d LLL")} ${formatTime(d.toMillis(), e.tz, hour12)}`;
      return `${fmt(f)} → ${fmt(t)} (${h.reason === "unfinished" ? "not completed in its time" : "a fixed appointment took its time"})`;
    });
}

/** Short text for a block NEXUS has moved or wants the user to look at; null otherwise. */
export function autoBadge(e: CalendarEvent): { text: string; attention: boolean } | null {
  if (e.sched?.attention) return { text: "Needs a new time", attention: true };
  const n = e.sched?.moves ?? 0;
  if (e.sched?.origin === "auto" && n > 0) return { text: n > 1 ? `Auto-rescheduled ×${n}` : "Auto-rescheduled", attention: false };
  return null;
}
