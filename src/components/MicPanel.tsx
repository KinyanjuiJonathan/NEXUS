import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Settings2 } from "lucide-react";
import { openExternal } from "@/lib/platform";
import { Button, cx } from "./ui";

interface Device {
  id: string;
  label: string;
}

const clean = (label: string) => label.replace(/^(Default|Communications)\s*-\s*/i, "").trim();

/**
 * Which microphone is being used, and whether it is picking anything up.
 *
 * Dictation listens through the microphone Windows has set as its default
 * input, so that is the one shown as "in use"; the others are listed, and
 * the default is changed in Windows' sound settings (one click from here).
 * The level meter listens to that same microphone while dictating, or on
 * request, so a muted or wrong microphone is obvious before speaking.
 */
export function MicPanel({ active }: { active: boolean }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [inUse, setInUse] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const bar = useRef<HTMLSpanElement>(null);
  const peak = useRef<HTMLSpanElement>(null);
  const on = active || testing;

  const refresh = async () => {
    try {
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      const def = all.find((d) => d.deviceId === "default");
      const real = all.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
      setDevices(real.map((d, i) => ({ id: d.deviceId, label: clean(d.label) || `Microphone ${i + 1}` })));
      // names are only given once microphone access has been allowed
      const name = clean(def?.label ?? "") || clean(real[0]?.label ?? "");
      setInUse(name || (all.length ? null : ""));
    } catch {
      setInUse(null);
    }
  };

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError("This window cannot list microphones.");
      return;
    }
    void refresh();
    const onChange = () => void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", onChange);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", onChange);
  }, []);

  // the level meter: runs while dictating or testing
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let stopped = false;
    let held = 0;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        setError(null);
        void refresh(); // now the names are available
        const track = stream.getAudioTracks()[0];
        if (track?.label) setInUse(clean(track.label));
        ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += ((v - 128) / 128) ** 2;
          const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
          held = Math.max(level, held - 0.012);
          if (bar.current) bar.current.style.width = `${level * 100}%`;
          if (peak.current) peak.current.style.left = `${held * 100}%`;
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        const name = (e as { name?: string })?.name;
        setError(
          name === "NotAllowedError" ? "Microphone access is blocked. Allow it for desktop apps in Windows privacy settings."
          : name === "NotFoundError" ? "No microphone was found. Plug one in or enable it in Windows sound settings."
          : "The microphone could not be opened.",
        );
        setTesting(false);
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
      if (bar.current) bar.current.style.width = "0%";
    };
  }, [on]);

  const others = devices.filter((d) => d.label !== inUse);

  return (
    <div className="rounded-xl border border-line px-3 py-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={cx("h-7 w-7 rounded-lg flex items-center justify-center shrink-0", error ? "text-danger bg-[color-mix(in_oklab,var(--danger)_14%,transparent)]" : on ? "text-success bg-[color-mix(in_oklab,var(--success)_16%,transparent)]" : "text-accent bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]")}>
          {error ? <MicOff size={14} /> : <Mic size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-muted">Microphone in use</div>
          <div className="text-sm font-medium truncate" title="The microphone Windows has set as its default input: the one dictation listens to">
            {inUse ? inUse : inUse === "" ? "No microphone found" : "Windows default microphone"}
            {inUse == null && <span className="text-muted font-normal text-xs"> · press Test to show its name</span>}
          </div>
        </div>
        {/* level: how loud the microphone hears you right now, with a marker that holds the recent peak */}
        <div className="relative h-2 w-40 rounded-full bg-line overflow-hidden" role="meter" aria-label="Microphone level" title={on ? "Input level" : "Press Test, or start dictating, to see the input level"}>
          <span ref={bar} className="absolute left-0 top-0 bottom-0 rounded-full" style={{ width: "0%", background: "linear-gradient(90deg, var(--success), #eab308 75%, var(--danger))", transition: "width 60ms linear" }} />
          <span ref={peak} className="absolute top-0 bottom-0 w-0.5 bg-fg" style={{ left: "0%", opacity: on ? 0.8 : 0 }} />
        </div>
        <Button size="sm" variant={testing ? "soft" : "outline"} disabled={active} onClick={() => setTesting((t) => !t)} title="Listen to the microphone for a moment to check it is working">{testing ? "Stop test" : "Test"}</Button>
        <Button size="sm" variant="ghost" icon={<Settings2 size={13} />} onClick={() => void openExternal("ms-settings:sound").catch(() => setError("Open Windows Settings → System → Sound to choose the input device."))} title="Choose which microphone Windows uses (Settings → System → Sound → Input)">Change</Button>
      </div>
      {error && <p role="alert" className="text-[11px] text-danger">{error}{" "}<button type="button" className="underline" onClick={() => void openExternal("ms-settings:privacy-microphone").catch(() => {})}>Open microphone privacy settings</button></p>}
      {others.length > 0 && (
        <div className="text-[11px] text-muted">
          <button type="button" className="hover:text-accent underline-offset-2 hover:underline" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {others.length} other microphone{others.length === 1 ? "" : "s"} available
          </button>
          {showAll && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {others.map((d) => <li key={d.id} className="truncate">· {d.label}</li>)}
              <li className="text-muted/80">To use one of these, press <b className="font-medium text-fg-2">Change</b> and pick it as the input device in Windows; NEXUS follows the Windows default.</li>
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
