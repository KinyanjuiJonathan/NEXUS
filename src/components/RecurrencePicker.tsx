import type { Frequency, RecurrenceRule } from "@/data/types";
import { describeRule } from "@/lib/recurrence";
import { Input, Select, cx } from "./ui";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

export function RecurrencePicker({ value, onChange }: { value: RecurrenceRule | null; onChange: (r: RecurrenceRule | null) => void }) {
  const freq = value?.freq ?? "none";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Select
          value={freq}
          onChange={(e) => {
            const f = e.target.value as Frequency | "none";
            onChange(f === "none" ? null : { freq: f, interval: value?.interval ?? 1, byWeekday: f === "weekly" ? value?.byWeekday ?? [] : undefined, exdates: value?.exdates });
          }}
        >
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekdays">Every weekday (Mon–Fri)</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </Select>
        {value && value.freq !== "weekdays" && (
          <div className="flex items-center gap-1.5 text-xs text-muted shrink-0">
            every
            <Input
              type="number"
              min={1}
              max={99}
              value={value.interval}
              onChange={(e) => onChange({ ...value, interval: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
              className="!w-16 text-center"
              aria-label="Interval"
            />
          </div>
        )}
      </div>
      {value?.freq === "weekly" && (
        <div className="flex gap-1">
          {DAYS.map((d, i) => {
            const wd = i + 1;
            const on = value.byWeekday?.includes(wd);
            return (
              <button
                key={wd}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const cur = new Set(value.byWeekday ?? []);
                  if (on) cur.delete(wd);
                  else cur.add(wd);
                  onChange({ ...value, byWeekday: [...cur].sort() });
                }}
                className={cx("h-8 w-8 rounded-lg text-xs font-semibold transition", on ? "bg-accent text-white" : "bg-hover text-muted hover:text-fg")}
              >
                {d}
              </button>
            );
          })}
        </div>
      )}
      {value && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>{describeRule(value)}</span>
          <span className="ml-auto">End after</span>
          <Input
            type="number"
            min={0}
            placeholder="∞"
            value={value.count ?? ""}
            onChange={(e) => onChange({ ...value, count: e.target.value ? Math.max(1, Number(e.target.value)) : null })}
            className="!w-20 !h-8 text-center"
            aria-label="Occurrences"
          />
          <span>times</span>
        </div>
      )}
    </div>
  );
}
