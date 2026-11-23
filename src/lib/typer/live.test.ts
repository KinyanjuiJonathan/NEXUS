import { describe, expect, it } from "vitest";
import { NEW_DICTATION, ScreenFollower, backspaceEvents, dictate, type DictationState } from "./live";

describe("dictation", () => {
  const say = (phrases: string[], opts = {}) => {
    let state: DictationState = NEW_DICTATION;
    let text = "";
    let stopped = false;
    for (const p of phrases) {
      const step = dictate(p, state, opts);
      state = step.state;
      if (step.backspaces) text = Array.from(text).slice(0, -step.backspaces).join("");
      text += step.type;
      stopped = stopped || step.stop;
    }
    return { text, stopped, state };
  };

  it("joins phrases into sentences with capitals and single spaces", () => {
    expect(say(["hello there", "this is a test"]).text).toBe("Hello there this is a test");
    // the recogniser capitalises every phrase; mid-sentence that is undone, but not for "I"
    expect(say(["The report is ready", "And I sent it"]).text).toBe("The report is ready and I sent it");
    expect(say(["first sentence.", "second one"]).text).toBe("First sentence. Second one");
  });

  it("turns spoken punctuation and layout into the real thing", () => {
    expect(say(["dear team comma", "the build passed full stop", "new line", "thanks exclamation mark"]).text).toBe("Dear team, the build passed.\nThanks!");
    expect(say(["is it done question mark new paragraph next item colon tests"]).text).toBe("Is it done?\n\nNext item: tests");
    expect(say(["one", "two"], { fullStop: true }).text).toBe("One. Two.");
  });

  it("takes back the last phrase and stops on request", () => {
    const r = say(["keep this", "not this part", "delete that", "but this"]);
    expect(r.text).toBe("Keep this but this");
    expect(say(["hello", "delete that", "delete that"]).text).toBe("");
    expect(say(["some words", "stop dictation"]).stopped).toBe(true);
    expect(dictate("   ", NEW_DICTATION)).toMatchObject({ type: "", stop: false });
  });

  it("removes characters with the Backspace key", () => {
    const ev = backspaceEvents(3);
    expect(ev).toHaveLength(6);
    expect(ev.every((e) => e.key === "<backspace>")).toBe(true);
    expect(ev.filter((e) => e.down)).toHaveLength(3);
    for (let i = 1; i < ev.length; i++) expect(ev[i].t).toBeGreaterThanOrEqual(ev[i - 1].t);
  });
});

describe("following a region of the screen", () => {
  it("types only what is new, and only once it has been read the same way twice", () => {
    const f = new ScreenFollower();
    expect(f.feed(["Alice: hello", "Bob: hi"])).toBe(""); // what is already there is the starting point
    expect(f.feed(["Alice: hello", "Bob: hi", "Alice: how are you"])).toBe(""); // seen once: wait
    expect(f.feed(["Alice: hello", "Bob: hi", "Alice: how are you"])).toBe("Alice: how are you");
    expect(f.feed(["Alice: hello", "Bob: hi", "Alice: how are you"])).toBe(""); // never twice
    // the window scrolls: old lines leave, a new one arrives
    expect(f.feed(["Bob: hi", "Alice: how are you", "Bob: fine thanks"])).toBe("");
    expect(f.feed(["Bob: hi", "Alice: how are you", "Bob: fine thanks"])).toBe("\nBob: fine thanks");
  });

  it("ignores a one-off misreading", () => {
    const f = new ScreenFollower();
    f.feed(["Total: 100"]);
    expect(f.feed(["Total: 100", "Paid in fu11"])).toBe(""); // misread once
    expect(f.feed(["Total: 100", "Paid in full"])).toBe(""); // read differently: still not settled
    expect(f.feed(["Total: 100", "Paid in full"])).toBe("Paid in full");
  });

  it("follows a line that keeps growing, typing only the part that was added", () => {
    const f = new ScreenFollower({ joiner: "newline", includeExisting: false });
    f.feed([]);
    f.feed(["The quick brown"]);
    expect(f.feed(["The quick brown"])).toBe("The quick brown");
    f.feed(["The quick brown fox jumps"]);
    expect(f.feed(["The quick brown fox jumps"])).toBe(" fox jumps");
    f.feed(["The quick brown fox jumps over the dog"]);
    expect(f.feed(["The quick brown fox jumps over the dog"])).toBe(" over the dog");
  });

  it("can start with what is already on screen, and join lines with spaces", () => {
    const f = new ScreenFollower({ joiner: "space", includeExisting: true });
    expect(f.feed(["one", "two"])).toBe("");
    expect(f.feed(["one", "two"])).toBe("one two");
    f.feed(["one", "two", "three"]);
    expect(f.feed(["one", "two", "three"])).toBe(" three");
    f.reset();
    expect(f.feed(["one"])).toBe("");
  });
});
