import { DateTime } from "luxon";
import type { CalendarEvent, Task } from "@/data/types";
import { DAY, MIN, expandEvents, type Interval } from "@/lib/schedule";
import { parseScheduleRequest, type ScheduleRequest } from "./parse";
import { resolveRequest } from "./slots";
import type { RescheduleSettings } from "./reschedule";
import { baseVerb, generateTitle } from "./title";

/**
 * Conversational scheduling.
 *
 * One message can mention several activities, refer back to things said
 * earlier ("it", "the gym", "my meeting") and relate them ("before my gym
 * session", "after my meeting", "30 minutes between those two"). This module
 * turns a message into a plan of actions against the real calendar:
 *
 *   - references are matched against what was mentioned in the conversation
 *     and against saved calendar entries, never invented; an unclear reference
 *     becomes a question;
 *   - "before" / "after" are constraints the chosen times must satisfy, solved
 *     together when several activities depend on each other;
 *   - nothing is double-booked and fixed appointments are never moved unless
 *     the user names one explicitly.
 *
 * It only plans. The caller applies the actions and remembers what was mentioned.
 */

export interface Entity {
  kind: "event" | "task";
  id: string;
  title: string;
}

/** What the conversation has been about, most recent first. */
export interface ConvContext {
  recent: Entity[];
  /** Entities of the previous message, in the order they were mentioned ("the first task"). */
  lastBatch: Entity[];
}
export const EMPTY_CONTEXT: ConvContext = { recent: [], lastBatch: [] };

export interface TurnEnv {
  now: number;
  tasks: Task[];
  events: CalendarEvent[];
  slot: RescheduleSettings;
  /** Zone used when the message names none. */
  defaultZone: string;
  texasZone: string;
}

export type Action =
  | { type: "create"; tempId: string; req: ScheduleRequest; slot: Interval; durationMin: number; existingTaskId: string | null }
  | { type: "move"; eventId: string; title: string; to: Interval }
  | { type: "fixed"; eventId: string; title: string; fixed: boolean };

export interface Line {
  kind: "created" | "moved" | "fixed" | "info" | "problem";
  title: string;
  slot?: Interval;
  zone?: string;
  fixed?: boolean;
  /** Relationship or assumption worth telling the user. */
  note?: string;
  /** The calendar entry this is about: an event id, or a `new-…` id until it is saved. */
  ref?: string;
}

export interface Question {
  /** Answer key to pass back in `answers`. */
  key: string;
  text: string;
  options: { value: string; label: string; slot?: Interval; zone?: string }[];
}

export interface Turn {
  actions: Action[];
  lines: Line[];
  question: Question | null;
  /** Everything this message referred to or created, in order (for the next message's context). */
  mentioned: ({ entity: Entity } | { tempId: string; title: string })[];
}

interface Cand {
  title: string;
  start: number;
  end: number;
  fixed: boolean;
  eventId?: string;
  taskId?: string;
  tempId?: string;
  /** 0 = in this message, 1 = earlier in the conversation, 2 = on the calendar. */
  rank: number;
}

interface Relation {
  kind: "before" | "after";
  immediate: boolean;
  ref: string;
  cand: Cand;
}

interface Item {
  tempId: string;
  text: string;
  req: ScheduleRequest;
  relations: Relation[];
  slot: Interval | null;
  durationMin: number;
  existingTaskId: string | null;
  solving?: boolean;
  line?: Line;
}

const STOP = new Set("my the a an that this those these session appointment task tasks activity activities event time one thing work to of for on at in i im am going go be is next upcoming scheduled existing and with it its me our your about".split(" "));
const MEETING_WORDS = ["meeting", "zoom", "call", "interview", "sync", "standup", "conference", "webinar", "teams", "meet"];
const PERIOD_WORDS: Record<string, [number, number]> = { morning: [5, 12], afternoon: [12, 17], evening: [17, 24], tonight: [17, 24], night: [19, 24] };
const ACTIVITY_STARTS = new Set(
  ("attend go head call phone ring write review finish complete read study clean cook buy pay send email submit prepare plan fix repair update check visit meet book schedule work start build design test deploy record edit draft file renew pick drop take make do have join practice practise exercise run walk wash water order print sign install backup move put place reschedule push shift give mark set lock tidy organize organise sort reply respond research learn watch listen teach train pack ship deliver collect return cancel confirm arrange draw paint mow iron fold shop get grab bring help present demo interview sync debug refactor analyse analyze create upload download scan charge replace mend service wrap bake eat lunch dinner breakfast gym zoom meeting appointment class lecture")
    .split(" "),
);
const MOVE_VERB = /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:move|reschedule|push|shift|postpone|bring|delay|bump)\s+/i;
const SCHEDULE_VERB = /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:schedule|put|place|slot|book|plan|do|fit|add)\s+/i;
const PRONOUN = /^(?:it|that|this|that one|this one|(?:that|this|the) (?:task|appointment|meeting|activity|one|thing|event))$/i;
const TIME_LIKE = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight|midday|today|tomorrow|tonight|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|morning|afternoon|evening|week|weekend|month)\b/i;

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.endsWith("ing") ? baseVerb(w) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

const clean = (s: string) => s.trim().replace(/[.!?,;:]+$/, "").trim();

/** Sentences of a message. */
function sentences(text: string): string[] {
  return text
    .replace(/\b([ap])\.m\./gi, "$1m")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map(clean)
    .filter(Boolean);
}

