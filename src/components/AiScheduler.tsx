import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, CalendarCheck, Info, Lock, Mic, Minus, Send, Sparkles, Square, Trash2, TriangleAlert, Unlock } from "lucide-react";
import { useNexus } from "@/store";
import { useUI } from "@/store/ui";
import { KENYA_ZONE } from "@/lib/time";
import { listen, voiceSupported, type ListenHandle } from "@/lib/voice/engine";
import { useScheduler, type ChatMessage } from "@/lib/smart/chat";
import type { Line } from "@/lib/smart/converse";
import { slotElsewhere, slotLabel } from "@/lib/smart/format";
import { Button, IconButton, cx } from "./ui";

/** The compact entry point: sits with the other header actions and opens the panel. */
export function AiScheduleButton({ size = "md" }: { size?: "sm" | "md" }) {
  const enabled = useNexus((s) => s.settings.smartEnabled);
  const { open, setOpen, pending } = useScheduler();
  if (!enabled) return null;
  return (
    <Button
      size={size}
      variant="outline"
      aria-expanded={open}
      aria-controls="ai-scheduler"
      onClick={() => setOpen(!open)}
      title="Tell NEXUS what to schedule, in your own words or by voice"
      icon={<Sparkles size={size === "sm" ? 14 : 15} className="text-accent" />}
      className={cx("relative", open && "!border-accent glow-ring")}
    >
      AI Schedule
      {pending && !open && <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-warning" title="Waiting for your answer" />}
    </Button>
  );
}

const EXAMPLES = [
  "Schedule my gym session tomorrow at 6 PM Kenya time for one hour",
  "I need to review my financial report for two hours. Schedule it before my gym session",
  "Move that task to after my meeting",
];

function LineRow({ line, hour12, texasZone, now }: { line: Line; hour12: boolean; texasZone: string; now: number }) {
  const zone = line.zone ?? KENYA_ZONE;
  const icon =
    line.kind === "problem" ? <TriangleAlert size={14} className="text-warning" />
    : line.kind === "info" ? <Info size={14} className="text-muted" />
    : line.kind === "moved" ? <ArrowRight size={14} className="text-accent-2" />
    : line.kind === "fixed" ? (line.fixed ? <Lock size={14} className="text-accent-2" /> : <Unlock size={14} className="text-muted" />)
    : line.fixed ? <Lock size={14} className="text-accent-2" /> : <CalendarCheck size={14} className="text-success" />;
  const verb = line.kind === "created" ? "Scheduled" : line.kind === "moved" ? "Moved" : null;
  const canOpen = !!line.ref && !line.ref.startsWith("new-") && (line.kind === "created" || line.kind === "moved" || line.kind === "fixed");
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 text-[13px] leading-snug">
        <div>
          {verb && <span className="text-muted">{verb}: </span>}
          {canOpen ? (
            <button className="font-semibold text-fg hover:text-accent text-left" title="Open to view or edit" onClick={() => useUI.getState().openEvent(line.ref!)}>{line.title}</button>
          ) : (
            <span className="font-semibold text-fg">{line.title}</span>
          )}
          {line.fixed && line.kind === "created" && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-accent-2">fixed</span>}
        </div>
        {line.slot && line.slot.end > line.slot.start && (
          <div className="tabular text-fg-2">
            {slotLabel(line.slot, zone, hour12, now)}
            <span className="text-muted"> · {slotElsewhere(line.slot, zone === texasZone ? KENYA_ZONE : texasZone, zone, hour12)}</span>
          </div>
        )}
        {line.note && <div className="text-xs text-muted">{line.note}</div>}
      </div>
    </div>
  );
}

function Message({ m, last }: { m: ChatMessage; last: boolean }) {
  const { hour12, texasZone } = useNexus((s) => ({ hour12: s.settings.hour12, texasZone: s.settings.texasZone }));
  const { answer, busy } = useScheduler();
  if (m.role === "user") {
    return <div className="self-end max-w-[88%] rounded-2xl rounded-br-md bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] px-3 py-2 text-[13px] text-fg whitespace-pre-wrap break-words">{m.text}</div>;
  }
  const q = m.question;
  return (
    <div className="self-start max-w-[94%] rounded-2xl rounded-bl-md bg-hover px-3 py-2">
      {m.lines?.map((l, i) => <LineRow key={i} line={l} hour12={hour12} texasZone={texasZone} now={m.at} />)}
      {q && (
        <div className="py-1">
          <p className="text-[13px] text-fg">{q.text}</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {q.options.map((o) => {
              const label = o.slot ? slotLabel(o.slot, o.zone ?? KENYA_ZONE, hour12, m.at) : o.label;
              return (
                <Button key={o.value} size="sm" variant={m.answered === label ? "primary" : "soft"} disabled={!!m.answered || !last || busy} onClick={() => void answer(o.value, label)}>
                  {label}
                </Button>
              );
            })}
          </div>
          {!m.answered && last && <p className="text-[11px] text-muted mt-1.5">Pick one, or type a new instruction.</p>}
        </div>
      )}
      {!q && m.question === null && !m.lines?.length && <p className="text-[13px] text-muted">That question was left unanswered.</p>}
    </div>
  );
}

/**
 * The expanded scheduler: a compact floating panel for a typed or spoken
 * conversation. Minimising keeps the conversation and any unsent text. The
 * microphone is only ever on between pressing the mic button and the end of
 * that one utterance (or pressing stop).
 */
export function AiSchedulerPanel() {
  const { open, setOpen, draft, setDraft, messages, send, busy, clear } = useScheduler();
  const { enabled, engine, language } = useNexus((s) => ({ enabled: s.settings.smartEnabled, engine: s.settings.voiceEngine, language: s.settings.voiceLanguage }));
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const handle = useRef<ListenHandle | null>(null);
  const session = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const stopListening = () => {
    session.current += 1; // whatever is still on its way is ignored
    handle.current?.cancel();
    handle.current = null;
    setListening(false);
  };

  const startListening = () => {
    setVoiceError(null);
    const mine = ++session.current;
    const base = useScheduler.getState().draft.trim();
    const join = (t: string) => (base ? `${base} ${t}` : t);
    try {
      const h = listen(engine, language, (interim) => mine === session.current && setDraft(join(interim)));
      handle.current = h;
      setListening(true);
      h.promise
        .then((text) => {
          if (mine !== session.current) return;
          // the words go into the box to be checked and edited; nothing is sent yet
          setDraft(join(text.trim()));
          requestAnimationFrame(() => area.current?.focus());
        })
        .catch((e: unknown) => mine === session.current && setVoiceError(String(e instanceof Error ? e.message : e)))
        .finally(() => {
          if (mine !== session.current) return;
          handle.current = null;
          setListening(false);
        });
    } catch (e) {
      setListening(false);
      setVoiceError(String(e instanceof Error ? e.message : e));
    }
  };

  // The microphone never outlives the panel.
  useEffect(() => {
    if (!open) stopListening();
    else requestAnimationFrame(() => area.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => stopListening(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]")) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (open) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, open, busy]);

  // grow with the text, up to a few lines
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(132, el.scrollHeight)}px`;
  }, [draft, open]);

  const canSpeak = voiceSupported(engine);
  if (!enabled) return null;
  return (
    <AnimatePresence>
      {open && (
        <motion.section
          id="ai-scheduler"
          role="complementary"
          aria-label="AI Schedule"
          initial={{ opacity: 0, y: -8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={{ duration: 0.16 }}
          className="fixed z-40 right-4 lg:right-7 top-[118px] w-[min(440px,calc(100vw-2rem))] max-h-[min(620px,calc(100vh-134px))] glass-strong rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        >
          <header className="flex items-center gap-2 pl-4 pr-2 h-11 shrink-0 border-b border-line">
            <span className="h-6 w-6 rounded-lg bg-gradient-to-br from-cyan-400 to-violet-500 text-white flex items-center justify-center"><Sparkles size={13} /></span>
            <h2 className="text-[13px] font-semibold tracking-wide">AI Schedule</h2>
            <span className="text-[11px] text-muted hidden sm:inline">understands context · works offline</span>
            <div className="ml-auto flex items-center">
              {messages.length > 0 && <IconButton label="Clear this conversation" size={28} onClick={clear}><Trash2 size={14} /></IconButton>}
              <IconButton label="Minimise (keeps the conversation)" size={28} onClick={() => setOpen(false)}><Minus size={15} /></IconButton>
            </div>
          </header>

          <div ref={scroller} className="flex-1 min-h-[96px] overflow-y-auto scroll-y px-3 py-3 flex flex-col gap-2" aria-live="polite">
            {messages.length === 0 ? (
              <div className="text-[13px] text-muted">
                <p>Tell me what to schedule. I remember what we have talked about, so you can say “schedule it before my gym session” or “move that task to after my meeting”.</p>
                <div className="flex flex-col gap-1.5 mt-3">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} onClick={() => { setDraft(ex); area.current?.focus(); }} className="text-left rounded-lg bg-hover hover:bg-[color-mix(in_oklab,var(--accent)_12%,transparent)] px-2.5 py-1.5 text-xs text-fg-2 transition-colors">“{ex}”</button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) => <Message key={m.id} m={m} last={i === messages.length - 1} />)
            )}
            {busy && <div className="self-start rounded-2xl bg-hover px-3 py-2 text-[13px] text-muted">Checking your calendar…</div>}
          </div>

          <form
            className="shrink-0 border-t border-line p-2.5 flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              stopListening();
              void send();
            }}
          >
            {listening && (
              <div className="flex items-center gap-2 text-xs text-accent" role="status">
                <span className="relative h-2.5 w-2.5"><span className="absolute inset-0 rounded-full bg-danger animate-ping" /><span className="absolute inset-0 rounded-full bg-danger" /></span>
                Listening… speak one instruction. It appears below for you to check before sending.
              </div>
            )}
            {voiceError && !listening && <p className="text-xs text-warning" role="alert">{voiceError}</p>}
            <div className="flex items-end gap-1.5">
              <textarea
                ref={area}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    stopListening();
                    void send();
                  }
                }}
                aria-label="What should I schedule?"
                placeholder="e.g. Zoom meeting tomorrow at 3 PM, and review the report before it"
                className="flex-1 min-w-0 rounded-xl bg-hover border border-line px-3 py-2 text-sm text-fg placeholder:text-muted outline-none focus:border-accent focus:ring-2 focus:ring-[var(--glow)] transition resize-none leading-snug"
              />
              {listening ? (
                <IconButton type="button" label="Stop listening" size={36} onClick={stopListening} className="!bg-[color-mix(in_oklab,var(--danger)_18%,transparent)] !text-danger">
                  <Square size={14} fill="currentColor" />
                </IconButton>
              ) : (
                <IconButton type="button" label={canSpeak ? "Dictate (one instruction at a time)" : "Voice input is turned off or unavailable (Settings → Voice input)"} size={36} disabled={!canSpeak || busy} onClick={startListening}>
                  <Mic size={16} />
                </IconButton>
              )}
              <IconButton type="submit" label="Send (Enter)" size={36} disabled={!draft.trim() || busy} className="!bg-gradient-to-r from-sky-500 to-violet-500 !text-white disabled:opacity-40">
                <Send size={15} />
              </IconButton>
            </div>
            <p className="text-[10px] text-muted px-1">Enter to send · Shift+Enter for a new line · Esc to minimise</p>
          </form>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
