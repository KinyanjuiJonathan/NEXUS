import { useCallback, useEffect, useRef, useState } from "react";
import { workHours } from "@/lib/workPlan";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Command, CornerDownLeft, Loader2, Mic, MicOff, Plus, Sparkles, X } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { useUI } from "@/store/ui";
import { parseCommand, type ParsedCommand } from "@/lib/voice/parser";
import { describeIntent, executeIntent, type ExecResult } from "@/lib/voice/execute";
import { listen, voiceSupported, type ListenHandle } from "@/lib/voice/engine";
import { aiRequest, setOverlayVisible } from "@/lib/platform";
import { aiContext } from "@/lib/assistant";
import { fromLocalInput } from "@/lib/time";
import { Button, Kbd, Modal, cx } from "./ui";

const EXAMPLES = [
  "Add a task to finish my report tomorrow at 9 AM",
  "Remind me to attend the meeting at 4 PM Kenya time",
  "Move my meeting to Friday at 3 PM Texas time",
  "Start a 25-minute focus session",
  "What tasks do I have today?",
  "How much time is left?",
];

type Phase = "idle" | "listening" | "preview" | "running" | "done";

export function useCommandRunner() {
  const settings = useNexus((s) => s.settings);
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<ListenHandle | null>(null);

  const reset = useCallback(() => {
    handle.current?.cancel();
    setText("");
    setInterim("");
    setPhase("idle");
    setParsed(null);
    setResult(null);
    setError(null);
  }, []);

  const run = useCallback(async (p: ParsedCommand) => {
    setPhase("running");
    try {
      const r = await executeIntent(p.intent, { state: nexus, now: () => Date.now(), setOverlay: setOverlayVisible });
      setResult(r);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("preview");
    }
  }, []);

  const submit = useCallback(
    async (input: string, fromVoice = false) => {
      const t = input.trim();
      if (!t) return;
      setError(null);
      setResult(null);
      const s = nexus().settings;
      const p = parseCommand(t, { now: Date.now(), homeZone: s.homeZone, texasZone: s.texasZone });
      setParsed(p);
      setText(t);
      // Queries and timer controls run immediately; anything ambiguous/destructive waits for confirmation.
      // Voice-created items are always previewed first so the user sees what was recognised.
      const createsData = p.intent.type === "add_task" || p.intent.type === "add_event";
      if (!p.needsConfirmation && !(fromVoice && createsData)) await run(p);
      else setPhase("preview");
    },
    [run],
  );

  const startListening = useCallback(() => {
    setError(null);
    setResult(null);
    setParsed(null);
    setInterim("");
    setPhase("listening");
    const s = nexus().settings;
    const h = listen(s.voiceEngine, s.voiceLanguage, setInterim);
    handle.current = h;
    h.promise
      .then((t) => submit(t, true))
      .catch((e) => {
        setPhase("idle");
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [submit]);

  const stopListening = useCallback(() => {
    handle.current?.cancel();
    setPhase("idle");
  }, []);

  const interpretWithAI = useCallback(async () => {
    const s = nexus();
    setPhase("running");
    try {
      const r = await aiRequest<{ title: string; dueLocal: string | null; zone: string | null; priority: string | null; estimateMin: number | null; category: string | null }>(
        "interpret",
        text,
        aiContext(s.tasks, s.events, Date.now(), s.settings.homeZone, s.settings.texasZone, workHours(s.settings)),
      );
      const zone = r.zone || s.settings.homeZone;
      const due = r.dueLocal ? fromLocalInput(r.dueLocal.slice(0, 16), zone) : null;
      setParsed({
        transcript: text,
        confidence: 0.8,
        needsConfirmation: true,
        notes: ["Interpreted by Claude — please confirm"],
        intent: {
          type: "add_task",
          title: r.title,
          dueAt: due,
          tz: zone,
          estimateMin: r.estimateMin,
          priority: (r.priority as "high") ?? null,
          categoryId: r.category,
          reminderAtTime: false,
        },
      });
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("preview");
    }
  }, [text]);

  return { settings, text, setText, interim, phase, parsed, result, error, submit, run, reset, startListening, stopListening, interpretWithAI };
}

export function CommandPanel({ autoListen, initial, compact, onDone, autoFocus = true }: { autoListen?: boolean; initial?: string; compact?: boolean; onDone?: () => void; autoFocus?: boolean }) {
  const r = useCommandRunner();
  const inputRef = useRef<HTMLInputElement>(null);
  const voiceOk = voiceSupported(r.settings.voiceEngine);
  const s = nexus();

  useEffect(() => {
    if (initial) r.setText(initial);
    if (autoListen && voiceOk) r.startListening();
    else if (autoFocus) setTimeout(() => inputRef.current?.focus(), 30);
    return () => r.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listening = r.phase === "listening";

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void r.submit(r.text);
        }}
        className={cx("flex items-center gap-2 rounded-2xl border bg-hover px-2 transition", listening ? "border-accent glow-ring" : "border-line focus-within:border-accent")}
      >
        <Command size={16} className="text-muted ml-1.5 shrink-0" />
        <input
          ref={inputRef}
          value={listening ? r.interim : r.text}
          onChange={(e) => r.setText(e.target.value)}
          placeholder={listening ? "Listening…" : "Type or say a command — e.g. “Add a task to call Amina tomorrow at 10 AM Texas time”"}
          className={cx("flex-1 bg-transparent outline-none text-fg placeholder:text-muted min-w-0", compact ? "h-10 text-sm" : "h-12 text-[15px]")}
          aria-label="Command"
          readOnly={listening}
        />
        {r.text && !listening && (
          <button type="button" aria-label="Clear" onClick={r.reset} className="text-muted hover:text-fg p-1">
            <X size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={listening ? r.stopListening : r.startListening}
          disabled={!voiceOk}
          aria-label={listening ? "Stop listening" : "Speak a command"}
          title={voiceOk ? (listening ? "Stop" : "Speak (one command; NEXUS never records continuously)") : "Voice input isn't available — type instead"}
          className={cx(
            "relative h-9 w-9 shrink-0 rounded-xl flex items-center justify-center transition",
            listening ? "bg-accent text-white mic-pulse" : "text-fg-2 hover:bg-hover hover:text-accent",
            !voiceOk && "opacity-40",
          )}
        >
          {voiceOk ? <Mic size={17} /> : <MicOff size={17} />}
        </button>
        <Button type="submit" size="sm" variant="primary" disabled={!r.text.trim() || listening} className="shrink-0" aria-label="Run command">
          <CornerDownLeft size={14} />
        </Button>
      </form>

      {r.error && <p role="alert" className="text-xs text-warning px-1">{r.error}</p>}

      <AnimatePresence mode="wait">
        {r.parsed && (r.phase === "preview" || r.phase === "running") && (
          <motion.div key="preview" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-xl border border-line bg-surface p-3.5">
            <p className="text-[11px] uppercase tracking-wider text-muted">Recognised</p>
            <p className="text-sm text-fg mt-0.5">“{r.parsed.transcript}”</p>
            <p className="text-[11px] uppercase tracking-wider text-muted mt-3">Action</p>
            <p className="text-sm font-medium text-accent mt-0.5">{describeIntent(r.parsed.intent, s, Date.now())}</p>
            {r.parsed.notes.length > 0 && <ul className="mt-1.5 text-xs text-muted list-disc pl-4">{r.parsed.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            <div className="flex flex-wrap gap-2 mt-3">
              {r.parsed.intent.type === "unknown" ? (
                <>
                  <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => void r.run({ ...r.parsed!, intent: { type: "add_task", title: r.parsed!.transcript, dueAt: null, tz: s.settings.homeZone, estimateMin: null, priority: null, categoryId: null, reminderAtTime: false } })}>
                    Add as a task
                  </Button>
                  {s.settings.aiEnabled && (
                    <Button size="sm" variant="outline" icon={<Sparkles size={14} />} onClick={r.interpretWithAI}>
                      Ask Claude to interpret
                    </Button>
                  )}
                </>
              ) : (
                <Button size="sm" variant="primary" autoFocus icon={r.phase === "running" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} onClick={() => void r.run(r.parsed!)} disabled={r.phase === "running"}>
                  Confirm
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={r.reset}>Cancel</Button>
            </div>
          </motion.div>
        )}
        {r.result && r.phase === "done" && (
          <motion.div key="result" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={cx("rounded-xl border p-3.5", r.result.ok ? "border-[color-mix(in_oklab,var(--success)_35%,transparent)] bg-[color-mix(in_oklab,var(--success)_8%,transparent)]" : "border-line bg-surface")}>
            <p className="text-sm text-fg font-medium" role="status">{r.result.message}</p>
            {r.result.lines && r.result.lines.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm text-fg-2">
                {r.result.lines.map((l, i) => <li key={i} className="tabular">{l}</li>)}
              </ul>
            )}
            <div className="flex gap-2 mt-3">
              <Button size="sm" variant="soft" onClick={r.reset}>New command</Button>
              {onDone && <Button size="sm" variant="ghost" onClick={onDone}>Close</Button>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {!compact && r.phase === "idle" && !r.result && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] uppercase tracking-wider text-muted px-1 mb-1">Try saying</p>
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => void r.submit(ex)} className="text-left text-sm text-fg-2 hover:text-fg hover:bg-hover rounded-lg px-2 py-1.5 transition">
              “{ex}”
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CommandPalette() {
  const { open, listen: autoListen, initial } = useUI((s) => s.command);
  const close = useUI((s) => s.closeCommand);
  return (
    <Modal open={open} onClose={close} title={<span className="inline-flex items-center gap-2">Command center <Kbd>Ctrl K</Kbd></span>} icon={<Mic size={18} />} width={640}>
      {open && <CommandPanel autoListen={autoListen} initial={initial} onDone={close} />}
    </Modal>
  );
}