const startsActivity = (part: string) => {
  const p = part.toLowerCase().replace(/^(?:and\s+|then\s+|also\s+|please\s+)*(?:(?:i|we)(?:'ll|\s+(?:also\s+|still\s+)?(?:need|have|want|must|should|will|ought|would like)(?:\s+to)?)\s+)?(?:to\s+)?(?:a\s+|an\s+|my\s+|the\s+)?/, "");
  const first = p.split(/\s+/)[0] ?? "";
  return ACTIVITY_STARTS.has(first) || (/^[a-z]{4,}ing$/.test(first) && !["morning", "evening"].includes(first));
};

/** The separate activities in a sentence: "review X, attend Y at 3, and go to Z at 6" → three. */
export function splitActivities(sentence: string): string[] {
  const pieces = sentence.split(/(\s*,\s*(?:and\s+)?(?:then\s+)?|\s+and\s+(?:then\s+)?|\s+then\s+)/);
  const out: string[] = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 2) {
    const sep = pieces[i];
    const part = pieces[i + 1] ?? "";
    if (startsActivity(part)) out.push(part);
    else out[out.length - 1] += sep + part;
  }
  return out.map(clean).filter(Boolean);
}

export function planTurn(text: string, env: TurnEnv, ctx: ConvContext = EMPTY_CONTEXT, answers: Record<string, string> = {}): Turn {
  const { now } = env;
  const zone = env.defaultZone;
  const bufferMs = Math.max(0, env.slot.bufferMin) * MIN;
  /** The calendar as it will be once the actions planned so far are applied. */
  let work = env.events.filter((e) => !e.deletedAt);
  const actions: Action[] = [];
  const lines: Line[] = [];
  const mentioned: Turn["mentioned"] = [];
  const items: Item[] = [];
  let question: Question | null = null;
  let seq = 0;

  const ask = (q: Question) => {
    if (!question) question = q;
  };
  const problem = (title: string, note: string) => lines.push({ kind: "problem", title, note });
  const fmt = (ms: number, z = zone) => {
    const d = DateTime.fromMillis(ms, { zone: z });
    const today = DateTime.fromMillis(now, { zone: z });
    const day = d.hasSame(today, "day") ? "today" : d.hasSame(today.plus({ days: 1 }), "day") ? "tomorrow" : d.toFormat("ccc d LLL");
    return `${day} ${d.toFormat(d.minute ? "h:mm a" : "h a")}`;
  };
  const mention = (c: Cand) => {
    if (c.tempId) mentioned.push({ tempId: c.tempId, title: c.title });
    else if (c.eventId) mentioned.push({ entity: { kind: "event", id: c.eventId, title: c.title } });
    else if (c.taskId) mentioned.push({ entity: { kind: "task", id: c.taskId, title: c.title } });
  };

  // ------------------------------------------------------------ what can be referred to
  const calendarCands = (): Cand[] => {
    const seen = new Set<string>();
    const out: Cand[] = [];
    for (const o of expandEvents(work, now - 2 * 3600_000, now + 30 * DAY)) {
      if (o.end <= now || seen.has(o.event.id)) continue;
      seen.add(o.event.id);
      out.push({ title: o.event.title, start: o.start, end: o.end, fixed: o.event.fixed, eventId: o.event.id, taskId: o.event.taskId ?? undefined, rank: 2 });
    }
    const planned = new Set(out.map((c) => c.taskId).filter(Boolean));
    for (const t of env.tasks) {
      if (t.deletedAt || t.archivedAt || t.status === "done" || t.dueAt == null || planned.has(t.id) || t.dueAt < now) continue;
      out.push({ title: t.title, start: t.dueAt, end: t.dueAt, fixed: false, taskId: t.id, rank: 2 });
    }
    return out;
  };
  const itemCand = (it: Item): Cand => ({ title: it.req.title, start: it.slot?.start ?? NaN, end: it.slot?.end ?? NaN, fixed: it.req.fixed, tempId: it.tempId, rank: 0 });
  const contextCand = (e: Entity, cal: Cand[]): Cand | null => {
    const hit = cal.find((c) => (e.kind === "event" ? c.eventId === e.id : c.taskId === e.id));
    return hit ? { ...hit, rank: 1 } : null;
  };

  type Found = { status: "found"; cand: Cand } | { status: "ambiguous"; cands: Cand[] } | { status: "none" };

  /** Match a phrase such as "my gym session", "it" or "the first task" to something real. */
  const resolveRef = (raw: string, exclude?: string): Found => {
    const ref = clean(raw).replace(/^(?:the time (?:i'?m|i am) (?:going to|at)\s+)/i, "");
    const cal = calendarCands();
    const pending = items.filter((it) => it.tempId !== exclude).map(itemCand);
    const recent = ctx.recent.map((e) => contextCand(e, cal)).filter((c): c is Cand => !!c);
    const forced = answers[`ref:${ref.toLowerCase()}`];
    if (forced) {
      const c = [...pending, ...cal].find((x) => (x.eventId ?? x.taskId ?? x.tempId) === forced);
      if (c) return { status: "found", cand: c };
    }
    if (PRONOUN.test(ref)) {
      const c = pending[pending.length - 1] ?? recent[0];
      return c ? { status: "found", cand: c } : { status: "none" };
    }
    const ordinal = ref.match(/^(?:the\s+)?(first|second|third|last)\s+(?:task|one|activity|appointment|item|thing)$/i);
    if (ordinal) {
      const batch = pending.length > 1 ? pending : ctx.lastBatch.map((e) => contextCand(e, cal)).filter((c): c is Cand => !!c);
      const idx = { first: 0, second: 1, third: 2, last: batch.length - 1 }[ordinal[1].toLowerCase() as "first"]!;
      return batch[idx] ? { status: "found", cand: batch[idx] } : { status: "none" };
    }
    if (/^(?:my\s+|the\s+)?next\s+(?:meeting|appointment|call|event)$/i.test(ref)) {
      const c = cal.filter((x) => x.fixed && x.start > now).sort((a, b) => a.start - b.start)[0];
      return c ? { status: "found", cand: c } : { status: "none" };
    }

    // words that narrow by time of day or day rather than by name
    const lower = ref.toLowerCase();
    const period = Object.keys(PERIOD_WORDS).find((p) => new RegExp(`\\b${p}\\b`).test(lower));
    const dayOffset = /\btoday\b|\btonight\b/.test(lower) ? 0 : /\btomorrow\b/.test(lower) ? 1 : null;
    const wantsMeeting = /\bmeeting\b/.test(lower);
    const wantsAppointment = /\bappointment\b/.test(lower);
    const want = tokens(lower.replace(/\b(?:morning|afternoon|evening|tonight|night|today|tomorrow|meeting)\b/g, " "));
    const inTime = (c: Cand) => {
      if (Number.isNaN(c.start)) return !period && dayOffset == null;
      const d = DateTime.fromMillis(c.start, { zone });
      if (period && !(d.hour >= PERIOD_WORDS[period][0] && d.hour < PERIOD_WORDS[period][1])) return false;
      if (dayOffset != null && !d.hasSame(DateTime.fromMillis(now, { zone }).plus({ days: dayOffset }), "day")) return false;
      return true;
    };
    const score = (c: Cand) => {
      if (!inTime(c)) return 0;
      const have = new Set(tokens(c.title));
      const isMeeting = MEETING_WORDS.some((w) => have.has(w)) || (c.fixed && wantsMeeting);
      let hits = want.filter((w) => have.has(w)).length;
      let total = want.length;
      if (wantsMeeting) {
        // something actually called a meeting is a better match than a call or an interview
        total += 1;
        if (/\bmeeting\b/i.test(c.title)) hits += 1;
        else if (isMeeting) hits += 0.8;
      }
      if (!total) return wantsAppointment || period || dayOffset != null ? (wantsAppointment && !c.fixed && !isMeeting ? 0.5 : 0.7) : 0;
      return hits / total;
    };
    const scored = [...pending, ...recent, ...cal]
      .map((c) => ({ c, s: score(c) }))
      .filter((x) => x.s >= 0.6)
      .sort((a, b) => b.s - a.s || a.c.rank - b.c.rank || a.c.start - b.c.start);
    if (!scored.length) return { status: "none" };
    const best = scored.filter((x) => x.s === scored[0].s && x.c.rank === scored[0].c.rank);
    // the same entry can be both "recent" and "on the calendar"
    const distinct = best.filter((x, i) => best.findIndex((y) => (y.c.eventId ?? y.c.taskId ?? y.c.tempId) === (x.c.eventId ?? x.c.taskId ?? x.c.tempId)) === i);
    if (distinct.length > 1 && distinct[0].c.rank === 2) return { status: "ambiguous", cands: distinct.map((x) => x.c).slice(0, 4) };
    return { status: "found", cand: distinct[0].c };
  };

  const askWhich = (ref: string, cands: Cand[]) =>
    ask({
      key: `ref:${clean(ref).toLowerCase()}`,
      text: `Which one do you mean by “${clean(ref)}”?`,
      options: cands.map((c) => ({ value: (c.eventId ?? c.taskId ?? c.tempId)!, label: `${c.title} — ${fmt(c.start)}` })),
    });

  // ------------------------------------------------------------ reading one activity
  const parse = (t: string, defaultDay: number | null, z = zone) => parseScheduleRequest(t, { now, defaultZone: z, texasZone: env.texasZone, defaultDay }, answersFor(t));
  const answersFor = (t: string) => {
    const out: Record<string, string> = {};
    for (const id of ["inHours", "meridiem", "nextWeekday"]) {
      const v = answers[`${id}:${t.toLowerCase()}`];
      if (v) out[id] = v;
    }
    return out;
  };
  const hasTimeInfo = (r: ScheduleRequest) => r.dated || r.startAt != null || r.period != null || r.durationMin != null || r.deadline != null;

  /** Take a trailing "before X" / "after X" off an activity when X is something real. */
  const takeRelations = (textIn: string, self?: string): { rest: string; relations: Relation[]; failed: boolean } => {
    let rest = textIn;
    const relations: Relation[] = [];
    for (let guard = 0; guard < 3; guard++) {
      const m = rest.match(/^(.*?)[,]?\s+(?:to\s+)?(right\s+|immediately\s+|just\s+|straight\s+|directly\s+)?(before|after|following)\s+(.+)$/i);
      if (!m) break;
      // "after lunch for 1 hour": the length belongs to the activity, not to the reference
      const cut = m[4].match(/^(.+?)(\s+(?:for\s+(?:about\s+|around\s+)?(?:\d|an?\b|one\b|two\b|three\b|four\b|five\b|half\b)|at\s+\d|on\s+(?:mon|tue|wed|thu|fri|sat|sun)|tomorrow\b|today\b|tonight\b).*)$/i);
      const refText = cut ? cut[1] : m[4];
      const tail = cut ? cut[2] : "";
      m[1] += tail;
      const found = resolveRef(refText, self);
      if (found.status === "ambiguous") {
        askWhich(refText, found.cands);
        return { rest, relations, failed: true };
      }
      if (found.status === "none") {
        if (/^(?:my\s+|the\s+)?lunch(?:\s+break)?$/i.test(clean(refText))) {
          // no lunch on the calendar: the usual lunch hour stands in for it
          const day = DateTime.fromMillis(Math.max(now, 0), { zone });
          const noon = day.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
          const base = noon.plus({ hours: 1 }).toMillis() > now ? noon : noon.plus({ days: 1 });
          relations.push({ kind: m[3].toLowerCase() === "before" ? "before" : "after", immediate: !!m[2], ref: refText, cand: { title: "lunch (12–1 PM)", start: base.toMillis(), end: base.plus({ hours: 1 }).toMillis(), fixed: false, rank: 2 } });
          rest = m[1];
          continue;
        }
        if (TIME_LIKE.test(refText)) break; // "before 5 pm", "after Friday": a time, handled by the reader
        problem(clean(refText), `I couldn't find “${clean(refText)}” on your calendar or in what we have discussed, so I haven't scheduled anything against it.`);
        return { rest, relations, failed: true };
      }
      relations.push({ kind: m[3].toLowerCase() === "before" ? "before" : "after", immediate: !!m[2], ref: refText, cand: found.cand });
      mention(found.cand);
      rest = m[1];
    }
    return { rest: clean(rest), relations, failed: false };
  };

  const newItem = (textIn: string, defaultDay: number | null, relations: Relation[]): Item | null => {
    let req = parse(textIn, defaultDay);
    if (!req.title) {
      problem(textIn, "I couldn't tell what to schedule there. Say what it is, then when.");
      return null;
    }
    if (req.questions.length) {
      const q = req.questions[0];
      ask({ key: `${q.id}:${textIn.toLowerCase()}`, text: `${req.title}: ${q.question}`, options: q.options });
      return null;
    }
    // referring again to a task that already exists and has no time yet: schedule that one, don't duplicate it
    const want = new Set(tokens(req.title));
    const planned = new Set(work.filter((e) => e.taskId && e.endAt > now).map((e) => e.taskId));
    const same = env.tasks.find((t) => {
      if (t.deletedAt || t.archivedAt || t.status === "done" || planned.has(t.id)) return false;
      const have = new Set(tokens(t.title));
      return want.size > 0 && have.size === want.size && [...want].every((w) => have.has(w));
    });
    if (same && req.durationMin == null && same.estimateMin) req = { ...req, durationMin: same.estimateMin };
    const it: Item = { tempId: `new-${++seq}`, text: textIn, req, relations, slot: null, durationMin: req.durationMin ?? 0, existingTaskId: same?.id ?? null };
    items.push(it);
    return it;
  };

  // ------------------------------------------------------------ choosing times
  const dayOf = (ms: number, z: string) => {
    const d = DateTime.fromMillis(ms, { zone: z }).startOf("day");
    return { start: d.toMillis(), end: d.plus({ days: 1 }).toMillis(), label: d.hasSame(DateTime.fromMillis(now, { zone: z }), "day") ? "today" : d.hasSame(DateTime.fromMillis(now, { zone: z }).plus({ days: 1 }), "day") ? "tomorrow" : d.toFormat("cccc d LLL") };
  };

  const anchorSlot = (rel: Relation): Interval | null => {
    if (rel.cand.tempId) {
      const dep = items.find((i) => i.tempId === rel.cand.tempId);
      if (!dep) return null;
      if (!dep.slot) solve(dep);
      return dep.slot;
    }
    return { start: rel.cand.start, end: rel.cand.end };
  };

  /** Apply "before" / "after" to a request; returns the limits for checking afterwards. */
  const constrain = (reqIn: ScheduleRequest, relations: Relation[], dur: number): { req: ScheduleRequest; latestEnd: number; earliest: number; anchorDay: number | null; ok: boolean } => {
    let req = reqIn;
    let latestEnd = Infinity;
    let earliest = 0;
    let anchorDay: number | null = null;
    for (const rel of relations) {
      const a = anchorSlot(rel);
      if (!a) return { req, latestEnd, earliest, anchorDay, ok: false };
      anchorDay = a.start;
      if (rel.kind === "before") {
        latestEnd = Math.min(latestEnd, a.start - bufferMs);
        if (rel.immediate && req.startAt == null) req = { ...req, startAt: a.start - bufferMs - dur, startApprox: true };
      } else {
        earliest = Math.max(earliest, a.end + bufferMs);
        if (rel.immediate && req.startAt == null) req = { ...req, startAt: a.end + bufferMs, startApprox: true };
      }
    }
    if (latestEnd < Infinity) req = { ...req, deadline: Math.min(req.deadline ?? Infinity, latestEnd) };
    if (earliest > 0) req = { ...req, earliest: Math.max(req.earliest ?? 0, earliest) };
    return { req, latestEnd, earliest, anchorDay, ok: true };
  };

  const relationNote = (relations: Relation[]) =>
    relations
      .map((r) => {
        const a = anchorSlot(r);
        return a ? `${r.kind} ${r.cand.title} (${fmt(r.kind === "before" ? a.start : a.end)})` : "";
      })
      .filter(Boolean)
      .join(", ");

  /** Find a time for a request under its relations, on the calendar as planned so far. */
  const place = (key: string, title: string, reqIn: ScheduleRequest, relations: Relation[], calendar: CalendarEvent[]): { slot: Interval; durationMin: number; notes: string[] } | null => {
    const first = resolveRequest(reqIn, calendar, env.slot, now);
    const dur = first.durationMin * MIN;
    const c = constrain(reqIn, relations, dur);
    if (!c.ok) {
      problem(title, "It depends on something that could not be scheduled.");
      return null;
    }
    const fits = (s: Interval) => s.end <= c.latestEnd + 1 && s.start >= c.earliest - 1;
    const forced = Number(answers[`slot:${key}`]);
    if (forced) return { slot: { start: forced, end: forced + dur }, durationMin: first.durationMin, notes: [] };

    const attempts: ScheduleRequest[] = [];
    // with no day of its own, something tied to an appointment belongs on that appointment's day
    if (c.anchorDay != null && !c.req.dated && c.req.startAt == null && !c.req.window) attempts.push({ ...c.req, window: dayOf(c.anchorDay, c.req.zone) });
    attempts.push(c.req);
    let last = first;
    for (const attempt of attempts) {
      const res = resolveRequest(attempt, calendar, env.slot, now);
      last = res;
      if (res.status === "ok" && res.slot && fits(res.slot)) return { slot: res.slot, durationMin: res.durationMin, notes: res.notes };
    }
    // impossible as asked: say why and offer the nearest times
    const rel = relationNote(relations);
    const alts = [...(last.slot && last.status === "ok" ? [last.slot] : []), ...last.alternatives];
    const good = alts.filter(fits);
    const offer = (good.length ? good : alts).slice(0, 3);
    const length = first.durationMin >= 60 && first.durationMin % 60 === 0 ? `${first.durationMin / 60}-hour` : `${first.durationMin}-minute`;
    const why = last.status === "conflict" ? last.message : rel ? `There is no free ${length} slot ${rel}${attempts[0].window ? ` ${attempts[0].window.label}` : ""}.` : last.message;
    if (offer.length) {
      ask({
        key: `slot:${key}`,
        text: `${title}: ${why} ${good.length ? "These times would work:" : rel ? "The nearest free times do not keep that order:" : "The closest free times:"}`,
        options: offer.map((s) => ({ value: String(s.start), label: "", slot: s, zone: reqIn.zone })),
      });
    } else problem(title, `${why} Nothing else is free in the next two weeks.`);
    return null;
  };

  const virtualEvent = (id: string, title: string, slot: Interval, fixed: boolean, tz: string): CalendarEvent => ({
    id, title, notes: "", startAt: slot.start, endAt: slot.end, tz, taskId: null, recurrence: null, important: false, reminders: [], color: null, fixed, sched: null, createdAt: now, updatedAt: now, deletedAt: null,
  });

  const solve = (it: Item) => {
    if (it.slot || it.solving) return;
    it.solving = true;
    const placed = place(it.tempId, it.req.title, it.req, it.relations, work);
    it.solving = false;
    if (!placed) return;
    it.slot = placed.slot;
    it.durationMin = placed.durationMin;
    work = [...work, virtualEvent(it.tempId, it.req.title, placed.slot, it.req.fixed, it.req.zone)];
    const notes = [relationNote(it.relations), ...placed.notes, ...it.req.notes].filter(Boolean);
    if (it.existingTaskId) notes.push("Already in your To-Do list: I gave it a time instead of adding it again.");
    it.line = { kind: "created", title: it.req.title, slot: placed.slot, zone: it.req.zone, fixed: it.req.fixed, note: notes.join(" · ") || undefined, ref: it.tempId };
  };

  /** Move an existing calendar entry under a target time and/or relations. */
  const move = (cand: Cand, target: string | null, relations: Relation[], defaultDay: number | null) => {
    const ev = work.find((e) => e.id === cand.eventId);
    if (!ev) {
      problem(cand.title, cand.taskId ? `“${cand.title}” has no time on the calendar yet, so there is nothing to move. Tell me when to schedule it.` : `I couldn't find “${cand.title}” on the calendar.`);
      return;
    }
    const len = ev.endAt - ev.startAt;
    let req = parse(`${ev.title} ${target ?? ""}`.trim(), defaultDay, ev.tz);
    if (req.questions.length) {
      const q = req.questions[0];
      ask({ key: `${q.id}:${`${ev.title} ${target ?? ""}`.trim().toLowerCase()}`, text: `${ev.title}: ${q.question}`, options: q.options });
      return;
    }
    req = { ...req, title: ev.title, durationMin: req.durationMin ?? Math.round(len / MIN), fixed: ev.fixed };
    // "to tomorrow" with no time: the same time of day
    if (req.dated && req.startAt == null && !req.period && req.window && !relations.length) {
      const orig = DateTime.fromMillis(ev.startAt, { zone: ev.tz });
      req = { ...req, startAt: DateTime.fromMillis(req.window.start, { zone: ev.tz }).set({ hour: orig.hour, minute: orig.minute }).toMillis(), startApprox: true };
    }
    if (!hasTimeInfo({ ...req, durationMin: null }) && !relations.length) {
      problem(ev.title, "Tell me where to move it: a day, a time, or before / after something.");
      return;
    }
    const without = work.filter((e) => e.id !== ev.id);
    const placed = place(ev.id, ev.title, req, relations, without);
    if (!placed) return;
    if (placed.slot.start === ev.startAt && placed.slot.end === ev.endAt) {
      lines.push({ kind: "info", title: ev.title, slot: placed.slot, zone: ev.tz, fixed: ev.fixed, note: "Already there." });
      return;
    }
    work = [...without, { ...ev, startAt: placed.slot.start, endAt: placed.slot.end }];
    actions.push({ type: "move", eventId: ev.id, title: ev.title, to: placed.slot });
    const notes = [relationNote(relations), ev.fixed ? "a fixed appointment, moved because you asked" : ""].filter(Boolean);
    lines.push({ kind: "moved", ref: ev.id, title: ev.title, slot: placed.slot, zone: ev.tz, fixed: ev.fixed, note: notes.join(" · ") || undefined });
  };

  // ------------------------------------------------------------ the message, sentence by sentence
  for (const sentence of sentences(text)) {
    if (question) break;
    let m: RegExpMatchArray | null;

    // "Make the Zoom meeting fixed"
    if ((m = sentence.match(/^(?:please\s+)?(?:make|mark|set|keep|lock)\s+(.+?)\s+(?:as\s+|to\s+)?(fixed|locked|flexible|movable|unlocked|not fixed)$/i))) {
      const found = resolveRef(m[1]);
      if (found.status === "ambiguous") askWhich(m[1], found.cands);
      else if (found.status === "none") problem(clean(m[1]), `I couldn't find “${clean(m[1])}” on your calendar.`);
      else {
        mention(found.cand);
        const fixed = /^(fixed|locked)$/i.test(m[2]);
        const pending = items.find((i) => i.tempId === found.cand.tempId);
        if (pending) {
          pending.req = { ...pending.req, fixed };
          if (pending.line) pending.line.fixed = fixed;
        } else if (found.cand.eventId) {
          if (found.cand.fixed === fixed) lines.push({ kind: "info", title: found.cand.title, slot: { start: found.cand.start, end: found.cand.end }, fixed, note: `Already ${fixed ? "fixed" : "flexible"}.` });
          else {
            work = work.map((e) => (e.id === found.cand.eventId ? { ...e, fixed } : e));
            actions.push({ type: "fixed", eventId: found.cand.eventId, title: found.cand.title, fixed });
            lines.push({ kind: "fixed", title: found.cand.title, slot: { start: found.cand.start, end: found.cand.end }, fixed, note: fixed ? "Fixed: it will not be moved automatically." : "Flexible: it may be re-planned." });
          }
        } else problem(found.cand.title, "It has no time on the calendar yet.");
      }
      continue;
    }

    // "Give me 30 minutes between those two activities"
    if ((m = sentence.match(/^(?:please\s+)?(?:give me|leave|put|add|keep|i (?:need|want))\s+(?:a\s+|at least\s+)?(\d+|an?|half an?)\s*(minutes?|mins?|hours?|hrs?)?\s*(?:gap|break|buffer|pause|free)?\s*between\s+(.+)$/i))) {
      const n = /half/i.test(m[1]) ? 30 : /^an?$/i.test(m[1]) ? (m[2] && /^h/i.test(m[2]) ? 60 : 1) : Number(m[1]) * (m[2] && /^h/i.test(m[2]) ? 60 : 1);
      const gap = n * MIN;
      let pair: Cand[] = [];
      if (/^(?:those|these|the)\s+(?:two|2)(?:\s+\w+)?$|^them$/i.test(clean(m[3]))) {
        const cal = calendarCands();
        const pend = items.map(itemCand);
        pair = (pend.length >= 2 ? pend.slice(-2) : ctx.lastBatch.map((e) => contextCand(e, cal)).filter((c): c is Cand => !!c).slice(-2));
        if (pair.length < 2) pair = ctx.recent.slice(0, 2).map((e) => contextCand(e, cal)).filter((c): c is Cand => !!c);
      } else {
        const names = m[3].split(/\s+and\s+/i);
        for (const name of names.slice(0, 2)) {
          const f = resolveRef(name);
          if (f.status === "found") pair.push(f.cand);
          else if (f.status === "ambiguous") askWhich(name, f.cands);
          else problem(clean(name), `I couldn't find “${clean(name)}” on your calendar.`);
        }
      }
      if (question) continue;
      if (pair.length < 2) {
        if (!lines.some((l) => l.kind === "problem")) problem("Gap", "I'm not sure which two activities you mean. Name them, for example “between the report and my meeting”.");
        continue;
      }
      for (const p of pair) {
        const it = items.find((i) => i.tempId === p.tempId);
        if (it && !it.slot) solve(it);
      }
      const live = pair.map((p) => {
        const it = items.find((i) => i.tempId === p.tempId);
        const ev = work.find((e) => e.id === (p.eventId ?? p.tempId));
        return { p, it, start: it?.slot?.start ?? ev?.startAt ?? p.start, end: it?.slot?.end ?? ev?.endAt ?? p.end, fixed: it ? it.req.fixed : p.fixed };
      });
      live.sort((a, b) => a.start - b.start);
      const [a, b] = live;
      pair.forEach(mention);
      if (b.start - a.end >= gap) {
        lines.push({ kind: "info", title: `${a.p.title} → ${b.p.title}`, note: `There are already ${Math.round((b.start - a.end) / MIN)} minutes between them.` });
        continue;
      }
      // move the later one back if it can move, otherwise the earlier one forward
      const mover = !b.fixed ? b : !a.fixed ? a : null;
      if (!mover) {
        problem(`${a.p.title} → ${b.p.title}`, `Both are fixed appointments, ${Math.max(0, Math.round((b.start - a.end) / MIN))} minutes apart. Move one of them yourself if you need ${n} minutes between them.`);
        continue;
      }
      const other = mover === b ? a : b;
      const rel: Relation = { kind: mover === b ? "after" : "before", immediate: false, ref: other.p.title, cand: { ...other.p, start: other.start - (mover === b ? 0 : gap - bufferMs), end: other.end + (mover === b ? gap - bufferMs : 0) } };
      const len = mover.end - mover.start;
      const wantStart = mover === b ? other.end + gap : other.start - gap - len;
      if (mover.it) {
        work = work.filter((e) => e.id !== mover.it!.tempId);
        mover.it.slot = null;
        mover.it.req = { ...mover.it.req, startAt: wantStart, startApprox: true, durationMin: Math.round(len / MIN), window: null };
        mover.it.relations = [...mover.it.relations.filter((r) => r.cand.tempId !== other.p.tempId && r.cand.eventId !== other.p.eventId), rel];
        solve(mover.it);
        if (mover.it.line) mover.it.line.note = `${n} minutes ${mover === b ? "after" : "before"} ${other.p.title}`;
      } else {
        const ev = work.find((e) => e.id === mover.p.eventId);
        if (!ev) continue;
        const req = { ...parse(ev.title, null, ev.tz), title: ev.title, durationMin: Math.round(len / MIN), startAt: wantStart, startApprox: true, fixed: ev.fixed };
        const without = work.filter((e) => e.id !== ev.id);
        const placed = place(ev.id, ev.title, req, [rel], without);
        if (!placed) continue;
        work = [...without, { ...ev, startAt: placed.slot.start, endAt: placed.slot.end }];
        actions.push({ type: "move", eventId: ev.id, title: ev.title, to: placed.slot });
        lines.push({ kind: "moved", ref: ev.id, title: ev.title, slot: placed.slot, zone: ev.tz, fixed: ev.fixed, note: `${n} minutes ${mover === b ? "after" : "before"} ${other.p.title}` });
      }
      continue;
    }

    // "Reschedule everything except my interview (to tomorrow)"
    if ((m = sentence.match(/^(?:please\s+)?(?:reschedule|move|push|shift|postpone)\s+(?:everything|all(?:\s+(?:my\s+|of\s+)?(?:tasks|them|it|activities))?)(?:\s+(?:else\s+)?(?:except|but(?:\s+not)?|apart from|other than)\s+(.+?))?(?:\s+(?:to|for|until|till)\s+(.+))?$/i))) {
      let keep: Cand | null = null;
      if (m[1]) {
        const f = resolveRef(m[1]);
        if (f.status === "ambiguous") {
          askWhich(m[1], f.cands);
          continue;
        }
        if (f.status === "none") {
          problem(clean(m[1]), `I couldn't find “${clean(m[1])}” on your calendar, so I have not moved anything.`);
          continue;
        }
        keep = f.cand;
        mention(keep);
      }
      const when = m[2] ?? answers["everything:when"];
      if (!when) {
        ask({ key: "everything:when", text: "Move them to when?", options: [{ value: "later today", label: "Later today" }, { value: "tomorrow", label: "Tomorrow" }, { value: "next week", label: "Next week" }] });
        continue;
      }
      const target = parse(`x ${when}`, null);
      const until = target.window && target.window.start > now ? target.window.start : DateTime.fromMillis(now, { zone }).endOf("day").toMillis();
      const movable = work.filter((e) => !e.fixed && !e.recurrence && e.endAt > now && e.startAt < until && e.id !== keep?.eventId && !e.id.startsWith("new-")).sort((a, b) => a.startAt - b.startAt);
      const skipped = work.filter((e) => e.fixed && e.endAt > now && e.startAt < until && e.id !== keep?.eventId);
      if (!movable.length) {
        lines.push({ kind: "info", title: "Nothing to move", note: `There are no flexible tasks ${target.window && target.window.start > now ? `before ${target.window.label}` : "left today"}${skipped.length ? `; ${skipped.length} fixed appointment${skipped.length === 1 ? " stays" : "s stay"} where ${skipped.length === 1 ? "it is" : "they are"}` : ""}.` });
        continue;
      }
      // they all leave their current times, then go back in one by one, in their original order
      let base = work.filter((e) => !movable.includes(e));
      const from = /later today/i.test(when) ? Math.max(now, ...movable.map((e) => e.endAt)) : 0;
      for (const ev of movable) {
        const req = { ...parse(`x ${when}`, null, ev.tz), title: ev.title, durationMin: Math.round((ev.endAt - ev.startAt) / MIN), fixed: false, period: ev.sched?.period ?? target.period, earliest: from || undefined };
        const placed = place(ev.id, ev.title, req, [], base);
        if (!placed) {
          base = [...base, ev];
          continue;
        }
        base = [...base, { ...ev, startAt: placed.slot.start, endAt: placed.slot.end }];
        actions.push({ type: "move", eventId: ev.id, title: ev.title, to: placed.slot });
        lines.push({ kind: "moved", ref: ev.id, title: ev.title, slot: placed.slot, zone: ev.tz, fixed: false });
        mentioned.push({ entity: { kind: "event", id: ev.id, title: ev.title } });
      }
      work = base;
      const stay = [...(keep ? [keep.title] : []), ...skipped.map((e) => e.title)];
      if (stay.length) lines.push({ kind: "info", title: "Left where they are", note: [...new Set(stay)].join(", ") });
      continue;
    }

    // everything else: activities to create, or existing ones to move
    const parts = splitActivities(sentence);
    // a day named once in the sentence applies to the activities that name none
    const shared = parts.map((p) => parse(p.replace(/\s+(?:before|after|following)\s+.+$/i, ""), null)).find((r) => r.dated && r.window)?.window ?? null;
    for (const part of parts) {
      if (question) break;
      const isMove = MOVE_VERB.test(part);
      const isSchedule = !isMove && SCHEDULE_VERB.test(part);
      const body = part.replace(isMove ? MOVE_VERB : isSchedule ? SCHEDULE_VERB : /^$/, "");
      const taken = takeRelations(body);
      if (taken.failed) continue;
      let subject = taken.rest;
      let target: string | null = null;

      if (isMove) {
        // "move X to tomorrow"
        const t = subject.match(/^(.+?)\s+(?:to|for|until|till|into)\s+(.+)$/i);
        if (t) [subject, target] = [t[1], t[2]];
        const f = resolveRef(subject);
        if (f.status === "ambiguous") {
          askWhich(subject, f.cands);
          continue;
        }
        if (f.status === "none") {
          problem(clean(subject), `I couldn't find “${clean(subject)}” on your calendar or in what we have discussed.`);
          continue;
        }
        mention(f.cand);
        const pending = items.find((i) => i.tempId === f.cand.tempId);
        if (pending) {
          // something from this same message: re-read it with the new instruction
          work = work.filter((e) => e.id !== pending.tempId);
          pending.slot = null;
          if (target) pending.req = { ...parse(`${pending.text} ${target}`, null), title: pending.req.title, fixed: pending.req.fixed };
          pending.relations = [...pending.relations, ...taken.relations];
        } else move(f.cand, target, taken.relations, null);
        continue;
      }

      // "schedule it …", "put the report …": something already mentioned, or a new activity
      const probe = parse(subject, null);
      const definite = PRONOUN.test(clean(subject)) || /^(?:the|that|this|my)\s+/i.test(subject) || /^(?:the\s+)?(?:first|second|third|last)\s+/i.test(subject);
      if ((isSchedule || !startsActivity(subject)) && definite && !hasTimeInfo(probe) && (taken.relations.length || isSchedule)) {
        const f = resolveRef(subject);
        if (f.status === "ambiguous") {
          askWhich(subject, f.cands);
          continue;
        }
        if (f.status === "found") {
          mention(f.cand);
          const pending = items.find((i) => i.tempId === f.cand.tempId);
          if (pending) {
            work = work.filter((e) => e.id !== pending.tempId);
            pending.slot = null;
            pending.relations = [...pending.relations, ...taken.relations.filter((r) => r.cand.tempId !== pending.tempId)];
          } else if (taken.relations.length) move(f.cand, null, taken.relations, null);
          else lines.push({ kind: "info", title: f.cand.title, slot: { start: f.cand.start, end: f.cand.end }, fixed: f.cand.fixed, note: "Already on your calendar." });
          continue;
        }
        if (PRONOUN.test(clean(subject))) {
          problem(clean(subject), "I'm not sure what “" + clean(subject) + "” refers to. Name the task.");
          continue;
        }
      }
      newItem(subject, shared && !probe.dated ? shared.start : null, taken.relations);
    }
  }

  // ------------------------------------------------------------ times for the new activities
  if (!question) {
    // set times first: they are what the others have to fit around
    for (const it of [...items].sort((a, b) => Number(b.req.startAt != null && !b.req.startApprox) - Number(a.req.startAt != null && !a.req.startApprox))) {
      if (question) break;
      solve(it);
    }
  }
  if (question) return { actions: [], lines: lines.filter((l) => l.kind === "problem"), question, mentioned: [] };

  for (const it of items) {
    if (!it.slot || !it.line) continue;
    // check the order really holds now that everything has a time
    for (const rel of it.relations) {
      const a = anchorSlot(rel);
      if (a && (rel.kind === "before" ? it.slot.end > a.start : it.slot.start < a.end)) it.line = { ...it.line, kind: "problem", note: `Could not be placed ${rel.kind} ${rel.cand.title}.` };
    }
    if (it.line.kind === "problem") {
      lines.push(it.line);
      continue;
    }
    it.line.note = [relationNote(it.relations), ...(it.line.note ?? "").split(" · ").filter((n) => n && !/^(before|after) /.test(n))].filter(Boolean).join(" · ") || undefined;
    actions.push({ type: "create", tempId: it.tempId, req: it.req, slot: it.slot, durationMin: it.durationMin, existingTaskId: it.existingTaskId });
    lines.push(it.line);
    mentioned.push({ tempId: it.tempId, title: it.req.title });
  }
  // creations first in time order, then the rest as they came
  const created = lines.filter((l) => l.kind === "created").sort((a, b) => (a.slot?.start ?? 0) - (b.slot?.start ?? 0));
  const rest = lines.filter((l) => l.kind !== "created");
  if (!actions.length && !lines.length) lines.push({ kind: "problem", title: "Nothing to do", note: "Tell me what to schedule and when, for example “Gym tomorrow at 6 PM for an hour”." });
  return { actions, lines: [...created, ...rest.filter((l) => l.kind !== "created")], question: null, mentioned };
}

/** The context to carry into the next message. `ids` maps this turn's new activities to their saved entries. */
export function nextContext(ctx: ConvContext, turn: Turn, ids: Record<string, Entity>): ConvContext {
  const batch: Entity[] = [];
  for (const m of turn.mentioned) {
    const e = "entity" in m ? m.entity : ids[m.tempId];
    if (e && !batch.some((x) => x.id === e.id)) batch.push(e);
  }
  if (!batch.length) return ctx;
  const recent = [...[...batch].reverse(), ...ctx.recent.filter((e) => !batch.some((b) => b.id === e.id))].slice(0, 12);
  return { recent, lastBatch: batch };
}

export { generateTitle };
