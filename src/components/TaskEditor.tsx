import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, Check, GripVertical, ListChecks, Loader2, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { PRIORITIES, type Priority, type Subtask, type Task } from "@/data/types";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { breakdownLocally, suggestEstimate } from "@/lib/assistant";
import { findFreeSlots } from "@/lib/schedule";
import { aiRequest } from "@/lib/platform";
import { formatWithZone } from "@/lib/time";
import { Button, Field, Input, Modal, Select, Textarea, cx } from "./ui";
import { PRIORITY_META } from "./meta";
import { ZonedDateTime } from "./ZonedDateTime";
import { RecurrencePicker } from "./RecurrencePicker";
import { ReminderPicker } from "./ReminderPicker";

type Draft = Omit<Task, "id" | "createdAt" | "updatedAt" | "spentMs" | "sortOrder" | "completedAt" | "archivedAt" | "deletedAt" | "status">;

export function TaskEditor() {
  const { open, taskId, defaults } = useUI((s) => s.taskEditor);
  const close = useUI((s) => s.closeTask);
  const { tasks, categories, settings } = useNexus((s) => ({ tasks: s.tasks, categories: s.categories, settings: s.settings }));
  const existing = taskId ? tasks.find((t) => t.id === taskId) : undefined;

  const blank = (): Draft => ({
    title: "",
    notes: "",
    priority: "medium",
    categoryId: defaults?.categoryId ?? "work",
    dueAt: defaults?.dueAt ?? null,
    dueTz: settings.homeZone,
    estimateMin: null,
    recurrence: null,
    reminders: [...settings.defaultReminders],
    subtasks: [],
  });

  const [d, setD] = useState<Draft>(blank);
  const [newSub, setNewSub] = useState("");
  const [busy, setBusy] = useState(false);
  const [newCat, setNewCat] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setD(existing ? { ...existing } : blank());
    setNewSub("");
    setNewCat(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const valid = d.title.trim().length > 0;
  const estimateHint = useMemo(() => suggestEstimate({ title: d.title, categoryId: d.categoryId, priority: d.priority }, tasks), [d.title, d.categoryId, d.priority, tasks]);

  const save = async () => {
    if (!valid) return;
    const s = nexus();
    let catId = d.categoryId;
    if (newCat && newCat.trim()) {
      catId = `c-${crypto.randomUUID().slice(0, 8)}`;
      await s.saveCategory({ id: catId, name: newCat.trim(), color: "#34d399", icon: "tag", builtin: false, sortOrder: categories.length });
    }
    const payload = { ...d, categoryId: catId, title: d.title.trim(), reminders: d.dueAt == null ? [] : d.reminders };
    if (existing) await s.updateTask(existing.id, payload);
    else await s.addTask(payload);
    close();
  };

  const addSub = () => {
    const t = newSub.trim();
    if (!t) return;
    set("subtasks", [...d.subtasks, { id: crypto.randomUUID(), title: t, done: false }]);
    setNewSub("");
  };

  const breakdown = async () => {
    if (!d.title.trim()) return;
    setBusy(true);
    const s = nexus();
    let items = breakdownLocally(d.title);
    let source = "Local templates";
    if (s.settings.aiEnabled && s.settings.aiConsent) {
      try {
        const ctx = { task: { title: d.title, notes: d.notes, estimateMin: d.estimateMin, due: d.dueAt ? formatWithZone(d.dueAt, d.dueTz ?? settings.homeZone, false) : null } };
        const r = await aiRequest<{ subtasks: { title: string; estimateMin: number }[] }>("breakdown", `Break down: ${d.title}`, ctx);
        if (r.subtasks?.length) {
          items = r.subtasks;
          source = "Claude";
        }
      } catch (e) {
        s.toast({ kind: "warning", title: "AI unavailable — used local templates", body: e instanceof Error ? e.message : String(e) });
      }
    }
    const subs: Subtask[] = items.map((i) => ({ id: crypto.randomUUID(), title: `${i.title} (${i.estimateMin}m)`, done: false }));
    setD((x) => ({ ...x, subtasks: [...x.subtasks, ...subs], estimateMin: x.estimateMin ?? items.reduce((a, i) => a + i.estimateMin, 0) }));
    s.toast({ kind: "success", title: `Added ${subs.length} subtasks`, body: `Source: ${source}`, ttl: 3000 });
    setBusy(false);
  };

  const scheduleBlock = async () => {
    if (!existing) return;
    const s = nexus();
    const dur = (d.estimateMin ?? 60) * 60_000;
    const [slot] = findFreeSlots(s.events, dur, Date.now(), { zone: settings.homeZone, startHour: settings.workStartHour, endHour: settings.workEndHour, days: settings.workDays }, { maxSlots: 1 });
    close();
    useUI.getState().openEvent(null, { startAt: slot?.start ?? Date.now(), endAt: (slot?.start ?? Date.now()) + dur, taskId: existing.id, title: d.title });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={existing ? "Edit task" : "New task"}
      width={640}
      icon={<ListChecks size={18} />}
      footer={
        <>
          {existing && (
            <Button variant="ghost" className="mr-auto" icon={<CalendarPlus size={15} />} onClick={scheduleBlock} title="Reserve a calendar time block for this task">
              Schedule time block
            </Button>
          )}
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!valid} icon={<Check size={15} />}>
            {existing ? "Save" : "Add task"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          autoFocus
          placeholder="What needs to get done?"
          value={d.title}
          onChange={(e) => set("title", e.target.value)}
          className="!h-11 !text-base font-medium"
          aria-label="Task title"
        />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <div className="grid grid-cols-4 gap-1">
              {PRIORITIES.map((p: Priority) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={d.priority === p}
                  onClick={() => set("priority", p)}
                  className={cx("h-9 rounded-lg text-xs font-semibold border transition", d.priority === p ? "border-transparent" : "border-line text-muted hover:text-fg")}
                  style={d.priority === p ? { color: PRIORITY_META[p].color, background: `color-mix(in oklab, ${PRIORITY_META[p].color} 18%, transparent)` } : undefined}
                >
                  {PRIORITY_META[p].label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Category">
            {newCat == null ? (
              <Select value={d.categoryId} onChange={(e) => (e.target.value === "__new" ? setNewCat("") : set("categoryId", e.target.value))}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value="__new">+ New category…</option>
              </Select>
            ) : (
              <div className="flex gap-1">
                <Input autoFocus placeholder="Category name" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
                <Button type="button" variant="ghost" size="sm" onClick={() => setNewCat(null)}><X size={14} /></Button>
              </div>
            )}
          </Field>
        </div>

        <Field label="Deadline">
          <ZonedDateTime
            value={d.dueAt}
            zone={d.dueTz ?? settings.homeZone}
            onChange={(ms, z) => setD((x) => ({ ...x, dueAt: ms, dueTz: z }))}
            homeZone={settings.homeZone}
            texasZone={settings.texasZone}
            hour12={settings.hour12}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Estimated duration (minutes)" hint={!d.estimateMin && d.title ? <button type="button" className="text-accent" onClick={() => set("estimateMin", estimateHint)}>Suggest: {estimateHint} min</button> : undefined}>
            <Input type="number" min={0} step={5} placeholder="e.g. 45" value={d.estimateMin ?? ""} onChange={(e) => set("estimateMin", e.target.value ? Math.max(0, Number(e.target.value)) : null)} />
          </Field>
          <Field label="Repeat">
            <RecurrencePicker value={d.recurrence} onChange={(r) => set("recurrence", r)} />
          </Field>
        </div>

        <Field label="Reminders" hint={d.dueAt == null ? "Set a deadline to enable reminders." : "Windows notifications fire even when NEXUS is minimized to the tray."}>
          <ReminderPicker value={d.reminders} onChange={(v) => set("reminders", v)} disabled={d.dueAt == null} />
        </Field>

        <Field label="Subtasks & checklist">
          <div className="flex flex-col gap-1">
            {d.subtasks.map((s, i) => (
              <div key={s.id} className="group flex items-center gap-2 rounded-lg px-1 hover:bg-hover">
                <GripVertical size={13} className="text-muted opacity-40" />
                <input type="checkbox" checked={s.done} onChange={() => set("subtasks", d.subtasks.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))} className="accent-sky-500 h-4 w-4" aria-label={`Done: ${s.title}`} />
                <input
                  value={s.title}
                  onChange={(e) => set("subtasks", d.subtasks.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  className={cx("flex-1 bg-transparent outline-none text-sm py-1.5", s.done && "line-through text-muted")}
                />
                <button type="button" aria-label="Remove subtask" className="opacity-0 group-hover:opacity-100 text-muted hover:text-danger" onClick={() => set("subtasks", d.subtasks.filter((_, j) => j !== i))}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="flex gap-2 mt-1">
              <Input
                placeholder="Add a subtask and press Enter"
                value={newSub}
                onChange={(e) => setNewSub(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSub();
                  }
                }}
              />
              <Button type="button" variant="soft" onClick={addSub} icon={<Plus size={14} />}>Add</Button>
              <Button type="button" variant="outline" onClick={breakdown} disabled={!d.title.trim() || busy} title="Break this into subtasks" icon={busy ? <Loader2 size={14} className="animate-spin" /> : settings.aiEnabled ? <Sparkles size={14} /> : <Wand2 size={14} />}>
                Break down
              </Button>
            </div>
          </div>
        </Field>

        <Field label="Notes">
          <Textarea rows={3} placeholder="Details, links, context…" value={d.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
