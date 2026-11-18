import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { createLocalBackend, memoryKV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { findConflicts } from "@/lib/schedule";
import { applyTurn, turnEnv } from "./apply";
import { EMPTY_CONTEXT, planTurn, splitActivities, type ConvContext, type Turn } from "./converse";

const NBO = "Africa/Nairobi";
const at = (iso: string) => DateTime.fromISO(iso, { zone: NBO }).toMillis();
const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: NBO }).toFormat("ccc HH:mm");

/** A scheduling conversation against a real store. Wednesday 18 Nov 2026, 10:00 in Nairobi. */
async function chat() {
  let seq = 0;
  const clock = { now: at("2026-11-18T10:00") };
  const store = createNexusStore({ backend: createLocalBackend(memoryKV()), now: () => clock.now, id: () => `id${++seq}` });
  await store.getState().init();
  await store.getState().setSetting("homeZone", NBO);
  let ctx: ConvContext = EMPTY_CONTEXT;
  let pending: { text: string; answers: Record<string, string> } | null = null;
  const run = async (text: string, answers: Record<string, string> = {}): Promise<Turn> => {
    const s = store.getState();
    const turn = planTurn(text, turnEnv(s, clock.now), ctx, answers);
    pending = turn.question ? { text, answers } : null;
    if (!turn.question) ctx = await applyTurn(turn, s, ctx);
    return turn;
  };
  /** Answer the question the last message raised. */
  const answer = (value: string) => {
    const last = pending!;
    const q = planTurn(last.text, turnEnv(store.getState(), clock.now), ctx, last.answers).question!;
    return run(last.text, { ...last.answers, [q.key]: value });
  };
  const live = () => store.getState().events.filter((e) => !e.deletedAt).sort((a, b) => a.startAt - b.startAt);
  const schedule = () => live().map((e) => `${e.title} ${fmt(e.startAt)}-${DateTime.fromMillis(e.endAt, { zone: NBO }).toFormat("HH:mm")}${e.fixed ? " [fixed]" : ""}`);
  const ev = (title: string) => live().find((e) => e.title === title)!;
  const noOverlaps = () => {
    for (const e of live()) expect(findConflicts(live(), { start: e.startAt, end: e.endAt }, e.id)).toEqual([]);
  };
  return { store, clock, run, answer, live, schedule, ev, noOverlaps };
}

