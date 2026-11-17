import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  KENYA_ZONE,
  TEXAS_CENTRAL,
  TEXAS_MOUNTAIN,
  clockFor,
  convertWallTime,
  normalizeZone,
  overlapWindows,
  wallTimeToUtc,
  zoneAbbr,
  zoneDiffHours,
} from "./time";

const utc = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).toMillis();

describe("dual clocks", () => {
  it("Kenya is always EAT, UTC+3, no DST", () => {
    for (const iso of ["2026-01-15T12:00", "2026-07-15T12:00"]) {
      const c = clockFor(KENYA_ZONE, utc(iso), false);
      expect(c.abbr).toBe("EAT");
      expect(c.offset).toBe("+03:00");
      expect(c.isDST).toBe(false);
      expect(c.time).toBe("15:00");
    }
  });

  it("Texas Central switches CST ⇄ CDT automatically", () => {
    expect(clockFor(TEXAS_CENTRAL, utc("2026-01-15T18:00"), true)).toMatchObject({ abbr: "CST", offset: "-06:00", time: "12:00", meridiem: "PM" });
    expect(clockFor(TEXAS_CENTRAL, utc("2026-07-15T18:00"), true)).toMatchObject({ abbr: "CDT", offset: "-05:00", time: "1:00" });
  });

  it("El Paso (Mountain) switches MST ⇄ MDT", () => {
    expect(zoneAbbr(TEXAS_MOUNTAIN, utc("2026-01-15T18:00"))).toBe("MST");
    expect(zoneAbbr(TEXAS_MOUNTAIN, utc("2026-07-15T18:00"))).toBe("MDT");
  });

  it("shows weekday and date in each zone (date line crossing)", () => {
    // 22:30 UTC Monday = Tuesday 01:30 in Nairobi, still Monday in Chicago
    const ms = utc("2026-11-16T22:30");
    expect(clockFor(KENYA_ZONE, ms, false)).toMatchObject({ weekday: "Tuesday", date: "17 Nov 2026", time: "01:30" });
    expect(clockFor(TEXAS_CENTRAL, ms, false)).toMatchObject({ weekday: "Monday", date: "16 Nov 2026", time: "16:30" });
  });

  it("supports 12h and 24h formats", () => {
    const ms = utc("2026-11-17T18:05");
    expect(clockFor(KENYA_ZONE, ms, true)).toMatchObject({ time: "9:05", meridiem: "PM" });
    expect(clockFor(KENYA_ZONE, ms, false)).toMatchObject({ time: "21:05", meridiem: "" });
  });

  it("aliases America/El_Paso to America/Denver and rejects junk zones", () => {
    expect(normalizeZone("America/El_Paso")).toBe("America/Denver");
    expect(normalizeZone("Mars/Olympus", "UTC")).toBe("UTC");
    expect(normalizeZone(TEXAS_CENTRAL)).toBe(TEXAS_CENTRAL);
  });
});

describe("daylight saving transitions (2026)", () => {
  // US DST 2026: starts Sun 8 Mar 02:00, ends Sun 1 Nov 02:00
  it("Kenya ⇄ Texas difference is 9h in winter and 8h in summer", () => {
    expect(zoneDiffHours(TEXAS_CENTRAL, KENYA_ZONE, utc("2026-03-07T12:00"))).toBe(9);
    expect(zoneDiffHours(TEXAS_CENTRAL, KENYA_ZONE, utc("2026-03-09T12:00"))).toBe(8);
    expect(zoneDiffHours(TEXAS_CENTRAL, KENYA_ZONE, utc("2026-11-02T12:00"))).toBe(9);
  });

  it("spring-forward gap: 02:30 does not exist and shifts to 03:30 CDT", () => {
    const ms = wallTimeToUtc(TEXAS_CENTRAL, 2026, 3, 8, 2, 30);
    expect(DateTime.fromMillis(ms, { zone: TEXAS_CENTRAL }).toFormat("HH:mm ZZZZ")).toBe("03:30 CDT");
  });

  it("fall-back ambiguity: 01:30 resolves to the first (CDT) occurrence", () => {
    const ms = wallTimeToUtc(TEXAS_CENTRAL, 2026, 11, 1, 1, 30);
    expect(ms).toBe(utc("2026-11-01T06:30"));
  });

  it("a day containing the transition is 23h / 25h long in Texas", () => {
    const len = (y: number, m: number, d: number) =>
      (wallTimeToUtc(TEXAS_CENTRAL, y, m, d + 1) - wallTimeToUtc(TEXAS_CENTRAL, y, m, d)) / 3600_000;
    expect(len(2026, 3, 8)).toBe(23);
    expect(len(2026, 11, 1)).toBe(25);
  });
});

describe("time-zone conversion tool", () => {
  it("3 PM Texas (CST) on Friday is Saturday 00:00 in Kenya", () => {
    const c = convertWallTime("2026-11-20T15:00", TEXAS_CENTRAL, KENYA_ZONE, false)!;
    expect(c.targetLabel).toBe("Sat 21 Nov · 00:00 EAT");
    expect(c.dayShift).toBe(1);
    expect(c.hoursDiff).toBe(9);
  });

  it("9 AM Kenya is the previous evening in Texas", () => {
    const c = convertWallTime("2026-11-18T09:00", KENYA_ZONE, TEXAS_CENTRAL, true)!;
    expect(c.targetLabel).toBe("Wed 18 Nov · 12:00 AM CST");
    const c2 = convertWallTime("2026-11-18T08:00", KENYA_ZONE, TEXAS_CENTRAL, true)!;
    expect(c2.targetLabel).toBe("Tue 17 Nov · 11:00 PM CST");
    expect(c2.dayShift).toBe(-1);
  });

  it("rejects invalid input", () => {
    expect(convertWallTime("not a date", KENYA_ZONE, TEXAS_CENTRAL, true)).toBeNull();
  });

  it("finds the overlap of working hours between Kenya and Texas", () => {
    // 8–18 in both zones: Kenya 17:00–18:00 = Texas 08:00–09:00 (CST, 9h apart)
    const w = overlapWindows(KENYA_ZONE, TEXAS_CENTRAL, utc("2026-11-18T09:00"))!;
    expect(DateTime.fromMillis(w.start, { zone: KENYA_ZONE }).toFormat("HH:mm")).toBe("17:00");
    expect((w.end - w.start) / 3600_000).toBe(1);
  });
});
