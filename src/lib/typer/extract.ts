/**
 * Extracting text from a part of the screen while it scrolls.
 *
 * Each reading is a list of recognised lines with their boxes. A reading is
 * first laid out the way it looks (indentation, gaps between paragraphs,
 * larger text as headings), then stitched onto what was read before: the part
 * that overlaps is found and skipped, and only what is new is added. Nothing
 * here touches the screen; it only decides what the text is.
 */

/** One recognised line and its box inside the region, in pixels. */
export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line of the document being built. */
export interface DocLine {
  /** The text, with its indentation. */
  text: string;
  /** For comparing two readings of the same line: lower case, single spaces, no indentation. */
  key: string;
  /** A paragraph gap came before it on screen. */
  gap: boolean;
  /** Noticeably larger than the text around it. */
  heading: boolean;
  /** How many readings have shown it. A line seen once may still be a partial or wrong reading. */
  seen: number;
  /** A row of a table: its cells, separated by tabs. */
  table?: boolean;
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export const lineKey = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * One reading, laid out as it appears: lines top to bottom, text on the same
 * row joined, indentation as spaces, a gap flag where a paragraph break is,
 * and a heading flag on larger text.
 */
export function layout(lines: OcrLine[], opts: { /** Height of the region read: a line sliced through by its top or bottom edge is left out. */ height?: number } = {}): DocLine[] {
  // A whole line that merely sits against the edge is kept. Only a line the edge cuts through is dropped:
  // it touches the edge and is clearly shorter than the other lines, because part of its letters is missing.
  const usual = median(lines.filter((l) => l.h > 0 && l.text.trim()).map((l) => l.h));
  const cut = (l: OcrLine) => opts.height != null && l.h > 0 && usual > 0 && lines.length > 1 && (l.y <= 1 || l.y + l.h >= opts.height - 1) && l.h < 0.72 * usual;
  const clean = lines.filter((l) => !cut(l)).map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
  if (!clean.length) return [];
  const boxed = clean.some((l) => l.h > 0 && l.w > 0);
  if (!boxed) return clean.map((l) => ({ text: l.text, key: lineKey(l.text), gap: false, heading: false, seen: 1 }));
  const H = median(clean.map((l) => l.h)) || 1;
  // text on the same row (columns, a label and its value) is one line
  const sorted = [...clean].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: OcrLine[][] = [];
  for (const l of sorted) {
    const row = rows[rows.length - 1];
    const mid = l.y + l.h / 2;
    if (row && Math.abs(mid - (row[0].y + row[0].h / 2)) < 0.5 * Math.min(l.h || H, row[0].h || H)) row.push(l);
    else rows.push([l]);
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x);
  const span = (parts: OcrLine[]) => {
    const x = Math.min(...parts.map((p) => p.x));
    const y = Math.min(...parts.map((p) => p.y));
    return { x, y, w: Math.max(...parts.map((p) => p.x + p.w)) - x, h: Math.max(...parts.map((p) => p.y + p.h)) - y };
  };
  // Tables are rebuilt row by row and cell by cell; everything else is laid out line by line as before.
  const blocks = findTables(rows, H);
  const merged: { text: string; x: number; y: number; w: number; h: number; table?: boolean }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const block = blocks.find((b) => b.from === i);
    if (!block) {
      merged.push({ text: rows[i].map((p) => p.text).join("    "), ...span(rows[i]) });
      continue;
    }
    for (const group of tableRows(rows.slice(block.from, block.to + 1), H)) {
      const cells = block.columns.map(() => [] as string[]);
      for (const row of group) for (const p of row) cells[columnOf(block.columns, p.x)].push(p.text);
      merged.push({ text: cells.map((c) => joinCell(c)).join("\t"), ...span(group.flat()), table: true });
    }
    i = block.to;
  }
  const charW = median(merged.filter((l) => l.text.length >= 4).map((l) => l.w / l.text.length)) || H * 0.5;
  const left = Math.min(...merged.map((l) => l.x));
  return merged.map((l, i) => {
    const prev = merged[i - 1];
    // a table stands apart from the text before and after it; its rows follow one another directly
    if (l.table) return { text: l.text, key: lineKey(l.text), gap: !!prev && !prev.table, heading: false, seen: 1, table: true };
    const indent = Math.min(40, Math.max(0, Math.round((l.x - left) / charW)));
    // a little offset is the recogniser's wobble, not indentation
    const pad = indent >= 2 ? " ".repeat(indent) : "";
    return {
      text: pad + l.text,
      key: lineKey(l.text),
      gap: !!prev && (!!prev.table || l.y - (prev.y + prev.h) > 0.75 * H),
      heading: l.h > 1.3 * H && l.text.length <= 90,
      seen: 1,
    };
  });
}

