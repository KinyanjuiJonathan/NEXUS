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
      "17:45-22:15 Open for work", // a freelancer's day does not end at a set hour (12 hours of work at most)
      "21:00-22:30 Gym",
    ]);
    expect(workMinutes(DEFAULT_ROUTINE)).toBe(7.5 * 60);
    // gym Monday to Thursday only; work every day of the week
    expect(day("2026-11-20").some((l) => l.endsWith("Gym"))).toBe(false); // Friday
    expect(day("2026-11-22").filter((l) => l.includes("Work session"))).toHaveLength(5); // Sunday
    expect(routineWork("2026-11-22", DEFAULT_ROUTINE).map((s) => `${hm(s.start)}-${hm(s.end)}`)).toEqual(["08:30-13:30", "14:30-22:15"]); // Sunday: no gym
    // with the adaptive mode off it is the plain timetable again
    expect(routineWork("2026-11-22", { ...DEFAULT_ROUTINE, flexible: false }).map((s) => `${hm(s.start)}-${hm(s.end)}`)).toEqual(["08:30-13:30", "14:30-17:45"]);
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
    expect(wins).toEqual(["08:30-13:30", "14:30-21:00"]); // working time stops for the gym, the one fixed commitment
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
    // the sessions are full, but the evening is open for a freelancer: it goes there, clear of the gym at 9 PM
    expect(span((await say("One more thing, 2 hours"))!.event)).toBe("Wed 18:00–20:00");
    // nothing is ever planned into the night: the next one waits for tomorrow's first session
    expect(span((await say("And another, 2 hours"))!.event)).toBe("Thu 08:30–10:30");
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

