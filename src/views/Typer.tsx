import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bold, Eraser, Italic, Keyboard, Lock, Play, Square } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { idleSeconds, native, typerShortcut } from "@/lib/platform";
import { shouldLeaveTyper } from "@/lib/typer/idle";
import { useUI } from "@/store/ui";
import { BOLD, DEFAULT_TYPER, ITALIC, MAX_REPEAT, buildPlan, htmlToMarkup, parseMarkup, prepareText, type TyperOptions } from "@/lib/typer/engine";
import { isBusy, useTyper } from "@/lib/typer/controller";
import { Button, Card, CardHeader, Field, Input, Kbd, ProgressBar, Select, Toggle, cx } from "@/components/ui";

const accel = (s: string) => s.replace("CommandOrControl", "Ctrl");
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/** The text as it will be typed: markers greyed out, marked text shown bold / italic. */
function Highlight({ text, literal }: { text: string; literal: boolean }) {
  const nodes = useMemo(() => {
    if (literal) return [text];
    const cls: (string | null)[] = new Array(text.length).fill("tm");
    for (const c of parseMarkup(text)) {
      const k = c.style === (BOLD | ITALIC) ? "tb ti" : c.style === BOLD ? "tb" : c.style === ITALIC ? "ti" : null;
      for (let i = 0; i < c.ch.length; i++) cls[c.index + i] = k;
    }
    const out: ReactNode[] = [];
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || cls[i] !== cls[start]) {
        const piece = text.slice(start, i);
        out.push(cls[start] ? <span key={start} className={cls[start]!}>{piece}</span> : piece);
        start = i;
      }
    }
    return out;
  }, [text, literal]);
  // The trailing space keeps a final empty line as tall as it is in the textarea.
  return <>{nodes} </>;
}

function Editor({ value, onChange, literal, disabled }: { value: string; onChange: (v: string) => void; literal: boolean; disabled: boolean }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLPreElement>(null);
  const sync = () => {
    if (backdrop.current && area.current) backdrop.current.scrollTop = area.current.scrollTop;
  };
  useEffect(sync, [value]);

  /** Replace the selection, keeping the browser's undo history where possible. */
  const insert = (text: string, select?: [number, number]) => {
    const el = area.current;
    if (!el) return;
    el.focus();
    const start = el.selectionStart;
    if (!document.execCommand?.("insertText", false, text)) {
      el.setRangeText(text, el.selectionStart, el.selectionEnd, "end");
      onChange(el.value);
    }
    if (select) el.setSelectionRange(start + select[0], start + select[1]);
  };

  const wrap = (mark: string) => {
    const el = area.current;
    if (!el) return;
    const picked = el.value.slice(el.selectionStart, el.selectionEnd);
    const core = picked.trim() || "text";
    const lead = picked.slice(0, picked.length - picked.trimStart().length);
    insert(`${lead}${mark}${core}${mark}${picked.trim() ? picked.slice(picked.trimEnd().length) : ""}`, [lead.length + mark.length, lead.length + mark.length + core.length]);
  };

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" icon={<Bold size={14} />} disabled={disabled || literal} onClick={() => wrap("**")} title="Bold (Ctrl+B)">Bold</Button>
        <Button size="sm" variant="ghost" icon={<Italic size={14} />} disabled={disabled || literal} onClick={() => wrap("*")} title="Italic (Ctrl+I)">Italic</Button>
        <span className="text-[11px] text-muted ml-1 hidden sm:inline">
          <code className="font-mono">**bold**</code> · <code className="font-mono">*italic*</code> · <code className="font-mono"># heading</code> — or paste formatted text
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Eraser size={14} />} disabled={disabled || !value} onClick={() => onChange("")}>Clear</Button>
      </div>
      <div className={cx("typer-editor flex-1 min-h-[240px] rounded-xl bg-hover border border-line focus-within:border-accent focus-within:ring-2 focus-within:ring-[var(--glow)] transition overflow-hidden", disabled && "opacity-70")}>
        <pre ref={backdrop} aria-hidden>
          <Highlight text={value} literal={literal} />
        </pre>
        <textarea
          ref={area}
          value={value}
          disabled={disabled}
          spellCheck={false}
          aria-label="Text to type"
          placeholder={"Type or paste the text to be typed for you.\n\nFormatting carries over: **bold**, *italic* and # headings are typed as real formatting, never as symbols."}
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={(e) => {
            if (literal || !(e.ctrlKey || e.metaKey) || e.altKey) return;
            const k = e.key.toLowerCase();
            if (k === "b" || k === "i") {
              e.preventDefault();
              wrap(k === "b" ? "**" : "*");
            }
          }}
          onPaste={(e) => {
            if (literal) return;
            const html = e.clipboardData.getData("text/html");
            if (!html) return;
            // Keep bold / italic / headings from Word, Google Docs or a web page as markers.
            const marked = htmlToMarkup(html);
            if (marked && marked !== prepareText(marked, "strip").text) {
              e.preventDefault();
              insert(marked);
            }
          }}
        />
      </div>
    </div>
  );
}

