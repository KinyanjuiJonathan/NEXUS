import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { createLocalBackend, memoryKV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { queueUnits, sortedQueue } from "@/lib/smart/reschedule";
import { parseScheduleRequest } from "@/lib/smart/parse";
import { resolveRequest } from "@/lib/smart/slots";
import { DEFAULT_ROUTINE, MAX_WORK_MIN, normalizeRoutine, personalTime, routineDay, routineNow, routineWork, workMinutes } from "./routine";
import { hoursFor, workWindows } from "./workPlan";
import { compareVersions, feedbackBody, feedbackTitle, feedbackUrl, isNewer } from "./updates";

const NBO = "Africa/Nairobi";
const CHI = "America/Chicago";
const at = (iso: string, zone = NBO) => DateTime.fromISO(iso, { zone }).toMillis();
const hm = (ms: number, zone = NBO) => DateTime.fromMillis(ms, { zone }).toFormat("HH:mm");
const span = (e: { startAt: number; endAt: number }) => `${DateTime.fromMillis(e.startAt, { zone: NBO }).toFormat("ccc HH:mm")}–${hm(e.endAt)}`;
const MIN = 60_000;

describe("daily routine", () => {
  const day = (key: string) => routineDay(key, DEFAULT_ROUTINE).map((b) => `${hm(b.start)}-${hm(b.end)} ${b.label}`);

  it("builds the day asked for: morning, admin, five 90-minute sessions, breaks, lunch, gym and sleep", () => {
    // Wednesday 18 November 2026
    expect(day("2026-11-18")).toEqual([
      "23:30-06:30 Sleep",
      "06:30-06:45 Wake up",
      "06:45-07:15 Exercise",
      "07:15-07:35 Get ready",
      "07:35-08:00 Breakfast",
      "08:00-08:30 Admin & planning",
      "08:30-10:00 Work session 1",
      "10:00-10:15 Break",
      "10:15-11:45 Work session 2",
      "11:45-12:00 Break",
      "12:00-13:30 Work session 3",
      "13:30-14:30 Lunch",
      "14:30-16:00 Work session 4",
      "16:00-16:15 Break",
      "16:15-17:45 Work session 5",
      "21:00-22:30 Gym",
    ]);
    expect(workMinutes(DEFAULT_ROUTINE)).toBe(7.5 * 60);
    // gym Monday to Thursday only; work every day of the week
    expect(day("2026-11-20").some((l) => l.endsWith("Gym"))).toBe(false); // Friday
    expect(day("2026-11-22").filter((l) => l.includes("Work session"))).toHaveLength(5); // Sunday
    expect(routineWork("2026-11-22", DEFAULT_ROUTINE).map((s) => `${hm(s.start)}-${hm(s.end)}`)).toEqual(["08:30-13:30", "14:30-17:45"]);
  });

  it("keeps the rules: at least 6 hours of sleep and at most 12 hours of work", () => {
    expect(normalizeRoutine({ sleepMin: 120 }).sleepMin).toBe(6 * 60);
    const greedy = normalizeRoutine({ sessions: 20, sessionMin: 90 });
    expect(workMinutes(greedy)).toBeLessThanOrEqual(MAX_WORK_MIN);
    expect(greedy.sessions).toBe(8);
    expect(normalizeRoutine({ sessions: 3, lunchAfter: 9 }).lunchAfter).toBe(3);
  });

  it("the gym is 9 PM Kenya time whatever zone is on screen, and personal time is protected", () => {
    const wh = { zone: CHI, startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5, 6, 7], routine: DEFAULT_ROUTINE };
    // working time seen from Texas: 8:30 EAT is 23:30 the evening before in Chicago
    const wins = workWindows(at("2026-11-18T00:00"), at("2026-11-19T00:00"), wh).map((w) => `${hm(w.start)}-${hm(w.end)}`);
    expect(wins).toEqual(["08:30-13:30", "14:30-17:45"]);
    const personal = personalTime(at("2026-11-18T00:00"), at("2026-11-19T00:00"), DEFAULT_ROUTINE).map((p) => `${hm(p.start)}-${hm(p.end)}`);
    expect(personal).toContain("21:00-22:30");
    expect(personal).toContain("13:30-14:30");
    expect(personal).not.toContain("10:00-10:15"); // breaks are a guide, not a wall
    expect(routineNow(at("2026-11-18T02:00"), DEFAULT_ROUTINE, "sleep")).not.toBeNull();
    expect(routineNow(at("2026-11-18T09:00"), DEFAULT_ROUTINE)?.kind).toBe("work");
    expect(personalTime(0, 1e13, { ...DEFAULT_ROUTINE, enabled: false })).toEqual([]);
    // hours given for one date still win over the routine
    const own = { ...wh, zone: NBO, plans: { "2026-11-18": { start: at("2026-11-18T19:00"), end: at("2026-11-18T23:00"), zone: NBO } } };
    expect(hm(hoursFor("2026-11-18", own)!.start)).toBe("19:00");
    expect(hm(hoursFor("2026-11-19", own)!.start)).toBe("08:30");
  });
});