describe("start now", () => {
  async function setup(at0: string) {
    let seq = 0;
    const clock = { now: at(at0) };
    const store = createNexusStore({ backend: createLocalBackend(memoryKV()), now: () => clock.now, id: () => `id${++seq}` });
    await store.getState().init();
    await store.getState().setSetting("homeZone", NBO);
    const s = () => store.getState();
    const add = async (title: string, start: string, end: string) => {
      clock.now += 1000;
      const t = await s().addTask({ title, estimateMin: 60, reminders: [] }, { autoPlace: false });
      const e = await s().addEvent({ title, startAt: at(start), endAt: at(end), taskId: t.id, tz: NBO, reminders: [] });
      return { t, e };
    };
    const where = (taskId: string) => s().events.filter((e) => e.taskId === taskId && !e.deletedAt).map(span);
    return { s, clock, add, where };
  }

  it("a queued task starts in the next minute, not at the next free slot, and the clock counts", async () => {
    // 10:40 PM on a Wednesday: outside the routine's work sessions, in the middle of gym time
    const { s, clock, add, where } = await setup("2026-11-18T22:40:00");
    const a = await add("A", "2026-11-19T08:30", "2026-11-19T09:30");
    const b = await add("B", "2026-11-19T09:30", "2026-11-19T10:30");
    clock.now = at("2026-11-18T22:40:20");
    expect(await s().startTaskNow(b.t.id)).toBe(true);
    expect(where(b.t.id)).toEqual(["Wed 22:41–23:41"]); // the next minute, exactly
    expect(where(a.t.id)).toEqual(["Thu 08:30–09:30"]); // not in the way: untouched
    expect(s().settings.activeTaskId).toBe(b.t.id);
    expect(s().workSessions.some((w) => w.endedAt == null)).toBe(true); // counting
    expect(s().toasts.some((t) => t.title === "“B” starts now")).toBe(true);
  });

  it("tasks in the way follow straight after it in the same order, around a fixed appointment", async () => {
    const { s, clock, add, where } = await setup("2026-11-18T09:00:00");
    const a = await add("A", "2026-11-18T09:05", "2026-11-18T10:05");
    const b = await add("B", "2026-11-18T10:05", "2026-11-18T11:05");
    const c = await add("C", "2026-11-18T15:00", "2026-11-18T16:00");
    await s().addEvent({ title: "Zoom", startAt: at("2026-11-18T11:30"), endAt: at("2026-11-18T12:00"), tz: NBO });
    clock.now = at("2026-11-18T09:01:30");
    await s().startTaskNow(c.t.id);
    expect(where(c.t.id)).toEqual(["Wed 09:02–10:02"]);
    expect(where(a.t.id)).toEqual(["Wed 10:02–11:02"]); // first in, first out: A, then B
    expect(where(b.t.id)).toEqual(["Wed 12:00–13:00"]); // would run into Zoom, so right after it
    const note = s().toasts.find((t) => t.title === "“C” starts now")!;
    expect(note.body).toContain("A: 9:05 AM–10:05 AM → 10:02 AM–11:02 AM");
  });

  it("a task with no time reserved can be started too", async () => {
    const { s, clock, where } = await setup("2026-11-18T09:00:00");
    const t = await s().addTask({ title: "Loose task", estimateMin: 45, reminders: [] }, { autoPlace: false });
    clock.now = at("2026-11-18T09:10:10");
    expect(await s().startTaskNow(t.id)).toBe(true);
    expect(where(t.id)).toEqual(["Wed 09:11–09:56"]);
    expect(await s().startTaskNow(t.id)).toBe(true); // already under way: nothing moves
    expect(where(t.id)).toEqual(["Wed 09:11–09:56"]);
  });

  it("“now” and “in a minute” in AI Schedule mean exactly then, and what was there follows", async () => {
    const { s, clock, add, where } = await setup("2026-11-18T22:10:00");
    const a = await add("A", "2026-11-18T22:15", "2026-11-18T23:15");
    clock.now = at("2026-11-18T22:10:20");
    const ctx = { now: clock.now, defaultZone: NBO, texasZone: CHI };
    const say = async (text: string) => {
      const req = parseScheduleRequest(text, { ...ctx, now: clock.now });
      const res = resolveRequest(req, s().events, s().slotSettings(), clock.now);
      return { req, res, made: res.slot ? await s().smartCreate(req, res.slot, res.durationMin) : null };
    };
    const now1 = await say("Fix the login bug now, 30 minutes");
    expect(now1.req).toMatchObject({ title: "Fix Login Bug", immediate: true, durationMin: 30 });
    expect(span(now1.made!.event)).toBe("Wed 22:11–22:41");
    expect(where(a.t.id)).toEqual(["Wed 22:41–23:41"]); // pushed behind it, not to tomorrow morning
    const soon = await say("Call the client in 1 minute, 15 minutes");
    expect(soon.req.immediate).toBe(true);
    expect(span(soon.made!.event)).toBe("Wed 22:12–22:27");
    // "in two hours" is still a rough time, as before
    expect(parseScheduleRequest("Submit tax form in two hours", ctx)).toMatchObject({ immediate: false, startApprox: true });
    expect(parseScheduleRequest("Review budget immediately, 30 minutes", ctx)).toMatchObject({ title: "Review Budget", immediate: true });
  });
});

describe("version labels", () => {
  it("names the version, the build and the day it was built", async () => {
    const { versionLabel, CHANGELOG } = await import("./changelog");
    expect(versionLabel("1.1.0", "845442c", "2026-11-22")).toBe("v1.1.0 · build 845442c · 22 Nov 2026");
    expect(CHANGELOG[0].version).toBe(__APP_VERSION__);
    // every release is described, newest first, and all of them are version 1
    const { MAJOR, } = await import("./changelog");
    const { compareVersions } = await import("./updates");
    expect(MAJOR).toBe(1);
    for (const r of CHANGELOG) expect(r.version.startsWith("1.")).toBe(true);
    for (let i = 1; i < CHANGELOG.length; i++) expect(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version)).toBe(1);
    expect(__APP_VERSION__.startsWith("1.")).toBe(true);
  });
});

