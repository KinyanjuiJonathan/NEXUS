import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Bold, Eraser, Heading, Italic, Keyboard, Lock, Mic, Play, Redo2, RemoveFormatting, ScanText, Square, Undo2 } from "lucide-react";
import { useNexus, nexus } from "@/store";
import { idleSeconds, native, typerShortcut } from "@/lib/platform";
import { shouldLeaveTyper } from "@/lib/typer/idle";
import { useUI } from "@/store/ui";
import { DEFAULT_TYPER, MAX_REPEAT, buildPlan, htmlToMarkup, markupToHtml, prepareText, type TyperOptions } from "@/lib/typer/engine";
import { isBusy, useTyper } from "@/lib/typer/controller";
import { LiveTyper } from "@/components/LiveTyper";
import { useLive } from "@/lib/typer/liveController";
import { Button, Card, CardHeader, Field, Input, Kbd, ProgressBar, Segmented, Select, Toggle, cx } from "@/components/ui";

const accel = (s: string) => s.replace("CommandOrControl", "Ctrl");
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/**
 * The editing pad. It works like a word processor: select with the mouse or
 * Shift+arrows, type over a selection, Backspace and Delete, Ctrl+B / Ctrl+I,
 * Ctrl+Z / Ctrl+Y, and formatting shown as formatting (no ** markers). What is
 * stored and typed is still the marked-up text, converted both ways here.
 * "Type exactly as written" uses a plain text box instead.
 */
