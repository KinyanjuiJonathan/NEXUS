import { create } from "zustand";
import { nexus } from "@/store";
import { closeRegion, native, openRegion, pickRegion, regionNote, screenRead, startDictation, typerStart, typerStop, type ScreenRegion } from "@/lib/platform";
import { listen } from "@/lib/voice/engine";
import { buildPlan } from "./engine";
import { isBusy, useTyper } from "./controller";
import { NEW_DICTATION, backspaceEvents, dictate, type DictationState } from "./live";
import { Stitcher, layout, mergeIntoPad, render } from "./extract";

export type LiveSource = "voice" | "screen";
export type LivePhase = "idle" | "listening" | "reading" | "typing";

interface LiveStore {
  source: LiveSource | null;
  running: boolean;
  phase: LivePhase;
  /** What came in: phrases heard, or the latest reading of the screen. */
  input: string[];
  /** For each line of the latest screen reading: was it new text (true) or already extracted? */
  fresh: boolean[];
  /** Capturing from the screen: lines taken so far, how many the last capture added, captures made, and whether any text has been taken. */
  extract: { lines: number; added: number; readings: number; aligned: boolean; done: boolean };
  /** The reading region is open on the screen. Text is only read when the user right-clicks inside it. */
  regionOpen: boolean;
  /** A capture is being read right now. */
  capturing: boolean;
  /** Put the reading region on the screen (where it was last time). */
  openRegion(): Promise<void>;
  /** Take the region off the screen. Nothing can be captured after this. */
  closeRegion(): Promise<void>;
  /** Everything typed so far in this session. */
  output: string;
  /** Text waiting to be typed. */
  waiting: number;
  /** Words recognised so far in the phrase being spoken. */
  interim: string;
  /** Type fast and without deliberate typos, so the typing keeps up with speech. */
  keepUp: boolean;
  error: string | null;
  region: ScreenRegion | null;
  /** Seconds between readings of the screen. */
  interval: number;
  joiner: "newline" | "space";
  includeExisting: boolean;
  /** End each spoken phrase with a full stop. */
  fullStop: boolean;
  /** Type into the app that has focus, or only show the text in the output box. */
  toApp: boolean;
  set(patch: Partial<Pick<LiveStore, "interval" | "joiner" | "includeExisting" | "fullStop" | "toApp" | "keepUp">>): void;
  chooseRegion(): Promise<void>;
  readOnce(): Promise<void>;
  startVoice(): Promise<void>;
  stop(): Promise<void>;
  clear(): void;
}

