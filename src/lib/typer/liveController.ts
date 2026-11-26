import { create } from "zustand";
import { nexus } from "@/store";
import { native, pickRegion, regionFrame, screenRead, startDictation, typerStart, typerStop, type ScreenRegion } from "@/lib/platform";
import { listen } from "@/lib/voice/engine";
import { buildPlan } from "./engine";
import { isBusy, useTyper } from "./controller";
import { NEW_DICTATION, backspaceEvents, dictate, type DictationState } from "./live";
import { Stitcher, layout, render } from "./extract";

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
  /** Extraction from the screen: lines taken so far, how many the last reading added, readings made, and whether the text is ready to be typed. */
  extract: { lines: number; added: number; readings: number; aligned: boolean; done: boolean };
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
  /** Start extracting from the region into the editing pad. `resume` carries on with the text already extracted. */
  startScreen(resume?: boolean): Promise<void>;
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
/** The document being extracted from the screen, kept between Stop and Continue. */
const stitcher = new Stitcher();
/** What was in the pad before the extraction began. */
let padBase = "";
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

    startScreen: async (resume = false) => {
      if (get().running) return;
      const region = get().region;
      if (!region) {
        set({ error: "Select the part of the screen to extract from first." });
        return;
      }
      const mine = ++session;
      const pad = useTyper.getState();
      const marks = nexus().settings.typer.format !== "literal";
      if (!resume || !stitcher.lines.length) {
        stitcher.reset();
        // what is already in the pad stays; the extraction is written after it
        padBase = pad.text.trimEnd();
      }
      let written = "";
      const write = () => {
        const text = render(stitcher.lines, marks);
        if (text === written) return;
        written = text;
        useTyper.getState().setText(padBase && text ? `${padBase}\n\n${text}` : padBase || text);
      };
      set((s) => ({ running: true, source: "screen", phase: "reading", error: null, waiting: 0, extract: { ...s.extract, lines: stitcher.lines.length, added: 0, done: false } }));
      void regionFrame(region, "reading");
      let failures = 0;
      while (mine === session) {
        try {
          const seen = layout(await screenRead(region));
          if (mine !== session) break;
          failures = 0;
          const r = stitcher.feed(seen);
          write();
          set((s) => ({ input: seen.map((l) => l.text), fresh: r.fresh, phase: r.added ? "typing" : "reading", extract: { lines: stitcher.lines.length, added: r.added, readings: s.extract.readings + 1, aligned: r.aligned, done: false } }));
          void regionFrame(region, r.added ? "found" : "reading");
        } catch (e) {
          if (mine !== session) break;
          if (++failures >= 3) {
            void regionFrame(null);
            return finish(mine, e instanceof Error ? e.message : String(e));
          }
        }
        await sleep(Math.max(0.3, get().interval) * 1000);
      }
    },

    stop: async () => {
      const wasScreen = get().source === "screen";
      session += 1;
      stopListening?.();
      stopListening = null;
      if (wasScreen) void regionFrame(null);
      set((s) => ({ running: false, phase: "idle", source: null, interim: "", extract: wasScreen ? { ...s.extract, added: 0, done: stitcher.lines.length > 0 } : s.extract }));
      if (native && isBusy(useTyper.getState().status)) await typerStop().catch(() => {});
    },
  };
});
