import { create } from "zustand";
import { nexus } from "@/store";
import { listenTo, native, typerStart, typerStatus, typerStop, type TyperStatus } from "@/lib/platform";
import { buildPlan } from "./engine";

const TEXT_KEY = "nexus.typer.text";
const IDLE: TyperStatus = { state: "idle", secondsLeft: null, progress: 0, locked: false, message: null };

const loadText = () => {
  try {
    return localStorage.getItem(TEXT_KEY) ?? "";
  } catch {
    return "";
  }
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

interface TyperStore {
  /** Text to type, with its formatting markers. Kept on this PC only. */
  text: string;
  status: TyperStatus;
  /** True between pressing Start and the native side taking over. */
  starting: boolean;
  setText(text: string): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
}

export const isBusy = (s: TyperStatus) => s.state === "countdown" || s.state === "waiting" || s.state === "typing" || s.state === "paused";

export const useTyper = create<TyperStore>((set, get) => ({
  text: loadText(),
  status: IDLE,
  starting: false,
  setText: (text) => {
    set({ text });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(TEXT_KEY, text);
      } catch {
        /* storage full or unavailable: the text still works for this session */
      }
    }, 400);
  },
  start: async () => {
    if (get().starting || isBusy(get().status)) return;
    const toast = nexus().toast;
    const options = nexus().settings.typer;
    if (!get().text.trim()) {
      toast({ kind: "warning", title: "Nothing to type", body: "Add some text to the Auto Typer first.", ttl: 4000 });
      return;
    }
    if (!native) {
      toast({ kind: "info", title: "Auto Typer runs in the desktop app", body: "It sends real keystrokes through Windows, which a browser preview can't do.", ttl: 6000 });
      return;
    }
    set({ starting: true });
    try {
      const plan = buildPlan(get().text, options);
      await typerStart({ events: plan.events, countdown: Math.min(600, Math.max(0, Math.round(options.countdown) || 0)), lock: options.lock });
    } catch (e) {
      set({ status: { ...IDLE, state: "error", message: String(e) } });
      toast({ kind: "error", title: "Auto Typer couldn't start", body: String(e) });
    } finally {
      set({ starting: false });
    }
  },
  stop: async () => {
    await typerStop();
  },
  toggle: async () => {
    if (isBusy(get().status)) await get().stop();
    else await get().start();
  },
}));

let wired = false;

/**
 * Listen for native status updates and the global start/stop shortcut.
 * Called once from the main window, so the shortcut works on any screen.
 */
export function initTyper() {
  if (wired) return;
  wired = true;
  void typerStatus().then((s) => s && useTyper.setState({ status: s }));
  void listenTo<TyperStatus>("nexus://typer", (status) => useTyper.setState({ status }));
  void listenTo("nexus://typer-toggle", () => void useTyper.getState().toggle());
}
