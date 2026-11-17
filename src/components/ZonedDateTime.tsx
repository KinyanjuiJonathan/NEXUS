import { KENYA_ZONE, formatWithZone, fromLocalInput, toLocalInput, zoneAbbr } from "@/lib/time";
import { Input, Select } from "./ui";

/**
 * Date-time input with an explicit time zone. The value is stored as UTC ms
 * together with the chosen zone, and the equivalent Kenya/Texas times are
 * shown underneath so cross-zone scheduling is unambiguous.
 */
export function ZonedDateTime({
  value,
  zone,
  onChange,
  homeZone,
  texasZone,
  hour12,
  allowEmpty = true,
  showEquivalents = true,
}: {
  value: number | null;
  zone: string;
  onChange: (ms: number | null, zone: string) => void;
  homeZone: string;
  texasZone: string;
  hour12: boolean;
  allowEmpty?: boolean;
  showEquivalents?: boolean;
}) {
  const zones = Array.from(new Set([homeZone, KENYA_ZONE, texasZone, zone]));
  const label = (z: string) =>
    z === KENYA_ZONE ? "Kenya (EAT)" : z === texasZone ? `Texas (${zoneAbbr(z, value ?? Date.now())})` : z === homeZone ? `Local (${z.split("/").pop()?.replace(/_/g, " ")})` : z;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          type="datetime-local"
          value={value != null ? toLocalInput(value, zone) : ""}
          onChange={(e) => {
            const ms = fromLocalInput(e.target.value, zone);
            if (ms != null || allowEmpty) onChange(ms, zone);
          }}
          className="flex-1"
        />
        <Select
          value={zone}
          className="!w-[170px]"
          aria-label="Time zone"
          onChange={(e) => {
            const z = e.target.value;
            // Keep the same wall-clock time, interpreted in the new zone.
            if (value == null) return onChange(null, z);
            onChange(fromLocalInput(toLocalInput(value, zone), z), z);
          }}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {label(z)}
            </option>
          ))}
        </Select>
      </div>
      {showEquivalents && value != null && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted">
          <span><b className="text-cyan-400 font-semibold">KE</b> {formatWithZone(value, KENYA_ZONE, hour12)}</span>
          <span><b className="text-violet-400 font-semibold">TX</b> {formatWithZone(value, texasZone, hour12)}</span>
        </div>
      )}
    </div>
  );
}
