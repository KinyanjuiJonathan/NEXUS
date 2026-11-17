import { DateTime } from "luxon";
import type { NexusState } from "@/store/store";
import type { Intent } from "./parser";
import { matchScore } from "./parser";
import { expandEvents, findConflicts } from "@/lib/schedule";
import { agendaForDay, suggestNext, summarizeDay, openTasks } from "@/lib/assistant";
import { formatTime, formatWithZone, KENYA_ZONE, zoneAbbr } from "@/lib/time";
import { formatClock, remainingMs, elapsedMs, humanDuration } from "@/lib/countdown";

export interface ExecDeps {
  state: () => NexusState;
  now: () => number;
  setOverlay?: (visible: boolean) => Promise<void>;
}

export interface ExecResult {
  ok: boolean;
  message: string;
  /** Optional list to show (query results). */
  lines?: string[];
}

type Target = { kind: "task" | "event"; id: string; title: string; score: number };

/** Find the best matching task or upcoming event for a spoken reference. */
export function findTarget(s: NexusState, query: string, now: number): Target | null {
  const candidates: Target[] = [];
  for (const t of openTasks(s.tasks)) candidates.push({ kind: "task", id: t.id, title: t.title, score: matchScore(query, t.title) });
  const seen = new Set<string>();
  for (const o of expandEvents(s.events, now - 3600_000, now + 60 * 86_400_000)) {
    if (seen.has(o.event.id)) continue;
    seen.add(o.event.id);
    // Slight preference for events when the query says meeting/appointment/call.
    const bonus = /\b(meeting|appointment|call|event|session)\b/i.test(query) ? 0.1 : 0;
    candidates.push({ kind: "event", id: o.event.id, title: o.event.title, score: matchScore(query, o.event.title) + bonus });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] && candidates[0].score >= 0.4 ? candidates[0] : null;
}

/** Human description of what an intent would do (for the confirmation card). */
export function describeIntent(intent: Intent, s: NexusState, now: number): string {
  const h12 = s.settings.hour12;
  const both = (ms: number) =>
    `${formatWithZone(ms, KENYA_ZONE, h12)} · ${formatTime(ms, s.settings.texasZone, h12)} ${zoneAbbr(s.settings.texasZone, ms)}`;
  switch (intent.type) {
    case "add_task":
      return `Add task “${intent.title}”${intent.dueAt ? ` due ${both(intent.dueAt)}` : ""}${intent.reminderAtTime ? " with a reminder" : ""}`;
    case "add_event":
      return `Schedule “${intent.title}” ${both(intent.startAt)} for ${humanDuration(intent.endAt - intent.startAt)}`;
    case "reschedule": {
      const t = findTarget(s, intent.query, now);
      return t ? `Move “${t.title}” to ${both(intent.newStart)}${intent.dateOnly ? " (keeping its time)" : ""}` : `No task or appointment matches “${intent.query}”`;
    }
    case "complete_current": {
      const t = s.tasks.find((x) => x.id === s.settings.activeTaskId);
      return t ? `Mark “${t.title}” complete` : "There's no active task to complete";
    }
    case "complete_task": {
      const t = findTarget(s, intent.query, now);
      return t?.kind === "task" ? `Mark “${t.title}” complete` : `No open task matches “${intent.query}”`;
    }
    case "delete_task": {
      const t = findTarget(s, intent.query, now);
      return t ? `Delete ${t.kind} “${t.title}” (restorable)` : `Nothing matches “${intent.query}”`;
    }
    case "start_focus":
      return intent.mode === "stopwatch" ? "Start a stopwatch" : `Start a ${intent.minutes ?? s.settings.pomodoroFocusMin}-minute ${intent.mode === "pomodoro" ? "focus session" : "countdown"}`;
    default:
      return intent.type.replace(/_/g, " ");
  }
}

