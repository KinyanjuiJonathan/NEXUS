import { useMemo, useState } from "react";
import { DateTime } from "luxon";
import { ArrowRightLeft, CalendarPlus, Clock, Globe } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { useNow } from "@/lib/ticker";
import { DualClock } from "@/components/DualClock";
import { KENYA_ZONE, TEXAS_CENTRAL, TEXAS_MOUNTAIN, convertWallTime, formatTime, overlapWindows, zoneAbbr, zoneDiffHours, zoneLabel } from "@/lib/time";
import { Button, Card, CardHeader, Field, Input, Segmented, Select, Toggle } from "@/components/ui";

export default function Clocks() {
  const now = useNow();
  const settings = useNexus((s) => s.settings);
  const s = nexus();
  const zones = [KENYA_ZONE, settings.texasZone, settings.homeZone].filter((z, i, a) => a.indexOf(z) === i);
  const [src, setSrc] = useState<string>(KENYA_ZONE);
  const [dst, setDst] = useState<string>(settings.texasZone);
  const [value, setValue] = useState(() => DateTime.fromMillis(Date.now(), { zone: KENYA_ZONE }).startOf("hour").plus({ hours: 1 }).toFormat("yyyy-LL-dd'T'HH:mm"));
  const conv = useMemo(() => convertWallTime(value, src, dst, settings.hour12), [value, src, dst, settings.hour12]);
  const diff = zoneDiffHours(settings.texasZone, KENYA_ZONE, now);
  const overlap = overlapWindows(KENYA_ZONE, settings.texasZone, now, settings.workStartHour, settings.workEndHour);

  // 24h strip: every hour of today in Kenya and the matching Texas hour.
  const strip = useMemo(() => {
    const day = DateTime.fromMillis(now, { zone: KENYA_ZONE }).startOf("day");
    return Array.from({ length: 24 }, (_, h) => {
      const ms = day.plus({ hours: h }).toMillis();
      const tx = DateTime.fromMillis(ms, { zone: settings.texasZone });
      const work = (hh: number) => hh >= settings.workStartHour && hh < settings.workEndHour;
      return { ms, ke: h, tx: tx.hour, both: work(h) && work(tx.hour) && tx.weekday <= 5 };
    });
  }, [Math.floor(now / 3600_000), settings.texasZone, settings.workStartHour, settings.workEndHour]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">World Clocks</h1>
          <p className="text-sm text-muted">IANA time zones with automatic daylight-saving handling. Kenya is currently {diff} hours ahead of Texas.</p>
        </div>
        <div className="flex items-center gap-3">
          <Segmented
            value={settings.hour12 ? "12" : "24"}
            onChange={(v) => void s.setSetting("hour12", v === "12")}
            options={[{ value: "12", label: "12-hour" }, { value: "24", label: "24-hour" }]}
          />
        </div>
      </div>

      <DualClock hour12={settings.hour12} texasZone={settings.texasZone} />

      <Card>
        <CardHeader title="Texas time zone" icon={<Globe size={16} />} />
        <div className="px-5 pb-4 flex flex-col gap-1">
          <Toggle
            checked={settings.texasZone === TEXAS_MOUNTAIN}
            onChange={(v) => void s.setSetting("texasZone", v ? TEXAS_MOUNTAIN : TEXAS_CENTRAL)}
            label="Use El Paso / West Texas (Mountain time)"
            description={`Most of Texas uses Central time (America/Chicago: CST/CDT). El Paso uses Mountain time (America/Denver: MST/MDT — the IANA database has no separate “America/El_Paso” zone). Currently: ${zoneLabel(settings.texasZone)} ${zoneAbbr(settings.texasZone, now)}.`}
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Time-zone converter" icon={<ArrowRightLeft size={16} />} subtitle="Plan activities across Kenya and Texas" />
        <div className="px-5 pb-5 grid gap-4 lg:grid-cols-[1fr_auto_1fr] items-end">
          <div className="grid grid-cols-[1fr_170px] gap-2">
            <Field label="Date & time"><Input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
            <Field label="In">
              <Select value={src} onChange={(e) => setSrc(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
              </Select>
            </Field>
          </div>
          <Button variant="ghost" aria-label="Swap zones" onClick={() => { setSrc(dst); setDst(src); }} className="mb-0.5"><ArrowRightLeft size={16} /></Button>
          <Field label="Convert to">
            <Select value={dst} onChange={(e) => setDst(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
            </Select>
          </Field>
        </div>
        {conv && (
          <div className="mx-5 mb-5 rounded-xl border border-line bg-hover p-4 flex flex-wrap items-center gap-4">
            <div>
              <p className="text-xs text-muted">{zoneLabel(src)}</p>
              <p className="text-lg font-semibold">{conv.sourceLabel}</p>
            </div>
            <ArrowRightLeft size={16} className="text-muted" />
            <div>
              <p className="text-xs text-muted">{zoneLabel(dst)}</p>
              <p className="text-lg font-semibold text-gradient">{conv.targetLabel}</p>
            </div>
            <div className="text-xs text-muted">
              {conv.hoursDiff > 0 ? `+${conv.hoursDiff}` : conv.hoursDiff} h{conv.dayShift !== 0 && ` · ${conv.dayShift > 0 ? "next" : "previous"} day`}
            </div>
            <Button size="sm" variant="primary" className="ml-auto" icon={<CalendarPlus size={14} />} onClick={() => useUI.getState().openEvent(null, { startAt: conv.sourceMs, endAt: conv.sourceMs + 3600_000 })}>
              Schedule at this time
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Kenya ⇄ Texas day planner" icon={<Clock size={16} />} subtitle={overlap ? `Shared working hours (${settings.workStartHour}:00–${settings.workEndHour}:00 both sides): ${formatTime(overlap.start, KENYA_ZONE, settings.hour12)}–${formatTime(overlap.end, KENYA_ZONE, settings.hour12)} EAT = ${formatTime(overlap.start, settings.texasZone, settings.hour12)}–${formatTime(overlap.end, settings.texasZone, settings.hour12)} ${zoneAbbr(settings.texasZone, overlap.start)}` : "No overlapping working hours today"} />
        <div className="px-5 pb-5 overflow-x-auto">
          <div className="grid gap-px min-w-[760px]" style={{ gridTemplateColumns: "64px repeat(24, 1fr)" }}>
            <div className="text-[11px] font-semibold text-cyan-400 py-1.5">KE EAT</div>
            {strip.map((h) => <div key={`k${h.ke}`} className={`text-center text-[11px] tabular py-1.5 rounded-sm ${h.both ? "bg-[color-mix(in_oklab,var(--success)_22%,transparent)] text-fg" : "bg-hover text-fg-2"}`}>{settings.hour12 ? `${h.ke % 12 || 12}${h.ke < 12 ? "a" : "p"}` : h.ke}</div>)}
            <div className="text-[11px] font-semibold text-violet-400 py-1.5">TX {zoneAbbr(settings.texasZone, now)}</div>
            {strip.map((h) => <div key={`t${h.ke}`} className={`text-center text-[11px] tabular py-1.5 rounded-sm ${h.both ? "bg-[color-mix(in_oklab,var(--success)_22%,transparent)] text-fg" : "bg-hover text-muted"}`}>{settings.hour12 ? `${h.tx % 12 || 12}${h.tx < 12 ? "a" : "p"}` : h.tx}</div>)}
          </div>
          <p className="text-[11px] text-muted mt-2">Green = inside working hours in both places (weekday in Texas). Adjust working hours in Settings.</p>
        </div>
      </Card>
    </div>
  );
}
