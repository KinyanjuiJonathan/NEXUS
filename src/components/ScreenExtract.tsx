import { useEffect, useRef, type ReactNode } from "react";
import { CheckCheck, Crosshair, Eraser, Keyboard, MonitorDot, Play, RefreshCw, RotateCw, ScanText } from "lucide-react";
import { native } from "@/lib/platform";
import { useLive } from "@/lib/typer/liveController";
import { Button, Select, cx } from "./ui";

/**
 * Extract text from a part of the screen into the editing pad.
 *
 * Select the region, start, and scroll the other window: each reading is laid
 * over what was read before, so only new text is added and nothing is taken
 * twice. The region is outlined on the screen while it is read. When you mark
 * the extraction done, the text is in the pad to edit or to type elsewhere.
 * `children` is the editing pad itself.
 */
export function ScreenExtract({ children, onType, hasText }: { children: ReactNode; onType: () => void; hasText: boolean }) {
  const live = useLive();
  const running = live.running && live.source === "screen";
  const other = live.running && live.source !== "screen";
  const r = live.region;
  const x = live.extract;
  const seenRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // keep the newest lines of the reading in view
    if (running && seenRef.current) seenRef.current.scrollTop = seenRef.current.scrollHeight;
  }, [live.input, running]);

  const status = running
    ? x.added
      ? `+${x.added} new line${x.added === 1 ? "" : "s"}`
      : x.readings && !x.aligned
        ? "New place: taking what was not read before"
        : "Reading… scroll the other window for more"
    : x.done
      ? "Extraction done"
      : other
        ? "Dictation is running"
        : "";

  return (
    <div className="flex flex-col gap-3 min-h-0 flex-1">
      {/* 1 · where to read, and start / done */}
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <Button variant="primary" icon={<CheckCheck size={15} />} onClick={() => void live.stop()} title="Stop reading. The text stays in the pad below.">Mark done</Button>
        ) : (
          <Button variant="primary" icon={<ScanText size={15} />} disabled={other || !r} onClick={() => void live.startScreen(false)} title={x.done ? "Start a new extraction; it is added after the text already in the pad" : "Read the region and keep reading as it scrolls"}>
            {x.done ? "New extraction" : "Start extracting"}
          </Button>
        )}
        {!running && x.done && (
          <Button variant="outline" icon={<RotateCw size={14} />} disabled={other || !r} onClick={() => void live.startScreen(true)} title="Carry on where you stopped: text already extracted is not taken again">Continue</Button>
        )}
        <Button variant="outline" icon={<Crosshair size={14} />} disabled={live.running} onClick={() => void live.chooseRegion()} title="NEXUS steps aside; drag a rectangle over the part of the screen to read">
          {r ? "Change region" : "Select region"}
        </Button>
        {r && !running && <Button variant="ghost" icon={<RefreshCw size={14} />} disabled={live.running} onClick={() => void live.readOnce()} title="Read the region once to check what NEXUS sees">Read once</Button>}
        <span role="status" aria-live="polite" className={cx("text-xs font-medium tabular", running && x.added ? "text-success" : running ? "text-accent" : "text-muted")}>{status}</span>
        <span className="ml-auto text-[11px] text-muted tabular">{x.lines ? `${x.lines} line${x.lines === 1 ? "" : "s"} extracted` : r ? `${r.w} × ${r.h} px` : "no region yet"}</span>
      </div>

      {/* 2 · what the region shows right now: new lines lit, lines already taken dimmed */}
      <div className={cx("extract-seen relative rounded-xl border bg-hover overflow-hidden", running ? "extract-on" : "border-line")}>
        <div className="flex items-center gap-2 px-3 pt-2 pb-1">
          <span className={cx("h-1.5 w-1.5 rounded-full", running ? "bg-success animate-pulse" : "bg-[var(--muted)]")} />
          <span className={cx("text-[11px] uppercase tracking-[0.14em] font-semibold", running ? "text-success" : "text-muted")}>{running ? "Reading this part of the screen" : "The region"}</span>
          {running && <span className="text-[10px] text-muted">outlined on the screen · green = new, grey = already extracted</span>}
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-fg-2">
            <MonitorDot size={12} className="text-accent" /> every
            <Select className="!w-20 !h-7 !text-xs" value={String(live.interval)} disabled={live.running} onChange={(e) => live.set({ interval: Number(e.target.value) })} aria-label="Seconds between readings">
              {[0.5, 1, 2, 3].map((s) => <option key={s} value={s}>{s} s</option>)}
            </Select>
          </span>
        </div>
        <div ref={seenRef} className="h-[104px] overflow-y-auto scroll-y px-3 pb-2 text-[12px] leading-snug font-mono whitespace-pre">
          {live.input.length ? (
            live.input.map((line, i) => (
              <div key={i} className={cx("truncate", running && live.fresh[i] ? "extract-new text-success" : running || x.done ? "text-muted" : "text-fg-2")}>{line || " "}</div>
            ))
          ) : (
            <span className="text-muted whitespace-normal font-sans text-[12px]">
              {native ? "Select the part of the screen that holds the text. Press Start extracting, then scroll that window at a steady pace: NEXUS adds what comes into view and skips what it has already read." : "Reading text from the screen runs in the NEXUS desktop app for Windows."}
            </span>
          )}
        </div>
        {running && <span className="extract-scan" aria-hidden />}
      </div>

      {live.error && <p role="alert" className="text-xs text-danger">{live.error}</p>}

      {/* 3 · the editing pad: the extracted text is written here */}
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="uppercase tracking-[0.14em] font-semibold" style={{ color: running ? "var(--accent)" : undefined }}>Extracted text · the editing pad</span>
        <span>{running ? "filling in as you scroll; editing is paused until you mark it done" : "edit it freely"}</span>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Eraser size={13} />} disabled={live.running || (!x.lines && !live.input.length)} onClick={live.clear} title="Forget what was extracted, so the next extraction starts fresh. The pad keeps its text.">Reset</Button>
      </div>
      {children}

      {/* 4 · once done: type it somewhere else */}
      {!running && x.done && (
        <div className="extract-next rounded-xl border px-3 py-2.5 flex flex-wrap items-center gap-3">
          <CheckCheck size={16} className="text-success shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">The extraction is in the pad</div>
            <div className="text-[11px] text-muted">Check or edit it above, then have it typed into another window, with the rhythm set on the right.</div>
          </div>
          <Button variant="primary" icon={native ? <Play size={15} /> : <Keyboard size={15} />} disabled={!hasText} onClick={onType}>Type it into another app</Button>
        </div>
      )}

      <p className="text-[11px] text-muted">
        Text is read with the recognition built into Windows, on this PC; nothing is sent anywhere. Indentation, paragraph gaps and larger text (as headings) are kept. Bold, italic, colours and fonts cannot be recognised from the screen. Scroll so that each step still shows a few lines of the one before: that overlap is how repeats are avoided. <b className="text-fg-2 font-medium">Beta:</b> accuracy depends on text size and contrast.
      </p>
    </div>
  );
}