// ------------------------------------------------------------------ tables

/** The column a piece of text starting at `x` belongs to: the nearest column start at or before it. */
function columnOf(columns: number[], x: number): number {
  let best = 0;
  for (let c = 0; c < columns.length; c++) if (Math.abs(columns[c] - x) < Math.abs(columns[best] - x)) best = c;
  return best;
}

/** The lines of one cell as one text; a word split with a hyphen at the end of a line is put back together. */
function joinCell(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (!out) out = line;
    else if (/[a-z]-$/.test(out) && /^[a-z]/.test(line)) out += line; // "non-" + "existent"
    else out += ` ${line}`;
  }
  return out;
}

/**
 * Where the tables are, among the text rows of a reading. A table is a run of rows whose
 * pieces start at the same few places (its columns): at least two columns, and at least two
 * rows with text in more than one of them. A piece that runs on past the start of the next
 * column is ordinary text, not a cell, and ends the table.
 */
function findTables(rows: OcrLine[][], H: number): { from: number; to: number; columns: number[] }[] {
  const tol = 0.9 * H;
  const out: { from: number; to: number; columns: number[] }[] = [];
  const bottom = (row: OcrLine[]) => Math.max(...row.map((p) => p.y + p.h));
  const top = (row: OcrLine[]) => Math.min(...row.map((p) => p.y));
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length < 2) continue;
    let columns = rows[i].map((p) => p.x);
    const fits = (row: OcrLine[], cols: number[]) =>
      row.every((p) => {
        const next = cols[columnOf(cols, p.x) + 1];
        return next == null || p.x + p.w <= next - 0.2 * H;
      });
    let to = i;
    let wide = 1;
    while (to + 1 < rows.length) {
      const row = rows[to + 1];
      if (top(row) - bottom(rows[to]) > 5 * H) break;
      const fresh = row.filter((p) => !columns.some((c) => Math.abs(c - p.x) <= tol)).map((p) => p.x);
      // a new column may only appear in a row that also uses a known one
      if (fresh.length && (row.length < 2 || fresh.length === row.length)) break;
      const cols = [...columns, ...fresh].sort((a, b) => a - b);
      if (!fits(row, cols)) break;
      columns = cols;
      if (row.length >= 2) wide++;
      to++;
    }
    if (wide >= 2 && columns.length >= 2) {
      out.push({ from: i, to, columns });
      i = to;
    }
  }
  return out;
}

/**
 * The text rows of a table, grouped into the table's own rows. Inside a cell the lines follow
 * each other closely; between two rows of the table there is the cells' padding and a rule, so
 * the gap is clearly larger. When all gaps are alike, every text row is a row of the table.
 */
function tableRows(rows: OcrLine[][], H: number): OcrLine[][][] {
  const top = (row: OcrLine[]) => Math.min(...row.map((p) => p.y));
  const bottom = (row: OcrLine[]) => Math.max(...row.map((p) => p.y + p.h));
  const gaps = rows.slice(1).map((row, k) => top(row) - bottom(rows[k]));
  const usual = median(gaps.filter((g) => g > 0));
  const limit = Math.max(0.9 * H, 1.7 * usual);
  // Cells are aligned at the top, so the first line of a table row has text in several columns. A line with text
  // in only one column after a slightly wider gap (the second line of a heading in larger type) still belongs
  // to the row above, unless the gap is very large.
  const starts = (k: number) => gaps[k - 1] > limit && (rows[k].length >= 2 || gaps[k - 1] > 3 * limit);
  const split = gaps.some((_, i) => starts(i + 1)) ? starts : () => true;
  const out: OcrLine[][][] = [];
  rows.forEach((row, k) => {
    if (k === 0 || split(k)) out.push([row]);
    else out[out.length - 1].push(row);
  });
  return out;
}

