import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { extractDuration, matchScore, parseCommand, type ParseContext } from "./parser";

// Tuesday 17 Nov 2026, 10:00 in Nairobi (07:00 UTC, 01:00 in Chicago)
const NOW = DateTime.fromISO("2026-11-17T10:00", { zone: "Africa/Nairobi" }).toMillis();
const ctx: ParseContext = { now: NOW, homeZone: "Africa/Nairobi", texasZone: "America/Chicago" };

const wall = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toFormat("yyyy-LL-dd HH:mm");

describe("voice command parser — spec examples", () => {
  it("Add a task to finish my report tomorrow at 9 AM", () => {
    const r = parseCommand("Add a task to finish my report tomorrow at 9 AM.", ctx);
    expect(r.intent.type).toBe("add_task");
    if (r.intent.type !== "add_task") return;
    expect(r.intent.title).toBe("Finish my report");
    expect(wall(r.intent.dueAt!, "Africa/Nairobi")).toBe("2026-11-18 09:00");
    expect(r.needsConfirmation).toBe(false);
  });

  it("Remind me to attend the meeting at 4 PM Kenya time", () => {
    const r = parseCommand("Remind me to attend the meeting at 4 PM Kenya time", { ...ctx, homeZone: "America/Chicago" });
    expect(r.intent.type).toBe("add_task");
    if (r.intent.type !== "add_task") return;
    expect(r.intent.title).toBe("Attend the meeting");
    expect(r.intent.tz).toBe("Africa/Nairobi");
    expect(r.intent.reminderAtTime).toBe(true);
    expect(wall(r.intent.dueAt!, "Africa/Nairobi")).toBe("2026-11-17 16:00");
    expect(r.intent.categoryId).toBe("meetings");
  });

  it("Move my meeting to Friday at 3 PM Texas time", () => {
    const r = parseCommand("Move my meeting to Friday at 3 PM Texas time", ctx);
    expect(r.intent.type).toBe("reschedule");
    if (r.intent.type !== "reschedule") return;
    expect(r.intent.query).toBe("meeting");
    expect(r.intent.tz).toBe("America/Chicago");
    expect(wall(r.intent.newStart, "America/Chicago")).toBe("2026-11-20 15:00");
    // 3 PM CST = midnight in Nairobi (UTC-6 vs UTC+3)
    expect(wall(r.intent.newStart, "Africa/Nairobi")).toBe("2026-11-21 00:00");
    expect(r.needsConfirmation).toBe(true);
  });

  it("What tasks do I have today?", () => {
    expect(parseCommand("What tasks do I have today?", ctx).intent.type).toBe("query_today");
  });

  it("Start a 25-minute focus session", () => {
    const r = parseCommand("Start a 25-minute focus session", ctx);
    expect(r.intent).toEqual({ type: "start_focus", minutes: 25, mode: "pomodoro" });
  });

  it("How much time is left?", () => {
    expect(parseCommand("How much time is left?", ctx).intent.type).toBe("time_left");
  });

  it("Mark my current task as complete (requires confirmation)", () => {
    const r = parseCommand("Mark my current task as complete", ctx);
    expect(r.intent.type).toBe("complete_current");
    expect(r.needsConfirmation).toBe(true);
  });

  it("Show my upcoming appointments", () => {
    expect(parseCommand("Show my upcoming appointments", ctx).intent.type).toBe("query_upcoming");
  });
});

