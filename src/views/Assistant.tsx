import { useState } from "react";
import { workHours } from "@/lib/workPlan";
import { Brain, CalendarClock, ListChecks, Loader2, Shuffle, Sparkles, Target, TriangleAlert, Wand2 } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { aiContext, breakdownLocally, describeConflicts, openTasks, proposeReorganization, suggestEstimate, suggestNext, summarizeDay } from "@/lib/assistant";
import { findFreeSlots } from "@/lib/schedule";
import { formatTime, formatWithZone, KENYA_ZONE, zoneAbbr } from "@/lib/time";
import { aiRequest } from "@/lib/platform";
import { CommandPanel } from "@/components/CommandBar";
import { Button, Card, CardHeader, Select, Textarea } from "@/components/ui";

interface Answer {
  title: string;
  source: "local" | "claude";
  lines: string[];
  actions?: { label: string; run: () => void }[];
}

export default function Assistant() {
  const { tasks, events, focus, settings } = useNexus((s) => ({ tasks: s.tasks, events: s.events, focus: s.focusSessions, settings: s.settings }));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [ask, setAsk] = useState("");
  const zone = settings.homeZone;
  const wh = workHours(settings);
  const aiOn = settings.aiEnabled && settings.aiConsent;
  const open = openTasks(tasks);
  const s = nexus();

  const withAI = async (title: string, prompt: string, local: () => Answer) => {
    const base = local();
    if (!aiOn) return setAnswer(base);
    setBusy(true);
    try {
      const r = await aiRequest<{ text: string }>("plan", prompt, aiContext(tasks, events, Date.now(), zone, settings.texasZone, wh));
      setAnswer({ title, source: "claude", lines: r.text.split("\n").filter(Boolean), actions: base.actions });
    } catch (e) {
      setAnswer({ ...base, lines: [...base.lines, "", `(Claude unavailable: ${e instanceof Error ? e.message : e} — showing the offline answer.)`] });
    } finally {
      setBusy(false);
    }
  };

  const actions = [
    {
      icon: <CalendarClock size={18} />,
      title: "Summarize my day",
      run: () =>
        withAI("Today's agenda", "Summarize my day: what's scheduled, what's due, and what to prioritise.", () => ({
          title: "Today's agenda",
          source: "local",
          lines: summarizeDay({ tasks, events, focus, now: Date.now(), zone, zones: [KENYA_ZONE, settings.texasZone], hour12: settings.hour12, wh }).split("\n"),
        })),
    },
    {
      icon: <Target size={18} />,
      title: "What should I work on next?",
      run: () =>
        withAI("Next best task", "Which task should I work on next and why? Consider deadlines, priority and my next appointment.", () => {
          const n = suggestNext(tasks, Date.now());
          return {
            title: "Next best task",
            source: "local",
            lines: n ? [`“${n.task.title}”`, n.reason] : ["No open tasks."],
            actions: n ? [{ label: "Make it active", run: () => void s.setActiveTask(n.task.id) }, { label: "Start focus", run: () => void s.startTimer({ kind: "pomodoro", taskId: n.task.id }) }] : [],
          };
        }),
    },
    {
      icon: <Sparkles size={18} />,
      title: "Recommend free time slots",
      run: () => {
        const slots = findFreeSlots(events, 60 * 60_000, Date.now(), wh, { maxSlots: 6 });
        setAnswer({
          title: "Free 1-hour slots",
          source: "local",
          lines: slots.length
            ? slots.map((sl) => `${formatWithZone(sl.start, zone, settings.hour12)} · KE ${formatTime(sl.start, KENYA_ZONE, settings.hour12)} · TX ${formatTime(sl.start, settings.texasZone, settings.hour12)} ${zoneAbbr(settings.texasZone, sl.start)}`)
            : ["No free hour in your working hours over the next two weeks."],
          actions: slots.slice(0, 1).map((sl) => ({ label: "Book the first slot", run: () => useUI.getState().openEvent(null, { startAt: sl.start, endAt: sl.end }) })),
        });
      },
    },
    {
      icon: <TriangleAlert size={18} />,
      title: "Find schedule conflicts",
      run: () => {
        const c = describeConflicts(events, Date.now(), zone, settings.hour12);
        setAnswer({ title: "Conflicts (next 14 days)", source: "local", lines: c.length ? c : ["No overlapping appointments. 👍"] });
      },
    },
    {
      icon: <Shuffle size={18} />,
      title: "Reorganize unfinished work",
      run: () => {
        const props = proposeReorganization(tasks, events, Date.now(), wh);
        setAnswer({
          title: "Proposed plan for overdue work",
          source: "local",
          lines: props.length ? props.map((p) => `${p.task.title} → ${p.slot ? formatWithZone(p.slot.start, zone, settings.hour12) : "no free slot found"}`) : ["Nothing overdue — you're on track."],
          actions: props.some((p) => p.slot)
            ? [
                {
                  label: "Apply this plan",
                  run: async () => {
                    for (const p of props) {
                      if (!p.slot) continue;
                      await s.updateTask(p.task.id, { dueAt: p.slot.end, dueTz: zone });
                      await s.addEvent({ title: p.task.title, startAt: p.slot.start, endAt: p.slot.end, taskId: p.task.id, tz: zone, reminders: [5] });
                    }
                    s.toast({ kind: "success", title: "Plan applied", body: `${props.filter((p) => p.slot).length} tasks rescheduled with time blocks.` });
                  },
                },
              ]
            : [],
        });
      },
    },
  ];

  const breakdown = async () => {
    const t = tasks.find((x) => x.id === projectId);
    if (!t) return;
    let items = breakdownLocally(t.title);
    let source: Answer["source"] = "local";
    if (aiOn) {
      setBusy(true);
      try {
        const r = await aiRequest<{ subtasks: { title: string; estimateMin: number }[] }>("breakdown", `Break down: ${t.title}`, { task: { title: t.title, notes: t.notes, estimateMin: t.estimateMin } });
        if (r.subtasks?.length) {
          items = r.subtasks;
          source = "claude";
        }
      } catch {
        /* fall back to local */
      } finally {
        setBusy(false);
      }
    }
    setAnswer({
      title: `Breakdown: ${t.title}`,
      source,
      lines: items.map((i) => `• ${i.title} — ${i.estimateMin} min`),
      actions: [
        {
          label: "Add as subtasks",
          run: () =>
            void s.updateTask(t.id, {
              subtasks: [...t.subtasks, ...items.map((i) => ({ id: crypto.randomUUID(), title: `${i.title} (${i.estimateMin}m)`, done: false }))],
              estimateMin: t.estimateMin ?? items.reduce((a, i) => a + i.estimateMin, 0),
            }),
        },
      ],
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-2xl font-semibold flex items-center gap-2">
          Assistant <span className="text-xs font-medium px-2 py-0.5 rounded-full glass">{aiOn ? "Claude connected" : "Offline mode"}</span>
        </h1>
        <p className="text-sm text-muted">Everything here works offline. Enable Claude in Settings → AI for richer answers — your API key stays in Windows Credential Manager, never in the UI.</p>
      </div>

      <Card className="p-5">
        <CommandPanel autoFocus={false} />
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {actions.map((a) => (
          <button key={a.title} onClick={() => void a.run()} disabled={busy} className="glass rounded-2xl p-4 text-left hover:border-accent hover:-translate-y-0.5 transition flex flex-col gap-2 disabled:opacity-60">
            <span className="text-accent">{a.icon}</span>
            <span className="text-sm font-medium">{a.title}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Break a project into subtasks" icon={<ListChecks size={16} />} />
          <div className="px-5 pb-5 flex gap-2">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Choose a task…</option>
              {open.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </Select>
            <Button variant="primary" disabled={!projectId || busy} onClick={() => void breakdown()} icon={<Wand2 size={14} />}>Break down</Button>
          </div>
          {projectId && (
            <p className="px-5 pb-4 -mt-2 text-xs text-muted">
              Suggested realistic time: ~{suggestEstimate(tasks.find((t) => t.id === projectId)!, tasks)} min (based on similar completed tasks).
            </p>
          )}
        </Card>
        <Card>
          <CardHeader title="Ask anything about your schedule" icon={<Brain size={16} />} subtitle={aiOn ? "Answered by Claude using your task & calendar titles" : "Requires AI to be enabled in Settings"} />
          <form className="px-5 pb-5 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (ask.trim()) void withAI("Answer", ask, () => ({ title: "Answer", source: "local", lines: ["Enable the AI assistant in Settings → AI to ask free-form questions. The quick actions above work offline."] })); }}>
            <Textarea rows={2} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. Can I fit a 2-hour workshop with the Texas team this week?" />
            <Button type="submit" variant="soft" disabled={!ask.trim() || busy} className="self-end">Ask</Button>
          </form>
        </Card>
      </div>

      {(answer || busy) && (
        <Card glow>
          <CardHeader title={busy ? "Thinking…" : answer!.title} icon={busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} right={answer && !busy && <span className="text-[11px] text-muted">{answer.source === "claude" ? "via Claude" : "offline assistant"}</span>} />
          {answer && !busy && (
            <div className="px-5 pb-5">
              <div className="text-sm text-fg-2 leading-relaxed whitespace-pre-wrap select-text">{answer.lines.join("\n")}</div>
              {answer.actions && answer.actions.length > 0 && (
                <div className="flex gap-2 mt-4">
                  {answer.actions.map((a) => <Button key={a.label} size="sm" variant="primary" onClick={a.run}>{a.label}</Button>)}
                </div>
              )}
              <p className="text-[11px] text-muted mt-3">Suggestions are never applied automatically.</p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
