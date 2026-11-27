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

describe("tables", () => {
  // The table in the screenshot: four columns, cells of several lines, a header row.
  const COLS = [64, 223, 382, 541];
  const cell = (col: number, y: number, text: string): OcrLine => ({ text, x: COLS[col], y, w: Math.min(150, text.length * 6.2), h: 11 });
  const TABLE: OcrLine[] = [
    { text: "Behavioral Issues Types table", x: 58, y: 138, w: 250, h: 15 },
    // header (two lines in the third column)
    cell(0, 173, "Behavioral Issue"), cell(1, 173, "Description"), cell(2, 173, "Example of what to"), cell(3, 173, "What to document"),
    cell(2, 194, "watch for"),
    // first row
    cell(0, 226, "Code Hallucinations"), cell(1, 226, "Invents or assumes"), cell(2, 226, "Invents a method on a real"), cell(3, 226, "The specific hallucinated"),
    cell(1, 242, "existence of functions, APIs,"), cell(2, 242, "class; invents API functions;"), cell(3, 242, "code element and what"),
    cell(1, 258, "libraries, or code structures"), cell(2, 258, "creates imports from"), cell(3, 258, "actually exists"),
    cell(1, 274, "that don't exist."), cell(2, 274, "non-"),
    cell(2, 290, "existent modules"),
    // second row
    cell(0, 355, "Documentation Issues"), cell(1, 355, "Creates unwanted"), cell(2, 355, "Adds documentation when"), cell(3, 355, "What documentation was"),
    cell(1, 371, "documentation"), cell(2, 371, "not requested"), cell(3, 371, "added"),
  ];

  it("a table comes out row by row, each cell whole, with tabs between the cells", () => {
    const doc = layout(TABLE);
    expect(doc.map((l) => l.text)).toEqual([
      "Behavioral Issues Types table",
      "Behavioral Issue\tDescription\tExample of what to watch for\tWhat to document",
      "Code Hallucinations\tInvents or assumes existence of functions, APIs, libraries, or code structures that don't exist.\tInvents a method on a real class; invents API functions; creates imports from non-existent modules\tThe specific hallucinated code element and what actually exists",
      "Documentation Issues\tCreates unwanted documentation\tAdds documentation when not requested\tWhat documentation was added",
    ]);
    expect(doc.map((l) => !!l.table)).toEqual([false, true, true, true]);
    // the table stands apart from the heading above it; its rows follow one another
    expect(doc.map((l) => l.gap)).toEqual([false, true, false, false]);
  });

  it("a simple table with one line per cell keeps one row per line", () => {
    const rows = [["Name", "Hours", "Rate"], ["Amina", "12", "40"], ["Brian", "6", "54"]];
    const doc = layout(rows.flatMap((r, i) => r.map((text, c) => ({ text, x: [20, 180, 300][c], y: 10 + i * 30, w: text.length * 7, h: 12 }))));
    expect(doc.map((l) => l.text)).toEqual(["Name\tHours\tRate", "Amina\t12\t40", "Brian\t6\t54"]);
  });

  it("ordinary text is not mistaken for a table", () => {
    // a label and its value on one row, then a paragraph: laid out as before
    const doc = layout([
      { text: "Total", x: 10, y: 0, w: 45, h: 20 },
      { text: "5 * 3 = 15", x: 200, y: 1, w: 90, h: 20 },
      { text: "This sentence is long enough to run across where the second column would begin.", x: 10, y: 28, w: 620, h: 20 },
      { text: "And so is this one, which follows it on the next line of the paragraph.", x: 10, y: 56, w: 560, h: 20 },
    ]);
    expect(doc.every((l) => !l.table)).toBe(true);
    expect(doc[0].text).toBe("Total    5 * 3 = 15");
  });

  it("the text after a table is ordinary text again", () => {
    const after: OcrLine = { text: "Log an entry whenever one of these issues shows up in a run, with a quote and a severity.", x: 58, y: 420, w: 640, h: 11 };
    const doc = layout([...TABLE, after]);
    expect(doc.at(-1)).toMatchObject({ text: after.text, gap: true });
    expect(doc.at(-1)!.table).toBeFalsy();
  });

  it("a row cut off by the edge is completed by the next capture, and nothing is repeated", () => {
    const s = new Stitcher(true);
    // first capture ends in the middle of the first row
    s.feed(layout(TABLE.filter((l) => l.y <= 242)));
    expect(s.lines.at(-1)!.text).toBe("Code Hallucinations\tInvents or assumes existence of functions, APIs,\tInvents a method on a real class; invents API functions;\tThe specific hallucinated code element and what");
    // second capture, scrolled down: from the header's second line to the end
    const r = s.feed(layout(TABLE.filter((l) => l.y >= 173)));
    expect(r.added).toBe(2); // the completed row and the new one
    expect(s.lines.map((l) => l.text.split("\t")[0])).toEqual(["Behavioral Issues Types table", "Behavioral Issue", "Code Hallucinations", "Documentation Issues"]);
    expect(s.lines[2].text).toContain("non-existent modules");
    // capturing the same place again changes nothing
    const again = s.lines.map((l) => l.text);
    expect(s.feed(layout(TABLE.filter((l) => l.y >= 173))).added).toBe(0);
    expect(s.lines.map((l) => l.text)).toEqual(again);
  });

  it("a table is written as a list: every row under the table's headings", () => {
    expect(render(layout(TABLE), false)).toBe(
      [
        "Behavioral Issues Types table",
        "",
        "Behavioral Issue:",
        "Code Hallucinations",
        "",
        "Description:",
        "Invents or assumes existence of functions, APIs, libraries, or code structures that don't exist.",
        "",
        "Example of what to watch for:",
        "Invents a method on a real class; invents API functions; creates imports from non-existent modules",
        "",
        "What to document:",
        "The specific hallucinated code element and what actually exists",
        "",
        "",
        "Behavioral Issue:",
        "Documentation Issues",
        "",
        "Description:",
        "Creates unwanted documentation",
        "",
        "Example of what to watch for:",
        "Adds documentation when not requested",
        "",
        "What to document:",
        "What documentation was added",
      ].join("\n"),
    );
  });

  it("continuing down the same table keeps its headings, and a new table gets its own", () => {
    const s = new Stitcher(true);
    let pad = "";
    const capture = (lines: OcrLine[]) => {
      const before = render(s.lines, false);
      const count = s.lines.length;
      const r = s.feed(layout(lines));
      const tail = r.added - r.prepended > 0 ? render(s.lines, false, count + r.prepended) : "";
      pad = mergeIntoPad(pad, before, render(s.lines, false), tail, s.lines[count + r.prepended]?.table ? "\n\n\n" : "\n");
    };
    // 1: the heading row and the first row
    capture(TABLE.filter((l) => l.y < 340));
    // 2: scrolled down, the header is out of view: the first row again (for the overlap) and the second, starting at the top edge
    const scrolled = TABLE.filter((l) => l.y >= 226).map((l) => ({ ...l, y: l.y - 222 }));
    expect(layout(scrolled)[0].head).toBe(false);
    capture(scrolled);
    expect(pad.match(/Behavioral Issue:/g)).toHaveLength(2);
    expect(pad).toContain("Behavioral Issue:\nDocumentation Issues\n\nDescription:\nCreates unwanted documentation");
    expect(pad).not.toContain("Code Hallucinations:"); // the first row was never mistaken for headings
    // 3: text after the table, then another table with its own headings
    const other: OcrLine[] = [
      { text: "Severity levels", x: 58, y: 20, w: 120, h: 15 },
      ...[["Level", "Meaning"], ["High", "Blocks the task"], ["Low", "Cosmetic"]].flatMap((r, i) => r.map((text, c) => ({ text, x: [64, 223][c], y: 60 + i * 30, w: text.length * 6.2, h: 11 }))),
    ];
    capture(other);
    expect(pad.endsWith("Severity levels\n\nLevel:\nHigh\n\nMeaning:\nBlocks the task\n\n\nLevel:\nLow\n\nMeaning:\nCosmetic")).toBe(true);
    expect(pad.match(/Behavioral Issue:/g)).toHaveLength(2); // the earlier table is untouched
  });

  it("only the headings are shown until a row is captured, and edited text gets the next row under the right headings", () => {
    const s = new Stitcher(true);
    s.feed(layout(TABLE.filter((l) => l.y < 215)));
    expect(render(s.lines, false)).toBe("Behavioral Issues Types table\n\nBehavioral Issue    Description    Example of what to watch for    What to document");
    // rows added later, written on their own (the pad was edited meanwhile): still under the table's headings
    const count = s.lines.length;
    s.feed(layout(TABLE));
    expect(render(s.lines, false, count).startsWith("Behavioral Issue:\nCode Hallucinations\n\nDescription:\n")).toBe(true);
  });
});