describe("voice command parser — more phrasing", () => {
  it("El Paso / Mountain time", () => {
    const r = parseCommand("Add task call supplier tomorrow at 10 am El Paso time", ctx);
    if (r.intent.type !== "add_task") throw new Error(r.intent.type);
    expect(r.intent.tz).toBe("America/Denver");
    expect(wall(r.intent.dueAt!, "America/Denver")).toBe("2026-11-18 10:00");
  });

  it("Texas time follows the El Paso preference when configured", () => {
    const r = parseCommand("Remind me to pay rent at 5 pm Texas time", { ...ctx, texasZone: "America/Denver" });
    if (r.intent.type !== "add_task") throw new Error(r.intent.type);
    expect(r.intent.tz).toBe("America/Denver");
  });

  it("EAT abbreviation after a time, but not the verb 'eat'", () => {
    const r1 = parseCommand("Add task standup at 9am EAT", { ...ctx, homeZone: "America/Chicago" });
    if (r1.intent.type !== "add_task") throw new Error(r1.intent.type);
    expect(r1.intent.tz).toBe("Africa/Nairobi");
    const r2 = parseCommand("Remind me to eat lunch at 1 pm", ctx);
    if (r2.intent.type !== "add_task") throw new Error(r2.intent.type);
    expect(r2.intent.title).toBe("Eat lunch");
    expect(r2.intent.tz).toBe("Africa/Nairobi");
  });

  it("priority, estimate and spoken p.m.", () => {
    const r = parseCommand("Add an urgent task to fix the login bug for 2 hours today at 3 p.m.", ctx);
    if (r.intent.type !== "add_task") throw new Error(r.intent.type);
    expect(r.intent.priority).toBe("critical");
    expect(r.intent.estimateMin).toBe(120);
    expect(r.intent.title).toBe("Fix the login bug");
    expect(wall(r.intent.dueAt!, "Africa/Nairobi")).toBe("2026-11-17 15:00");
  });

  it("a bare time already passed today rolls to tomorrow", () => {
    const r = parseCommand("remind me to stretch at 8 am", ctx);
    if (r.intent.type !== "add_task") throw new Error(r.intent.type);
    expect(wall(r.intent.dueAt!, "Africa/Nairobi")).toBe("2026-11-18 08:00");
  });

  it("schedule an event with a time range", () => {
    const r = parseCommand("Schedule a meeting with Amina on Thursday from 2 to 3 pm Kenya time", ctx);
    if (r.intent.type !== "add_event") throw new Error(r.intent.type);
    expect(wall(r.intent.startAt, "Africa/Nairobi")).toBe("2026-11-19 14:00");
    expect(wall(r.intent.endAt, "Africa/Nairobi")).toBe("2026-11-19 15:00");
    expect(r.intent.title.toLowerCase()).toContain("amina");
  });

  it("start a timer / stopwatch / words-as-numbers", () => {
    expect(parseCommand("start a timer for 10 minutes", ctx).intent).toEqual({ type: "start_focus", minutes: 10, mode: "countdown" });
    expect(parseCommand("start the stopwatch", ctx).intent).toMatchObject({ type: "start_focus", mode: "stopwatch" });
    expect(parseCommand("start a forty five minute focus session", ctx).intent).toMatchObject({ minutes: 45 });
  });

  it("deletions always need confirmation", () => {
    const r = parseCommand("Delete the grocery task", ctx);
    expect(r.intent.type).toBe("delete_task");
    expect(r.needsConfirmation).toBe(true);
  });

  it("reschedule to a date only keeps the original time", () => {
    const r = parseCommand("Move the dentist appointment to next Monday", ctx);
    if (r.intent.type !== "reschedule") throw new Error(r.intent.type);
    expect(r.intent.dateOnly).toBe(true);
  });

  it("unknown text is not applied silently", () => {
    const r = parseCommand("banana", ctx);
    expect(r.intent.type).toBe("unknown");
    expect(r.needsConfirmation).toBe(true);
  });

  it("in N hours is relative to now", () => {
    const r = parseCommand("remind me to check the oven in 2 hours", ctx);
    if (r.intent.type !== "add_task") throw new Error(r.intent.type);
    expect(r.intent.dueAt).toBe(NOW + 2 * 3600_000);
  });
});

describe("helpers", () => {
  it("extracts durations", () => {
    expect(extractDuration("write docs for 90 minutes").value).toBe(90);
    expect(extractDuration("write docs for half an hour").value).toBe(30);
    expect(extractDuration("for 1 hour and 30 minutes").value).toBe(90);
  });
  it("fuzzy matches titles", () => {
    expect(matchScore("meeting", "Client meeting")).toBeGreaterThan(0.8);
    expect(matchScore("my report", "Finish quarterly report")).toBeGreaterThan(0.5);
    expect(matchScore("dentist", "Gym")).toBe(0);
  });
});
