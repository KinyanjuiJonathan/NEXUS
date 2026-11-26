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
export function layout(lines: OcrLine[]): DocLine[] {
  const clean = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
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
  const merged = rows.map((row) => {
    const parts = [...row].sort((a, b) => a.x - b.x);
    const x = parts[0].x;
    const y = Math.min(...parts.map((p) => p.y));
    const bottom = Math.max(...parts.map((p) => p.y + p.h));
    const right = Math.max(...parts.map((p) => p.x + p.w));
    return { text: parts.map((p) => p.text).join("    "), x, y, w: right - x, h: bottom - y };
  });
  const charW = median(merged.filter((l) => l.text.length >= 4).map((l) => l.w / l.text.length)) || H * 0.5;
  const left = Math.min(...merged.map((l) => l.x));
  return merged.map((l, i) => {
    const prev = merged[i - 1];
    const indent = Math.min(40, Math.max(0, Math.round((l.x - left) / charW)));
    // a little offset is the recogniser's wobble, not indentation
    const pad = indent >= 2 ? " ".repeat(indent) : "";
    return {
      text: pad + l.text,
      key: lineKey(l.text),
      gap: !!prev && l.y - (prev.y + prev.h) > 0.75 * H,
      heading: l.h > 1.3 * H && l.text.length <= 90,
      seen: 1,
    };
  });
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

  feed(reading: DocLine[]): StitchResult {
    const fresh = reading.map(() => false);
    if (!reading.length) return { fresh, added: 0, aligned: true };
    if (!this.lines.length) {
      this.lines = reading.map((l) => ({ ...l }));
      return { fresh: reading.map(() => true), added: reading.length, aligned: true };
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
      reading.forEach((l, r) => {
        const di = r + o;
        if (di < 0) return; // above where the extraction began
        if (di < doc.length) {
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
      return { fresh, added, aligned };
    }
    // Nothing in common: add what has not been read before.
    const known = new Set(doc.slice(-600).map((l) => l.key));
    reading.forEach((l, r) => {
      if (l.key.length >= 10 && (known.has(l.key) || doc.slice(-600).some((x) => sameLine(x.key, l.key)))) return;
      doc.push({ ...l, gap: added === 0 ? true : l.gap });
      fresh[r] = true;
      added++;
    });
    return { fresh, added, aligned };
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
