import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import type { DayPeriod, Priority } from "@/data/types";
import { KENYA_ZONE } from "@/lib/time";
import { extractZone } from "@/lib/voice/parser";
import { generateTitle } from "./title";

/**
 * Reads a scheduling request written in plain language, entirely offline.
 *
 *   "Repairing Mineh's phone today, in around 3 hours, preferably in the evening Kenya time"
 *
 * It separates the things a request can say about time, because they affect the
 * schedule differently:
 *   - a day or range of days ("today", "next Friday", "this weekend");
 *   - a preferred part of the day ("morning", "evening", "later tonight");
 *   - how long it takes ("around 3 hours");
 *   - a start time, exact ("at 3 pm") or approximate ("around 3", "in two hours");
 *   - a deadline ("by Friday", "before my next meeting").
 * When the wording has two reasonable readings that would change the schedule,
 * it returns a question instead of guessing.
 */

export interface SmartContext {
  now: number;
  /** Zone used when the request names none. */
  defaultZone: string;
  /** Which zone "Texas time" means. */
  texasZone: string;
  /** Day to assume when the request names none (an instant on that day), e.g. the day the rest of the sentence is about. */
  defaultDay?: number | null;
}

export interface Clarification {
  id: "inHours" | "meridiem" | "nextWeekday";
  question: string;
  options: { value: string; label: string }[];
}

export interface ScheduleRequest {
  /** The request as typed. */
  text: string;
  title: string;
  zone: string;
  /** "Kenya time", "Texas time"… when the request named a zone. */
  zoneLabel: string | null;
  durationMin: number | null;
  durationApprox: boolean;
  /** Days the request allows, as [start, end) instants; null = no day was mentioned. */
  window: { start: number; end: number; label: string } | null;
  /** The request itself named a day (as opposed to one being assumed). */
  dated: boolean;
  period: DayPeriod | null;
  /** "later today / tonight": not before now. */
  later: boolean;
  /** A start time the request gave. */
  startAt: number | null;
  startApprox: boolean;
  /** An explicit end time ("3 to 4 pm"). */
  endAt: number | null;
  deadline: number | null;
  deadlineLabel: string | null;
  /** "before my next meeting": resolved against the calendar later. */
  beforeNextMeeting: boolean;
  /** Not before this instant (set by "after …" relations in a conversation). */
  earliest?: number | null;
  /** A commitment at a fixed time (meeting, call, interview…) rather than flexible work. */
  fixed: boolean;
  priority: Priority | null;
  /** Things the user has to settle before this can be scheduled. */
  questions: Clarification[];
  /** How unclear parts were read, for display. */
  notes: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, "forty five": 45, fifty: 50, sixty: 60, ninety: 90,
};
const NUM = String.raw`(\d+(?:\.\d+)?|forty[\s-]five|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)`;
const UNIT = String.raw`(hours?|hrs?|h|minutes?|mins?|m)`;
const APPROX = String.raw`(?:about|around|roughly|approximately|approx\.?|maybe|~)`;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WD = String.raw`(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)`;
const FIXED_WORDS = /\b(zoom|meeting|interview|call|class|lecture|lesson|appointment|doctor|dentist|webinar|stand-?up|conference|exam|flight|workshop|training|presentation|demo)\b/i;

const num = (s: string) => {
  const t = s.toLowerCase().trim();
  return /^\d/.test(t) ? parseFloat(t) : NUMBER_WORDS[t.replace(/\s+/g, " ")] ?? NaN;
};
const minutes = (n: number, unit: string) => Math.round(unit.toLowerCase().startsWith("h") ? n * 60 : n);
const weekdayIndex = (s: string) => WEEKDAYS.findIndex((d) => d.startsWith(s.toLowerCase().slice(0, 3))) + 1;

