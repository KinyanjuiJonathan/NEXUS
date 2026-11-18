/**
 * Auto Typer planning engine.
 *
 * Turns text into a timed list of key presses and releases that reads like a
 * person typing: varied key holds and gaps, overlapping keys, bursts, pauses,
 * typos that get corrected and slips that are revised later. A virtual buffer
 * and cursor track what the target window should contain, so the finished text
 * always matches the input exactly.
 *
 * This module only plans; the native side (src-tauri/src/typer.rs) replays the
 * plan as real keystrokes.
 */

export const BOLD = 1;
export const ITALIC = 2;

/** A key is a single character or a name such as `<shift>`, `<backspace>`, `<left>`. */
export interface KeyEvent {
  /** Seconds from the start of typing. */
  t: number;
  /** Creation order; breaks ties between events at the same time. */
  seq: number;
  down: boolean;
  key: string;
}

export type Technique = "touch" | "two-finger" | "one-handed";
export type FormatMode = "apply" | "strip" | "literal";

export interface HumanizerOptions {
  wpm?: number;
  /** Probability of a slip per letter/digit, 0–0.2. */
  errorRate?: number;
  /** 1 = normal pauses and breaks, 0 = none. */
  pauseScale?: number;
  technique?: Technique;
  /** Allow arrow keys / Delete for corrections and later revisions. */
  revise?: boolean;
  /** Hold Shift for symbols as on a US keyboard; off = send symbols as-is. */
  usShift?: boolean;
  /** Uniform random source in [0, 1); defaults to Math.random. */
  random?: () => number;
}

// ------------------------------------------------------------------ keyboard model (QWERTY)

const ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const FINGER: Record<string, number> = {};
const NEIGHBORS: Record<string, string[]> = {};
const isLetter = (c: string) => /^\p{L}$/u.test(c);
ROWS.forEach((row, ri) => {
  [...row].forEach((c, j) => {
    FINGER[c] = [0, 1, 2, 3, 3, 4, 4, 5, 6, 7][j];
    const near: string[] = [];
    for (const k of [j - 1, j + 1]) if (k >= 0 && k < row.length) near.push(row[k]);
    for (const rr of [ri - 1, ri + 1]) {
      // letters only: digit slips are rarer
      if (rr >= 1 && rr < ROWS.length) for (const k of [j - 1, j]) if (k >= 0 && k < ROWS[rr].length) near.push(ROWS[rr][k]);
    }
    NEIGHBORS[c] = near.filter((n) => isLetter(n) === isLetter(c));
  });
});

/** US layout: symbol → key pressed together with Shift. */
export const SHIFT_MAP: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8",
  "(": "9", ")": "0", _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";",
  '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
};

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const COMMON_WORDS = words(
  "the be to of and a in that have i it for not on with he as you do at this but his " +
    "by from they we say her she or an will my one all would there their what so up out " +
    "if about who get which go me when make can like time no just him know take people " +
    "into year your good some could them see other than then now look only come its over " +
    "think also back after use two how our work first well way even new want because any " +
    "these give day most us is are was were been has had did",
);
const COMMON_BIGRAMS = words(
  "th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou " +
    "io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur",
);
const CONFUSABLE: Record<string, string> = {};
for (const [a, b] of [
  ["their", "there"], ["then", "than"], ["to", "too"], ["were", "where"], ["of", "off"], ["from", "form"],
  ["quite", "quiet"], ["lose", "loose"], ["affect", "effect"], ["accept", "except"], ["its", "it's"],
]) {
  CONFUSABLE[a] = b;
  CONFUSABLE[b] = a;
}
const SKIPPABLE = words("the a an of to in is it and that for");

type KeyClass = "letter" | "digit" | "punct" | "symbol" | "space" | "special";
/** Median key-hold seconds and gap multipliers per kind of key. */
const HOLD: Record<KeyClass, number> = { letter: 0.085, digit: 0.105, punct: 0.095, symbol: 0.11, space: 0.075, special: 0.08 };
const GAP: Record<KeyClass, number> = { letter: 1.0, digit: 1.45, punct: 1.3, symbol: 1.7, space: 0.9, special: 1.2 };
/** [keys may overlap, uses letter-pair fluency, timing spread] */
const TECHNIQUES: Record<Technique, [boolean, boolean, number]> = {
  touch: [true, true, 0.28],
  "two-finger": [false, false, 0.4],
  "one-handed": [false, false, 0.33],
};