export async function executeIntent(intent: Intent, deps: ExecDeps): Promise<ExecResult> {
  const s = deps.state();
  const now = deps.now();
  const h12 = s.settings.hour12;
  const zone = s.settings.homeZone;

  switch (intent.type) {
    case "add_task": {
      const t = await s.addTask({
        title: intent.title,
        dueAt: intent.dueAt,
        dueTz: intent.tz,
        estimateMin: intent.estimateMin,
        priority: intent.priority ?? undefined,
        categoryId: intent.categoryId ?? undefined,
        reminders: intent.dueAt == null ? [] : intent.reminderAtTime ? [0] : undefined,
      });
      return {
        ok: true,
        message: t.dueAt ? `Added “${t.title}” — due ${formatWithZone(t.dueAt, t.dueTz ?? zone, h12)}` : `Added “${t.title}”`,
      };
    }
    case "add_event": {
      const conflicts = findConflicts(s.events, { start: intent.startAt, end: intent.endAt });
      const e = await s.addEvent({ title: intent.title, startAt: intent.startAt, endAt: intent.endAt, tz: intent.tz });
      return {
        ok: true,
        message: `Scheduled “${e.title}” for ${formatWithZone(e.startAt, e.tz, h12)}` + (conflicts.length ? ` ⚠ overlaps “${conflicts[0].event.title}”` : ""),
      };
    }
    case "reschedule": {
      const target = findTarget(s, intent.query, now);
      if (!target) return { ok: false, message: `I couldn't find anything matching “${intent.query}”.` };
      if (target.kind === "event") {
        const ev = s.events.find((e) => e.id === target.id)!;
        let start = intent.newStart;
        if (intent.dateOnly) {
          const orig = DateTime.fromMillis(ev.startAt, { zone: ev.tz });
          start = DateTime.fromMillis(intent.newStart, { zone: ev.tz }).set({ hour: orig.hour, minute: orig.minute }).toMillis();
        }
        const dur = ev.endAt - ev.startAt;
        const conflicts = findConflicts(s.events, { start, end: start + dur }, ev.id);
        await s.updateEvent(ev.id, { startAt: start, endAt: start + dur, recurrence: ev.recurrence });
        return {
          ok: true,
          message: `Moved “${ev.title}” to ${formatWithZone(start, ev.tz, h12)}` + (conflicts.length ? ` ⚠ overlaps “${conflicts[0].event.title}”` : ""),
        };
      }
      const t = s.tasks.find((x) => x.id === target.id)!;
      let due = intent.newStart;
      if (intent.dateOnly && t.dueAt != null) {
        const tz = t.dueTz ?? zone;
        const orig = DateTime.fromMillis(t.dueAt, { zone: tz });
        due = DateTime.fromMillis(intent.newStart, { zone: tz }).set({ hour: orig.hour, minute: orig.minute }).toMillis();
      }
      await s.updateTask(t.id, { dueAt: due, dueTz: intent.dateOnly ? t.dueTz : intent.tz });
      return { ok: true, message: `Moved “${t.title}” to ${formatWithZone(due, intent.dateOnly ? t.dueTz ?? zone : intent.tz, h12)}` };
    }
    case "query_today": {
      const items = agendaForDay(s.tasks, s.events, now, zone);
      const active = openTasks(s.tasks).filter((t) => t.status === "in_progress" && !items.some((i) => i.title === t.title));
      const lines = [
        ...items.map((i) => `${i.at != null ? formatTime(i.at, zone, h12) : ""} ${i.kind === "event" ? "📅" : "☐"} ${i.title}`.trim()),
        ...active.map((t) => `▶ ${t.title} (in progress)`),
      ];
      return { ok: true, message: lines.length ? `You have ${lines.length} item${lines.length > 1 ? "s" : ""} today.` : "Nothing scheduled today — a clear runway.", lines };
    }
    case "query_upcoming": {
      const occ = expandEvents(s.events, now, now + 7 * 86_400_000).slice(0, 8);
      const lines = occ.map((o) => `${formatWithZone(o.start, zone, h12)} — ${o.event.title}`);
      return { ok: true, message: occ.length ? `Your next ${occ.length} appointment${occ.length > 1 ? "s" : ""}:` : "No appointments in the next 7 days.", lines };
    }
    case "query_overdue": {
      const od = openTasks(s.tasks).filter((t) => t.dueAt != null && t.dueAt < now);
      return {
        ok: true,
        message: od.length ? `${od.length} overdue task${od.length > 1 ? "s" : ""}.` : "Nothing overdue. 🎉",
        lines: od.map((t) => `${t.title} — overdue by ${humanDuration(now - t.dueAt!)}`),
      };
    }
    case "start_focus": {
      const minutes = intent.mode === "stopwatch" ? undefined : intent.minutes ?? undefined;
      const t = await s.startTimer({ kind: intent.mode, minutes, taskId: s.settings.activeTaskId });
      return { ok: true, message: intent.mode === "stopwatch" ? "Stopwatch started." : `${Math.round(t.durationMs / 60_000)}-minute ${intent.mode === "pomodoro" ? "focus session" : "countdown"} started.` };
    }
    case "pause_timer": {
      const t = s.timers.find((x) => x.state === "running");
      if (!t) return { ok: false, message: "No timer is running." };
      await s.pauseTimer(t.id);
      return { ok: true, message: `Paused “${t.label}”.` };
    }
    case "resume_timer": {
      const t = s.timers.find((x) => x.state === "paused" || (x.state === "idle" && x.kind === "pomodoro"));
      if (!t) return { ok: false, message: "No paused timer to resume." };
      await s.resumeTimer(t.id);
      return { ok: true, message: `Resumed “${t.label}”.` };
    }
    case "stop_timer": {
      const t = s.activeTimer();
      if (!t) return { ok: false, message: "No timer to stop." };
      await s.stopTimer(t.id);
      return { ok: true, message: `Stopped “${t.label}”.` };
    }
    case "time_left": {
      const t = s.activeTimer();
      const lines: string[] = [];
      if (t) {
        lines.push(t.kind === "stopwatch" ? `${t.label}: ${formatClock(elapsedMs(t, now))} elapsed` : `${t.label}: ${formatClock(remainingMs(t, now))} remaining${t.state === "paused" ? " (paused)" : ""}`);
      }
      const active = s.tasks.find((x) => x.id === s.settings.activeTaskId);
      if (active?.dueAt) lines.push(`“${active.title}” is ${active.dueAt > now ? `due in ${humanDuration(active.dueAt - now)}` : `overdue by ${humanDuration(now - active.dueAt)}`}`);
      const next = expandEvents(s.events, now, now + 7 * 86_400_000)[0];
      if (next) lines.push(`Next: “${next.event.title}” starts in ${humanDuration(next.start - now)}`);
      return { ok: true, message: lines[0] ?? "No active timer, task deadline or upcoming appointment.", lines: lines.slice(1) };
    }
    case "complete_current": {
      const id = s.settings.activeTaskId;
      const t = s.tasks.find((x) => x.id === id && x.status !== "done");
      if (!t) return { ok: false, message: "There's no active task. Pick one with ▶ first." };
      await s.setTaskDone(t.id, true);
      return { ok: true, message: `Completed “${t.title}”. Nice work!` };
    }
    case "complete_task": {
      const target = findTarget(s, intent.query, now);
      if (!target || target.kind !== "task") return { ok: false, message: `No open task matches “${intent.query}”.` };
      await s.setTaskDone(target.id, true);
      return { ok: true, message: `Completed “${target.title}”.` };
    }
    case "delete_task": {
      const target = findTarget(s, intent.query, now);
      if (!target) return { ok: false, message: `Nothing matches “${intent.query}”.` };
      if (target.kind === "task") await s.deleteTask(target.id);
      else await s.deleteEvent(target.id);
      return { ok: true, message: `Deleted “${target.title}”. You can undo or restore it from Trash.` };
    }
    case "overlay":
      if (deps.setOverlay) await deps.setOverlay(intent.show);
      return { ok: !!deps.setOverlay, message: deps.setOverlay ? (intent.show ? "Overlay shown." : "Overlay hidden.") : "The overlay is available in the desktop app." };
    case "what_next": {
      const n = suggestNext(s.tasks, now);
      return n ? { ok: true, message: `Work on “${n.task.title}”. ${n.reason}` } : { ok: true, message: "No open tasks — add one or take a break!" };
    }
    case "summarize": {
      const text = summarizeDay({
        tasks: s.tasks,
        events: s.events,
        focus: s.focusSessions,
        now,
        zone,
        zones: [KENYA_ZONE, s.settings.texasZone],
        hour12: h12,
        wh: { zone, startHour: s.settings.workStartHour, endHour: s.settings.workEndHour, days: s.settings.workDays },
      });
      const [first, ...rest] = text.split("\n");
      return { ok: true, message: first, lines: rest };
    }
    case "unknown":
      return { ok: false, message: "I didn't understand that. Try “Add a task to … tomorrow at 9 AM”." };
  }
}
