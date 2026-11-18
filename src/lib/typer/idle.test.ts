import { describe, expect, it } from "vitest";
import { shouldLeaveTyper } from "./idle";

describe("Auto Typer inactivity return", () => {
  const base = { enabled: true, minutes: 5, idleSeconds: 0, busy: false };

  it("returns to the dashboard only after the full timeout without input", () => {
    expect(shouldLeaveTyper({ ...base, idleSeconds: 299 })).toBe(false);
    expect(shouldLeaveTyper({ ...base, idleSeconds: 300 })).toBe(true);
    // any activity resets the idle time, so the countdown starts again
    expect(shouldLeaveTyper({ ...base, idleSeconds: 2 })).toBe(false);
  });

  it("never leaves while the Auto Typer is running", () => {
    expect(shouldLeaveTyper({ ...base, idleSeconds: 3600, busy: true })).toBe(false);
  });

  it("does nothing when the option is off", () => {
    expect(shouldLeaveTyper({ ...base, enabled: false, idleSeconds: 3600 })).toBe(false);
  });

  it("honours a custom timeout and falls back to five minutes for bad values", () => {
    expect(shouldLeaveTyper({ ...base, minutes: 1, idleSeconds: 61 })).toBe(true);
    expect(shouldLeaveTyper({ ...base, minutes: 30, idleSeconds: 600 })).toBe(false);
    expect(shouldLeaveTyper({ ...base, minutes: NaN, idleSeconds: 299 })).toBe(false);
    expect(shouldLeaveTyper({ ...base, minutes: 0, idleSeconds: 300 })).toBe(true);
  });
});