function Editor({ value, onChange, literal, disabled, follow }: { value: string; onChange: (v: string) => void; literal: boolean; disabled: boolean; /** Keep the end of the text in view while it is being filled in. */ follow?: boolean }) {
  const pad = useRef<HTMLDivElement>(null);
  const plainPad = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!follow) return;
    for (const el of [pad.current, plainPad.current]) if (el) el.scrollTop = el.scrollHeight;
  }, [value, follow]);
  /** The markup this pad last produced: an outside change (Clear, loading) is anything else. */
  const emitted = useRef<string | null>(null);
  const [fmt, setFmt] = useState({ bold: false, italic: false, heading: false });

  useEffect(() => {
    const el = pad.current;
    if (!el || literal || value === emitted.current) return;
    el.innerHTML = value ? markupToHtml(value) : "";
    emitted.current = value;
  }, [value, literal]);

  const emit = () => {
    const el = pad.current;
    if (!el) return;
    // an emptied pad can keep a stray <br> or empty block
    const text = el.textContent ? htmlToMarkup(el.innerHTML, { exact: true }) : "";
    if (!el.textContent && el.innerHTML) el.innerHTML = "";
    emitted.current = text;
    onChange(text);
  };
  const refresh = () => {
    const el = pad.current;
    const sel = document.getSelection();
    if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
    let block = "";
    try {
      block = String(document.queryCommandValue("formatBlock")).toLowerCase();
    } catch {
      /* not supported: the button just does not light up */
    }
    setFmt({ bold: document.queryCommandState("bold"), italic: document.queryCommandState("italic"), heading: /^h[1-6]$/.test(block) });
  };
  useEffect(() => {
    document.addEventListener("selectionchange", refresh);
    return () => document.removeEventListener("selectionchange", refresh);
  }, []);

  const cmd = (name: string, arg?: string) => {
    pad.current?.focus();
    document.execCommand(name, false, arg);
    emit();
    refresh();
  };

  if (literal) {
    return (
      <div className="flex flex-col gap-2 min-h-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted">Typed exactly as written, symbols included.</span>
          <Button size="sm" variant="ghost" className="ml-auto" icon={<Eraser size={14} />} disabled={disabled || !value} onClick={() => onChange("")}>Clear</Button>
        </div>
        <textarea
          ref={plainPad}
          value={value}
          disabled={disabled}
          spellCheck={false}
          aria-label="Text to type"
          placeholder="Type or paste the text to be typed for you."
          onChange={(e) => onChange(e.target.value)}
          className={cx("typer-pad flex-1 min-h-[240px] rounded-xl bg-hover border border-line focus:border-accent focus:ring-2 focus:ring-[var(--glow)] transition resize-none font-mono text-[13px]", disabled && "opacity-70")}
        />
      </div>
    );
  }

  const tool = (on: boolean) => cx(on && "!text-accent !bg-[color-mix(in_oklab,var(--accent)_14%,transparent)]");
  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Formatting">
        <Button size="sm" variant="ghost" icon={<Bold size={14} />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("bold")} title="Bold (Ctrl+B)" aria-pressed={fmt.bold} className={tool(fmt.bold)}>Bold</Button>
        <Button size="sm" variant="ghost" icon={<Italic size={14} />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("italic")} title="Italic (Ctrl+I)" aria-pressed={fmt.italic} className={tool(fmt.italic)}>Italic</Button>
        <Button size="sm" variant="ghost" icon={<Heading size={14} />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("formatBlock", fmt.heading ? "div" : "h3")} title="Heading (typed bold)" aria-pressed={fmt.heading} className={tool(fmt.heading)}>Heading</Button>
        <Button size="sm" variant="ghost" icon={<RemoveFormatting size={14} />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => { cmd("removeFormat"); if (fmt.heading) cmd("formatBlock", "div"); }} title="Remove formatting from the selection">Plain</Button>
        <span className="w-px h-5 bg-line mx-1" />
        <Button size="sm" variant="ghost" icon={<Undo2 size={14} />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("undo")} title="Undo (Ctrl+Z)" aria-label="Undo" />
        <Button size="sm" variant="ghost" icon={<Redo2 size={14} />} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("redo")} title="Redo (Ctrl+Y)" aria-label="Redo" />
        <Button size="sm" variant="ghost" disabled={disabled || !value} onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("selectAll")} title="Select everything (Ctrl+A)">Select all</Button>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Eraser size={14} />} disabled={disabled || !value} onClick={() => onChange("")}>Clear</Button>
      </div>
      <div
        ref={pad}
        role="textbox"
        aria-multiline="true"
        aria-label="Text to type"
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder={"Type or paste the text to be typed for you.\n\nSelect text and press Ctrl+B or Ctrl+I, or use the buttons above. Formatting pasted from Word, Google Docs or a web page is kept. It is typed as real formatting, never as symbols."}
        className={cx("typer-pad typer-rich flex-1 min-h-[240px] rounded-xl bg-hover border border-line focus:border-accent focus:ring-2 focus:ring-[var(--glow)] transition", disabled && "opacity-70")}
        onInput={emit}
        onKeyDown={(e) => {
          if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            document.execCommand("insertText", false, "\t");
          }
        }}
        onPaste={(e) => {
          // Keep only bold, italic and headings from what is pasted; fonts, colours and sizes are dropped.
          e.preventDefault();
          const html = e.clipboardData.getData("text/html");
          const plain = e.clipboardData.getData("text/plain");
          const marked = html ? htmlToMarkup(html) : "";
          if (marked && marked !== prepareText(marked, "strip").text) document.execCommand("insertHTML", false, markupToHtml(marked));
          else document.execCommand("insertText", false, plain || prepareText(marked, "strip").text);
        }}
        onDrop={(e) => e.preventDefault()}
      />
    </div>
  );
}

/**
 * Capturing text from the screen, as one row above the editing pad.
 *
 * "Reading region" puts a frame on the screen that can be dragged and resized.
 * Nothing is read until you right-click inside it; each right-click captures
 * what the region shows and adds what is new to the pad, in reading order,
 * without changing what is already there. "Close region" takes the frame away.
 */