/**
 * `next` is the same table row as `old`, read in full: the same number of cells, and every
 * cell of `old` is the beginning or the end of the matching cell of `next` (the row was cut
 * off by the edge of the region the first time).
 */
export function completesRow(old: string, next: string): boolean {
  if (!old.includes("\t") || next.length <= old.length) return false;
  const a = old.split("\t").map((c) => lineKey(c));
  const b = next.split("\t").map((c) => lineKey(c));
  return a.length === b.length && a.every((cell, i) => !cell || b[i].startsWith(cell) || b[i].endsWith(cell));
}

/** Edit distance, given up early once it passes `limit`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The same line read twice: identical, or differing only by a few misread characters. */
export function sameLine(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.max(a.length, b.length);
  if (n < 8) return false;
  const limit = Math.floor(n * 0.16);
  return distance(a, b, limit) <= limit;
}

export interface StitchResult {
  /** For each line of the reading, in the order `layout` gave them: is it new text? */
  fresh: boolean[];
  /** How many lines this reading added. */
  added: number;
  /** The reading was lined up with what had been read before. */
  aligned: boolean;
  /** How many of the added lines went in front of the document (text from above where it began). */
  prepended: number;
}

/**
 * Builds one document from successive readings of a scrolling region.
 *
 * A reading is lined up with the document where the most text agrees and the
 * least disagrees. Lines past the end of the document are new. The last line of a
 * reading is often cut off by the edge of the region, so a line seen only
 * once is replaced when the next reading shows it better. When a reading
 * shares nothing with the document (a jump, another page), its lines are
 * added unless they were read before.
 */
export class Stitcher {
  lines: DocLine[] = [];

  /**
   * `frozen`: what has been captured is never changed. New text is only added,
   * after the document or, when it comes from above its beginning, before it.
   */
  constructor(private readonly frozen = false) {}

