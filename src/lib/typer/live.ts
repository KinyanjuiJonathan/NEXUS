/**
 * Live input for the Auto Typer: what is said (dictation) or what appears in a
 * part of the screen is turned into text to type, piece by piece.
 * These functions only decide what to type; the controller does the typing.
 */

// ------------------------------------------------------------------ dictation

export interface DictationState {
  /** The last character typed so far ("" at the very start). */
  lastChar: string;
  /** What each phrase added, newest last, so "delete that" can take it back. */
  chunks: string[];
}

export const NEW_DICTATION: DictationState = { lastChar: "", chunks: [] };

export interface DictationStep {
  /** Characters to remove first (Backspace presses). */
  backspaces: number;
  /** Text to type after that. */
  type: string;
  /** The user said to stop. */
  stop: boolean;
  state: DictationState;
}

/** Spoken punctuation and layout, replaced inside a phrase. */
const SPOKEN: [RegExp, string][] = [
  [/\s*\b(?:new paragraph|next paragraph)\b[.,]?\s*/gi, "\n\n"],
  [/\s*\b(?:new line|next line|line break)\b[.,]?\s*/gi, "\n"],
  [/\s*\b(?:full stop|period)\b/gi, "."],
  [/\s*\bcomma\b/gi, ","],
  [/\s*\bquestion mark\b/gi, "?"],
  [/\s*\bexclamation (?:mark|point)\b/gi, "!"],
  [/\s*\bsemi ?colon\b/gi, ";"],
  [/\s*\bcolon\b/gi, ":"],
  [/\s*\b(?:dash|hyphen)\b\s*/gi, " - "],
  [/\bopen (?:bracket|parenthesis)\b\s*/gi, "("],
  [/\s*\bclose (?:bracket|parenthesis)\b/gi, ")"],
];

const STOP = /^(?:stop (?:dictation|dictating|typing|listening)|end dictation)[.!]?$/i;
const UNDO = /^(?:delete that|scratch that|undo that|remove that)[.!]?$/i;
const endsSentence = (c: string) => c === "" || c === "." || c === "!" || c === "?" || c === "\n";

/**
 * One recognised phrase becomes text to type. Sentences start with a capital,
 * phrases are separated by a space, spoken punctuation ("comma", "new line")
 * becomes the real thing, "delete that" removes the last phrase and
 * "stop dictation" ends the session.
 */
export function dictate(phrase: string, state: DictationState, opts: { fullStop?: boolean } = {}): DictationStep {
  const said = phrase.trim();
  if (!said) return { backspaces: 0, type: "", stop: false, state };
  if (STOP.test(said)) return { backspaces: 0, type: "", stop: true, state };
  if (UNDO.test(said)) {
    const chunks = [...state.chunks];
    const last = chunks.pop() ?? "";
    const before = chunks.length ? chunks[chunks.length - 1].slice(-1) : "";
    return { backspaces: Array.from(last).length, type: "", stop: false, state: { lastChar: before, chunks } };
  }
  let text = said;
  for (const [re, to] of SPOKEN) text = text.replace(re, to);
  text = text.replace(/[ \t]+([.,;:!?)])/g, "$1").replace(/[ \t]{2,}/g, " ").replace(/ *\n */g, "\n");
  // the recogniser sometimes ends every phrase with a full stop of its own; keep one
  if (opts.fullStop && /[\p{L}\p{N}]$/u.test(text)) text += ".";
  // capitals at the start of each sentence
  let cap = endsSentence(state.lastChar);
  text = Array.from(text)
    .map((ch) => {
      if (/\p{L}/u.test(ch)) {
        const out = cap ? ch.toUpperCase() : ch;
        cap = false;
        return out;
      }
      if (ch === "." || ch === "!" || ch === "?" || ch === "\n") cap = true;
      else if (!/\s/.test(ch)) cap = false;
      return ch;
    })
    .join("");
  // the recogniser capitalises the first word of every phrase: undo that in mid-sentence
  if (!endsSentence(state.lastChar) && /^\p{Lu}\p{Ll}/u.test(text) && !/^I\b/.test(text)) text = text[0].toLowerCase() + text.slice(1);
  // one space between phrases, none before punctuation or after a line break
  const needsSpace = state.lastChar !== "" && !/\s/.test(state.lastChar) && !/^[.,;:!?)\n]/.test(text);
  const type = (needsSpace ? " " : "") + text;
  return { backspaces: 0, type, stop: false, state: { lastChar: type.slice(-1) || state.lastChar, chunks: [...state.chunks, type].slice(-50) } };
}