// ------------------------------------------------------------------ character helpers

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);
const isAsciiLetter = (c: string) => /^[A-Za-z]$/.test(c);
const isAsciiAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c);
const isDigit = (c: string) => /^\p{Nd}$/u.test(c);
const isAlnum = (c: string) => /^[\p{L}\p{N}]$/u.test(c);
const isAlphaWord = (s: string) => /^\p{L}+$/u.test(s);
const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isSpace = (c: string) => /^\s$/u.test(c);

// ------------------------------------------------------------------ markup

export interface ParsedChar {
  /** UTF-16 index of the character in the source text. */
  index: number;
  ch: string;
  /** BOLD | ITALIC bits. */
  style: number;
}

const EMPH = /(?<!\\)(\*\*\*|___)(?=\S)(.+?)(?<=\S)\1|(?<!\\)(\*\*|__)(?=\S)(.+?)(?<=\S)\3|(?<![\w*\\])(\*|_)(?=[^\s*_])(.+?)(?<=[^\s*_])\5(?![\w*])/g;
const HEADING = /^(#{1,6})[ \t]+(?=\S)/;

/**
 * Read `**bold**`, `*italic*`, `_italic_`, `__bold__` and `# headings`.
 * Returns every character that should actually be typed; the markers are left out.
 */
export function parseMarkup(text: string): ParsedChar[] {
  const out: ParsedChar[] = [];

  const plain = (s: string, off: number, style: number) => {
    let i = 0;
    for (const ch of s) {
      const next = s[i + ch.length];
      // "\*" means a real "*"
      if (!(ch === "\\" && (next === "*" || next === "_"))) out.push({ index: off + i, ch, style });
      i += ch.length;
    }
  };

  const inline = (s: string, off: number, style: number) => {
    let pos = 0;
    for (;;) {
      EMPH.lastIndex = pos;
      const m = EMPH.exec(s);
      if (!m) break;
      const g = m[1] ? 1 : m[3] ? 3 : 5;
      const mark = m[g];
      const a = m.index;
      const end = a + m[0].length;
      if (mark[0] === "_" && ((a > 0 && isAlnum(s[a - 1])) || (end < s.length && isAlnum(s[end])))) {
        plain(s.slice(pos, a + 1), off + pos, style); // snake_case, not emphasis
        pos = a + 1;
        continue;
      }
      plain(s.slice(pos, a), off + pos, style);
      const bits = mark.length === 3 ? BOLD | ITALIC : mark.length === 2 ? BOLD : ITALIC;
      // the inner text starts right after the opening marker (the look-arounds are zero-width)
      inline(m[g + 1], off + a + mark.length, style | bits);
      pos = end;
    }
    plain(s.slice(pos), off + pos, style);
  };

  let off = 0;
  for (const line of text.split("\n")) {
    if (off) out.push({ index: off - 1, ch: "\n", style: 0 });
    const h = HEADING.exec(line);
    if (h) inline(line.slice(h[0].length), off + h[0].length, BOLD);
    else inline(line, off, 0);
    off += line.length + 1;
  }
  return out;
}

// ------------------------------------------------------------------ random helpers

class Rng {
  constructor(private readonly next: () => number) {}
  random() {
    return this.next();
  }
  uniform(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  gauss(mu: number, sigma: number) {
    const u = 1 - this.next();
    const v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  lognorm(sigma: number) {
    return Math.exp(this.gauss(0, sigma));
  }
  triangular(lo: number, hi: number, mode: number) {
    const u = this.next();
    const c = (mode - lo) / (hi - lo);
    return u < c ? lo + Math.sqrt(u * (hi - lo) * (mode - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - mode));
  }
  /** Integer in [a, b). */
  range(a: number, b: number) {
    return a + Math.floor(this.next() * (b - a));
  }
  choice<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}

/** Small seedable generator for tests and reproducible plans. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ the humanizer

interface Defect {
  pos: number;
  /** Length of the wrong text left in the buffer. */
  wrong: number;
  correct: string[];
  style: number;
}

export class Humanizer {
  /** What the target should contain once every planned event has played. */
  readonly buf: string[] = [];
  /** Style each buffered character was typed in. */
  readonly bufStyles: number[] = [];

  private readonly rng: Rng;
  private readonly base: number;
  private readonly errorRate: number;
  private readonly ps: number;
  private readonly revise: boolean;
  private readonly usShift: boolean;
  private readonly overlap: boolean;
  private readonly digraph: boolean;
  private readonly sigma: number;

  private ev: KeyEvent[] = [];
  private t = 0;
  private pend = 0;
  private rel = new Map<string, number>();
  private recent: { press: number; release: KeyEvent }[] = [];
  private shiftDown = false;
  private shiftPress = 0;
  private shiftHold = 0;
  private shiftRel = -1;
  private cur = 0;
  private defects: Defect[] = [];
  private prev: string | null = null;
  private style = 0;
  private block = -1;
  private x = 0;
  private burstF = 1;
  private wordF = 1;
  private burstLeft: number;

  constructor(opts: HumanizerOptions = {}) {
    this.rng = new Rng(opts.random ?? Math.random);
    this.base = 12 / Math.max(5, opts.wpm ?? 60); // seconds per key at nominal speed
    this.errorRate = opts.errorRate ?? 0.025;
    this.ps = opts.pauseScale ?? 1;
    this.revise = opts.revise ?? true;
    this.usShift = opts.usShift ?? true;
    [this.overlap, this.digraph, this.sigma] = TECHNIQUES[opts.technique ?? "touch"];
    this.burstLeft = this.burstLen();
  }

  // ---- low level: timing

  private emit(t: number, down: boolean, key: string): KeyEvent {
    const e = { t, seq: this.ev.length, down, key };
    this.ev.push(e);
    return e;
  }

  private pause(seconds: number) {
    this.pend = Math.max(this.pend, seconds);
  }

  private slow() {
    return Math.exp(this.x) * this.burstF * this.wordF;
  }

  private press(key: string, cls: KeyClass, gap: number, shift = false, overlap = true) {
    const r = this.rng;
    let tp = this.t + gap + this.pend;
    this.pend = 0;
    tp = Math.max(tp, (this.rel.get(key) ?? -1) + 0.02); // same key must be up first
    tp = Math.max(tp, this.block + 0.02); // Ctrl must be up first
    if (!(overlap && this.overlap) && this.recent.length) {
      tp = Math.max(tp, Math.max(...this.recent.map((x) => x.release.t)) + r.uniform(0.005, 0.03));
    }
    let hold = HOLD[cls] * r.lognorm(0.25) * Math.sqrt(Math.min(1.3, Math.max(0.8, this.slow())));
    hold = Math.min(0.3, Math.max(0.03, hold));
    if (this.shiftDown && !shift) {
      // let go of Shift first
      let up = Math.min(tp - r.uniform(0.006, 0.03), this.shiftPress + this.shiftHold * r.uniform(0.6, 1.5));
      up = Math.max(up, this.shiftPress + 0.012);
      tp = Math.max(tp, up + 0.008);
      this.emit(up, false, "<shift>");
      this.shiftDown = false;
      this.shiftRel = up;
    }
    if (shift && !this.shiftDown) {
      // Shift leads the key
      const ts = Math.max(tp - 0.09 * r.lognorm(0.35), this.t + 0.008, this.shiftRel + 0.02, this.block + 0.01);
      tp = Math.max(tp, ts + 0.02);
      this.emit(ts, true, "<shift>");
      this.shiftDown = true;
    }
    for (const older of this.recent.slice(0, -1)) {
      // at most two keys down at once
      if (older.release.t > tp - 0.004) {
        older.release.t = Math.max(older.press + 0.02, tp - r.uniform(0.004, 0.03));
        tp = Math.max(tp, older.release.t + 0.002);
      }
    }
    if (shift) {
      this.shiftPress = tp;
      this.shiftHold = hold;
    }
    this.emit(tp, true, key);
    const release = this.emit(tp + hold, false, key);
    this.rel.set(key, tp + hold);
    this.recent = [...this.recent, { press: tp, release }].slice(-3);
    this.t = tp;
  }

  private gap(c: string, cls: KeyClass, shift: boolean) {
    let m = GAP[cls];
    if (shift && cls === "letter" && !this.shiftDown) m *= 1.35;
    const a = (this.prev ?? "").toLowerCase();
    const b = c.toLowerCase();
    if (this.digraph && a in FINGER && b in FINGER) {
      if (a === b) m *= 0.95;
      else if (COMMON_BIGRAMS.has(a + b)) m *= 0.78;
      else if (FINGER[a] === FINGER[b]) m *= 1.25;
      else if (FINGER[a] < 4 !== FINGER[b] < 4) m *= 0.92;
      else m *= 1.05;
    }
    if (a === " ") m *= 1.1;
    let g = this.base * this.slow() * m * this.rng.lognorm(this.sigma);
    if (this.rng.random() < 0.015) g += this.rng.uniform(0.15, 0.6) * this.ps; // momentary hesitation
    return Math.max(g, 0.03);
  }

  /** Switch bold/italic with Ctrl+B / Ctrl+I so the next key is typed in `style`. */
  private restyle(style: number) {
    const r = this.rng;
    for (const [bit, letter] of [[BOLD, "b"], [ITALIC, "i"]] as const) {
      if (!((this.style ^ style) & bit)) continue;
      let tp = this.t + r.uniform(0.12, 0.45) * r.lognorm(0.3) + this.pend;
      this.pend = 0;
      if (this.recent.length) tp = Math.max(tp, Math.max(...this.recent.map((x) => x.release.t)) + r.uniform(0.01, 0.05));
      tp = Math.max(tp, this.block + 0.03);
      if (this.shiftDown) {
        const up = this.shiftPress + Math.max(0.012, this.shiftHold * r.uniform(0.6, 1.5));
        this.emit(up, false, "<shift>");
        this.shiftDown = false;
        this.shiftRel = up;
        tp = Math.max(tp, up + 0.03);
      }
      this.emit(tp, true, "<mod>");
      const t2 = Math.max(tp + r.uniform(0.06, 0.2), (this.rel.get(letter) ?? -1) + 0.02);
      const hold = r.uniform(0.05, 0.12);
      this.emit(t2, true, letter);
      this.emit(t2 + hold, false, letter);
      this.block = t2 + hold + r.uniform(0.015, 0.1);
      this.emit(this.block, false, "<mod>");
      this.rel.set(letter, t2 + hold);
      this.t = t2;
      this.recent = [];
    }
    this.style = style;
    this.prev = null;
  }

  /**
   * After moving or deleting, an editor types in the style of the character
   * before the caret. Slips are only made where that is unambiguous.
   */
  private caretStyle() {
    if (this.cur > 0) this.style = this.bufStyles[this.cur - 1];
  }

  // ---- low level: keys that edit the buffer

  private ch(c: string, style = 0) {
    if (style !== this.style) this.restyle(style);
    let key = c;
    let cls: KeyClass;
    let shift = false;
    let overlap = true;
    if (c === "\n") [key, cls, overlap] = ["<enter>", "special", false];
    else if (c === "\t") [key, cls, overlap] = ["<tab>", "special", false];
    else if (c === " ") cls = "space";
    else if (isAsciiLetter(c)) [key, cls, shift] = [c.toLowerCase(), "letter", isUpper(c)];
    else if (isDigit(c)) cls = "digit";
    else if (this.usShift && c in SHIFT_MAP) [key, cls, shift] = [SHIFT_MAP[c], "symbol", true];
    else if (isAscii(c) && !this.usShift && !isAsciiAlnum(c)) [cls, overlap] = ["symbol", false];
    else if (isAscii(c)) cls = "punct";
    else [cls, overlap] = ["symbol", false]; // sent as-is
    this.press(key, cls, this.gap(c, cls, shift), shift, overlap);
    this.buf.splice(this.cur, 0, c);
    this.bufStyles.splice(this.cur, 0, style);
    this.cur += 1;
    this.prev = c;
  }

  private special(name: string, gap: number) {
    this.press(name, "special", gap, false, false);
    this.prev = null;
  }

  private navGap(fast = false) {
    const [lo, hi] = fast ? [0.04, 0.085] : [0.09, 0.17];
    return this.rng.uniform(lo, hi) * this.rng.lognorm(0.2);
  }

  private backspace(n = 1) {
    for (let i = 0; i < n; i++) {
      this.special("<backspace>", this.navGap());
      this.cur -= 1;
      this.buf.splice(this.cur, 1);
      this.bufStyles.splice(this.cur, 1);
    }
    this.caretStyle();
  }

  private del(n = 1) {
    for (let i = 0; i < n; i++) {
      this.special("<delete>", this.navGap());
      this.buf.splice(this.cur, 1);
      this.bufStyles.splice(this.cur, 1);
    }
    this.caretStyle();
  }

  /** Move the cursor n characters (negative = left). */
  private move(n: number) {
    const fast = Math.abs(n) > 6;
    for (let i = 0; i < Math.abs(n); i++) {
      const g = this.navGap(fast && i > 0) + (i === 0 ? this.rng.uniform(0.1, 0.3) : 0);
      this.special(n < 0 ? "<left>" : "<right>", g);
    }
    this.cur += n;
    this.caretStyle();
  }

  /** Type characters; `style` is one value for all of them or one per character. */
  private typeStr(chars: string[], style: number | number[] = 0) {
    chars.forEach((c, i) => this.ch(c, typeof style === "number" ? style : style[i]));
  }

  // ---- typos, fixed on the spot

  private wrong(c: string): string | null {
    if (isUpper(c) && this.rng.random() < 0.3) return c.toLowerCase(); // missed the Shift key
    const near = NEIGHBORS[c.toLowerCase()];
    if (!near?.length) return null;
    const w = this.rng.choice(near);
    return isUpper(c) ? w.toUpperCase() : w;
  }

  private notice() {
    this.pause(this.rng.uniform(0.15, 0.65) * this.rng.lognorm(0.3));
  }

  private typeWord(w: string[], st = 0, firstOk = true) {
    const rng = this.rng;
    const arrows = this.revise;
    let i = 0;
    while (i < w.length) {
      const c = w[i];
      const left = w.length - i - 1;
      const p = this.errorRate * (this.wordF > 1.1 ? 1.4 : 1);
      if (!isAsciiAlnum(c) || rng.random() >= p || (i === 0 && !firstOk)) {
        this.ch(c, st);
        i += 1;
        continue;
      }
      const kind = rng.choice(["sub", "sub", "sub", "double", "omit", "swap"] as const);
      if (kind === "omit" && left >= 1) {
        const k = Math.min(rng.choice([1, 1, 2, 3]), left);
        this.typeStr(w.slice(i + 1, i + 1 + k), st);
        this.notice();
        if (arrows && rng.random() < 0.35) {
          this.move(-k);
          this.ch(c, st);
          this.move(k);
        } else {
          this.backspace(k);
          this.typeStr(w.slice(i, i + 1 + k), st);
        }
        i += k + 1;
      } else if (kind === "swap" && left >= 1 && w[i + 1] !== c && isAlnum(w[i + 1])) {
        const k = Math.min(rng.choice([0, 0, 1]), left - 1);
        this.ch(w[i + 1], st);
        this.ch(c, st);
        this.typeStr(w.slice(i + 2, i + 2 + k), st);
        this.notice();
        this.backspace(2 + k);
        this.typeStr(w.slice(i, i + 2 + k), st);
        i += 2 + k;
      } else if (kind === "double") {
        const k = Math.min(rng.choice([0, 0, 1]), left);
        this.ch(c, st);
        this.ch(c, st);
        this.typeStr(w.slice(i + 1, i + 1 + k), st);
        this.notice();
        this.backspace(k + 1);
        this.typeStr(w.slice(i + 1, i + 1 + k), st);
        i += k + 1;
      } else {
        const wrong = this.wrong(c);
        if (wrong == null) {
          this.ch(c, st);
          i += 1;
          continue;
        }
        const k = Math.min(rng.choice([0, 0, 0, 1, 1, 2, 3]), left);
        this.ch(wrong, st);
        this.typeStr(w.slice(i + 1, i + 1 + k), st);
        this.notice();
        const r = rng.random();
        if (arrows && k >= 1 && r < 0.2) {
          this.move(-k);
          this.backspace();
          this.ch(c, st);
          this.move(k);
        } else if (arrows && k >= 1 && r < 0.35) {
          this.move(-k - 1);
          this.del();
          this.ch(c, st);
          this.move(k);
        } else {
          this.backspace(k + 1);
          this.typeStr(w.slice(i, i + 1 + k), st);
        }
        i += k + 1;
      }
    }
  }

  // ---- revisions: slips left behind and fixed on a later read-through

  private misspell(w: string[]): string[] | null {
    const rng = this.rng;
    for (let n = 0; n < 8; n++) {
      const i = rng.range(1, w.length - 1);
      const kind = rng.choice(["swap", "drop", "double", "sub"] as const);
      let v: string[];
      if (kind === "swap") v = [...w.slice(0, i), w[i + 1], w[i], ...w.slice(i + 2)];
      else if (kind === "drop") v = [...w.slice(0, i), ...w.slice(i + 1)];
      else if (kind === "double") v = [...w.slice(0, i), w[i], ...w.slice(i)];
      else {
        const near = NEIGHBORS[w[i].toLowerCase()];
        v = near?.length ? [...w.slice(0, i), rng.choice(near), ...w.slice(i + 1)] : w;
      }
      if (v.join("") !== w.join("")) return v;
    }
    return null;
  }

  /** Go back over the current line and fix everything left behind. */
  private review() {
    if (!this.defects.length) return;
    const r = this.rng;
    this.pause(r.uniform(0.6, 2.5) * this.ps + 0.2);
    for (const d of [...this.defects].reverse()) {
      // last slip first, so earlier positions stay valid
      if (d.wrong > 0 && d.wrong <= 2 && r.random() < 0.35) {
        this.move(d.pos - this.cur);
        this.pause(r.uniform(0.15, 0.5));
        this.del(d.wrong);
      } else {
        this.move(d.pos + d.wrong - this.cur);
        this.pause(r.uniform(0.15, 0.5));
        this.backspace(d.wrong);
      }
      this.typeStr(d.correct, d.style);
      this.pause(r.uniform(0.2, 0.7) * this.ps + 0.1);
    }
    this.defects = [];
    this.move(this.buf.length - this.cur);
    this.pause(r.uniform(0.25, 0.9) * this.ps + 0.1);
  }

  // ---- the session

  private burstLen() {
    return Math.floor(this.rng.triangular(2, 16, 5));
  }

  /**
   * Plan the typing of `text`. `styles` optionally gives BOLD/ITALIC bits per
   * character (code point); they are switched with Ctrl+B / Ctrl+I as the text goes.
   */
  run(text: string, styles?: number[]): KeyEvent[] {
    const rng = this.rng;
    const chars = Array.from(text);
    const S = styles ?? new Array<number>(chars.length).fill(0);

    // tokens: runs of non-space characters, and single whitespace characters
    const tokens: { a: number; b: number }[] = [];
    for (let i = 0; i < chars.length; ) {
      if (isSpace(chars[i])) {
        tokens.push({ a: i, b: i + 1 });
        i += 1;
      } else {
        let j = i;
        while (j < chars.length && !isSpace(chars[j])) j += 1;
        tokens.push({ a: i, b: j });
        i = j;
      }
    }

    let sentenceStart = true;
    let afterClause = false;
    let skipSpace = false;
    let first = true;
    tokens.forEach(({ a, b }, idx) => {
      const tok = chars.slice(a, b);
      const word = tok.join("");
      if (isSpace(tok[0])) {
        if (word === "\n") {
          this.review();
          this.ch("\n", S[a]);
          this.pause(rng.uniform(1.0, 4.5) * this.ps);
          sentenceStart = true;
        } else if (!(skipSpace && word === " ")) {
          this.ch(word, S[a]);
        }
        skipSpace = false;
        return;
      }
      // Slips are only made where the editor's style after a fix is certain:
      // the word is in one style, and so are the characters around it.
      const st = S[a];
      const uniform = S.slice(a, b).every((x) => x === st);
      const firstOk = a ? S[a - 1] === st : st === 0;
      const settled = uniform && firstOk && (b >= S.length || S[b] === st);

      // speed drifts over the session, per burst and per word
      this.x += -0.08 * this.x + rng.gauss(0, 0.05);
      const bare = word.replace(/^[.,;:!?"'()[\]]+|[.,;:!?"'()[\]]+$/g, "").toLowerCase();
      const hard = !isAlphaWord(bare) || Array.from(bare).length >= 9;
      this.wordF = COMMON_WORDS.has(bare) ? rng.uniform(0.8, 0.92) : hard ? rng.uniform(1.12, 1.4) : rng.uniform(0.95, 1.08);

      // pauses: bursts, sentences, clauses, unfamiliar terms
      if (this.burstLeft <= 0) {
        this.pause((rng.random() < 0.85 ? rng.uniform(0.35, 1.5) : rng.uniform(2.5, 9)) * this.ps);
        this.burstLeft = this.burstLen();
        this.burstF = Math.exp(rng.gauss(0, 0.1));
      }
      this.burstLeft -= 1;
      if (first) first = false;
      else if (sentenceStart) this.pause(Math.min(4, 0.6 * rng.lognorm(0.6)) * this.ps);
      else if (afterClause && rng.random() < 0.7) this.pause(rng.uniform(0.12, 0.5) * this.ps);
      else if (rng.random() < 0.08) this.pause(rng.uniform(0.15, 0.6) * this.ps);
      if (hard) this.pause(rng.uniform(0.2, 0.9) * this.ps);

      // sometimes leave a slip behind to be revised later
      let typed = false;
      if (this.revise && settled && isAscii(word) && rng.random() < Math.min(0.12, this.errorRate * 1.2)) {
        const next = tokens[idx + 1];
        const nextIsSpace = idx + 2 < tokens.length && next.b - next.a === 1 && chars[next.a] === " ";
        if (SKIPPABLE.has(bare) && isAlphaWord(word) && nextIsSpace && !sentenceStart) {
          this.defects.push({ pos: this.cur, wrong: 0, correct: [...tok, " "], style: st }); // word left out
          skipSpace = typed = true;
        } else {
          let alt: string[] | null = null;
          const lower = word.toLowerCase();
          if (lower in CONFUSABLE) {
            // wrong word
            const swap = CONFUSABLE[lower];
            alt = Array.from(isUpper(tok[0]) ? swap[0].toUpperCase() + swap.slice(1) : swap);
          } else if (isAlphaWord(word) && tok.length >= 4) {
            alt = this.misspell(tok); // unnoticed typo
          }
          if (alt) {
            this.defects.push({ pos: this.cur, wrong: alt.length, correct: tok, style: st });
            this.typeStr(alt, st);
            typed = true;
          }
        }
      }
      if (!typed && uniform) this.typeWord(tok, st, firstOk);
      else if (!typed) this.typeStr(tok, S.slice(a, b));

      const end = word.replace(/["')\]]+$/, "").slice(-1);
      sentenceStart = end === "." || end === "!" || end === "?";
      afterClause = end === "," || end === ";" || end === ":";
      if (sentenceStart && this.defects.length && (rng.random() < 0.7 || this.defects.length >= 3)) this.review();
    });

    this.review();
    if (this.style) this.restyle(0); // leave bold/italic off
    if (this.shiftDown) {
      this.emit(this.shiftPress + Math.max(0.012, this.shiftHold * rng.uniform(0.6, 1.5)), false, "<shift>");
      this.shiftDown = false;
    }
    this.ev.sort((p, q) => p.t - q.t || p.seq - q.seq);
    return this.ev;
  }
}

// ------------------------------------------------------------------ building a plan for the native player

export interface TyperOptions {
  wpm: number;
  /** Percent of keys, 0–20. */
  mistakes: number;
  /** Percent of normal pauses, 0–500. */
  pauses: number;
  countdown: number;
  repeat: number;
  technique: Technique;
  format: FormatMode;
  revise: boolean;
  usShift: boolean;
  enterAfter: boolean;
  lock: boolean;
}

export const DEFAULT_TYPER: TyperOptions = {
  wpm: 60,
  mistakes: 2.5,
  pauses: 100,
  countdown: 3,
  repeat: 1,
  technique: "touch",
  format: "apply",
  revise: true,
  usShift: true,
  enterAfter: false,
  lock: false,
};

export const MAX_REPEAT = 50;

const clamp = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Text and styles that will really be typed for a source text and format mode. */
export function prepareText(source: string, format: FormatMode): { text: string; styles?: number[] } {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (format === "literal") return { text: normalized };
  const parsed = parseMarkup(normalized);
  const text = parsed.map((p) => p.ch).join("");
  if (format === "apply" && parsed.some((p) => p.style)) return { text, styles: parsed.map((p) => p.style) };
  return { text };
}

export interface TyperPlan {
  events: { t: number; down: boolean; key: string }[];
  /** Seconds of typing, excluding the countdown. */
  duration: number;
  /** Characters in the finished text (all repeats). */
  chars: number;
}

/** Plan every repeat (each with a fresh rhythm) as one timeline. */
export function buildPlan(source: string, o: TyperOptions, random?: () => number): TyperPlan {
  const { text, styles } = prepareText(source, o.format);
  const repeat = Math.round(clamp(o.repeat, 1, MAX_REPEAT, 1));
  const rnd = random ?? Math.random;
  const events: TyperPlan["events"] = [];
  let offset = 0;
  for (let n = 0; n < repeat && text.length; n++) {
    const h = new Humanizer({
      wpm: clamp(o.wpm, 5, 250, 60),
      errorRate: clamp(o.mistakes, 0, 20, 2.5) / 100,
      pauseScale: clamp(o.pauses, 0, 500, 100) / 100,
      technique: o.technique,
      revise: o.revise,
      usShift: o.usShift,
      random,
    });
    const plan = h.run(text, styles);
    for (const e of plan) events.push({ t: Math.round((offset + e.t) * 1000) / 1000, down: e.down, key: e.key });
    offset += plan.length ? plan[plan.length - 1].t : 0;
    if (o.enterAfter) {
      const at = offset + 0.2 + rnd() * 0.5;
      const hold = 0.05 + rnd() * 0.06;
      events.push({ t: Math.round(at * 1000) / 1000, down: true, key: "<enter>" }, { t: Math.round((at + hold) * 1000) / 1000, down: false, key: "<enter>" });
      offset = at + hold;
    }
    if (n + 1 < repeat) offset += 0.6 + rnd() * 1.9; // a breath between repeats
  }
  return { events, duration: offset, chars: Array.from(text).length * repeat };
}

// ------------------------------------------------------------------ pasted rich text → markers

/**
 * Convert copied rich text (HTML from Word, Google Docs, a web page…) into
 * plain text with `**bold**` / `*italic*` markers and `# ` headings.
 */
export function htmlToMarkup(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const BLOCK = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "BLOCKQUOTE", "PRE", "UL", "OL", "TABLE", "SECTION", "ARTICLE"]);
  const runs: { text: string; style: number }[] = [];
  const newline = () => {
    if (runs.length && runs[runs.length - 1].text !== "\n") runs.push({ text: "\n", style: 0 });
  };

  const walk = (node: Node, style: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? "").replace(/\s+/g, " ");
      if (text) runs.push({ text, style });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "STYLE" || tag === "SCRIPT" || tag === "HEAD" || tag === "META" || tag === "TITLE") return;
    if (tag === "BR") {
      runs.push({ text: "\n", style: 0 });
      return;
    }
    let s = style;
    if (tag === "B" || tag === "STRONG") s |= BOLD;
    if (tag === "I" || tag === "EM") s |= ITALIC;
    // inline styles override tags (Google Docs wraps everything in <b style="font-weight:normal">)
    const weight = el.style?.fontWeight;
    if (weight) s = weight === "bold" || weight === "bolder" || Number(weight) >= 600 ? s | BOLD : s & ~BOLD;
    const fs = el.style?.fontStyle;
    if (fs) s = fs === "italic" || fs === "oblique" ? s | ITALIC : s & ~ITALIC;
    const block = BLOCK.has(tag);
    if (block) newline();
    const heading = /^H[1-6]$/.test(tag);
    if (heading) runs.push({ text: "#".repeat(Number(tag[1])) + " ", style: 0 });
    if (tag === "LI") runs.push({ text: "- ", style: 0 });
    // headings are typed bold anyway, so don't also wrap them in ** **
    for (const child of Array.from(el.childNodes)) walk(child, heading ? s & ~BOLD : s);
    if (block) newline();
  };
  walk(doc.body, 0);

  // merge neighbouring runs of one style, then wrap each styled run
  const merged: { text: string; style: number }[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.style === r.style && r.text !== "\n" && last.text !== "\n") last.text += r.text;
    else merged.push({ ...r });
  }
  const mark = (st: number) => (st === (BOLD | ITALIC) ? "***" : st === BOLD ? "**" : st === ITALIC ? "*" : "");
  let out = "";
  for (const r of merged) {
    const m = mark(r.style);
    const core = r.text.trim();
    if (!m || !core) {
      out += r.text;
      continue;
    }
    // markers must hug the words, so keep outer spaces outside them
    const lead = r.text.slice(0, r.text.length - r.text.trimStart().length);
    const trail = r.text.slice(r.text.trimEnd().length);
    out += lead + m + core + m + trail;
  }
  return out
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]+/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
