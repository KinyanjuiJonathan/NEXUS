import { memo } from "react";
import { clockFor, KENYA_ZONE, zoneDiffHours } from "@/lib/time";
import { useNow } from "@/lib/ticker";
import { cx } from "./ui";

export const ZoneClock = memo(function ZoneClock({ zone, label, flag, hour12, compact, accent }: { zone: string; label: string; flag: string; hour12: boolean; compact?: boolean; accent: string }) {
  const now = useNow();
  const c = clockFor(zone, now, hour12);
  if (compact) {
    return (
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-[10px] font-semibold tracking-wider text-muted">{flag}</span>
        <span className="font-mono tabular text-[15px] font-semibold text-fg">{c.time}</span>
        {c.meridiem && <span className="text-[10px] text-muted">{c.meridiem}</span>}
        <span className="text-[10px] font-medium" style={{ color: accent }}>{c.abbr}</span>
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-2xl glass p-5 flex-1 min-w-[240px]">
      <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full blur-3xl opacity-40" style={{ background: accent }} />
      <div className="relative flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-6 px-1.5 rounded-md text-[11px] font-bold tracking-wider flex items-center" style={{ color: accent, background: `color-mix(in oklab, ${accent} 16%, transparent)` }}>
            {flag}
          </span>
          <span className="text-sm font-semibold text-fg-2">{label}</span>
        </div>
        <span className="text-xs font-mono text-muted" title={`${zone} · UTC${c.offset}`}>
          {c.abbr} · UTC{c.offset}
        </span>
      </div>
      <div className="relative mt-3 flex items-baseline gap-2">
        <span className="font-display tabular text-[46px] leading-none font-light tracking-tight text-fg">{c.time}</span>
        <span className="font-mono tabular text-lg text-muted">:{c.seconds}</span>
        {c.meridiem && <span className="text-sm font-semibold text-fg-2 ml-1">{c.meridiem}</span>}
      </div>
      <div className="relative mt-2 text-sm text-fg-2">
        {c.weekday}, {c.date}
        {c.isDST && <span className="ml-2 text-[11px] text-muted">daylight time</span>}
      </div>
    </div>
  );
});

export function DualClock({ hour12, texasZone, compact }: { hour12: boolean; texasZone: string; compact?: boolean }) {
  const now = useNow();
  const diff = zoneDiffHours(texasZone, KENYA_ZONE, now);
  const texasLabel = texasZone === "America/Denver" ? "Texas · El Paso" : "Texas";
  if (compact) {
    return (
      <div className="flex items-center gap-3">
        <ZoneClock zone={KENYA_ZONE} label="Kenya" flag="KE" hour12={hour12} compact accent="#22d3ee" />
        <span className="h-3 w-px bg-line-strong" />
        <ZoneClock zone={texasZone} label={texasLabel} flag="TX" hour12={hour12} compact accent="#a78bfa" />
      </div>
    );
  }
  return (
    <div className={cx("flex flex-wrap gap-4")}>
      <ZoneClock zone={KENYA_ZONE} label="Kenya · Nairobi" flag="KE" hour12={hour12} accent="#22d3ee" />
      <ZoneClock zone={texasZone} label={texasLabel} flag="TX" hour12={hour12} accent="#a78bfa" />
      <div className="sr-only">Kenya is {diff} hours ahead of Texas.</div>
    </div>
  );
}
