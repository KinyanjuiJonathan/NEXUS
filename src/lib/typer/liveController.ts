import { create } from "zustand";
import { nexus } from "@/store";
import { native, pickRegion, screenRead, typerStart, typerStop, type ScreenRegion } from "@/lib/platform";
import { listen } from "@/lib/voice/engine";
import { buildPlan } from "./engine";
import { isBusy, useTyper } from "./controller";
import { NEW_DICTATION, ScreenFollower, backspaceEvents, dictate, type DictationState } from "./live";

export type LiveSource = "voice" | "screen";
export type LivePhase = "idle" | "listening" | "reading" | "typing";

interface LiveStore {
  source: LiveSource | null;
  running: boolean;
  phase: LivePhase;
  /** What came in: phrases heard, or the latest reading of the screen. */
  input: string[];
  /** Everything typed so far in this session. */
  output: string;
  /** Text waiting to be typed. */
  waiting: number;
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
  set(patch: Partial<Pick<LiveStore, "interval" | "joiner" | "includeExisting" | "fullStop" | "toApp">>): void;
  chooseRegion(): Promise<void>;
  readOnce(): Promise<void>;
  startVoice(): Promise<void>;
  startScreen(): Promise<void>;
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
          const plan = text ? buildPlan(text, { ...o, format: "literal", repeat: 1, enterAfter: false, countdown: 0 }) : null;
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
    set({ running: false, phase: "idle", source: null, error });
  };

  return {
    source: null,
    running: false,
    phase: "idle",
    input: [],
    output: "",
    waiting: 0,
    error: null,
    region: loadRegion(),
    interval: 1,
    joiner: "newline",
    includeExisting: false,
    fullStop: false,
    toApp: true,
    set: (patch) => set(patch),
    clear: () => set({ input: [], output: "", error: null }),

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
        set({ input: await screenRead(region), error: null });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      }
    },

    startVoice: async () => {
      if (get().running) return;
      const mine = ++session;
      queue = Promise.resolve();
      set({ running: true, source: "voice", phase: "listening", error: null, input: [], output: "", waiting: 0 });
      const { voiceEngine, voiceLanguage } = nexus().settings;
      let state: DictationState = NEW_DICTATION;
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

    startScreen: async () => {
      if (get().running) return;
      const region = get().region;
      if (!region) {
        set({ error: "Select the part of the screen to follow first." });
        return;
      }
      const mine = ++session;
      queue = Promise.resolve();
      set({ running: true, source: "screen", phase: "reading", error: null, output: "", waiting: 0 });
      const follower = new ScreenFollower({ joiner: get().joiner, includeExisting: get().includeExisting });
      let failures = 0;
      while (mine === session) {
        try {
          const lines = await screenRead(region);
          if (mine !== session) return;
          failures = 0;
          set({ input: lines, phase: get().waiting ? "typing" : "reading" });
          send(follower.feed(lines), 0, mine);
        } catch (e) {
          if (mine !== session) return;
          if (++failures >= 3) {
            await queue;
            return finish(mine, e instanceof Error ? e.message : String(e));
          }
        }
        await sleep(Math.max(0.3, get().interval) * 1000);
      }
    },

    stop: async () => {
      session += 1;
      set({ running: false, phase: "idle", source: null });
      if (native && isBusy(useTyper.getState().status)) await typerStop().catch(() => {});
    },
  };
});