describe("scheduling with the routine in the app", () => {
  async function setup() {
    let seq = 0;
    const clock = { now: at("2026-11-18T08:00") }; // Wednesday, before the first session
    const store = createNexusStore({ backend: createLocalBackend(memoryKV()), now: () => clock.now, id: () => `id${++seq}` });
    await store.getState().init();
    await store.getState().setSetting("homeZone", NBO);
    const s = () => store.getState();
    const say = async (text: string) => {
      const req = parseScheduleRequest(text, { now: clock.now, defaultZone: NBO, texasZone: CHI });
      const res = resolveRequest(req, s().events, s().slotSettings(), clock.now);
      return res.slot ? s().smartCreate(req, res.slot, res.durationMin) : null;
    };
    const add = async (title: string, start: string, end: string, extra = {}) => {
      clock.now += 1000; // each task is added a little later than the one before
      const t = await s().addTask({ title, estimateMin: 60, reminders: [], ...extra }, { autoPlace: false });
      const e = await s().addEvent({ title, startAt: at(start), endAt: at(end), taskId: t.id, tz: NBO, reminders: [] });
      return { t, e };
    };
    const event = (id: string) => s().events.find((x) => x.id === id)!;
    const titles = () => queueUnits(s().tasks, s().events, clock.now).map((u) => u.title);
    return { s, clock, say, add, event, titles };
  }

  it("is on by default, uses first in first out, and plans tasks inside the work sessions only", async () => {
    const { s, say } = await setup();
    expect(s().settings.routine.enabled).toBe(true);
    expect(s().settings.schedOrder).toBe("fifo");
    const made = [];
    for (const t of ["Write report today, 2 hours", "Review budget today, 2 hours", "Plan sprint today, 1 hour", "Email clients today, 2 hours"]) made.push((await say(t))!.event);
    expect(made.map(span)).toEqual(["Wed 08:30–10:30", "Wed 10:45–12:45", "Wed 14:30–15:30", "Wed 15:45–17:45"]);
    // nothing over lunch, admin time, the gym or sleep
    for (const e of made) for (const p of personalTime(at("2026-11-18T00:00"), at("2026-11-19T12:00"), s().settings.routine)) expect(e.endAt <= p.start || e.startAt >= p.end).toBe(true);
    // the day is full: the next one goes to tomorrow's first session, not into the evening or the night
    expect(span((await say("One more thing, 2 hours"))!.event)).toBe("Thu 08:30–10:30");
  });

  it("pushing a task one hour moves it exactly one hour and the tasks after it follow in order", async () => {
    const { s, add, event, titles } = await setup();
    const a = await add("A", "2026-11-18T09:00", "2026-11-18T10:00");
    const b = await add("B", "2026-11-18T10:00", "2026-11-18T11:00");
    const c = await add("C", "2026-11-18T11:00", "2026-11-18T12:00");
    const d = await add("D", "2026-11-18T15:00", "2026-11-18T16:00");
    expect(await s().shiftTask(a.e.id, 60 * MIN)).toBe(true);
    expect([a, b, c, d].map((x) => span(event(x.e.id)))).toEqual(["Wed 10:00–11:00", "Wed 11:00–12:00", "Wed 12:00–13:00", "Wed 15:00–16:00"]);
    expect(titles()).toEqual(["A", "B", "C", "D"]); // order kept; D was not in the way and did not move
    const note = s().toasts.find((t) => t.title === "Moved 1 h later")!;
    expect(note.body).toContain("A: 9:00 AM–10:00 AM → 10:00 AM–11:00 AM"); // original and new time
    expect(note.body).toContain("C: 11:00 AM–12:00 PM → 12:00 PM–1:00 PM");
    // once more: C would run into lunch, so it goes after it, and D behind it
    await s().shiftTask(a.e.id, 60 * MIN);
    expect([a, b, c, d].map((x) => span(event(x.e.id)))).toEqual(["Wed 11:00–12:00", "Wed 12:00–13:00", "Wed 14:30–15:30", "Wed 15:30–16:30"]);
    note.action!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(span(event(a.e.id))).toBe("Wed 09:00–10:00"); // undo of the first push
  });

  it("making a task longer pushes the ones after it; nothing overlaps", async () => {
    const { s, add, event, titles } = await setup();
    const a = await add("A", "2026-11-18T09:00", "2026-11-18T10:00");
    const b = await add("B", "2026-11-18T10:00", "2026-11-18T11:00");
    const c = await add("C", "2026-11-18T11:00", "2026-11-18T12:00");
    await s().updateEvent(a.e.id, { endAt: at("2026-11-18T10:45") });
    expect([a, b, c].map((x) => span(event(x.e.id)))).toEqual(["Wed 09:00–10:45", "Wed 10:45–11:45", "Wed 11:45–12:45"]);
    expect(titles()).toEqual(["A", "B", "C"]);
    expect(s().toasts.some((t) => t.title === "2 later tasks moved along")).toBe(true);
    // shorter again: nothing needs to move, so nothing does
    await s().updateEvent(a.e.id, { endAt: at("2026-11-18T09:30") });
    expect(span(event(b.e.id))).toBe("Wed 10:45–11:45");
  });

  it("replaces the task under way with another from the queue; the first continues afterwards with its clocked time", async () => {
    const { s, clock, add, event, titles } = await setup();
    await s().clockIn();
    const a = await add("A", "2026-11-18T09:00", "2026-11-18T10:00");
    const b = await add("B", "2026-11-18T10:00", "2026-11-18T11:00");
    const c = await add("C", "2026-11-18T11:00", "2026-11-18T11:30");
    clock.now = at("2026-11-18T09:20"); // 20 minutes into A
    expect(await s().startTaskNow(c.t.id)).toBe(true);
    expect(span(event(c.e.id))).toBe("Wed 09:20–09:50");
    expect(span(event(a.e.id))).toBe("Wed 09:50–10:30"); // the 40 minutes A still needs
    expect(event(a.e.id).sched).toMatchObject({ workedMs: 20 * MIN, targetMs: 60 * MIN });
    expect(span(event(b.e.id))).toBe("Wed 10:30–11:30");
    expect(titles()).toEqual(["A", "B"]);
    expect(s().settings.activeTaskId).toBe(c.t.id);
    expect(s().toasts.some((t) => t.title === "Now working on “C”")).toBe(true);
  });

  it("reorganises the queue by priority, shortest time or deadline on request", async () => {
    const { s, clock, add, titles } = await setup();
    await add("First", "2026-11-18T09:00", "2026-11-18T10:30", { priority: "low" });
    await add("Urgent", "2026-11-18T10:30", "2026-11-18T11:30", { priority: "critical" });
    await add("Quick", "2026-11-18T11:30", "2026-11-18T12:00", { priority: "medium", dueAt: at("2026-11-18T13:00") });
    const order = (o: Parameters<typeof sortedQueue>[3]) => { const by = new Map(s().tasks.map((t) => [t.id, t.title])); return sortedQueue(s().tasks, s().events, clock.now, o).map((id) => by.get(id)); };
    expect(order("fifo")).toEqual(["First", "Urgent", "Quick"]);
    expect(order("priority")).toEqual(["Urgent", "Quick", "First"]);
    expect(order("shortest")).toEqual(["Quick", "Urgent", "First"]);
    expect(order("deadline")).toEqual(["Quick", "First", "Urgent"]);
    expect(await s().sortQueue("priority")).toBe(true);
    expect(titles()).toEqual(["Urgent", "Quick", "First"]);
    const blocks = queueUnits(s().tasks, s().events, clock.now);
    expect(DateTime.fromMillis(blocks[0].start, { zone: NBO }).toFormat("HH:mm")).toBe("09:00"); // the first place keeps its start
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].start).toBeGreaterThanOrEqual(blocks[i - 1].end);
    await s().sortQueue(); // back to the configured order: first in, first out
    expect(titles()).toEqual(["First", "Urgent", "Quick"]);
  });
});

describe("updates and feedback", () => {
  it("compares versions", () => {
    expect(isNewer("v1.2.0", "1.1.9")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("v1.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.10", "1.0.9")).toBe(true);
    expect(compareVersions("0.9.9", "1.0.0")).toBe(-1);
  });

  it("prepares feedback with the version in use and the one before", () => {
    const f = { kind: "problem" as const, area: "Auto Typer", text: "Commas come out as z\nin the remote desktop", version: "1.1.0", previousVersion: "1.0.0", platform: "Windows" };
    expect(feedbackTitle(f)).toBe("[Problem · Auto Typer] Commas come out as z");
    expect(feedbackBody(f)).toContain("NEXUS 1.1.0 (updated from 1.0.0)");
    const url = new URL(feedbackUrl(f));
    expect(url.origin + url.pathname).toBe("https://github.com/KinyanjuiJonathan/NEXUS/issues/new");
    expect(url.searchParams.get("body")).toContain("in the remote desktop");
  });
});
