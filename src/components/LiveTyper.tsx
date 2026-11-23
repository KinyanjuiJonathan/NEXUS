import { useEffect, useRef } from "react";
import { ArrowRight, Crosshair, Eraser, Mic, MonitorDot, RefreshCw, ScanText, Square } from "lucide-react";
import { useNexus } from "@/store";
import { native } from "@/lib/platform";
import { voiceSupported } from "@/lib/voice/engine";
import { useLive, type LiveSource } from "@/lib/typer/liveController";
import { SPOKEN_HELP } from "@/lib/typer/live";
import { Button, Select, Toggle, cx } from "./ui";
import { MicPanel } from "./MicPanel";

/** A box that keeps its newest text in view. */
function Pane({ title, hint, children, live, tone }: { title: string; hint: string; children: React.ReactNode; live: boolean; tone: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  return (
    <div className={cx("live-pane flex-1 min-w-0 rounded-xl border bg-hover flex flex-col", live ? "live-pane-on" : "border-line")} style={{ ["--tone" as string]: tone }}>
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className={cx("h-1.5 w-1.5 rounded-full", live && "animate-pulse")} style={{ background: live ? tone : "var(--muted)" }} />
        <span className="text-[11px] uppercase tracking-[0.14em] font-semibold" style={{ color: live ? tone : "var(--muted)" }}>{title}</span>
        <span className="ml-auto text-[10px] text-muted truncate">{hint}</span>
      </div>
      <div ref={ref} className="flex-1 min-h-[200px] max-h-[340px] overflow-y-auto scroll-y px-3 pb-3 text-[13px] leading-relaxed whitespace-pre-wrap break-words">{children}</div>
    </div>
  );
}

/**
 * Live input for the Auto Typer: what you say, or what appears in a part of
 * the screen, comes in on the left and is typed out on the right, into the
 * text box you click in.
 */
export function LiveTyper({ source }: { source: LiveSource }) {
  const live = useLive();
  const { engine, language } = useNexus((s) => ({ engine: s.settings.voiceEngine, language: s.settings.voiceLanguage }));
  const mine = live.running && live.source === source;
  const other = live.running && live.source !== source;
  const voice = source === "voice";
  const canVoice = voiceSupported(engine === "keyboard" ? "auto" : engine);
  const start = () => void (voice ? live.startVoice() : live.startScreen());
  const r = live.region;

  return (
    <div className="flex flex-col gap-3 min-h-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        {mine ? (
          <Button variant="danger" icon={<Square size={14} />} onClick={() => void live.stop()}>Stop</Button>
        ) : (
          <Button variant="primary" icon={voice ? <Mic size={15} /> : <ScanText size={15} />} disabled={other || (voice ? !canVoice : !r)} onClick={start}>
            {voice ? "Start dictating" : "Start following"}
          </Button>
        )}
        {!voice && (
          <>
            <Button variant="outline" icon={<Crosshair size={14} />} disabled={live.running} onClick={() => void live.chooseRegion()} title="NEXUS steps aside; drag a rectangle over the part of the screen to follow">
              {r ? "Change region" : "Select region"}
            </Button>
            {r && <Button variant="ghost" icon={<RefreshCw size={14} />} disabled={live.running} onClick={() => void live.readOnce()} title="Read the region once to check what NEXUS sees">Read once</Button>}
            {r && <span className="text-[11px] text-muted tabular">{r.w} × {r.h} px at {r.x}, {r.y}</span>}
          </>
        )}
        <span role="status" className="text-xs font-medium" style={{ color: mine ? (live.phase === "typing" ? "var(--accent)" : "var(--success)") : "var(--muted)" }}>
          {mine ? (live.phase === "typing" ? `Typing${live.waiting > 1 ? ` · ${live.waiting - 1} waiting` : ""}` : voice ? "Listening…" : "Watching the region…") : other ? "The other live mode is running" : ""}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Eraser size={14} />} disabled={!live.input.length && !live.output} onClick={live.clear}>Clear</Button>
      </div>

      {voice && <MicPanel active={mine} />}

      <div className="flex items-stretch gap-2">
        <Pane title={voice ? "Input · your voice" : "Input · the screen"} hint={voice ? language : r ? "latest reading" : "no region yet"} live={mine && live.phase !== "typing"} tone="var(--success)">
          {live.input.length ? (
            voice ? live.input.map((p, i) => <p key={i} className={cx(i === live.input.length - 1 && !live.interim ? "text-fg" : "text-fg-2")}>{p}</p>) : live.input.join("\n")
          ) : voice && live.interim ? null : (
            <span className="text-muted">
              {voice
                ? "Press Start dictating, click into the text box you want, and speak. Each phrase appears here as it is heard."
                : "Select a region of the screen. NEXUS reads the text inside it and shows it here; while following, whatever newly appears is typed out."}
            </span>
          )}
          {/* the phrase being spoken right now, before it is finished and typed */}
          {voice && live.interim && <p className="text-success/90 italic">{live.interim}…</p>}
        </Pane>
        <div className="flex flex-col items-center justify-center w-7 shrink-0" aria-hidden>
          <ArrowRight size={18} className={cx("transition-colors", mine ? "text-accent live-flow" : "text-muted")} />
        </div>
        <Pane title="Output · typed" hint={live.toApp && native ? "into the text box you click in" : "shown here only"} live={mine && live.phase === "typing"} tone="var(--accent)">
          {live.output ? live.output : <span className="text-muted">What NEXUS types appears here{live.toApp && native ? ", and in the other app's text box at the same time" : ""}.</span>}
          {mine && <span className="live-caret" />}
        </Pane>
      </div>

      {live.error && <p role="alert" className="text-xs text-danger">{live.error}</p>}

      <div className="grid sm:grid-cols-2 gap-x-5 gap-y-2">
        <Toggle
          checked={live.toApp}
          disabled={live.running || !native}
          onChange={(v) => live.set({ toApp: v })}
          label="Type into the other app"
          description={native ? "Off: the text is only collected in the output box here, for you to copy." : "Typing into other apps runs in the NEXUS desktop app for Windows; here the text is collected in the output box."}
        />
        {voice ? (
          <Toggle checked={live.fullStop} disabled={live.running} onChange={(v) => live.set({ fullStop: v })} label="Full stop after each phrase" description="For recognisers that leave punctuation out. You can always say “comma”, “full stop”, “question mark”." />
        ) : (
          <Toggle checked={live.includeExisting} disabled={live.running} onChange={(v) => live.set({ includeExisting: v })} label="Also type what is there now" description="Off: only text that appears after you start is typed." />
        )}
        {voice && (
          <Toggle checked={live.keepUp} disabled={live.running} onChange={(v) => live.set({ keepUp: v })} label="Keep up with my speech" description="Types quickly and without deliberate typos, so nothing queues up while you talk. Off: your normal human-like typing settings are used." />
        )}
        {!voice && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-2 sm:col-span-2">
            <MonitorDot size={14} className="text-accent" />
            Read every
            <Select className="!w-24 !h-8" value={String(live.interval)} disabled={live.running} onChange={(e) => live.set({ interval: Number(e.target.value) })} aria-label="Seconds between readings">
              {[0.5, 1, 2, 3, 5].map((s) => <option key={s} value={s}>{s} s</option>)}
            </Select>
            and put each new line
            <Select className="!w-40 !h-8" value={live.joiner} disabled={live.running} onChange={(e) => live.set({ joiner: e.target.value as "newline" | "space" })} aria-label="How new lines are joined">
              <option value="newline">on a new line</option>
              <option value="space">after a space</option>
            </Select>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted">
        {voice ? (
          <>Say {SPOKEN_HELP.map((w, i) => <span key={w}>{i ? ", " : ""}<b className="text-fg-2 font-medium">“{w}”</b></span>)} for punctuation and control. Typing uses the speed and technique set on the right; NEXUS never types into its own window, it waits until another app has focus. {!canVoice && "Voice input is not available here."}</>
        ) : (
          <>Text is read with the recognition built into Windows, on this PC; nothing is sent anywhere. A line is typed once it has been read the same way twice, so a momentary misreading is not typed, and nothing is typed twice. Keep the region clear of the text box you are typing into. <b className="text-fg-2 font-medium">Beta:</b> accuracy depends on text size and contrast.</>
        )}
      </p>
    </div>
  );
}
