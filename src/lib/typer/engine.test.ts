import { describe, expect, it } from "vitest";
import { BOLD, DEFAULT_TYPER, Humanizer, ITALIC, SHIFT_MAP, buildPlan, parseMarkup, prepareText, seeded, type KeyEvent } from "./engine";

const UNSHIFT: Record<string, string> = Object.fromEntries(Object.entries(SHIFT_MAP).map(([sym, key]) => [key, sym]));

/**
 * Play a plan into a model text editor and return what ends up in it.
 * `backspace` picks how the editor chooses the typing style after Backspace:
 * the character before the caret ("prev") or the one just removed ("deleted").
 * Real editors differ, so plans must come out right under both.
 */
function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function replay(events: Pick<KeyEvent, "t" | "down" | "key">[], backspace: "prev" | "deleted" = "prev") {
  const buf: string[] = [];
  const sty: number[] = [];
  const down = new Set<string>();
  let cur = 0;
  let style = 0;
  let last = -1;
  let maxDown = 0;
  let overlaps = 0;
  const caret = () => {
    if (cur > 0) style = sty[cur - 1];
  };
  for (const e of events) {
    check(e.t >= Math.max(0, last), "events out of order");
    last = e.t;
    if (!e.down) {
      check(down.has(e.key), `release of a key that is up: ${e.key}`);
      down.delete(e.key);
      continue;
    }
    check(!down.has(e.key), `press of a key that is already down: ${e.key}`);
    if (e.key.length === 1 && [...down].some((k) => !k.startsWith("<"))) overlaps += 1;
    down.add(e.key);
    maxDown = Math.max(maxDown, down.size);
    const shift = down.has("<shift>");
    const mod = down.has("<mod>");
    if (e.key === "<shift>" || e.key === "<mod>") {
      check(!(shift && mod), "Shift and Ctrl together");
      continue;
    }
    if (mod) {
      // only Ctrl+B / Ctrl+I, with nothing else held
      check((e.key === "b" || e.key === "i") && down.size === 2, `unexpected Ctrl+${e.key}`);
      style ^= e.key === "b" ? BOLD : ITALIC;
      continue;
    }
    if (e.key.startsWith("<") && e.key !== "<enter>" && e.key !== "<tab>") check(!shift, `${e.key} with Shift held would select text`);
    if (e.key === "<backspace>") {
      cur -= 1;
      const gone = sty[cur];
      buf.splice(cur, 1);
      sty.splice(cur, 1);
      if (backspace === "prev") caret();
      else style = gone;
    } else if (e.key === "<delete>") {
      buf.splice(cur, 1);
      sty.splice(cur, 1);
      if (backspace === "prev") caret();
    } else if (e.key === "<left>") {
      check(cur > 0, "left at start");
      cur -= 1;
      caret();
    } else if (e.key === "<right>") {
      check(cur < buf.length, "right at end");
      cur += 1;
      caret();
    } else {
      let c = e.key === "<enter>" ? "\n" : e.key === "<tab>" ? "\t" : e.key;
      if (shift) c = UNSHIFT[c] ?? c.toUpperCase();
      buf.splice(cur, 0, c);
      sty.splice(cur, 0, style);
      cur += 1;
    }
  }
  expect([...down]).toEqual([]);
  expect(style).toBe(0);
  return { text: buf.join(""), styles: sty, maxDown, overlaps };
}

const PROSE =
  "Hello there, World! This is a test of the typer; it's 100% working (I hope). Their plan was better than the first one, and then we went to the shop for a bit.\n" +
  "Second line: e-mail me @ foo_bar+1@example.com? OK... USA #1 {x} <y> ~z|\n\nThe end of it is near.";

const MARKED = [
  "# Project **Update** for Q3",
  "This is **very important**: the *quick* brown fox, and __their__ plan was _better_ than the first one.",
  "***Bold italic*** start. Then we went to the **shop** for a bit of the *best bread in town*, I think.",
  "Not emphasis: 2 * 3 * 4, snake_case_name, a*b*c, \\*literal\\*, **unclosed and * lone.",
  "- **Item one:** done",
  "- Item *two*: mixed**Bold**word here and **B**old.",
].join("\n");

describe("parseMarkup", () => {
  it("drops markers and keeps the styles", () => {
    const p = parseMarkup("a **b** *c* ***d*** __e__ _f_");
    expect(p.map((x) => x.ch).join("")).toBe("a b c d e f");
    expect(p.filter((x) => x.ch !== " ").map((x) => x.style)).toEqual([0, BOLD, ITALIC, BOLD | ITALIC, BOLD, ITALIC]);
  });

  it("types headings bold without the #", () => {
    const p = parseMarkup("## Title here\nbody");
    expect(p.map((x) => x.ch).join("")).toBe("Title here\nbody");
    expect(p.slice(0, 10).every((x) => x.style === BOLD)).toBe(true);
    expect(p.slice(10).every((x) => x.style === 0)).toBe(true);
  });

  it("leaves things that only look like markers alone", () => {
    const src = "2 * 3 * 4, snake_case_name, a*b*c, **unclosed and * lone, - bullet";
    const p = parseMarkup(src);
    expect(p.map((x) => x.ch).join("")).toBe(src);
    expect(p.every((x) => x.style === 0)).toBe(true);
    expect(parseMarkup("\\*literal\\*").map((x) => x.ch).join("")).toBe("*literal*");
  });

  it("reports where each kept character sits in the source", () => {
    const src = "x **bo** y";
    for (const c of parseMarkup(src)) expect(src.slice(c.index, c.index + c.ch.length)).toBe(c.ch);
  });
});

