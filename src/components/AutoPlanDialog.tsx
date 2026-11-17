import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import { Check, TriangleAlert, Wand2 } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import type { PlanResult } from "@/lib/planner";
import { formatTime, KENYA_ZONE } from "@/lib/time";
import { humanDuration } from "@/lib/countdown";
import { Button, Modal, Segmented, cx } from "./ui";

/**
 * Auto-plan: proposes time blocks for open tasks in your free working time.
 * Shows a preview; nothing is created until "Apply".
 */
export function AutoPlanDialog() {
  const open = useUI((s) => s.autoPlan);
  const close = () => useUI.getState().openAutoPlan(false);
  const { settings, tasks, events } = useNexus((s) => ({ settings: s.settings, tasks: s.tasks, events: s.events }));
  const [horizon, setHorizon] = useState<"3" | "7" | "14">("7");
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      setPlan(nexus().autoPlan({ horizonDays: Number(horizon) }));
      setSkip(new Set());
    }
  }, [open, horizon, tasks, events]);

  const byDay = useMemo(() => {
    const m = new Map<string, PlanResult["blocks"]>();
    for (const b of plan?.blocks ?? []) {
      const k = DateTime.fromMillis(b.start, { zone: settings.homeZone }).toFormat("cccc d LLL");
      m.set(k, [...(m.get(k) ?? []), b]);
    }
    return [...m.entries()];
  }, [plan, settings.homeZone]);

  const chosen = (plan?.blocks ?? []).filter((b) => !skip.has(b.taskId));
  const plannedMin = Math.round(chosen.reduce((a, b) => a + b.end - b.start, 0) / 60_000);

  const apply = async () => {
    const created = await nexus().applyPlan(chosen);
    nexus().toast({
      kind: "success",
      title: `Planned ${new Set(chosen.map((b) => b.taskId)).size} tasks`,
      body: `${created.length} time blocks added to your calendar.`,
      action: { label: "Undo", run: () => created.forEach((e) => void nexus().deleteEvent(e.id)) },
      ttl: 8000,
    });
    close();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Auto-plan my work"
      icon={<Wand2 size={18} />}
      width={640}
      footer={
        <>
          <span className="mr-auto text-xs text-muted">{plannedMin ? `${humanDuration(plannedMin * 60_000)} of work into ${humanDuration((plan?.freeMinutes ?? 0) * 60_000)} free` : ""}</span>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" icon={<Check size={15} />} disabled={!chosen.length} onClick={() => void apply()}>
            Apply {chosen.length ? `(${chosen.length} blocks)` : ""}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg-2 flex-1 min-w-[260px]">
            Fits open tasks into your free working time ({settings.workStartHour}:00–{settings.workEndHour}:00), earliest deadline first, around your appointments with a {settings.planBufferMin}-min buffer. Tasks that already have a time block are skipped.
          </p>
          <Segmented size="sm" value={horizon} onChange={setHorizon} options={[{ value: "3", label: "3 days" }, { value: "7", label: "1 week" }, { value: "14", label: "2 weeks" }]} />
        </div>
        {!plan?.blocks.length && !plan?.unplaced.length && <p className="text-sm text-muted">Nothing to plan. All open tasks already have time reserved.</p>}
        {byDay.map(([day, blocks]) => (
          <div key={day}>
            <p className="text-[11px] uppercase tracking-wider text-muted mb-1.5">{day}</p>
            <div className="flex flex-col gap-1">
              {blocks.map((b) => (
                <label key={b.taskId + b.start} className={cx("flex items-center gap-3 rounded-xl border px-3 py-2 cursor-pointer transition", skip.has(b.taskId) ? "border-line opacity-50" : "border-line hover:border-accent")}>
                  <input type="checkbox" className="accent-sky-500 h-4 w-4" checked={!skip.has(b.taskId)} onChange={() => setSkip((s) => { const n = new Set(s); if (n.has(b.taskId)) n.delete(b.taskId); else n.add(b.taskId); return n; })} />
                  <span className="tabular text-sm text-fg-2 w-36 shrink-0">{formatTime(b.start, settings.homeZone, settings.hour12)}–{formatTime(b.end, settings.homeZone, settings.hour12)}</span>
                  <span className="flex-1 min-w-0 truncate text-sm">{b.title}{b.parts > 1 && <span className="text-muted"> ({b.part}/{b.parts})</span>}</span>
                  {b.late && <span className="text-[11px] text-warning inline-flex items-center gap-1 shrink-0"><TriangleAlert size={12} /> after deadline</span>}
                  <span className="text-[10px] text-muted shrink-0 hidden sm:inline">KE {formatTime(b.start, KENYA_ZONE, settings.hour12)} · TX {formatTime(b.start, settings.texasZone, settings.hour12)}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        {!!plan?.unplaced.length && (
          <div className="rounded-xl border border-[color-mix(in_oklab,var(--warning)_40%,transparent)] bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] px-3 py-2 text-xs text-warning">
            <p className="font-semibold mb-1">Didn't fit:</p>
            {plan.unplaced.map((u) => <p key={u.taskId}>{u.title}: {humanDuration(u.minutesLeft * 60_000)} still unscheduled. {u.reason}.</p>)}
          </div>
        )}
      </div>
    </Modal>
  );
}
