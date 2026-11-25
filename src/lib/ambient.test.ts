import { describe, expect, it } from "vitest";
import { DEFAULT_AMBIENT, ambientMove, canStartAmbient, nextAmbientView, normalizeAmbient } from "./ambient";

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