describe("a routine that adapts (freelance)", () => {
  const R = DEFAULT_ROUTINE;
  const list = (key: string, r = R) => routineDay(key, r).map((b) => `${hm(b.start)}-${hm(b.end)} ${b.label}`);

  it("moves sleep later while I am still working, keeping its full length, and shifts the next day with it", async () => {
    const { postponeSleep } = await import("./routine");
    // 11:28 PM on Wednesday: sleep was due at 11:30
    const p = postponeSleep(at("2026-11-18T23:28"), R)!;
    expect([hm(p.start), hm(p.end)]).toEqual(["00:00", "07:00"]);
    expect(list("2026-11-19", p.routine).slice(0, 7)).toEqual([
      "00:00-07:00 Sleep", "07:00-07:15 Wake up", "07:15-07:45 Exercise", "07:45-08:05 Get ready", "08:05-08:30 Breakfast", "08:30-09:00 Admin & planning", "09:00-10:30 Work session 1",
    ]);
    // still working at 00:10: it moves again; not before it is due; never when the mode is off
    expect(hm(postponeSleep(at("2026-11-19T00:10"), p.routine)!.start)).toBe("00:45");
    expect(postponeSleep(at("2026-11-18T22:00"), R)).toBeNull();
    expect(postponeSleep(at("2026-11-18T23:28"), { ...R, flexible: false })).toBeNull();
    // the gym is not touched by any of this
    expect(list("2026-11-19", p.routine)).toContain("21:00-22:30 Gym");
  });

  it("a long absence can be counted as the night's sleep, with or without breakfast", async () => {
    const { countAsSleep } = await import("./routine");
    const from = at("2026-11-19T01:10");
    const to = at("2026-11-19T06:10");
    const night = countAsSleep(R, from, to, false, to);
    expect(night.kind).toBe("night");
    expect(list("2026-11-19", night.routine).slice(0, 6)).toEqual(["01:10-06:10 Sleep", "06:10-06:25 Wake up", "06:25-06:55 Exercise", "06:55-07:15 Get ready", "07:15-07:40 Breakfast", "07:40-08:10 Admin & planning"]);
    const fed = countAsSleep(R, from, to, true, to);
    expect(list("2026-11-19", fed.routine).some((l) => l.endsWith("Breakfast"))).toBe(false);
    expect(list("2026-11-19", fed.routine)).toContain("07:15-07:45 Admin & planning"); // admin and planning right after getting ready
  });

  it("a long break in the middle of the day is deducted from the next sleep instead", async () => {
    const { countAsSleep, sleepOf } = await import("./routine");
    const r = countAsSleep(R, at("2026-11-18T13:00"), at("2026-11-18T17:30"), false, at("2026-11-18T17:30"));
    expect(r).toMatchObject({ kind: "deducted", day: "2026-11-19" });
    const s = sleepOf("2026-11-19", r.routine);
    expect([hm(s.start), hm(s.end)]).toEqual(["04:00", "06:30"]); // 7 h planned minus 4 h 30 min already taken
    expect(list("2026-11-18", r.routine)[0]).toBe("23:30-06:30 Sleep"); // today itself is unchanged
  });

  it("recognises admin and planning work", async () => {
    const { isAdminTask } = await import("./routine");
    expect(isAdminTask({ title: "Plan the day" })).toBe(true);
    expect(isAdminTask({ title: "Reply to emails" })).toBe(true);
    expect(isAdminTask({ title: "Send invoices to clients" })).toBe(true);
    expect(isAdminTask({ title: "Build login page" })).toBe(false);
    expect(isAdminTask({ title: "Weekly review" }, "Admin")).toBe(true);
  });

  async function setup(at0: string) {
    let seq = 0;
    const clock = { now: at(at0) };
    const store = createNexusStore({ backend: createLocalBackend(memoryKV()), now: () => clock.now, id: () => `id${++seq}` });
    await store.getState().init();
    await store.getState().setSetting("homeZone", NBO);
    const s = () => store.getState();
    const add = async (title: string, start: string, end: string) => {
      clock.now += 1000;
      const t = await s().addTask({ title, estimateMin: 60, reminders: [] }, { autoPlace: false });
      const e = await s().addEvent({ title, startAt: at(start), endAt: at(end), taskId: t.id, tz: NBO, reminders: [] });
      return { t, e };
    };
    const where = (taskId: string) => s().events.filter((e) => e.taskId === taskId && !e.deletedAt).map(span);
    return { s, clock, add, where };
  }

  it("in the app: working past bedtime postpones sleep and moves tomorrow's first task out of it", async () => {
    const { s, clock, add, where } = await setup("2026-11-18T22:45:00");
    const early = await add("Early task", "2026-11-19T08:30", "2026-11-19T09:30");
    await s().clockIn();
    clock.now = at("2026-11-18T23:00");
    expect(await s().adaptRoutine()).toBeNull(); // not due yet
    clock.now = at("2026-11-18T23:27");
    expect(hm((await s().adaptRoutine())!)).toBe("00:00");
    expect(s().toasts.some((t) => t.title === "Sleep moved later")).toBe(true);
    // tomorrow now starts at 7:00, with admin until 9:00: the 8:30 task moves to the first session
    expect(where(early.t.id)).toEqual(["Thu 09:00–10:00"]);
    // away from the keyboard: nothing moves any more
    await s().pauseWork();
    clock.now = at("2026-11-19T00:20");
    expect(await s().adaptRoutine()).toBeNull();
  });

  it("in the app: after four hours away it asks, and a yes starts the day with admin and planning first", async () => {
    const { s, clock, add, where } = await setup("2026-11-18T20:00:00");
    const report = await add("Write report", "2026-11-19T08:30", "2026-11-19T09:30");
    const admin = await add("Plan the day and reply to emails", "2026-11-19T09:30", "2026-11-19T10:00");
    await s().clockIn();
    // gone at 00:40, back at 05:50
    clock.now = at("2026-11-19T00:45");
    await s().handleActivity({ kind: "away", since: at("2026-11-19T00:40"), reason: "idle" });
    clock.now = at("2026-11-19T05:50");
    await s().handleActivity({ kind: "back", at: clock.now });
    expect(s().sleepCheck).toEqual({ from: at("2026-11-19T00:40"), to: at("2026-11-19T05:50") });

    await s().answerSleepCheck("sleep+breakfast");
    expect(s().sleepCheck).toBeNull();
    const day = routineDay("2026-11-19", s().settings.routine).map((b) => `${hm(b.start)}-${hm(b.end)} ${b.label}`);
    expect(day.slice(0, 5)).toEqual(["00:40-05:50 Sleep", "05:50-06:05 Wake up", "06:05-06:35 Exercise", "06:35-06:55 Get ready", "06:55-07:25 Admin & planning"]);
    // admin and planning leads the queue, and both sit in the day as it now is (first session from 7:25)
    expect(queueUnits(s().tasks, s().events, clock.now).map((u) => u.title)).toEqual(["Plan the day and reply to emails", "Write report"]);
    expect(where(admin.t.id)).toEqual(["Thu 07:30–08:00"]); // pulled forward from 9:30 to the start of the new day (quarter-hour steps)
    const r = s().events.find((e) => e.taskId === report.t.id && !e.deletedAt)!;
    expect(r.startAt).toBeGreaterThanOrEqual(at("2026-11-19T08:00"));
    expect(r.startAt).toBeLessThan(at("2026-11-19T08:30")); // earlier than it was planned, right behind the admin task
    expect(s().toasts.some((t) => t.title === "Your day is planned")).toBe(true);
  });

  it("in the app: answering no changes nothing, and a short absence is never asked about", async () => {
    const { s, clock } = await setup("2026-11-18T20:00:00");
    await s().clockIn();
    clock.now = at("2026-11-18T22:00");
    await s().handleActivity({ kind: "away", since: at("2026-11-18T20:30"), reason: "idle" });
    await s().handleActivity({ kind: "back", at: clock.now }); // 1 h 30 min
    expect(s().sleepCheck).toBeNull();
    await s().handleActivity({ kind: "away", since: at("2026-11-18T22:05"), reason: "locked" });
    clock.now = at("2026-11-19T02:30");
    await s().handleActivity({ kind: "back", at: clock.now });
    expect(s().sleepCheck).not.toBeNull();
    const before = JSON.stringify(s().settings.routine);
    await s().answerSleepCheck("no");
    expect(JSON.stringify(s().settings.routine)).toBe(before);
  });
});