  feed(reading: DocLine[]): StitchResult {
    const fresh = reading.map(() => false);
    if (!reading.length) return { fresh, added: 0, aligned: true, prepended: 0 };
    if (!this.lines.length) {
      this.lines = reading.map((l) => ({ ...l }));
      return { fresh: reading.map(() => true), added: reading.length, aligned: true, prepended: 0 };
    }
    const doc = this.lines;
    const from = Math.max(0, doc.length - 600);
    // Every way of laying the reading over the document that makes at least one line agree…
    const offsets = new Set<number>();
    for (let d = from; d < doc.length; d++) for (let q = 0; q < reading.length; q++) if (sameLine(doc[d].key, reading[q].key)) offsets.add(d - q);
    // …is judged over the whole overlap: lines that agree count for it, lines that disagree count against it.
    // The first and last lines of a reading are often cut off by the edge of the region, so they are not held against it.
    let best: { o: number; score: number; clean: boolean } | null = null;
    for (const o of offsets) {
      let chars = 0;
      let matches = 0;
      let against = 0;
      let touchesEnd = false;
      for (let r = 0; r < reading.length; r++) {
        const di = r + o;
        if (di < from || di >= doc.length) continue;
        if (sameLine(doc[di].key, reading[r].key)) {
          matches++;
          chars += Math.max(1, reading[r].key.length);
          if (di === doc.length - 1) touchesEnd = true;
        } else if (r > 0 && r < reading.length - 1 && di < doc.length - 1) against += Math.max(1, Math.min(reading[r].key.length, doc[di].key.length));
      }
      const score = chars - against;
      // a single short line ("}", "OK") only places the reading when it simply continues the end of the document
      const sure = matches >= 2 || chars >= 14 || (against === 0 && touchesEnd);
      if (!sure || score <= 0) continue;
      // a placement nothing speaks against beats one with a contradiction, however much of that one agrees
      const clean = against === 0;
      const better = !best || (clean !== best.clean ? clean : score > best.score || (score === best.score && o > best.o));
      if (better) best = { o, score, clean };
    }
    const aligned = !!best;
    let added = 0;
    if (best) {
      const o = best.o;
      const lastBefore = doc.length - 1;
      const head: DocLine[] = [];
      let completed = 0;
      reading.forEach((l, r) => {
        const di = r + o;
        if (di < 0) {
          // above where the document begins: kept only when nothing captured may change, as text that goes in front
          if (this.frozen) {
            head.push({ ...l });
            fresh[r] = true;
            added++;
          }
          return;
        }
        if (di < doc.length) {
          if (this.frozen) {
            // Already captured: left exactly as it is. The one exception is a table row the edge of the
            // region cut off: when it is now read in full, the missing part of its cells is filled in.
            if (completesRow(doc[di].text, l.text)) {
              doc[di] = { ...l, gap: doc[di].gap };
              fresh[r] = true;
              completed++;
            }
            return;
          }
          const cur = doc[di];
          if (sameLine(cur.key, l.key)) {
            cur.seen++;
            // the fuller reading of a line that was cut off
            if (l.key.length > cur.key.length) doc[di] = { ...l, gap: cur.gap || l.gap, seen: cur.seen };
          } else if (di === lastBefore && cur.seen < 2) {
            // the document's last line was read only once, at the edge of the region: this is the better reading of it
            doc[di] = { ...l, gap: cur.gap || l.gap };
          }
          return;
        }
        doc.push({ ...l });
        fresh[r] = true;
        added++;
      });
      if (head.length) doc.unshift(...head);
      return { fresh, added: added + completed, aligned, prepended: head.length };
    }
    // Nothing in common: add what has not been read before.
    const known = new Set(doc.slice(-600).map((l) => l.key));
    reading.forEach((l, r) => {
      if (l.key.length >= 10 && (known.has(l.key) || doc.slice(-600).some((x) => sameLine(x.key, l.key)))) return;
      doc.push({ ...l, gap: added === 0 ? true : l.gap });
      fresh[r] = true;
      added++;
    });
    return { fresh, added, aligned, prepended: 0 };
  }

  reset() {
    this.lines = [];
  }
}

const escapeMarks = (t: string) => t.replace(/([*_])/g, "\\$1");

/**
 * The document as text for the editing pad. With `marks`, larger text becomes
 * a heading and characters the pad would read as formatting are kept as
 * themselves; without, it is plain text exactly as read.
 */
export function render(lines: DocLine[], marks: boolean): string {
  let out = "";
  lines.forEach((l, i) => {
    if (i) out += l.gap ? "\n\n" : "\n";
    if (!marks) out += l.text;
    else if (l.heading) out += `# ${escapeMarks(l.text.trim())}`;
    else out += escapeMarks(l.text).replace(/^(\s*)#(?=[ \t])/, "$1\\#");
  });
  return out;
}

/**
 * Put a capture into the pad without touching what is already there.
 * `before` is the captured document as it was written last time, `after` as it
 * is now, `tail` only the lines this capture added at the end. While the pad
 * still holds `before` as it was written, it is exchanged for `after` (which
 * is the same text with the additions around it), so text from above lands
 * above. If the user has edited that text since, nothing of theirs is
 * replaced: the new lines are simply added at the end.
 */
export function mergeIntoPad(pad: string, before: string, after: string, tail: string): string {
  if (!before) return pad.trim() ? `${pad.replace(/\s+$/, "")}\n\n${after}` : after;
  const at = pad.lastIndexOf(before);
  if (at >= 0) return pad.slice(0, at) + after + pad.slice(at + before.length);
  return tail ? `${pad.replace(/\s+$/, "")}\n${tail}` : pad;
}
