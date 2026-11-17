import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import type { Priority } from "@/data/types";
import { KENYA_ZONE, TEXAS_CENTRAL, TEXAS_MOUNTAIN } from "@/lib/time";

/**
 * Natural-language command parser (offline, deterministic).
 *
 * Speech (or typed text) → structured Intent. Time expressions are resolved in
 * an explicit zone when the user says "Kenya time" / "Texas time" / "EAT" /
 * "Central time" / "El Paso time"; otherwise in the user's home zone.
 */

export type Intent =
  | {
      type: "add_task";
      title: string;
      dueAt: number | null;
      tz: string;
      estimateMin: number | null;
      priority: Priority | null;
      categoryId: string | null;
      reminderAtTime: boolean;
    }
  | { type: "add_event"; title: string; startAt: number; endAt: number; tz: string }
  | { type: "reschedule"; query: string; newStart: number; tz: string; dateOnly: boolean }
  | { type: "query_today" }
  | { type: "query_upcoming" }
  | { type: "query_overdue" }
  | { type: "start_focus"; minutes: number | null; mode: "pomodoro" | "countdown" | "stopwatch" }
  | { type: "pause_timer" }
  | { type: "resume_timer" }
  | { type: "stop_timer" }
  | { type: "time_left" }
  | { type: "complete_current" }
  | { type: "complete_task"; query: string }
  | { type: "delete_task"; query: string }
  | { type: "overlay"; show: boolean }
  | { type: "what_next" }
  | { type: "summarize" }
  | { type: "unknown"; text: string };

export interface ParsedCommand {
  transcript: string;
  intent: Intent;
  /** 0..1 heuristic confidence. */
  confidence: number;
  /** True for destructive / ambiguous actions — UI must ask before applying. */
  needsConfirmation: boolean;
  /** Human-readable explanation of what will happen. */
  notes: string[];
}

export interface ParseContext {
  now: number;
  /** Zone used when none is spoken. */
  homeZone: string;
  /** Which zone "Texas time" means (Central by default, El Paso optional). */
  texasZone: string;
}

// ---------------------------------------------------------------- helpers

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, ninety: 90,
};

/** "twenty five" → 25, "forty-five" → 45, "25" → 25 */
function wordsToNumber(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/-/g, " ");
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  let total = 0;
  let seen = false;
  for (const w of t.split(/\s+/)) {
    if (w === "and") continue;
    const v = NUM_WORDS[w];
    if (v == null) return null;
    total += v;
    seen = true;
  }
  return seen ? total : null;
}

const NUM = String.raw`(\d+(?:\.\d+)?|(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?)`;
const UNIT = String.raw`(hours?|hrs?|h|minutes?|mins?|m)`;

interface Extracted {
  value: number | null;
  rest: string;
}

/** Duration phrases that describe length, not a deadline ("for 2 hours", "25-minute", "half an hour"). */
export function extractDuration(text: string): Extracted {
  let m = text.match(/\b(?:for\s+)?(?:about\s+)?half\s+an?\s+hour\b/i);
  if (m) return { value: 30, rest: cut(text, m) };
  m = text.match(new RegExp(String.raw`\b(?:for|takes?|lasting|estimated(?:\s+at)?|estimate(?:\s+of)?)\s+(?:about\s+|around\s+)?${NUM}\s*${UNIT}\b(?:\s+and\s+${NUM}\s*(minutes?|mins?))?`, "i"));
  if (!m) m = text.match(new RegExp(String.raw`\b${NUM}[\s-]*(hours?|hrs?|minutes?|mins?)[\s-]+(?:long\s+)?(?=focus|session|pomodoro|timer|countdown|block|task|meeting|call|work|break)`, "i"));
  // Trailing "… 30 minutes" is a length, but "… in 30 minutes" is a relative time.
  if (!m) m = text.match(new RegExp(String.raw`(?<!\bin\s+(?:about\s+|around\s+)?)(?:^|(?<=\s))${NUM}[\s-]*(hours?|minutes?|mins?)\s*$`, "i"));
  if (!m) return { value: null, rest: text };
  const n = wordsToNumber(m[1]);
  if (n == null) return { value: null, rest: text };
  const unit = m[2].toLowerCase();
  let minutes = unit.startsWith("h") ? n * 60 : n;
  if (m[3] && m[4]) {
    const extra = wordsToNumber(m[3]);
    if (extra != null) minutes += extra;
  }
  return { value: Math.round(minutes), rest: cut(text, m) };
}

