import { native, invokeSafe } from "@/lib/platform";

/**
 * Speech capture — one utterance per button press, never continuous.
 * Engine order for "auto": Windows native (WinRT, desktop app) → WebView
 * SpeechRecognition (if the runtime provides it) → keyboard fallback.
 */

export type EngineChoice = "auto" | "native" | "web" | "keyboard";

interface WebRecognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> & { length: number } }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

function webCtor(): (new () => WebRecognition) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as (new () => WebRecognition) | null;
}

export function webSpeechAvailable(): boolean {
  return typeof window !== "undefined" && webCtor() != null;
}

export interface ListenHandle {
  promise: Promise<string>;
  cancel(): void;
}

function listenWeb(lang: string, onInterim?: (t: string) => void): ListenHandle {
  const Ctor = webCtor();
  if (!Ctor) return { promise: Promise.reject(new Error("Speech recognition isn't available here. Type your command instead.")), cancel() {} };
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  let finalText = "";
  let settled = false;
  const promise = new Promise<string>((resolve, reject) => {
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      finalText = text;
      onInterim?.(text);
    };
    rec.onerror = (e) => {
      settled = true;
      const msg =
        e.error === "not-allowed" ? "Microphone access was blocked. Allow it in Windows privacy settings."
        : e.error === "no-speech" ? "I didn't hear anything. Try again or type the command."
        : e.error === "network" ? "The speech service is unreachable. Type your command instead."
        : `Speech recognition error (${e.error}).`;
      reject(new Error(msg));
    };
    rec.onend = () => {
      if (settled) return;
      settled = true;
      if (finalText.trim()) resolve(finalText.trim());
      else reject(new Error("I didn't catch that — try again or type the command."));
    };
  });
  rec.start();
  return { promise, cancel: () => rec.abort() };
}

function listenNative(lang: string): ListenHandle {
  return {
    promise: invokeSafe<string>("speech_listen", { language: lang, timeoutSecs: 10 }),
    cancel() {
      /* WinRT recognition ends on silence; result is simply ignored */
    },
  };
}

export function listen(choice: EngineChoice, lang: string, onInterim?: (t: string) => void): ListenHandle {
  if (choice === "keyboard") return { promise: Promise.reject(new Error("Voice input is turned off — type your command.")), cancel() {} };
  if (choice === "native" || (choice === "auto" && native)) {
    const h = listenNative(lang);
    if (choice === "native" || !webSpeechAvailable()) return h;
    // auto: fall back to web speech if the native engine is unavailable
    let inner: ListenHandle | null = null;
    return {
      promise: h.promise.catch((err: unknown) => {
        const msg = String(err instanceof Error ? err.message : err);
        if (/privacy|language pack/i.test(msg)) throw err instanceof Error ? err : new Error(msg);
        inner = listenWeb(lang, onInterim);
        return inner.promise;
      }),
      cancel: () => inner?.cancel(),
    };
  }
  return listenWeb(lang, onInterim);
}

export function voiceSupported(choice: EngineChoice): boolean {
  if (choice === "keyboard") return false;
  return native || webSpeechAvailable();
}
