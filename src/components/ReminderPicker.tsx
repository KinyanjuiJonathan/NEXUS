import { useState } from "react";
import { Plus, X } from "lucide-react";
import { REMINDER_PRESETS, offsetLabel } from "@/lib/reminders";
import { Input, cx } from "./ui";

export function ReminderPicker({ value, onChange, disabled }: { value: number[]; onChange: (v: number[]) => void; disabled?: boolean }) {
  const [custom, setCustom] = useState("");
  const toggle = (m: number) => onChange(value.includes(m) ? value.filter((x) => x !== m) : [...value, m].sort((a, b) => b - a));
  const customs = value.filter((v) => !(REMINDER_PRESETS as readonly number[]).includes(v));
  const addCustom = () => {
    const n = Math.round(Number(custom));
    if (n > 0 && n <= 60 * 24 * 14 && !value.includes(n)) onChange([...value, n].sort((a, b) => b - a));
    setCustom("");
  };
  return (
    <div className={cx("flex flex-col gap-2", disabled && "opacity-50 pointer-events-none")}>
      <div className="flex flex-wrap gap-1.5">
        {REMINDER_PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={value.includes(m)}
            onClick={() => toggle(m)}
            className={cx(
              "h-7 px-2.5 rounded-lg text-xs font-medium border transition",
              value.includes(m) ? "border-accent text-accent bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]" : "border-line text-muted hover:text-fg",
            )}
          >
            {offsetLabel(m)}
          </button>
        ))}
        {customs.map((m) => (
          <span key={m} className="h-7 pl-2.5 pr-1 rounded-lg text-xs font-medium border border-accent text-accent inline-flex items-center gap-1">
            {offsetLabel(m)}
            <button type="button" aria-label="Remove reminder" onClick={() => toggle(m)} className="h-5 w-5 flex items-center justify-center rounded hover:bg-hover">
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      {/* not a <form>: this sits inside the task and appointment editors' own forms */}
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          placeholder="Custom minutes before"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault(); // add the reminder; do not save the whole editor
              addCustom();
            }
          }}
          className="!h-8 !w-48 text-xs"
        />
        <button type="button" onClick={addCustom} className="h-8 px-2.5 rounded-lg text-xs text-fg-2 hover:bg-hover inline-flex items-center gap-1">
          <Plus size={13} /> Add
        </button>
      </div>
    </div>
  );
}