function cut(text: string, m: RegExpMatchArray): string {
  const i = m.index ?? 0;
  return (text.slice(0, i) + " " + text.slice(i + m[0].length)).replace(/\s+/g, " ").trim();
}

interface ZoneHit {
  zone: string | null;
  rest: string;
  label: string | null;
}

export function extractZone(text: string, texasZone: string): ZoneHit {
  const rules: [RegExp, string, string][] = [
    [/\b(?:in\s+)?(?:west\s+texas|el\s+paso|mountain)(?:\s+standard|\s+daylight)?\s+time\b/i, TEXAS_MOUNTAIN, "El Paso time"],
    [/\b(?:in\s+)?(?:kenya|kenyan|nairobi|east\s+africa|east\s+african)\s+time\b/i, KENYA_ZONE, "Kenya time"],
    [/(?<=\d\s?(?:[ap]\.?m\.?)?\s?)\bEAT\b/, KENYA_ZONE, "EAT"],
    [/\b(?:in\s+)?(?:texas|dallas|houston|austin|san\s+antonio)\s+time\b/i, texasZone, "Texas time"],
    [/\b(?:in\s+)?(?:central|chicago)(?:\s+standard|\s+daylight)?\s+time\b/i, TEXAS_CENTRAL, "Central time"],
    [/\b(?:CST|CDT|CT)\b/, TEXAS_CENTRAL, "Central time"],
    [/\b(?:MST|MDT)\b/, TEXAS_MOUNTAIN, "Mountain time"],
    [/\b(?:in\s+)?(?:my|local)\s+time\b/i, "__home__", "local time"],
    // "… in Kenya" / "… in Texas" at the end of a time phrase
    [/\b(?<=(?:am|pm|a\.m\.|p\.m\.|\d)\s+)in\s+kenya\b/i, KENYA_ZONE, "Kenya time"],
    [/\b(?<=(?:am|pm|a\.m\.|p\.m\.|\d)\s+)in\s+texas\b/i, texasZone, "Texas time"],
  ];
  for (const [re, zone, label] of rules) {
    const m = text.match(re);
    if (m) return { zone, rest: cut(text, m), label };
  }
  return { zone: null, rest: text, label: null };
}

interface TimeHit {
  start: number | null;
  end: number | null;
  hasTime: boolean;
  hasDate: boolean;
  rest: string;
  matched: string | null;
}