function ExtractBar({ text, literal, busy }: { text: string; literal: boolean; busy: boolean }) {
  const live = useLive();
  const open = live.regionOpen;
  const x = live.extract;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(literal ? text : prepareText(text, "strip").text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      nexus().toast({ kind: "warning", title: "Could not copy", body: "Select the text in the box and press Ctrl+C.", ttl: 5000 });
    }
  };
  return (
    <div className={cx("extract-bar rounded-xl border px-2.5 py-2 mb-2 flex flex-wrap items-center gap-2", open ? "extract-on" : "border-line")}>
      {open ? (
        <Button size="sm" variant="danger" icon={<Square size={13} />} onClick={() => void live.closeRegion()} title="Take the reading region off the screen. Nothing more is captured.">Close region</Button>
      ) : (
        <Button size="sm" variant="soft" icon={<ScanText size={14} />} disabled={busy || !native} onClick={() => void live.openRegion()} title={native ? "Mark a reading region on the screen: NEXUS steps aside, you press where the region starts, drag to the opposite corner and let go. Then right-click inside it to capture the text it shows." : "The reading region runs in the NEXUS desktop app for Windows."}>
          Reading region
        </Button>
      )}
      <span role="status" aria-live="polite" className={cx("text-xs tabular min-w-0 truncate", live.error ? "text-danger" : open ? (x.added ? "text-success font-medium" : "text-accent font-medium") : "text-muted")}>
        {live.error ? (
          live.error
        ) : open ? (
          <>
            <span className={cx("inline-block h-1.5 w-1.5 rounded-full bg-current mr-1.5 align-middle", live.capturing && "animate-pulse")} />
            {live.capturing
              ? "Reading…"
              : x.readings === 0
                ? "Region is on screen. Right-click inside it to capture."
                : x.added
                  ? `+${x.added} line${x.added === 1 ? "" : "s"} added · ${x.lines} captured`
                  : `Nothing new in that capture · ${x.lines} captured`}
          </>
        ) : x.done ? (
          `Captured ${x.lines} line${x.lines === 1 ? "" : "s"}. Edit, copy, or press Start to type it.`
        ) : native ? (
          "Capture text from the screen: mark the region by dragging, then right-click inside it. Nothing is read otherwise."
        ) : (
          "Capturing from the screen runs in the Windows desktop app."
        )}
      </span>
      <Button size="sm" variant="ghost" className="ml-auto" icon={copied ? <Check size={13} /> : <Copy size={13} />} disabled={!text.trim()} onClick={() => void copy()} title="Copy all the text in the box">{copied ? "Copied" : "Copy"}</Button>
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
  const capturing = useLive((s) => s.regionOpen);

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
      if (!alive || !shouldLeaveTyper({ enabled: true, minutes: idleReturnMin, idleSeconds: idle, busy: isBusy(t.status) || t.starting || useLive.getState().running })) return;
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
  // Where the text comes from: written here, spoken, or read off a part of the screen.
  const [source, setSource] = useState<"text" | "voice">("text");
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
      detail = status.locked ? <>Locked onto the text box: clicks on other apps are ignored. Click Stop here, or press {stopKeys}.</> : <>Press {stopKeys} to stop.</>;
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
            title={source === "text" ? "Text to type" : "Dictate: your voice in, typing out"}
            icon={source === "text" ? <Keyboard size={16} /> : <Mic size={16} />}
            right={
              <div className="flex items-center gap-3">
                {source === "text" && estimate && <span className="text-xs text-muted tabular hidden md:inline">{estimate.chars.toLocaleString()} characters · about {clock(estimate.seconds)}</span>}
                <Segmented
                  size="sm"
                  value={source}
                  onChange={setSource}
                  options={[
                    { value: "text", label: "Text", title: "Type text you wrote or pasted" },
                    { value: "voice", label: "Voice", title: "Speak, and NEXUS types what you say into another app" },
                  ]}
                />
              </div>
            }
          />
          <div className="px-5 pb-5 flex flex-col flex-1 min-h-0">
            {source === "text" ? (
              <>
                <ExtractBar text={text} literal={literal} busy={busy} />
                <Editor value={text} onChange={setText} literal={literal} disabled={busy} follow={capturing} />
              </>
            ) : (
              <LiveTyper source="voice" />
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          {/* Start / Stop for typed text; the live sources have their own controls beside the input */}
          {source === "text" && (
          <Card glow={busy}>
            <div className="p-5 flex flex-col gap-3">
              <div className="flex items-center gap-3">
                {busy ? (
                  <Button variant="danger" size="lg" icon={<Square size={15} />} onClick={() => void stop()} title={status.locked ? "Stops the typing. Clicks on NEXUS work even while locked onto the text box." : undefined}>Stop</Button>
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
          )}

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
              <Toggle checked={options.lock} disabled={busy} onChange={(v) => set("lock", v)} label="Lock onto the text box" description="Ignores mouse clicks on other apps while typing, so a click can't move the cursor to another box, and pauses if the window changes. Clicks on NEXUS still work, so you can always press Stop." />
              <Toggle checked={options.revise} disabled={busy} onChange={(v) => set("revise", v)} label="Revise with arrow keys" description="Off: corrections use Backspace only (safer in apps with autocomplete)." />
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