describe("conversational scheduling", () => {
  it("remembers the gym session and schedules the report before it", async () => {
    const c = await chat();
    const first = await c.run("Schedule my gym session tomorrow at 6 PM Kenya time for one hour.");
    expect(first.lines).toMatchObject([{ kind: "created", title: "Gym Session", slot: { start: at("2026-11-19T18:00"), end: at("2026-11-19T19:00") } }]);
    const second = await c.run("I also need to finish reviewing my financial report. Schedule it before the time I'm going to the gym.");
    expect(second.question).toBeNull();
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toMatchObject({ kind: "created", title: "Review Financial Report" });
    expect(second.lines[0].note).toMatch(/before Gym Session \(tomorrow 6 PM\)/); // the relationship is explained
    expect(second.lines[0].note).toMatch(/60 minutes assumed/); // no length was given
    const report = c.ev("Review Financial Report");
    const gym = c.ev("Gym Session");
    expect(report.endAt).toBeLessThanOrEqual(gym.startAt);
    expect(fmt(report.startAt)).toBe("Thu 09:00"); // the gym's day, in working hours
    expect(c.schedule()).toEqual(["Review Financial Report Thu 09:00-10:00", "Gym Session Thu 18:00-19:00"]);
    expect(c.store.getState().tasks.map((t) => t.title).sort()).toEqual(["Gym Session", "Review Financial Report"]);
    c.noOverlaps();
  });

  it("takes several activities from one message and keeps the order asked for", async () => {
    const c = await chat();
    const turn = await c.run("Tomorrow I need to review my financial report for two hours, attend a Zoom meeting at 3 PM, and go to the gym at 6 PM. Schedule the report before my meeting.");
    expect(turn.question).toBeNull();
    expect(turn.lines.map((l) => [l.kind, l.title, fmt(l.slot!.start), fmt(l.slot!.end), !!l.fixed])).toEqual([
      ["created", "Review Financial Report", "Thu 09:00", "Thu 11:00", false],
      ["created", "Zoom Meeting", "Thu 15:00", "Thu 16:00", true],
      ["created", "Gym", "Thu 18:00", "Thu 19:00", false],
    ]);
    expect(turn.lines[0].note).toMatch(/before Zoom Meeting/);
    expect(c.live()).toHaveLength(3); // three records, no duplicates
    expect(c.ev("Zoom Meeting").fixed).toBe(true); // a meeting at a set time is a fixed appointment
    expect(c.ev("Review Financial Report").endAt).toBeLessThanOrEqual(c.ev("Zoom Meeting").startAt);
    c.noOverlaps();
  });

  it("splits a sentence into activities only where a new activity starts", () => {
    expect(splitActivities("Tomorrow I need to review my financial report for two hours, attend a Zoom meeting at 3 PM, and go to the gym at 6 PM")).toHaveLength(3);
    expect(splitActivities("Buy milk and eggs tomorrow")).toEqual(["Buy milk and eggs tomorrow"]);
    expect(splitActivities("Call Amina and Brian at 3pm, preferably in the afternoon")).toHaveLength(1);
    expect(splitActivities("Review the contract and send the invoice tomorrow")).toEqual(["Review the contract", "send the invoice tomorrow"]);
    expect(splitActivities("Schedule a two-hour session to work on NEXUS tomorrow evening, before my gym appointment")).toHaveLength(1);
  });

  it("treats before and after as real constraints, including chains", async () => {
    const c = await chat();
    await c.run("Team meeting tomorrow 2pm to 3pm");
    const turn = await c.run("Write the agenda tomorrow for 1 hour before my meeting, and send the minutes for 30 minutes after my meeting.");
    expect(turn.question).toBeNull();
    const meeting = c.ev("Team Meeting");
    expect(c.ev("Write Agenda").endAt).toBeLessThanOrEqual(meeting.startAt);
    expect(c.ev("Send Minutes").startAt).toBeGreaterThanOrEqual(meeting.endAt);
    expect(fmt(c.ev("Send Minutes").startAt)).toBe("Thu 15:15"); // after the meeting and its buffer
    // a chain inside one message: C after B, B after A
    const chain = await c.run("On Friday draft the proposal for 2 hours. Review the budget for 1 hour after the proposal. Email the client for 30 minutes after the budget.");
    expect(chain.question).toBeNull();
    const [a, b, d] = ["Draft Proposal", "Review Budget", "Email Client"].map(c.ev);
    expect(a.endAt).toBeLessThanOrEqual(b.startAt);
    expect(b.endAt).toBeLessThanOrEqual(d.startAt);
    expect(fmt(a.startAt)).toBe("Fri 09:00");
    c.noOverlaps();
  });

  it("explains an impossible arrangement and offers the nearest times instead of ignoring it", async () => {
    const c = await chat();
    await c.run("Gym tomorrow at 6 PM for one hour");
    await c.store.getState().addEvent({ title: "All-day workshop", startAt: at("2026-11-19T07:00"), endAt: at("2026-11-19T17:30") });
    const turn = await c.run("Schedule a two-hour session to work on NEXUS tomorrow evening, before my gym appointment.");
    expect(turn.actions).toEqual([]);
    expect(turn.question!.text).toMatch(/Work on NEXUS: There is no free 2-hour slot before Gym/);
    expect(turn.question!.options.length).toBeGreaterThan(0);
    expect(c.live().map((e) => e.title)).not.toContain("Work on NEXUS"); // nothing created until I choose
    const picked = await c.answer(turn.question!.options[0].value);
    expect(picked.lines[0]).toMatchObject({ kind: "created", title: "Work on NEXUS" });
    c.noOverlaps();
  });

  it("handles the relative instructions", async () => {
    const c = await chat();
    await c.run("Tomorrow I need to repair Mineh's phone for 2 hours, attend a Zoom meeting at 3 PM, and have an interview at 11am.");
    expect(c.schedule()).toEqual(["Interview Thu 11:00-12:00 [fixed]", "Repair Mineh's Phone Thu 12:15-14:15", "Zoom Meeting Thu 15:00-16:00 [fixed]"]);
    // "Move that task to after my meeting."
    let t = await c.run("Move the phone repair task to after my meeting.");
    expect(t.lines[0]).toMatchObject({ kind: "moved", title: "Repair Mineh's Phone" });
    expect(c.ev("Repair Mineh's Phone").startAt).toBeGreaterThanOrEqual(c.ev("Zoom Meeting").endAt);
    // "Put the phone repair task before my evening appointment."
    await c.run("Dinner with Amina tomorrow at 7pm for 2 hours, fixed");
    t = await c.run("Put the phone repair task before my evening appointment.");
    expect(t.lines[0]).toMatchObject({ kind: "moved", title: "Repair Mineh's Phone" });
    expect(t.lines[0].note).toMatch(/before Dinner with Amina/);
    expect(c.ev("Repair Mineh's Phone").endAt).toBeLessThanOrEqual(c.ev("Dinner with Amina").startAt);
    // "Move the first task to tomorrow." / to another day
    t = await c.run("Move it to Friday.");
    expect(fmt(c.ev("Repair Mineh's Phone").startAt).slice(0, 3)).toBe("Fri");
    // "Make the Zoom meeting fixed." (already) and flexible
    t = await c.run("Make the Zoom meeting flexible.");
    expect(t.lines[0]).toMatchObject({ kind: "fixed", title: "Zoom Meeting", fixed: false });
    expect(c.ev("Zoom Meeting").fixed).toBe(false);
    t = await c.run("Make the Zoom meeting fixed.");
    expect(c.ev("Zoom Meeting").fixed).toBe(true);
    expect((await c.run("Make the Zoom meeting fixed.")).lines[0]).toMatchObject({ kind: "info", note: "Already fixed." });
    c.noOverlaps();
  });

  it("leaves a gap between two activities when asked", async () => {
    const c = await chat();
    await c.run("Tomorrow write the report from 9am to 11am and review the budget from 11:15am to 12pm.");
    expect(c.schedule()).toEqual(["Write Report Thu 09:00-11:00", "Review Budget Thu 11:15-12:00"]);
    const t = await c.run("Give me 30 minutes between those two activities.");
    expect(t.lines[0]).toMatchObject({ kind: "moved", title: "Review Budget" });
    expect(c.ev("Review Budget").startAt - c.ev("Write Report").endAt).toBeGreaterThanOrEqual(30 * 60_000);
    expect(fmt(c.ev("Review Budget").startAt)).toBe("Thu 11:30");
    expect((await c.run("Give me 30 minutes between those two activities.")).lines[0].note).toMatch(/already 30 minutes/);
  });

  it("reschedules everything except what is named, never touching fixed appointments", async () => {
    const c = await chat();
    await c.run("Today write notes at 2pm for 1 hour, review the budget at 4pm for 1 hour, and an interview at 3pm.");
    const interview = { ...c.ev("Interview") };
    const asked = await c.run("Reschedule everything except my interview.");
    expect(asked.question!.text).toBe("Move them to when?"); // it asks rather than assume
    const done = await c.answer("tomorrow");
    expect(done.lines.filter((l) => l.kind === "moved").map((l) => l.title)).toEqual(["Write Notes", "Review Budget"]);
    expect(done.lines.find((l) => l.kind === "info")!.note).toBe("Interview");
    expect(c.ev("Interview")).toMatchObject({ startAt: interview.startAt, endAt: interview.endAt, fixed: true });
    expect(c.schedule()).toEqual(["Interview Wed 15:00-16:00 [fixed]", "Write Notes Thu 09:00-10:00", "Review Budget Thu 10:15-11:15"]);
    c.noOverlaps();
  });

  it("schedules after lunch, using the lunch on the calendar when there is one", async () => {
    const c = await chat();
    const none = await c.run("Schedule the remaining work after lunch for 1 hour.");
    expect(none.lines[0]).toMatchObject({ kind: "created", title: "Remaining Work" });
    expect(fmt(c.ev("Remaining Work").startAt)).toBe("Wed 13:15"); // no lunch saved: after the usual lunch hour
    const d = await chat();
    await d.run("Lunch with Brian today at 1:30pm for 1 hour");
    await d.run("Schedule the remaining work after lunch for 1 hour.");
    expect(d.ev("Remaining Work").startAt).toBeGreaterThanOrEqual(d.ev("Lunch with Brian").endAt);
  });

  it("never invents an appointment, and asks when a reference could mean two things", async () => {
    const c = await chat();
    const missing = await c.run("Schedule the report before my dentist appointment.");
    expect(missing.actions).toEqual([]);
    expect(missing.lines[0]).toMatchObject({ kind: "problem" });
    expect(missing.lines[0].note).toMatch(/couldn't find “my dentist appointment”/);
    expect(c.live()).toEqual([]);

    await c.store.getState().addEvent({ title: "Budget meeting", startAt: at("2026-11-19T10:00"), endAt: at("2026-11-19T11:00") });
    await c.store.getState().addEvent({ title: "Design meeting", startAt: at("2026-11-19T14:00"), endAt: at("2026-11-19T15:00") });
    const unclear = await c.run("Prepare slides for 1 hour before my meeting.");
    expect(unclear.question!.text).toBe("Which one do you mean by “my meeting”?");
    expect(unclear.question!.options.map((o) => o.label)).toEqual(["Budget meeting — tomorrow 10 AM", "Design meeting — tomorrow 2 PM"]);
    const design = unclear.question!.options[1].value;
    await c.answer(design);
    expect(c.ev("Prepare Slides").endAt).toBeLessThanOrEqual(at("2026-11-19T14:00"));
    expect(c.ev("Prepare Slides").startAt).toBeGreaterThanOrEqual(at("2026-11-19T11:00"));
    // once it has been talked about, "my meeting" means that one
    const again = await c.run("Write the summary for 30 minutes after my meeting.");
    expect(again.question).toBeNull();
    expect(c.ev("Write Summary").startAt).toBeGreaterThanOrEqual(at("2026-11-19T15:00"));
  });

  it("gives an existing task a time instead of adding it twice, using its saved estimate", async () => {
    const c = await chat();
    const t = await c.store.getState().addTask({ title: "Review financial report", estimateMin: 90 }, { autoPlace: false });
    const turn = await c.run("I need to review my financial report tomorrow morning.");
    expect(turn.lines[0].note).toMatch(/Already in your To-Do list/);
    expect(c.store.getState().tasks.filter((x) => !x.deletedAt)).toHaveLength(1);
    const block = c.live()[0];
    expect(block).toMatchObject({ taskId: t.id, title: "Review financial report" });
    expect(block.endAt - block.startAt).toBe(90 * 60_000);
  });

  it("asks about wording that could be read two ways, per activity", async () => {
    const c = await chat();
    const turn = await c.run("Doctor appointment tomorrow at 9.");
    expect(turn.question!.text).toMatch(/Doctor Appointment: 9 in the morning or in the evening\?/);
    await c.answer("am");
    expect(fmt(c.ev("Doctor Appointment").startAt)).toBe("Thu 09:00");
  });

  it("works across Kenya and Texas time", async () => {
    const c = await chat();
    await c.run("Client call tomorrow at 10 AM Texas time for 30 minutes.");
    const call = c.ev("Client Call");
    expect(DateTime.fromMillis(call.startAt, { zone: "America/Chicago" }).toFormat("ccc HH:mm")).toBe("Thu 10:00");
    expect(fmt(call.startAt)).toBe("Thu 19:00");
    await c.run("Prepare notes for 1 hour before the client call.");
    expect(c.ev("Prepare Notes").endAt).toBeLessThanOrEqual(call.startAt);
  });

  it("completes nothing by itself and keeps fixed appointments where they are", async () => {
    const c = await chat();
    await c.run("Zoom meeting today at 11am for 1 hour. Write the report today at 12:30pm for 1 hour.");
    c.clock.now = at("2026-11-18T14:00");
    await c.store.getState().autoReschedule();
    expect(c.store.getState().tasks.every((t) => t.status !== "done")).toBe(true);
    expect(fmt(c.ev("Zoom Meeting").startAt)).toBe("Wed 11:00");
    expect(c.ev("Write Report").startAt).toBeGreaterThanOrEqual(c.clock.now);
  });
});