/** Normalise speech-isms ("p.m.", "9 o'clock", "noon") before chrono. */
function normaliseTimes(text: string): string {
  return text
    .replace(/\b([ap])\.\s?m\.?/gi, (_, a: string) => `${a.toLowerCase()}m`)
    .replace(/\b(\d{1,2})\s*o'?\s?clock\b/gi, "$1:00")
    .replace(/\bat\s+noon\b/gi, "at 12:00 pm")
    .replace(/\bat\s+midnight\b/gi, "at 11:59 pm")
    .replace(/\bend of (the )?day\b/gi, "5 pm")
    .replace(/\bthis evening\b/gi, "today at 6 pm")
    .replace(/\btonight\b/gi, "today at 8 pm")
    .replace(/\bthis afternoon\b/gi, "today at 2 pm")
    .replace(/\bthis morning\b/gi, "today at 9 am");
}

/** Parse the first date/time expression, interpreting wall-clock values in `zone`. */
export function extractTime(text: string, zone: string, now: number): TimeHit {
  const z = DateTime.fromMillis(now, { zone });
  const ref = new Date(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  const results = chrono.parse(text, ref, { forwardDate: true });
  if (!results.length) return { start: null, end: null, hasTime: false, hasDate: false, rest: text, matched: null };
  const r = results[0];
  const toUtc = (c: chrono.ParsedComponents): number => {
    const dt = DateTime.fromObject(
      {
        year: c.get("year") ?? z.year,
        month: c.get("month") ?? z.month,
        day: c.get("day") ?? z.day,
        hour: c.get("hour") ?? 9,
        minute: c.get("minute") ?? 0,
      },
      { zone },
    );
    return dt.toMillis();
  };
  const hasTime = r.start.isCertain("hour");
  const hasDate = r.start.isCertain("day") || r.start.isCertain("weekday") || r.start.isCertain("month");
  let start = toUtc(r.start);
  // Relative expressions ("in 2 hours") are anchored to now.
  if (/\bin\s+\d+|\bin\s+(an?|one|two|three|half)\b/i.test(r.text) && !hasDate) {
    start = now + (r.start.date().getTime() - ref.getTime());
  } else if (!hasTime) {
    // Date without time → end of working day by default for deadlines.
    start = DateTime.fromMillis(start, { zone }).set({ hour: 17, minute: 0 }).toMillis();
  }
  // A bare time that already passed today means the next day.
  if (!hasDate && hasTime && start <= now) start = DateTime.fromMillis(start, { zone }).plus({ days: 1 }).toMillis();
  let end = r.end ? toUtc(r.end) : null;
  if (end != null && end <= start) end = DateTime.fromMillis(end, { zone }).plus({ days: 1 }).toMillis();
  const rest = (text.slice(0, r.index) + " " + text.slice(r.index + r.text.length)).replace(/\s+/g, " ").trim();
  return { start, end, hasTime, hasDate, rest, matched: r.text };
}

function extractPriority(text: string): { value: Priority | null; rest: string } {
  const rules: [RegExp, Priority][] = [
    [/\b(?:as\s+)?(?:critical|urgent|asap|top)(?:\s+priority)?\b/i, "critical"],
    [/\b(?:with\s+)?(?:a\s+)?high[\s-]priority\b|\b(?:as\s+)?important\b/i, "high"],
    [/\b(?:with\s+)?(?:a\s+)?medium[\s-]priority\b/i, "medium"],
    [/\b(?:with\s+)?(?:a\s+)?low[\s-]priority\b/i, "low"],
  ];
  for (const [re, p] of rules) {
    const m = text.match(re);
    if (m) return { value: p, rest: cut(text, m) };
  }
  return { value: null, rest: text };
}

function extractCategory(text: string): { value: string | null; rest: string } {
  const m = text.match(/\b(?:under|in|to|for)\s+(?:my\s+|the\s+)?(work|personal|projects?|meetings?)\s+(?:list|category|tasks?)\b|#(work|personal|projects?|meetings?)\b/i);
  const pick = (w: string): string => {
    const k = w.toLowerCase();
    if (k.startsWith("project")) return "projects";
    if (k.startsWith("meeting")) return "meetings";
    return k;
  };
  if (m) return { value: pick(m[1] || m[2]), rest: cut(text, m) };
  if (/\b(meeting|call|standup|stand-up|interview|sync)\b/i.test(text)) return { value: "meetings", rest: text };
  if (/\b(report|client|email|presentation|deploy|review|invoice)\b/i.test(text)) return { value: "work", rest: text };
  return { value: null, rest: text };
}

function cleanTitle(s: string): string {
  let t = s
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;-]+|[\s,.:;!?-]+$/g, "")
    .replace(/\b(?:at|on|by|due|before|for|from|until|till|starting|this|next|and)\s*$/i, "")
    .replace(/^(?:to|about|that|for)\s+/i, "")
    .trim();
  t = t.replace(/\s+(?:at|on|by|due|for|from)$/i, "").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

function stripLeadingPhrases(s: string): string {
  return s
    .replace(/^(?:hey\s+|ok(?:ay)?\s+)?nexus[,\s]+/i, "")
    .replace(/^(?:please\s+|can you\s+|could you\s+)/i, "")
    .trim();
}

// ---------------------------------------------------------------- main

export function parseCommand(input: string, ctx: ParseContext): ParsedCommand {
  const transcript = input.trim();
  const text = stripLeadingPhrases(normaliseTimes(transcript)).replace(/[.!?]+$/, "");
  const lower = text.toLowerCase();
  const res = (intent: Intent, confidence: number, needsConfirmation: boolean, notes: string[] = []): ParsedCommand => ({
    transcript,
    intent,
    confidence,
    needsConfirmation,
    notes,
  });

  if (!text) return res({ type: "unknown", text }, 0, true, ["Nothing was recognised."]);

  // --- timer & status queries
  if (/\b(how (much|long)\b.*\b(left|remaining)|time (left|remaining)|remaining time)\b/.test(lower)) {
    return res({ type: "time_left" }, 0.95, false);
  }
  if (/^(pause|hold)\b.*\b(timer|focus|session|countdown|pomodoro|stopwatch)?/.test(lower) && /\b(pause|hold)\b/.test(lower) && !/\btask\b/.test(lower)) {
    return res({ type: "pause_timer" }, 0.9, false);
  }
  if (/^(resume|continue|unpause)\b/.test(lower)) return res({ type: "resume_timer" }, 0.9, false);
  if (/^(stop|end|cancel|finish)\b.*\b(timer|focus|session|countdown|pomodoro|stopwatch)\b/.test(lower)) {
    return res({ type: "stop_timer" }, 0.9, false);
  }
  if (/\b(start|begin|launch|run|set)\b.*\b(focus|pomodoro|timer|countdown|stopwatch|deep work|session)\b/.test(lower)) {
    const mode = /stopwatch/.test(lower) ? "stopwatch" : /\b(timer|countdown)\b/.test(lower) && !/focus|pomodoro/.test(lower) ? "countdown" : "pomodoro";
    const d = extractDuration(text);
    let minutes = d.value;
    if (minutes == null) {
      const m = lower.match(new RegExp(String.raw`${NUM}\s*(hours?|minutes?|mins?)`, "i"));
      if (m) {
        const n = wordsToNumber(m[1]);
        if (n != null) minutes = m[2].startsWith("h") ? n * 60 : n;
      }
    }
    return res({ type: "start_focus", minutes, mode }, 0.95, false, [
      mode === "stopwatch" ? "Start a stopwatch" : `Start a ${minutes ?? "default"}-minute ${mode === "pomodoro" ? "focus session" : "countdown"}`,
    ]);
  }

  // --- completion
  if (
    /\b(mark|set)\b.*\b(current|active|this)\s+task\b.*\b(complete|completed|done|finished)\b/.test(lower) ||
    /\b(complete|finish)\b\s+(my\s+|the\s+)?(current|active)\s+task\b/.test(lower) ||
    /^(i'?m|i am)\s+(done|finished)( with (this|my|the current) task)?$/.test(lower)
  ) {
    return res({ type: "complete_current" }, 0.9, true, ["Mark the active task as complete"]);
  }
  let m = text.match(/^(?:mark|tick off|check off)\s+(?:the\s+|my\s+)?(?:task\s+)?(.+?)\s+(?:as\s+)?(?:complete|completed|done|finished)$/i) ||
    text.match(/^(?:complete|finish)\s+(?:the\s+|my\s+)?(?:task\s+)?(.+)$/i);
  if (m) return res({ type: "complete_task", query: cleanTitle(m[1]) }, 0.8, true, [`Mark "${cleanTitle(m[1])}" complete`]);

  // --- deletion (always confirmed)
  m = text.match(/^(?:delete|remove|cancel|drop|trash)\s+(?:the\s+|my\s+)?(?:task\s+|reminder\s+|event\s+|appointment\s+)?(.+)$/i);
  if (m) return res({ type: "delete_task", query: cleanTitle(m[1]) }, 0.75, true, [`Delete "${cleanTitle(m[1])}" (can be restored from Trash)`]);

  // --- overlay
  if (/\b(show|open|display|bring up)\b.*\boverlay\b/.test(lower)) return res({ type: "overlay", show: true }, 0.95, false);
  if (/\b(hide|close|dismiss)\b.*\boverlay\b/.test(lower)) return res({ type: "overlay", show: false }, 0.95, false);

  // --- rescheduling
  m = text.match(/^(?:move|reschedule|push|shift|postpone|change|delay|bump)\s+(?:my\s+|the\s+|our\s+)?(.+?)\s+(?:to|until|till|for|back to)\s+(.+)$/i);
  if (m) {
    const zh = extractZone(m[2], ctx.texasZone);
    const zone = zh.zone === "__home__" || !zh.zone ? ctx.homeZone : zh.zone;
    const th = extractTime(zh.rest, zone, ctx.now);
    if (th.start != null) {
      const query = cleanTitle(m[1]).toLowerCase();
      return res(
        { type: "reschedule", query, newStart: th.start, tz: zone, dateOnly: !th.hasTime },
        th.hasDate || th.hasTime ? 0.85 : 0.6,
        true,
        [`Find "${query}" and move it`, zh.label ? `Time interpreted as ${zh.label}` : "Time interpreted in your home time zone"],
      );
    }
  }

  // --- queries
  if (/\boverdue\b/.test(lower) && /\b(what|show|list|any|which)\b/.test(lower)) return res({ type: "query_overdue" }, 0.9, false);
  if (/\b(what|which|show|list|read)\b.*\b(tasks?|to-?dos?|agenda|plan|schedule|do i have)\b.*\btoday\b|\bwhat'?s? (on )?(my )?(agenda|plate|schedule) today\b|\btoday'?s (tasks|agenda|schedule)\b/.test(lower)) {
    return res({ type: "query_today" }, 0.95, false);
  }
  if (/\b(show|what|list|any|read)\b.*\b(upcoming|next|coming up|this week|appointments?|meetings?|events?|schedule)\b/.test(lower) && !/\bshould\b/.test(lower)) {
    return res({ type: "query_upcoming" }, 0.9, false);
  }
  if (/\bwhat should i (do|work on|focus on|tackle)|\bwhat'?s next\b|\bnext task\b|\bsuggest (a|my|the next) task\b/.test(lower)) {
    return res({ type: "what_next" }, 0.9, false);
  }
  if (/\b(summari[sz]e|summary of|brief me|overview of)\b.*\b(day|agenda|today|schedule)?/.test(lower)) {
    return res({ type: "summarize" }, 0.9, false);
  }

  // --- creation (events vs tasks)
  const isEvent = /^(?:schedule|book|set up|arrange|plan|block|add)\s+(?:a\s+|an\s+|my\s+)?(?:new\s+)?(?:meeting|call|appointment|event|session|block|time block|interview|sync|standup)\b/i.test(text) ||
    /^(?:schedule|book)\b/i.test(text);
  const isReminder = /^(?:remind me|set a reminder|reminder)\b/i.test(text);
  const isTask = /^(?:add|create|new|make|put)\b/i.test(text) || /^(?:i need to|i have to|i must|don'?t (?:let me )?forget to|todo|to-do)\b/i.test(text);

  // Extract structured parts
  const zh = extractZone(text, ctx.texasZone);
  const zone = zh.zone === "__home__" || !zh.zone ? ctx.homeZone : zh.zone;
  const dur = extractDuration(zh.rest);
  const pri = extractPriority(dur.rest);
  const cat = extractCategory(pri.rest);
  const th = extractTime(cat.rest, zone, ctx.now);
  const notes: string[] = [];
  if (zh.label) notes.push(`Time interpreted as ${zh.label}`);

  let body = th.rest
    .replace(/^(?:remind me\s+(?:to|about|that)|set a reminder\s+(?:to|for)|reminder\s+(?:to|for))\s*/i, "")
    .replace(/^(?:add|create|new|make|put)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:task|to-?do|item|reminder)?\s*(?:to|for|called|named|:)?\s*/i, "")
    .replace(/^(?:i need to|i have to|i must|don'?t (?:let me )?forget to)\s*/i, "")
    .replace(/^(?:schedule|book|set up|arrange|plan|block)\s+(?:a\s+|an\s+|my\s+)?(?:time\s+block\s+for\s+)?/i, "")
    .replace(/\b(?:to my (?:list|tasks|to-?do list))\b/i, "");
  body = cleanTitle(body);

  if (isEvent && th.start != null) {
    const len = (th.end != null ? th.end - th.start : (dur.value ?? 60) * 60_000);
    const title = body || "Appointment";
    return res(
      { type: "add_event", title, startAt: th.start, endAt: th.start + Math.max(15 * 60_000, len), tz: zone },
      th.hasTime ? 0.9 : 0.6,
      !th.hasTime,
      [...notes, th.hasTime ? "Schedule an appointment" : "No time given — please confirm the time"],
    );
  }

  if (isTask || isReminder || isEvent || th.start != null) {
    if (!body) return res({ type: "unknown", text: transcript }, 0.2, true, ["Couldn't find what the task is."]);
    const confidence = isTask || isReminder || isEvent ? 0.9 : 0.55;
    if (isReminder && th.start == null) notes.push("No time recognised — reminder will need a time");
    return res(
      {
        type: "add_task",
        title: body,
        dueAt: th.start,
        tz: zone,
        estimateMin: dur.value,
        priority: pri.value,
        categoryId: cat.value,
        reminderAtTime: isReminder,
      },
      confidence,
      confidence < 0.7 || (isReminder && th.start == null),
      notes,
    );
  }

  return res({ type: "unknown", text: transcript }, 0.1, true, ["Not sure what to do — add it as a task?"]);
}

/** Fuzzy score of how well `query` matches `title` (0..1). */
export function matchScore(query: string, title: string): number {
  const q = query.toLowerCase().replace(/\b(my|the|a|an)\b/g, "").trim();
  const t = title.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1;
  if (t.includes(q)) return 0.85;
  const qw = q.split(/\W+/).filter((w) => w.length > 2);
  if (!qw.length) return 0;
  const hit = qw.filter((w) => t.includes(w) || (w.endsWith("s") && t.includes(w.slice(0, -1)))).length;
  return (hit / qw.length) * 0.75;
}
