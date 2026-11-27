import { describe, expect, it } from "vitest";
import { Stitcher, layout, mergeIntoPad, render, sameLine, type OcrLine } from "./extract";

/** A page of text; a reading is a window of consecutive lines, as a scrolled region shows. */
const PAGE = [
  "Chapter one: getting started",
  "This guide explains how the system works.",
  "Read it from top to bottom before you begin.",
  "Step 1 is to install the program on your computer.",
  "Step 2 is to open it and sign in with your account.",
  "Step 3 is to choose the folder you want to keep in sync.",
  "After that everything happens by itself in the background.",
  "If something goes wrong, look at the log file first.",
  "The log is kept in the same folder as the program.",
  "Contact support only after you have read the log.",
];
const H = 20;
const view = (from: number, count: number, texts = PAGE): OcrLine[] => texts.slice(from, from + count).map((text, i) => ({ text, x: 10, y: i * 28, w: text.length * 9, h: H }));
const read = (s: Stitcher, lines: OcrLine[]) => s.feed(layout(lines));
const text = (s: Stitcher) => s.lines.map((l) => l.text);

describe("extracting text while scrolling", () => {
  it("adds only what is new as the region scrolls down", () => {
    const s = new Stitcher();
    expect(read(s, view(0, 4)).added).toBe(4);
    const second = read(s, view(2, 4));
    expect(second).toMatchObject({ added: 2, aligned: true, fresh: [false, false, true, true] });
    read(s, view(5, 4));
    read(s, view(6, 4));
    expect(text(s)).toEqual(PAGE);
  });

  it("the same reading again, or scrolling back up, adds nothing", () => {
    const s = new Stitcher();
    read(s, view(0, 5));
    read(s, view(3, 5));
    expect(read(s, view(3, 5)).added).toBe(0);
    expect(read(s, view(1, 5)).added).toBe(0);
    expect(read(s, view(0, 3)).added).toBe(0);
    expect(text(s)).toEqual(PAGE.slice(0, 8));
  });

  it("a few misread characters do not make a line count as new", () => {
    const s = new Stitcher();
    read(s, view(0, 4));
    const noisy = view(1, 4).map((l, i) => (i === 1 ? { ...l, text: l.text.replace("top", "t0p").replace("begin", "beg1n") } : l));
    expect(read(s, noisy).added).toBe(1);
    expect(text(s)).toEqual(PAGE.slice(0, 5));
    expect(sameLine("read it from top to bottom", "read it from t0p to bottom")).toBe(true);
    expect(sameLine("step 1 is to install", "step 2 is to open it")).toBe(false);
  });

  it("a line cut off by the edge of the region is completed by the next reading", () => {
    const s = new Stitcher();
    const cut = view(0, 4);
    cut[3] = { ...cut[3], text: "Step 1 is to install the pro" };
    read(s, cut);
    read(s, view(2, 4));
    expect(text(s)).toEqual(PAGE.slice(0, 6));
  });

  it("lines that really repeat in the text are kept", () => {
    const page = ["function one() {", "return compute(alpha, beta);", "}", "", "function two() {", "return compute(alpha, beta);", "}"].filter(Boolean);
    const s = new Stitcher();
    read(s, view(0, 3, page));
    read(s, view(2, 3, page));
    read(s, view(3, 3, page));
    expect(text(s)).toEqual(page);
  });

  it("after a jump to somewhere else, text that was already read is not taken again", () => {
    const s = new Stitcher();
    read(s, view(0, 4));
    const far = read(s, view(7, 3));
    expect(far).toMatchObject({ aligned: false, added: 3 });
    // back to the start: all of it is known
    expect(read(s, view(0, 4)).added).toBe(0);
    // and on to a part not read yet
    expect(read(s, view(4, 3)).added).toBe(3);
  });
});