/** Mutable working copy of the request text; recognised phrases are cut out, what is left is the title. */
class Text {
  constructor(public s: string) {}
  /** Remove the first match and return it. */
  take(re: RegExp): RegExpMatchArray | null {
    const m = this.s.match(re);
    if (!m) return null;
    const i = m.index ?? 0;
    this.s = `${this.s.slice(0, i)} ${this.s.slice(i + m[0].length)}`.replace(/\s+/g, " ").trim();
    return m;
  }
  has(re: RegExp) {
    return re.test(this.s);
  }
}

interface Clock {
  hour: number;
  minute: number;
  /** am/pm (or 24-hour form) was explicit. */
  certain: boolean;
}

/** "3", "3:30", "3pm", "15:00", "noon" → clock time; `certain` is false for a bare "7". */
function readClock(h: string, min: string | undefined, mer: string | undefined): Clock | null {
  let hour = parseInt(h, 10);
  const minute = min ? parseInt(min, 10) : 0;
  if (Number.isNaN(hour) || hour > 23 || minute > 59) return null;
  const m = mer?.toLowerCase().replace(/\./g, "");
  if (m === "pm" && hour < 12) hour += 12;
  if (m === "am" && hour === 12) hour = 0;
  return { hour, minute, certain: !!m || hour >= 13 || hour === 0 || (!!min && h.length === 2 && h[0] === "0") };
}