describe("Humanizer", () => {
  const settings = [
    { errorRate: 0.025, revise: true },
    { errorRate: 0.1, revise: false },
    { errorRate: 0.12, revise: true },
    { errorRate: 0, revise: true },
  ];

  it("always ends with exactly the text it was given", () => {
    const texts = [PROSE, "a", "", "  lead\ttab  ", "THE QUICK BROWN FOX!!", "naïve café déjà vu 😀 ok"];
    for (let seed = 0; seed < 60; seed++) {
      for (const text of texts) {
        for (const technique of ["touch", "two-finger", "one-handed"] as const) {
          const cfg = settings[seed % settings.length];
          const h = new Humanizer({ ...cfg, technique, wpm: [30, 60, 110][seed % 3], random: seeded(seed * 7 + 1) });
          const out = replay(h.run(text));
          expect(out.text).toBe(text);
          expect(h.buf.join("")).toBe(text);
          expect(out.maxDown).toBeLessThanOrEqual(3);
        }
      }
    }
  }, 30_000);

  it("types bold and italic with Ctrl+B / Ctrl+I and never leaves them on", () => {
    const parsed = parseMarkup(MARKED);
    const text = parsed.map((p) => p.ch).join("");
    const styles = parsed.map((p) => p.style);
    const chars = Array.from(text);
    for (let seed = 0; seed < 150; seed++) {
      const cfg = settings[seed % 3];
      const events = new Humanizer({ ...cfg, wpm: [40, 70, 120][seed % 3], random: seeded(seed + 1000) }).run(text, styles);
      for (const model of ["prev", "deleted"] as const) {
        const out = replay(events, model);
        expect(out.text).toBe(text);
        const wrong = chars.map((c, i) => [c, out.styles[i], styles[i]] as const).filter(([c, got, want]) => got !== want && c.trim());
        expect(wrong, `seed ${seed}, ${model}`).toEqual([]);
      }
    }
  }, 30_000);

  it("makes real mistakes, corrections and revisions", () => {
    const count: Record<string, number> = {};
    for (let seed = 0; seed < 40; seed++) {
      for (const e of new Humanizer({ errorRate: 0.05, random: seeded(seed + 5) }).run(PROSE)) if (e.down) count[e.key] = (count[e.key] ?? 0) + 1;
    }
    for (const key of ["<backspace>", "<delete>", "<left>", "<right>", "<shift>", "<enter>"]) expect(count[key] ?? 0, key).toBeGreaterThan(0);
  });

  it("only uses Backspace when arrow-key revisions are off", () => {
    for (let seed = 0; seed < 40; seed++) {
      const keys = new Set(new Humanizer({ errorRate: 0.1, revise: false, random: seeded(seed) }).run(PROSE).map((e) => e.key));
      expect(keys.has("<left>") || keys.has("<right>") || keys.has("<delete>")).toBe(false);
    }
  });

  it("overlaps keys when typing fast, never with two-finger typing", () => {
    const run = (wpm: number, technique: "touch" | "two-finger") => replay(new Humanizer({ wpm, technique, random: seeded(3) }).run(PROSE.repeat(3))).overlaps;
    expect(run(120, "touch")).toBeGreaterThan(20);
    expect(run(120, "two-finger")).toBe(0);
  });

  it("varies key holds and gaps instead of using fixed intervals", () => {
    const events = new Humanizer({ random: seeded(9) }).run(PROSE);
    const presses = events.filter((e) => e.down);
    const gaps = new Set(presses.slice(1).map((e, i) => Math.round((e.t - presses[i].t) * 1000)));
    expect(gaps.size).toBeGreaterThan(80);
    expect(Math.max(...presses.slice(1).map((e, i) => e.t - presses[i].t))).toBeGreaterThan(1); // real pauses
  });
});

describe("buildPlan", () => {
  it("strips or applies formatting by mode", () => {
    expect(prepareText("a **b**", "strip")).toEqual({ text: "a b" });
    expect(prepareText("a **b**", "literal")).toEqual({ text: "a **b**" });
    expect(prepareText("a **b**", "apply")).toEqual({ text: "a b", styles: [0, 0, BOLD] });
    expect(prepareText("plain\r\ntext", "apply")).toEqual({ text: "plain\ntext" });
  });

  it("repeats with Enter in between and stays exact", () => {
    const plan = buildPlan("Hi **there**", { ...DEFAULT_TYPER, repeat: 3, enterAfter: true, mistakes: 6 }, seeded(4));
    const out = replay(plan.events);
    expect(out.text).toBe("Hi there\nHi there\nHi there\n");
    expect(plan.chars).toBe(24);
    expect(plan.duration).toBeGreaterThan(plan.events[plan.events.length - 2].t);
  });

  it("plans nothing for empty text and clamps wild settings", () => {
    expect(buildPlan("", DEFAULT_TYPER).events).toEqual([]);
    const plan = buildPlan("ok", { ...DEFAULT_TYPER, wpm: NaN, mistakes: 999, pauses: -5, repeat: 1e9 }, seeded(1));
    expect(replay(plan.events).text).toBe("ok".repeat(50));
  });
});