function Num({ label, hint, value, min, max, step = 1, onChange, disabled }: { label: string; hint?: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <Field label={label} hint={hint}>
      <Input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? NaN : Math.min(max, Math.max(min, Number(e.target.value))))} />
    </Field>
  );
}

export default function TyperView() {
  const { options, shortcut, idleReturn, idleReturnMin } = useNexus((s) => ({
    options: s.settings.typer,
    shortcut: s.settings.shortcuts.toggleTyper,
    idleReturn: s.settings.typerIdleReturn,
    idleReturnMin: s.settings.typerIdleReturnMin,
  }));
  const { text, status, starting, setText, start, stop } = useTyper();
  const busy = isBusy(status) || starting;
  const set = <K extends keyof TyperOptions>(k: K, v: TyperOptions[K]) => void nexus().setSetting("typer", { ...nexus().settings.typer, [k]: v });
  const literal = options.format === "literal";

  // The start/stop key is only taken from other apps while this screen is open.
  useEffect(() => {
    void typerShortcut(true);
    return () => void typerShortcut(false);
  }, [shortcut]);

  // Left open and untouched, this screen hands back to the dashboard. Idle time is
  // system-wide (any keyboard or mouse input resets it), and the check lives in this
  // component, so it only ever runs while the Auto Typer screen is the one showing.
  useEffect(() => {
    if (!idleReturn) return;
    let alive = true;
    const check = async () => {
      const t = useTyper.getState();
      const idle = await idleSeconds().catch(() => 0);
      if (!alive || !shouldLeaveTyper({ enabled: true, minutes: idleReturnMin, idleSeconds: idle, busy: isBusy(t.status) || t.starting })) return;
      alive = false;
      useUI.getState().setView("dashboard");
      nexus().toast({ kind: "info", title: "Back on the Dashboard", body: "The Auto Typer screen was idle. Your text and settings are still there.", ttl: 8000 });
    };
    const iv = setInterval(() => void check(), 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [idleReturn, idleReturnMin]);

  // A rough length for the run; every run differs, so this is planned once per change and only as a guide.
  const [estimate, setEstimate] = useState<{ seconds: number; chars: number } | null>(null);
  useEffect(() => {
    if (!text.trim() || text.length > 30_000) return setEstimate(null);
    const t = setTimeout(() => {
      const plan = buildPlan(text, options);
      setEstimate({ seconds: plan.duration, chars: plan.chars });
    }, 350);
    return () => clearTimeout(t);
  }, [text, options]);

  const stopKeys = (
    <>
      {shortcut && <Kbd>{accel(shortcut)}</Kbd>}
      {shortcut && " or "}
      <Kbd>Esc</Kbd>
    </>
  );
  let headline: ReactNode;
  let detail: ReactNode;
  switch (status.state) {
    case "countdown":
      headline = `Starting in ${status.secondsLeft ?? 0}…`;
      detail = "Click into the text box you want the text typed in.";
      break;
    case "waiting":
      headline = "Waiting for you";
      detail = "Click into the text box you want the text typed in. NEXUS never types into its own window.";
      break;
    case "typing":
      headline = `Typing… ${Math.round(status.progress * 100)}%`;
      detail = status.locked ? <>Locked onto the text box: mouse clicks are ignored. Press {stopKeys} to stop.</> : <>Press {stopKeys} to stop.</>;
      break;
    case "paused":
      headline = "Paused";
      detail = <>Go back to the window you were typing in and it carries on from the same place. Press {stopKeys} to stop.</>;
      break;
    case "done":
      headline = "Done";
      detail = "Everything was typed.";
      break;
    case "stopped":
      headline = "Stopped";
      detail = status.progress > 0 ? `Stopped at ${Math.round(status.progress * 100)}%.` : "Cancelled before typing began.";
      break;
    case "error":
      headline = "Couldn't start";
      detail = status.message;
      break;
    default:
      headline = "Ready";
      detail = native ? <>Press Start{shortcut && <> or <Kbd>{accel(shortcut)}</Kbd> from any app while this screen is open</>}, then click into the text box to type in.</> : "Typing runs in the NEXUS desktop app for Windows. You can prepare text and settings here.";
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold">Auto Typer</h1>
          <p className="text-sm text-muted">Types your text into any app with a human rhythm: varied speed, pauses, typos that get corrected, and later revisions. The finished text always matches yours.</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)] items-start">
        <Card className="flex flex-col min-h-[420px]">
          <CardHeader
            title="Text to type"
            icon={<Keyboard size={16} />}
            right={estimate && <span className="text-xs text-muted tabular">{estimate.chars.toLocaleString()} characters · about {clock(estimate.seconds)}</span>}
          />
          <div className="px-5 pb-5 flex flex-col flex-1 min-h-0">
            <Editor value={text} onChange={setText} literal={literal} disabled={busy} />
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card glow={busy}>
            <div className="p-5 flex flex-col gap-3">
              <div className="flex items-center gap-3">
                {busy ? (
                  <Button variant="danger" size="lg" icon={<Square size={15} />} onClick={() => void stop()} disabled={status.locked} title={status.locked ? "Clicks are blocked while locked: use the keyboard to stop" : undefined}>Stop</Button>
                ) : (
                  <Button variant="primary" size="lg" icon={<Play size={16} />} onClick={() => void start()} disabled={!text.trim()}>Start</Button>
                )}
                <div className="min-w-0">
                  <p className="font-semibold text-fg flex items-center gap-1.5" role="status" aria-live="polite">
                    {status.locked && <Lock size={13} className="text-accent" />}
                    <span className={cx(status.state === "error" && "text-danger", status.state === "done" && "text-success")}>{headline}</span>
                  </p>
                  <p className="text-xs text-muted">{detail}</p>
                </div>
              </div>
              {(busy || status.state === "stopped" || status.state === "done") && <ProgressBar value={status.state === "countdown" ? 0 : status.progress} tone={status.state === "done" ? "success" : "accent"} />}
            </div>
          </Card>

          <Card>
            <CardHeader title="Rhythm" />
            <div className="px-5 pb-5 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Num label="Speed (WPM)" hint="Raw keying speed; pauses make the overall pace slower." value={options.wpm} min={5} max={250} disabled={busy} onChange={(v) => set("wpm", v)} />
                <Num label="Mistakes (% of keys)" hint="Typos that are made and then fixed." value={options.mistakes} min={0} max={20} step={0.5} disabled={busy} onChange={(v) => set("mistakes", v)} />
                <Num label="Pauses (% of normal)" value={options.pauses} min={0} max={500} step={10} disabled={busy} onChange={(v) => set("pauses", v)} />
                <Num label="Countdown (seconds)" value={options.countdown} min={0} max={600} disabled={busy} onChange={(v) => set("countdown", v)} />
                <Num label="Repeat" hint={`1–${MAX_REPEAT} times`} value={options.repeat} min={1} max={MAX_REPEAT} disabled={busy} onChange={(v) => set("repeat", v)} />
                <Field label="Technique">
                  <Select value={options.technique} disabled={busy} onChange={(e) => set("technique", e.target.value as TyperOptions["technique"])}>
                    <option value="touch">Touch typing</option>
                    <option value="two-finger">Two-finger</option>
                    <option value="one-handed">One-handed</option>
                  </Select>
                </Field>
              </div>
              <Field label="Formatting" hint={options.format === "apply" ? "Uses Ctrl+B / Ctrl+I, for editors such as Word or Google Docs. In a plain text box pick “Drop markers”." : undefined}>
                <Select value={options.format} disabled={busy} onChange={(e) => set("format", e.target.value as TyperOptions["format"])}>
                  <option value="apply">Apply bold / italic</option>
                  <option value="strip">Drop markers, type plain</option>
                  <option value="literal">Type exactly as written</option>
                </Select>
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Behaviour" right={<Button size="sm" variant="ghost" disabled={busy} onClick={() => void nexus().setSetting("typer", DEFAULT_TYPER)}>Reset</Button>} />
            <div className="px-5 pb-4 flex flex-col">
              <Toggle checked={options.lock} disabled={busy} onChange={(v) => set("lock", v)} label="Lock onto the text box" description="Ignores mouse clicks while typing, so a click can't move the cursor to another box, and pauses if the window changes." />
              <Toggle checked={options.revise} disabled={busy} onChange={(v) => set("revise", v)} label="Revise with arrow keys and Delete" description="Off: corrections use Backspace only (safer in apps with autocomplete)." />
              <Toggle checked={options.usShift} disabled={busy} onChange={(v) => set("usShift", v)} label="US keyboard layout" description="Holds Shift for symbols like a person would. Turn off for other layouts." />
              <Toggle checked={options.enterAfter} disabled={busy} onChange={(v) => set("enterAfter", v)} label="Press Enter after each repeat" />
            </div>
          </Card>
        </div>
      </div>
      <p className="text-[11px] text-muted max-w-3xl">
        The target should be a plain text field: autocorrect, auto-indent or auto-closing brackets in the other app can throw corrections off. Caps Lock is switched off while typing and restored afterwards.
      </p>
    </div>
  );
}