const TIME = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`;

export function parseScheduleRequest(input: string, ctx: SmartContext, answers: Partial<Record<Clarification["id"], string>> = {}): ScheduleRequest {
  const notes: string[] = [];
  const questions: Clarification[] = [];
  const t = new Text(input.trim().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[.!?]+$/, ""));

  // ---- time zone
  let zone = ctx.defaultZone;
  let zoneLabel: string | null = null;
  const z = extractZone(t.s, ctx.texasZone);
  if (z.zone) {
    zone = z.zone === "__home__" ? ctx.defaultZone : z.zone;
    zoneLabel = z.label;
    t.s = z.rest;
  } else if (t.take(/\b(?:in\s+|for\s+)?(?:EAT|kenya|nairobi)\b(?!\s*')/)) {
    zone = KENYA_ZONE;
    zoneLabel = "Kenya time";
  } else if (t.take(/\b(?:in\s+|for\s+)?texas\b(?!\s*')/i)) {
    zone = ctx.texasZone;
    zoneLabel = "Texas time";
  }
  const now = DateTime.fromMillis(ctx.now, { zone });

  // ---- explicitly fixed, priority
  let fixed = !!t.take(/\b(?:fixed(?:[\s-]time)?|do\s?n[o']t\s+(?:reschedule|move)(?:\s+it)?|can(?:no|')t\s+(?:be\s+)?(?:move|moved|rescheduled?)|must\s+not\s+(?:be\s+)?moved?)\b/i);
  let priority: Priority | null = null;
  if (t.take(/\b(?:urgent(?:ly)?|asap|critical|top[\s-]priority)\b/i)) priority = "critical";
  else if (t.take(/\b(?:high[\s-]priority|important)\b/i)) priority = "high";
  else if (t.take(/\blow[\s-]priority\b/i)) priority = "low";

  // ---- "before my next meeting"
  const beforeNextMeeting = !!t.take(/\b(?:before|ahead of|prior to)\s+(?:my\s+|the\s+)?next\s+(?:meeting|appointment|call|event)\b/i);

  // ---- duration
  let durationMin: number | null = null;
  let durationApprox = false;
  let inHours: { minutes: number; approx: boolean } | null = null;
  let m: RegExpMatchArray | null;
  // "in around 3 hours": either how long it takes or how soon it starts. Decided below.
  if ((m = t.take(new RegExp(String.raw`\bin\s+(${APPROX}\s+)?${NUM}\s*${UNIT}\b(?:'?\s*time)?`, "i")))) {
    const n = num(m[2]);
    if (!Number.isNaN(n)) inHours = { minutes: minutes(n, m[3]), approx: !!m[1] };
  }
  const setDuration = (mins: number, approx: boolean) => {
    if (durationMin == null && mins > 0) {
      durationMin = Math.round(mins);
      durationApprox = approx;
    }
  };
  if ((m = t.take(/\b(?:for\s+|takes?\s+|taking\s+|lasting\s+)?(about\s+|around\s+|roughly\s+)?(?:an?\s+)?hour\s+and\s+a\s+half\b/i))) setDuration(90, !!m[1]);
  if ((m = t.take(new RegExp(String.raw`\b(?:for\s+|takes?\s+|taking\s+|lasting\s+)?(${APPROX}\s+)?${NUM}\s+and\s+a\s+half\s+(?:hours?|hrs?)\b`, "i")))) setDuration(num(m[2]) * 60 + 30, !!m[1]);
  if ((m = t.take(/\b(?:for\s+|takes?\s+|taking\s+|lasting\s+)?(about\s+|around\s+|roughly\s+)?half\s+an?\s+hour\b/i))) setDuration(30, !!m[1]);
  if ((m = t.take(/\b(\d{1,2})\s?h\s?(\d{1,2})(?:\s?m(?:in)?)?\b/i))) setDuration(parseInt(m[1], 10) * 60 + parseInt(m[2], 10), false);
  const DUR_LEAD = String.raw`(?:for|takes?|taking|lasting|will take|should take|it takes|needs?|duration(?:\s+of)?|estimated(?:\s+at)?)`;
  if ((m = t.take(new RegExp(String.raw`\b(?:${DUR_LEAD}\s+)(${APPROX}\s+)?${NUM}[\s-]*${UNIT}\b(?:\s+(?:and\s+)?${NUM}\s*(minutes?|mins?))?`, "i")))) {
    setDuration(minutes(num(m[2]), m[3]) + (m[4] ? num(m[4]) : 0), !!m[1]);
  }
  if ((m = t.take(new RegExp(String.raw`(${APPROX})\s+${NUM}[\s-]*(hours?|hrs?|minutes?|mins?)\b`, "i")))) setDuration(minutes(num(m[2]), m[3]), true);
  if ((m = t.take(new RegExp(String.raw`(?:^|(?<=[\s,(]))${NUM}[\s-]*(hours?|hrs?|minutes?|mins?)\b(?:\s+(?:long|of work|or so))?`, "i")))) setDuration(minutes(num(m[1]), m[2]), /or so/i.test(m[0]));
  if ((m = t.take(/(?:^|(?<=[\s,(]))(\d+(?:\.\d+)?)\s?(h|m)\b(?!\.)/i))) setDuration(minutes(parseFloat(m[1]), m[2]), false);

  // ---- part of the day
  let period: DayPeriod | null = null;
  let later = false;
  let today = false;
  if (t.take(/\blater\s+(?:today|on)\b/i)) [later, today] = [true, true];
  if ((m = t.take(/\b(?:later\s+)?(?:tonight|this\s+evening|this\s+night)\b/i))) {
    period = /tonight|night/i.test(m[0]) && !/evening/i.test(m[0]) ? "night" : "evening";
    today = true;
    later = later || /later/i.test(m[0]);
  }
  if ((m = t.take(/\bthis\s+(morning|afternoon)\b/i))) {
    period = m[1].toLowerCase() as DayPeriod;
    today = true;
  }
  if (!period && (m = t.take(/\b(?:(?:in|during|for)\s+)?(?:the\s+)?(?:early\s+|late\s+|mid[\s-]?)?(morning|afternoon|evening|night)s?\b/i))) period = m[1].toLowerCase() as DayPeriod;

  // ---- deadline: "by Friday", "before 5 pm", "due tomorrow"
  let deadline: number | null = null;
  let deadlineLabel: string | null = null;
  if ((m = t.take(/\b(?:by|before|due(?:\s+(?:by|on))?|deadline(?:\s+(?:is|of|on))?|no later than|not later than)\s+([^,;]+?)(?=\s*(?:[,;]|$|\bfor\b|\btakes?\b|\bpreferably\b|\bin the\b))/i))) {
    const phrase = m[1].trim();
    const parsed = chrono.parse(phrase, { instant: new Date(ctx.now), timezone: now.offset }, { forwardDate: true })[0];
    if (parsed) {
      const c = parsed.start;
      let d = DateTime.fromObject({ year: c.get("year")!, month: c.get("month")!, day: c.get("day")!, hour: c.get("hour") ?? 0, minute: c.get("minute") ?? 0 }, { zone });
      // "by Friday" means by the end of Friday
      if (!c.isCertain("hour")) d = d.endOf("day");
      if (d.toMillis() <= ctx.now && !c.isCertain("day")) d = d.plus({ days: 1 });
      deadline = d.toMillis();
      deadlineLabel = phrase;
    } else {
      t.s = `${t.s} ${m[0]}`.trim(); // not a date after all: keep it in the title
    }
  }

  // ---- day or range of days
  let window: ScheduleRequest["window"] = null;
  const dayWindow = (d: DateTime, label: string, days = 1) => ({ start: d.startOf("day").toMillis(), end: d.startOf("day").plus({ days }).toMillis(), label });
  if (today || t.take(/\btoday\b/i)) window = dayWindow(now, "today");
  if (!window && t.take(/\b(?:the\s+)?day\s+after\s+tomorrow\b/i)) window = dayWindow(now.plus({ days: 2 }), now.plus({ days: 2 }).toFormat("cccc"));
  if (!window && t.take(/\b(?:tomorrow|tmrw|tmr)\b/i)) window = dayWindow(now.plus({ days: 1 }), "tomorrow");
  if (!window && (m = t.take(/\b(?:sometime\s+)?(?:(this|next|over the|on the|at the|during the)\s+)?(?:coming\s+)?weekend\b/i))) {
    // Saturday and Sunday; on a weekend "this weekend" is what is left of it
    let sat = now.startOf("day").plus({ days: (6 - now.weekday + 7) % 7 });
    if (now.weekday === 7) sat = now.startOf("day").minus({ days: 1 });
    if (/next/i.test(m[1] ?? "")) sat = sat.plus({ weeks: now.weekday >= 6 ? 1 : 0 }).plus({ weeks: now.weekday >= 6 ? 0 : 1 });
    window = { start: sat.toMillis(), end: sat.plus({ days: 2 }).toMillis(), label: /next/i.test(m[1] ?? "") ? "next weekend" : "this weekend" };
  }
  if (!window && t.take(/\bnext\s+week\b/i)) {
    const mon = now.startOf("week").plus({ weeks: 1 });
    window = { start: mon.toMillis(), end: mon.plus({ days: 7 }).toMillis(), label: "next week" };
  }
  if (!window && t.take(/\b(?:sometime\s+)?(?:this|during the|in the)\s+week\b/i)) window = { start: now.startOf("day").toMillis(), end: now.startOf("week").plus({ days: 7 }).toMillis(), label: "this week" };
  if (!window && (m = t.take(new RegExp(String.raw`\b(?:on\s+)?(next\s+|this\s+|coming\s+)?${WD}\b`, "i")))) {
    const wd = weekdayIndex(m[2]);
    const ahead = (wd - now.weekday + 7) % 7 || 7; // the next such day after today
    let day = now.plus({ days: ahead });
    if (/next/i.test(m[1] ?? "") && wd > now.weekday) {
      // "next Friday" said on a Wednesday: this week's Friday, or the one after?
      const pick = answers.nextWeekday;
      if (pick === "following") day = day.plus({ weeks: 1 });
      else if (pick !== "upcoming") {
        questions.push({
          id: "nextWeekday",
          question: `Which ${day.toFormat("cccc")} do you mean?`,
          options: [
            { value: "upcoming", label: `This coming ${day.toFormat("cccc d LLL")}` },
            { value: "following", label: `${day.plus({ weeks: 1 }).toFormat("cccc d LLL")} (next week)` },
          ],
        });
      }
    }
    window = dayWindow(day, day.toFormat("cccc d LLL"));
  }
  if (!window && (m = t.take(new RegExp(String.raw`\bin\s+${NUM}\s+days?\b`, "i")))) window = dayWindow(now.plus({ days: num(m[1]) }), now.plus({ days: num(m[1]) }).toFormat("cccc d LLL"));
  if (!window) {
    // a written date: "25 November", "Nov 25", "12/05"
    const found = chrono.strict.parse(t.s, { instant: new Date(ctx.now), timezone: now.offset }, { forwardDate: true }).find((r) => r.start.isCertain("day") && !r.start.isCertain("hour"));
    if (found) {
      const c = found.start;
      const d = DateTime.fromObject({ year: c.get("year")!, month: c.get("month")!, day: c.get("day")! }, { zone });
      window = dayWindow(d, d.toFormat("cccc d LLL"));
      t.s = `${t.s.slice(0, found.index)} ${t.s.slice(found.index + found.text.length)}`.replace(/\b(?:on|for)\s*$/i, "").replace(/\s+/g, " ").trim();
    }
  }

  const dated = !!window;
  if (!window && ctx.defaultDay != null) {
    const d = DateTime.fromMillis(ctx.defaultDay, { zone });
    window = dayWindow(d, d.hasSame(now, "day") ? "today" : d.hasSame(now.plus({ days: 1 }), "day") ? "tomorrow" : d.toFormat("cccc d LLL"));
  }

  // ---- start time
  let startAt: number | null = null;
  let endAt: number | null = null;
  let startApprox = false;
  let clock: Clock | null = null;
  let endClock: Clock | null = null;
  const RANGE = new RegExp(String.raw`\b(?:from\s+|between\s+)?${TIME}\s*(?:to|-|–|—|until|till|and)\s*${TIME}(?!\s*(?:hours?|minutes?|mins?|days?))`, "i");
  const range = t.s.match(RANGE);
  // only a real time range: at least one side says am/pm or has minutes ("pages 3 to 4" is not one)
  if (range && (range[3] || range[6] || range[2] || range[5]) && (m = t.take(RANGE))) {
    // "3 to 4 pm": the first time takes am/pm from the second, unless that would run backwards ("11 to 1 pm")
    let mer1 = m[3];
    if (!mer1 && m[6]) mer1 = /p/i.test(m[6]) && parseInt(m[1], 10) % 12 > parseInt(m[4], 10) % 12 ? "am" : m[6];
    clock = readClock(m[1], m[2], mer1);
    endClock = readClock(m[4], m[5], m[6] ?? m[3]);
  } else if ((m = t.take(/\b(?:at\s+|around\s+|about\s+)?(noon|midday|midnight)\b/i))) {
    clock = { hour: /midnight/i.test(m[1]) ? 0 : 12, minute: 0, certain: true };
    startApprox = /around|about/i.test(m[0]);
  } else if ((m = t.take(new RegExp(String.raw`(?:\b(at|@|around|about|starting(?:\s+at)?|start(?:s)?\s+at)\s*|~\s?)${TIME}(-?ish)?(?!\s*(?:hours?|minutes?|mins?|days?|%|\w*phone|st\b|nd\b|rd\b|th\b))`, "i")))) {
    clock = readClock(m[2], m[3], m[4]);
    startApprox = /around|about/i.test(m[1] ?? "") || m[0].trim().startsWith("~") || !!m[5];
  } else if ((m = t.take(/(?:^|(?<=\s))(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=$|[\s,])/i))) {
    clock = readClock(m[1], m[2], m[3]);
  } else if ((m = t.take(/(?:^|(?<=\s))([01]?\d|2[0-3]):([0-5]\d)(?=$|[\s,])/))) {
    clock = readClock(m[1], m[2], undefined);
  }

  if (clock && !clock.certain) {
    // a bare "at 7": the part of the day settles it, otherwise ask
    const pick = answers.meridiem ?? (period === "morning" ? "am" : period ? "pm" : null);
    if (pick === "pm" && clock.hour < 12) clock.hour += 12;
    if (pick === "am" && clock.hour === 12) clock.hour = 0;
    if (!pick) {
      const h = clock.hour % 12 || 12;
      const mm = clock.minute ? `:${String(clock.minute).padStart(2, "0")}` : "";
      questions.push({ id: "meridiem", question: `${h}${mm} in the morning or in the evening?`, options: [{ value: "am", label: `${h}${mm} AM` }, { value: "pm", label: `${h}${mm} PM` }] });
    }
    if (endClock && !endClock.certain && pick === "pm" && endClock.hour < 12) endClock.hour += 12;
  }
  if (clock) {
    const base = window ? DateTime.fromMillis(window.start, { zone }) : now.startOf("day");
    let s = base.set({ hour: clock.hour, minute: clock.minute });
    // no day given and that time has already passed today: the next one
    if (!window && s.toMillis() <= ctx.now) s = s.plus({ days: 1 });
    startAt = s.toMillis();
    if (!window) window = dayWindow(s, s.hasSame(now, "day") ? "today" : s.hasSame(now.plus({ days: 1 }), "day") ? "tomorrow" : s.toFormat("cccc d LLL"));
    if (endClock) {
      let e = s.set({ hour: endClock.hour, minute: endClock.minute });
      if (e <= s) e = e.plus({ hours: endClock.hour < 12 && clock.hour < 12 ? 12 : 24 });
      endAt = e.toMillis();
      durationMin = Math.round((endAt - startAt) / 60_000);
      durationApprox = false;
    }
  }

  // ---- "in N hours": how long, or how soon?
  if (inHours) {
    const { minutes: mins, approx } = inHours;
    const pick = answers.inHours;
    const asDuration = () => {
      setDuration(mins, approx);
      notes.push(`Read “in ${approx ? "around " : ""}${fmtMinutes(mins)}” as how long it takes.`);
    };
    const asStart = () => {
      startAt = ctx.now + mins * 60_000;
      startApprox = true;
      const s = DateTime.fromMillis(startAt, { zone });
      window = dayWindow(s, s.hasSame(now, "day") ? "today" : "tomorrow");
      notes.push(`Read “in ${fmtMinutes(mins)}” as when to start.`);
    };
    if (pick === "duration") asDuration();
    else if (pick === "start") asStart();
    else if (durationMin != null) asStart(); // a length is already given, so this is the start
    else if (startAt != null || period) asDuration(); // a time or part of the day is already given, so this is the length
    else if (window) {
      // "… today, in 3 hours": both readings are reasonable and give different schedules
      questions.push({
        id: "inHours",
        question: `Does “in ${fmtMinutes(mins)}” mean how long it takes, or when it should start?`,
        options: [
          { value: "duration", label: `It takes ${fmtMinutes(mins)}` },
          { value: "start", label: `Start in ${fmtMinutes(mins)}` },
        ],
      });
    } else asStart();
  }

  // ---- what is left is the title
  const title = generateTitle(t.s);
  if (!fixed && startAt != null && !startApprox && FIXED_WORDS.test(title)) {
    fixed = true;
    notes.push("A commitment at a set time, so it is a fixed appointment.");
  }

  return { text: input, title, zone, zoneLabel, durationMin, durationApprox, window, dated, period, later, startAt, startApprox, endAt, deadline, deadlineLabel, beforeNextMeeting, fixed, priority, questions, notes };
}

export function fmtMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} hour${h === 1 ? "" : "s"}` : `${m} minutes`;
}
