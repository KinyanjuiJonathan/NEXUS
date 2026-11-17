import { DateTime } from "luxon";

/** Kenya never observes DST: always EAT (UTC+3). */
export const KENYA_ZONE = "Africa/Nairobi";
/** Most of Texas: Central time (CST/CDT). */
export const TEXAS_CENTRAL = "America/Chicago";
/**
 * El Paso & far West Texas: Mountain time (MST/MDT).
 * Note: tzdb has no "America/El_Paso" zone — El Paso is covered by America/Denver.
 * We accept "America/El_Paso" as an alias (see normalizeZone) for convenience.
 */
export const TEXAS_MOUNTAIN = "America/Denver";

const ZONE_ALIASES: Record<string, string> = {
  "America/El_Paso": TEXAS_MOUNTAIN,
  "US/Central": TEXAS_CENTRAL,
  "US/Mountain": TEXAS_MOUNTAIN,
};

/** Map aliases to canonical IANA zones; unknown/invalid zones fall back to `fallback`. */
export function normalizeZone(zone: string | null | undefined, fallback = "UTC"): string {
  if (!zone) return fallback;
  const z = ZONE_ALIASES[zone] ?? zone;
  return DateTime.now().setZone(z).isValid ? z : fallback;
}

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidZone(zone: string): boolean {
  return DateTime.now().setZone(zone).isValid;
}

export interface ZoneClock {
  zone: string;
  time: string;
  seconds: string;
  meridiem: string;
  date: string;
  weekday: string;
  /** Short zone name, e.g. EAT, CST, CDT, MST, MDT. */
  abbr: string;
  offset: string;
  isDST: boolean;
}

/** Short abbreviation for a zone at an instant. Luxon/ICU sometimes yields "GMT+3" for Nairobi, so normalise. */
export function zoneAbbr(zone: string, ms: number): string {
  const dt = DateTime.fromMillis(ms, { zone });
  if (zone === KENYA_ZONE) return "EAT";
  const short = dt.toFormat("ZZZZ");
  if (/^[A-Z]{2,5}$/.test(short)) return short;
  // ICU fallback for US zones when locale data lacks names.
  if (zone === TEXAS_CENTRAL) return dt.isInDST ? "CDT" : "CST";
  if (zone === TEXAS_MOUNTAIN) return dt.isInDST ? "MDT" : "MST";
  return short;
}

export function clockFor(zone: string, ms: number, hour12: boolean): ZoneClock {
  const dt = DateTime.fromMillis(ms, { zone });
  return {
    zone,
    time: hour12 ? dt.toFormat("h:mm") : dt.toFormat("HH:mm"),
    seconds: dt.toFormat("ss"),
    meridiem: hour12 ? dt.toFormat("a") : "",
    date: dt.toFormat("d LLL yyyy"),
    weekday: dt.toFormat("cccc"),
    abbr: zoneAbbr(zone, ms),
    offset: dt.toFormat("ZZ"),
    isDST: dt.isInDST,
  };
}

export function formatTime(ms: number, zone: string, hour12: boolean): string {
  const dt = DateTime.fromMillis(ms, { zone });
  return hour12 ? dt.toFormat("h:mm a") : dt.toFormat("HH:mm");
}

export function formatDateTime(ms: number, zone: string, hour12: boolean): string {
  const dt = DateTime.fromMillis(ms, { zone });
  return `${dt.toFormat("ccc d LLL")} · ${formatTime(ms, zone, hour12)}`;
}

/** "Fri 3:00 PM CDT" */
export function formatWithZone(ms: number, zone: string, hour12: boolean): string {
  return `${formatDateTime(ms, zone, hour12)} ${zoneAbbr(zone, ms)}`;
}

/**
 * Interpret a wall-clock time in a zone. Non-existent local times (spring-forward
 * gap) are shifted forward like most calendars do; ambiguous times (fall-back)
 * resolve to the earlier instant.
 */
export function wallTimeToUtc(
  zone: string,
  y: number,
  m: number,
  d: number,
  h = 0,
  min = 0,
): number {
  const dt = DateTime.fromObject({ year: y, month: m, day: d, hour: h, minute: min }, { zone });
  // Ambiguous wall time (DST fall-back): prefer the earlier instant.
  const earlier = dt.minus({ hours: 1 });
  if (earlier.hour === dt.hour && earlier.minute === dt.minute) return earlier.toMillis();
  return dt.toMillis();
}