const REGION_KEY = "nexus.typer.region";
const loadRegion = (): ScreenRegion | null => {
  try {
    const r = JSON.parse(localStorage.getItem(REGION_KEY) ?? "null") as ScreenRegion | null;
    return r && r.w > 0 && r.h > 0 ? r : null;
  } catch {
    return null;
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Bumped by every start and stop, so a loop from an earlier session ends itself. */
let session = 0;
let queue: Promise<void> = Promise.resolve();
/** What has been captured from the screen while the region is open. Captured text is never changed, only added to. */
const stitcher = new Stitcher(true);
/** The user is marking a region right now. */
let picking = false;
/** Stops listening to the reading region. */
let stopRegion: (() => void) | null = null;
/** Ends the native dictation session, when one is open. */
let stopListening: (() => void) | null = null;

/** Wait until the typer is free (the previous piece has been typed, or typing was stopped). */
async function typerIdle(mine: number) {
  for (let i = 0; i < 6000 && mine === session; i++) {
    if (!isBusy(useTyper.getState().status) && !useTyper.getState().starting) return;
    await sleep(60);
  }
}

export const useLive = create<LiveStore>((set, get) => {
  /** Queue a piece for typing; pieces are typed strictly one after another. */
  const send = (text: string, backspaces: number, mine: number) => {
    if (!text && !backspaces) return;
    set((s) => ({ waiting: s.waiting + 1 }));
    queue = queue.then(async () => {
      try {
        if (mine !== session) return;
        set({ phase: "typing" });
        if (get().toApp && native) {
          await typerIdle(mine);
          if (mine !== session) return;
          const o = nexus().settings.typer;
          // live text is typed as it is: no formatting pass, no repeats, no countdown
          const lead = backspaceEvents(backspaces);
          const at = lead.length ? lead[lead.length - 1].t + 0.12 : 0;
          // "Keep up": quick, steady and without deliberate typos, so a backlog never builds while speaking
          const pace = get().keepUp ? { wpm: Math.max(o.wpm, 140), mistakes: 0, pauses: Math.min(o.pauses, 20) } : {};
          const plan = text ? buildPlan(text, { ...o, ...pace, format: "literal", repeat: 1, enterAfter: false, countdown: 0 }) : null;
          const events = [...lead, ...(plan?.events ?? []).map((e) => ({ t: e.t + at, down: e.down, key: e.key }))];
          if (events.length) {
            await typerStart({ events, countdown: 0, lock: false });
            await sleep(80);
            await typerIdle(mine);
          }
        }
        set((s) => ({ output: Array.from(s.output).slice(0, backspaces ? -backspaces : undefined).join("") + text }));
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        set((s) => ({ waiting: Math.max(0, s.waiting - 1) }));
      }
    });
  };

  const finish = (mine: number, error: string | null = null) => {
    if (mine !== session) return;
    session += 1;
    stopListening?.();
    stopListening = null;
    set({ running: false, phase: "idle", source: null, error });
  };

  return {
    source: null,
    running: false,
    phase: "idle",
    input: [],
    fresh: [],
    extract: { lines: 0, added: 0, readings: 0, aligned: true, done: false },
    regionOpen: false,
    capturing: false,
    output: "",
    waiting: 0,
    interim: "",
    keepUp: true,
    error: null,
    region: loadRegion(),
    interval: 1,
    joiner: "newline",
    includeExisting: false,
    fullStop: false,
    toApp: true,
    set: (patch) => set(patch),
    clear: () => {
      stitcher.reset();
      set({ input: [], fresh: [], output: "", interim: "", error: null, extract: { lines: 0, added: 0, readings: 0, aligned: true, done: false } });
    },

    chooseRegion: async () => {
      try {
        const region = await pickRegion();
        if (!region) return;
        set({ region, error: null });
        try {
          localStorage.setItem(REGION_KEY, JSON.stringify(region));
        } catch {
          /* kept for this session only */
        }
        await get().readOnce();
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    readOnce: async () => {
      const region = get().region;
      if (!region) return;
      try {
        const seen = layout(await screenRead(region));
        set({ input: seen.map((l) => l.text), fresh: seen.map(() => false), error: null });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    startVoice: async () => {
      if (get().running) return;
      const mine = ++session;
      queue = Promise.resolve();
      set({ running: true, source: "voice", phase: "listening", error: null, input: [], output: "", interim: "", waiting: 0 });
      const { voiceEngine, voiceLanguage } = nexus().settings;
      let state: DictationState = NEW_DICTATION;

      // In the desktop app one recogniser stays open for the whole session and hands over every phrase,
      // so nothing said between phrases is lost.
      if (native && voiceEngine !== "web") {
        try {
          stopListening = await startDictation(voiceLanguage, (e) => {
            if (mine !== session) return;
            if (e.kind === "partial") return set({ interim: e.text });
            if (e.kind === "phrase") {
              const step = dictate(e.text, state, { fullStop: get().fullStop });
              state = step.state;
              set((s) => ({ interim: "", input: [...s.input, e.sure ? e.text : `${e.text}  (unsure)`].slice(-200), phase: "typing" }));
              if (step.stop) return void get().stop();
              send(step.type, step.backspaces, mine);
              void queue.then(() => mine === session && set({ phase: "listening" }));
              return;
            }
            // "ended" without being asked, or an error: the session is over
            void queue.then(() => finish(mine, e.kind === "error" ? e.text : null));
          });
        } catch (e) {
          finish(mine, e instanceof Error ? e.message : String(e));
        }
        return;
      }

      let misses = 0;
      while (mine === session) {
        set({ phase: get().waiting ? "typing" : "listening" });
        try {
          const heard = await listen(voiceEngine === "keyboard" ? "auto" : voiceEngine, voiceLanguage).promise;
          if (mine !== session) return;
          misses = 0;
          const step = dictate(heard, state, { fullStop: get().fullStop });
          state = step.state;
          set((s) => ({ input: [...s.input, heard].slice(-200) }));
          if (step.stop) break;
          send(step.type, step.backspaces, mine);
        } catch (e) {
          if (mine !== session) return;
          const msg = e instanceof Error ? e.message : String(e);
          // silence is not an error while dictating: keep listening
          if (/didn't (hear|catch)|no-speech|timed? ?out/i.test(msg)) {
            if (++misses >= 40) break; // a long silence: stop by itself
            continue;
          }
          await queue;
          return finish(mine, msg);
        }
      }
      await queue;
      finish(mine);
    },

    openRegion: async () => {
      if (get().regionOpen || picking) return;
      // The region is marked afresh every time: NEXUS steps aside, the user presses where the region starts,
      // drags to the opposite corner and lets go. Esc or a right-click cancels.
      let start: ScreenRegion | null = null;
      picking = true;
      try {
        start = await pickRegion(true);
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        picking = false;
      }
      if (!start) return;
      const remember = (region: ScreenRegion) => {
        set({ region });
        try {
          localStorage.setItem(REGION_KEY, JSON.stringify(region));
        } catch {
          /* kept for this session only */
        }
      };
      // One capture: read the region as it is now, and add what is new to the pad. Runs only on a right-click inside the region.
      const capture = async (region: ScreenRegion) => {
        if (!get().regionOpen || get().capturing) return;
        set({ capturing: true, error: null });
        try {
          const marks = nexus().settings.typer.format !== "literal";
          const pad = useTyper.getState().text;
          // an emptied pad means a fresh start: nothing earlier to line up with
          if (!pad.trim()) stitcher.reset();
          const before = render(stitcher.lines, marks);
          const count = stitcher.lines.length;
          const seen = layout(await screenRead(region), { height: region.h });
          if (!get().regionOpen) return; // closed while reading: nothing is added
          const r = stitcher.feed(seen);
          if (r.added) {
            const tail = r.added - r.prepended > 0 ? render(stitcher.lines, marks, count + r.prepended) : "";
            // a table's row is set two lines apart from the one before it
            const sep = stitcher.lines[count + r.prepended]?.table ? "\n\n\n" : "\n";
            useTyper.getState().setText(mergeIntoPad(pad, before, render(stitcher.lines, marks), tail, sep));
          }
          set((s) => ({ input: seen.map((l) => l.text), fresh: r.fresh, extract: { lines: stitcher.lines.length, added: r.added, readings: s.extract.readings + 1, aligned: r.aligned, done: stitcher.lines.length > 0 } }));
          void regionNote(seen.length ? (r.added ? `found:${r.added}` : "none") : "empty");
        } catch (e) {
          set({ error: e instanceof Error ? e.message : String(e) });
          void regionNote("error");
        } finally {
          set({ capturing: false });
        }
      };
      try {
        // each time the region is opened is a new piece of work on whatever is in the pad
        stitcher.reset();
        set({ regionOpen: true, error: null, extract: { lines: 0, added: 0, readings: 0, aligned: true, done: false } });
        stopRegion = await openRegion(start, {
          capture: (region) => void capture(region),
          changed: remember,
          closed: () => {
            stopRegion?.();
            stopRegion = null;
            set({ regionOpen: false, capturing: false });
          },
        });
      } catch (e) {
        set({ regionOpen: false, error: e instanceof Error ? e.message : String(e) });
      }
    },

    closeRegion: async () => {
      set({ regionOpen: false, capturing: false });
      await closeRegion();
      stopRegion?.();
      stopRegion = null;
    },

    stop: async () => {
      session += 1;
      stopListening?.();
      stopListening = null;
      set({ running: false, phase: "idle", source: null, interim: "" });
      if (native && isBusy(useTyper.getState().status)) await typerStop().catch(() => {});
    },
  };
});
