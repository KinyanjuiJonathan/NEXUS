import { describe, expect, it } from "vitest";
import { DEFAULT_AMBIENT, ambientMove, canStartAmbient, nextAmbientView, normalizeAmbient } from "./ambient";
import { deadlineHeat, hotTasks } from "./deadline";
import type { Task } from "@/data/types";

const H = 3600_000;

describe("ambient mode", () => {
  it("starts only after the idle time, from an overview page, with nothing open", () => {
    const base = { view: "dashboard" as const, idleMs: 3 * 60_000, busy: false, hidden: false };
    expect(canStartAmbient(DEFAULT_AMBIENT, base)).toBe(true);
    expect(canStartAmbient(DEFAULT_AMBIENT, { ...base, idleMs: 2 * 60_000 })).toBe(false);
    expect(canStartAmbient(DEFAULT_AMBIENT, { ...base, busy: true })).toBe(false);
    expect(canStartAmbient(DEFAULT_AMBIENT, { ...base, hidden: true })).toBe(false);
    expect(canStartAmbient(DEFAULT_AMBIENT, { ...base, view: "accounts" })).toBe(false);
    expect(canStartAmbient(DEFAULT_AMBIENT, { ...base, view: "typer" })).toBe(false);
    expect(canStartAmbient({ ...DEFAULT_AMBIENT, enabled: false }, base)).toBe(false);
  });

  it("goes round the chosen pages in order and never to a private one", () => {
    const a = normalizeAmbient({ pages: ["calendar", "accounts", "tasks"] as never });
    expect(a.pages).toEqual(["calendar", "tasks"]);
    expect(nextAmbientView(a, "calendar")).toBe("tasks");
    expect(nextAmbientView(a, "tasks")).toBe("calendar");
    expect(nextAmbientView(a, "history")).toBe("calendar");
    expect(normalizeAmbient({ idleMin: 0, everySec: 1, pages: [] })).toMatchObject({ idleMin: 3, everySec: 10, pages: DEFAULT_AMBIENT.pages });
    expect(ambientMove(0)).not.toBe(ambientMove(1));
  });
});

describe("deadline heat", () => {
  const now = Date.UTC(2026, 10, 18, 10);
  const task = (dueIn: number | null, extra: Partial<Task> = {}) => ({ id: `t${dueIn}`, status: "todo", dueAt: dueIn == null ? null : now + dueIn, deletedAt: null, archivedAt: null, ...extra }) as Task;

  it("warms up as the deadline comes closer", () => {
    expect(deadlineHeat(task(null), now).heat).toBe("none");
    expect(deadlineHeat(task(30 * H), now).heat).toBe("none");
    expect(deadlineHeat(task(10 * H), now)).toMatchObject({ heat: "near", label: "10 h left" });
    expect(deadlineHeat(task(1 * H), now).heat).toBe("close");
    expect(deadlineHeat(task(-2 * H), now)).toMatchObject({ heat: "late", label: "2 h late" });
    expect(deadlineHeat(task(1 * H, { status: "done" }), now).heat).toBe("none");
    expect(deadlineHeat(task(12 * H), now).burn).toBeCloseTo(0.5);
  });

  it("a task planned to finish after its deadline is already at risk", () => {
    const info = deadlineHeat(task(10 * H), now, now + 11 * H);
    expect(info).toMatchObject({ heat: "close", atRisk: true });
    expect(deadlineHeat(task(10 * H), now, now + 9 * H).heat).toBe("near");
  });

  it("lists the hot tasks, most urgent first", () => {
    const tasks = [task(10 * H), task(-1 * H), task(40 * H), task(1 * H)];
    expect(hotTasks(tasks, [], now).map((x) => x.info.heat)).toEqual(["late", "close", "near"]);
  });
});
