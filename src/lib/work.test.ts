import { describe, expect, it } from "vitest";
import type { WorkSession } from "@/data/types";
import { createLocalBackend, memoryKV } from "@/data/backend";
import { createNexusStore } from "@/store/store";
import { activeSession, closeStraySessions, workedBetween } from "./work";

const H = 3600_000;
const MIN = 60_000;
const DAY0 = Date.UTC(2026, 10, 23, 0, 0);
const session = (id: string, start: number, end: number | null, pauses: [number, number | null][] = []): WorkSession => ({
  id, startedAt: DAY0 + start, endedAt: end == null ? null : DAY0 + end, note: "", createdAt: 0, updatedAt: 0,
  pauses: pauses.map(([s, e]) => ({ start: DAY0 + s, end: e == null ? null : DAY0 + e, reason: "idle" as const })),
});

describe("the work clock only counts real work", () => {
  it("never counts the same time twice, so a day can never hold more than 24 hours", () => {
    // what went wrong: two extra sessions left open since midnight, counting alongside the real one
    const sessions = [session("stray1", 0, null), session("stray2", 0, null), session("real", 9 * H, null, [[12 * H, 13 * H]])];
    const now = DAY0 + 12.75 * H;
    // counted one by one that is 12.75 + 12.75 + 3 hours; it is one stretch of 12.75 hours
    expect(workedBetween(sessions, DAY0, DAY0 + 24 * H, now)).toBe(12.75 * H);
    expect(workedBetween(sessions, DAY0, DAY0 + 24 * H, DAY0 + 30 * H)).toBeLessThanOrEqual(24 * H);
    // sessions that do not overlap still add up
    expect(workedBetween([session("a", 8 * H, 10 * H), session("b", 11 * H, 12 * H)], DAY0, DAY0 + 24 * H, now)).toBe(3 * H);
  });

  it("closes sessions left open by mistake where their work really stopped, and keeps the real one", () => {
    const now = DAY0 + 15 * H;
    const sessions = [
      { ...session("old", 1 * H, null, [[2 * H, 3 * H]]), updatedAt: 5 }, // really used (it has a pause), never closed; a new session began at 9:00
      session("copy", 4 * H, null), // created and never touched again: a plain duplicate
      session("paused", 9 * H, null, [[10 * H, null]]), // left in a pause at 10:00
      session("twin", 13 * H, null), // started at the same moment as the real one
      { ...session("real", 13 * H + 1, null), updatedAt: 9 }, // the one NEXUS has been keeping up to date
    ];
    const fixed = closeStraySessions(sessions, now);
    const end = (id: string) => (fixed.find((s) => s.id === id)!.endedAt! - DAY0) / H;
    expect(fixed.map((s) => s.id).sort()).toEqual(["copy", "old", "paused", "twin"]);
    expect(end("old")).toBe(4); // when the next session began
    expect(end("copy")).toBe(4); // a duplicate: it ends where it began
    expect(end("paused")).toBe(10); // when it stopped counting
    expect(end("twin")).toBeCloseTo(13, 5); // a duplicate: nothing of its own
    expect(fixed.find((s) => s.id === "paused")!.pauses).toEqual([]); // the pause it was left in is where it ends
    const after = sessions.map((s) => fixed.find((f) => f.id === s.id) ?? s);
    expect(activeSession(after)!.id).toBe("real");
    expect(after.filter((s) => s.endedAt == null)).toHaveLength(1);
    // 1:00–2:00 and 3:00–4:00 (old), 9:00–10:00 (paused), then 13:00–15:00 (real)
    expect(workedBetween(after, DAY0, DAY0 + 24 * H, now) / H).toBeCloseTo(5, 3);
    expect(closeStraySessions(after, now)).toEqual([]);
    expect(closeStraySessions([session("only", 2 * H, null)], now)).toEqual([]);
  });
});

describe("in the app", () => {
  async function setup() {
    const kv = memoryKV();
    let seq = 0;
    const clock = { now: DAY0 + 9 * H };
    const make = () => createNexusStore({ backend: createLocalBackend(kv), now: () => clock.now, id: () => `id${++seq}` });
    const store = make();
    await store.getState().init();
    await store.getState().setSetting("homeZone", "UTC");
    return { store, s: () => store.getState(), clock, make, kv };
  }
  const open = (s: { workSessions: WorkSession[] }) => s.workSessions.filter((w) => w.endedAt == null);
  const today = (s: { workSessions: WorkSession[] }, now: number) => workedBetween(s.workSessions, DAY0, DAY0 + 24 * H, now);

  it("many things asking for the clock at once still open exactly one session", async () => {
    const { s, clock } = await setup();
    // the idle check, two activity reports and a click on Clock in, all at the same moment
    await Promise.all([
      s().handleIdle(0),
      s().handleActivity({ kind: "back", at: clock.now }),
      s().clockIn(),
      s().handleActivity({ kind: "back", at: clock.now }),
      s().handleIdle(5),
      s().clockIn(),
    ]);
    expect(open(s())).toHaveLength(1);
    clock.now += 2 * H;
    expect(today(s(), clock.now)).toBe(2 * H);
  });

  it("counts only while I am active: not while away, not on a break, not after clocking out", async () => {
    const { s, clock } = await setup();
    await s().clockIn(); // 9:00
    clock.now = DAY0 + 10 * H;
    await s().handleActivity({ kind: "away", since: DAY0 + 9.5 * H, reason: "idle" }); // last input 9:30
    clock.now = DAY0 + 12 * H;
    expect(today(s(), clock.now)).toBe(30 * MIN); // nothing counted while away
    await s().handleActivity({ kind: "back", at: clock.now }); // back at 12:00
    clock.now = DAY0 + 13 * H;
    expect(today(s(), clock.now)).toBe(1.5 * H);
    await s().pauseWork(); // break at 13:00
    clock.now = DAY0 + 14 * H;
    await s().handleActivity({ kind: "back", at: clock.now }); // moving the mouse does not end a break
    await s().handleIdle(0);
    expect(today(s(), clock.now)).toBe(1.5 * H);
    await s().resumeWork(); // 14:00
    clock.now = DAY0 + 15 * H;
    await s().clockOut(); // 15:00
    clock.now = DAY0 + 20 * H;
    expect(today(s(), clock.now)).toBe(2.5 * H);
    expect(open(s())).toHaveLength(0);
  });

  it("repairs stray open sessions found in saved data, tells me, and the total is right again", async () => {
    const { s, clock, make, kv } = await setup();
    await s().clockIn(); // the real session, 9:00
    // two sessions left open by an earlier version, both "running" since midnight
    const backend = createLocalBackend(kv);
    await backend.upsertWork({ ...session("stray1", 0, null), startedAt: DAY0 + 1 });
    await backend.upsertWork({ ...session("stray2", 0, null), startedAt: DAY0 + 2 });
    clock.now = DAY0 + 12.75 * H;

    const again = make();
    await again.getState().init();
    const st = again.getState();
    expect(open(st)).toHaveLength(1);
    expect(activeSession(st.workSessions)!.startedAt).toBe(DAY0 + 9 * H);
    // not 25 hours and more: only the 9:00–12:45 that was really worked
    expect(today(st, clock.now)).toBe(3.75 * H);
    expect(st.toasts.some((t) => t.title === "Work clock corrected")).toBe(true);
    // and it stays repaired after another restart
    const third = make();
    await third.getState().init();
    expect(open(third.getState())).toHaveLength(1);
    expect(third.getState().toasts.some((t) => t.title === "Work clock corrected")).toBe(false);
  });
});