export interface Conversion {
  sourceZone: string;
  targetZone: string;
  sourceMs: number;
  sourceLabel: string;
  targetLabel: string;
  /** Calendar day difference of the target relative to the source (-1, 0, +1). */
  dayShift: number;
  /** Hours difference target - source at that instant. */
  hoursDiff: number;
}

/** Convert a wall time ("2026-11-20T15:00") from one zone to another. */
export function convertWallTime(
  isoLocal: string,
  sourceZone: string,
  targetZone: string,
  hour12: boolean,
): Conversion | null {
  const src = DateTime.fromISO(isoLocal, { zone: sourceZone });
  if (!src.isValid) return null;
  const tgt = src.setZone(targetZone);
  // Compare calendar dates by projecting both wall dates onto UTC.
  const asUtcDate = (dt: DateTime) => DateTime.utc(dt.year, dt.month, dt.day);
  const dayShift = Math.round(asUtcDate(tgt).diff(asUtcDate(src), "days").days);
  return {
    sourceZone,
    targetZone,
    sourceMs: src.toMillis(),
    sourceLabel: formatWithZone(src.toMillis(), sourceZone, hour12),
    targetLabel: formatWithZone(src.toMillis(), targetZone, hour12),
    dayShift,
    hoursDiff: (tgt.offset - src.offset) / 60,
  };
}

/** Offset difference in hours between two zones at an instant (b - a). */
export function zoneDiffHours(a: string, b: string, ms: number): number {
  const oa = DateTime.fromMillis(ms, { zone: a }).offset;
  const ob = DateTime.fromMillis(ms, { zone: b }).offset;
  return (ob - oa) / 60;
}

/** Hours of overlap of two zones' working hours on a given day (useful for scheduling Kenya ⇄ Texas). */
export function overlapWindows(
  zoneA: string,
  zoneB: string,
  dayMs: number,
  startHour = 8,
  endHour = 18,
): { start: number; end: number } | null {
  const dayA = DateTime.fromMillis(dayMs, { zone: zoneA }).startOf("day");
  const aStart = dayA.set({ hour: startHour }).toMillis();
  const aEnd = dayA.set({ hour: endHour }).toMillis();
  // B's working windows on the B-days that intersect A's window.
  let best: { start: number; end: number } | null = null;
  for (const delta of [-1, 0, 1]) {
    const dayB = DateTime.fromMillis(aStart, { zone: zoneB }).startOf("day").plus({ days: delta });
    const bStart = dayB.set({ hour: startHour }).toMillis();
    const bEnd = dayB.set({ hour: endHour }).toMillis();
    const s = Math.max(aStart, bStart);
    const e = Math.min(aEnd, bEnd);
    if (e > s && (!best || e - s > best.end - best.start)) best = { start: s, end: e };
  }
  return best;
}

/** Start of day (ms) in a zone. */
export function startOfDay(ms: number, zone: string): number {
  return DateTime.fromMillis(ms, { zone }).startOf("day").toMillis();
}

export function endOfDay(ms: number, zone: string): number {
  return DateTime.fromMillis(ms, { zone }).endOf("day").toMillis();
}

/** Monday-based week start. */
export function startOfWeek(ms: number, zone: string): number {
  return DateTime.fromMillis(ms, { zone }).startOf("week").toMillis();
}

export function addDays(ms: number, zone: string, days: number): number {
  return DateTime.fromMillis(ms, { zone }).plus({ days }).toMillis();
}

export function isoWeekday(ms: number, zone: string): number {
  return DateTime.fromMillis(ms, { zone }).weekday;
}

export function sameDay(a: number, b: number, zone: string): boolean {
  return DateTime.fromMillis(a, { zone }).hasSame(DateTime.fromMillis(b, { zone }), "day");
}

/** For <input type="datetime-local"> */
export function toLocalInput(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("yyyy-LL-dd'T'HH:mm");
}

export function fromLocalInput(value: string, zone: string): number | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone });
  return dt.isValid ? dt.toMillis() : null;
}

export function zoneLabel(zone: string): string {
  switch (zone) {
    case KENYA_ZONE:
      return "Kenya";
    case TEXAS_CENTRAL:
      return "Texas (Central)";
    case TEXAS_MOUNTAIN:
      return "Texas (El Paso · Mountain)";
    default:
      return zone.split("/").pop()!.replace(/_/g, " ");
  }
}