/** The phrases NEXUS understands as instructions, for the help line. */
export const SPOKEN_HELP = ["comma", "full stop", "question mark", "new line", "new paragraph", "delete that", "stop dictation"];

// ------------------------------------------------------------------ following a region of the screen

const norm = (line: string) => line.replace(/\s+/g, " ").trim().toLowerCase();

export interface FollowOptions {
  /** How new lines are joined when typed. */
  joiner: "newline" | "space";
  /** Type what is on screen when following starts, or only what appears afterwards. */
  includeExisting: boolean;
}

/**
 * Turns successive readings of a screen region into the text that is new.
 *
 * Text recognition flickers: a line can be misread for one reading and come
 * back right in the next. So a line is only accepted once it has been read the
 * same way twice in a row, and nothing is ever typed twice. A line that keeps
 * growing (live captions, a chat message being written) is followed: only the
 * part that was added is typed.
 */
export class ScreenFollower {
  private last: string[] = [];
  private seen = false;
  /** Lines already typed (normalised), oldest first. */
  private typed: string[] = [];
  private typedRaw: string[] = [];

  constructor(private readonly opts: FollowOptions = { joiner: "newline", includeExisting: false }) {}

  /** Give the latest reading; returns the text to type now ("" when nothing new is settled). */
  feed(lines: string[]): string {
    const clean = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const previous = new Set(this.last.map(norm));
    const first = !this.seen;
    this.seen = true;
    this.last = clean;
    if (first) {
      if (!this.opts.includeExisting) {
        // what is already there is the starting point, not something to type
        this.typed = clean.map(norm);
        this.typedRaw = [...clean];
      }
      return "";
    }
    const out: string[] = [];
    for (const line of clean) {
      const key = norm(line);
      if (!previous.has(key)) continue; // not settled yet: wait for the next reading
      if (this.typed.includes(key)) continue;
      // a line that grew: type only what was added
      let grownFrom = -1;
      for (let i = this.typedRaw.length - 1; i >= 0; i--) {
        const old = this.typedRaw[i];
        if (old.length >= 4 && line.length > old.length && norm(line).startsWith(norm(old))) {
          grownFrom = i;
          break;
        }
      }
      if (grownFrom >= 0) {
        const added = line.slice(this.typedRaw[grownFrom].length);
        this.typed[grownFrom] = key;
        this.typedRaw[grownFrom] = line;
        if (added.trim()) out.push(`\u0000${added}`); // continues the line it belongs to
        continue;
      }
      this.typed.push(key);
      this.typedRaw.push(line);
      out.push(line);
    }
    if (this.typed.length > 400) {
      this.typed = this.typed.slice(-300);
      this.typedRaw = this.typedRaw.slice(-300);
    }
    if (!out.length) return "";
    const sep = this.opts.joiner === "newline" ? "\n" : " ";
    let text = "";
    for (const piece of out) {
      if (piece.startsWith("\u0000")) text += piece.slice(1);
      else text += (text || this.started ? sep : "") + piece;
    }
    this.started = true;
    return text;
  }

  private started = false;

  reset() {
    this.last = [];
    this.seen = false;
    this.typed = [];
    this.typedRaw = [];
    this.started = false;
  }
}

/** Keys for removing `n` characters, spaced like quick deliberate presses. */
export function backspaceEvents(n: number, startAt = 0): { t: number; down: boolean; key: string }[] {
  const out: { t: number; down: boolean; key: string }[] = [];
  for (let i = 0; i < n; i++) {
    const t = startAt + i * 0.055;
    out.push({ t, down: true, key: "<backspace>" }, { t: t + 0.03, down: false, key: "<backspace>" });
  }
  return out;
}