describe("keeping the layout", () => {
  it("keeps indentation, paragraph gaps and larger text", () => {
    const lines: OcrLine[] = [
      { text: "Release notes", x: 10, y: 0, w: 220, h: 34 },
      { text: "What changed in this version:", x: 10, y: 60, w: 29 * 9, h: H },
      { text: "- faster start", x: 46, y: 88, w: 14 * 9, h: H },
      { text: "- fewer questions", x: 46, y: 116, w: 17 * 9, h: H },
      { text: "Thank you for reading.", x: 10, y: 176, w: 22 * 9, h: H },
    ];
    const doc = layout(lines);
    expect(doc.map((l) => l.text)).toEqual(["Release notes", "What changed in this version:", "    - faster start", "    - fewer questions", "Thank you for reading."]);
    expect(doc.map((l) => l.gap)).toEqual([false, true, false, false, true]);
    expect(doc[0].heading).toBe(true);
    expect(render(doc, true)).toBe("# Release notes\n\nWhat changed in this version:\n    - faster start\n    - fewer questions\n\nThank you for reading.");
    expect(render(doc, false).startsWith("Release notes\n\nWhat changed")).toBe(true);
  });

  it("text on the same row is one line, and marks the pad would read as formatting are kept as text", () => {
    const doc = layout([
      { text: "Total", x: 10, y: 0, w: 45, h: H },
      { text: "5 * 3 = 15", x: 200, y: 1, w: 90, h: H },
      { text: "snake_case_name", x: 10, y: 28, w: 135, h: H },
    ]);
    expect(doc.map((l) => l.text)).toEqual(["Total    5 * 3 = 15", "snake_case_name"]);
    expect(render(doc, true)).toBe("Total    5 \\* 3 = 15\nsnake\\_case\\_name");
  });
});

describe("capturing section by section", () => {
  const capture = (s: Stitcher, pad: string, lines: OcrLine[]) => {
    const before = render(s.lines, true);
    const count = s.lines.length;
    const r = s.feed(layout(lines));
    const tail = render(s.lines.slice(count + r.prepended), true);
    return { pad: mergeIntoPad(pad, before, render(s.lines, true), r.added - r.prepended > 0 ? tail : ""), r };
  };

  it("each capture adds after the last, and what was captured is never changed", () => {
    const s = new Stitcher(true);
    let pad = "";
    ({ pad } = capture(s, pad, view(0, 4)));
    const first = pad;
    // the same lines read slightly differently the second time: the earlier text stays as it was
    const again = view(2, 4).map((l, i) => (i === 0 ? { ...l, text: l.text.replace("Read", "Rcad") } : l));
    ({ pad } = capture(s, pad, again));
    expect(pad.startsWith(first)).toBe(true);
    expect(pad.split("\n")).toEqual(PAGE.slice(0, 6));
    // capturing the same place again changes nothing
    expect(capture(s, pad, again).pad).toBe(pad);
  });

  it("a section from above the first capture goes in front, in reading order", () => {
    const s = new Stitcher(true);
    let pad = "";
    ({ pad } = capture(s, pad, view(3, 4)));
    ({ pad } = capture(s, pad, view(1, 4)));
    expect(pad.split("\n")).toEqual(PAGE.slice(1, 7));
  });

  it("text the user wrote or edited in the pad is kept", () => {
    const s = new Stitcher(true);
    let pad = "My notes:";
    ({ pad } = capture(s, pad, view(0, 3)));
    expect(pad).toBe(`My notes:\n\n${PAGE.slice(0, 3).join("\n")}`);
    // the user corrects a word in the captured text, then captures the next section
    pad = pad.replace("getting started", "GETTING STARTED");
    ({ pad } = capture(s, pad, view(2, 3)));
    expect(pad).toBe(`My notes:\n\n${[PAGE[0].replace("getting started", "GETTING STARTED"), ...PAGE.slice(1, 5)].join("\n")}`);
  });

  it("a line sliced through by the edge is left for the next capture, a whole line at the edge is kept", () => {
    const lines = view(0, 4).map((l) => ({ ...l, y: l.y + 6 }));
    // the last line runs past the bottom of a 100 px region: only the top 9 px of its letters are in the picture
    lines[3] = { ...lines[3], y: 91, h: 9 };
    expect(layout(lines, { height: 100 }).map((l) => l.text)).toEqual(PAGE.slice(0, 3));
    // whole lines right against the top and bottom edges are part of the capture
    const flush = view(0, 4).map((l, i) => ({ ...l, y: i === 0 ? 0 : i === 3 ? 80 : l.y }));
    expect(layout(flush, { height: 100 }).map((l) => l.text)).toEqual(PAGE.slice(0, 4));
  });
});
