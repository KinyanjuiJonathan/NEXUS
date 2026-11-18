import { isTauri } from "@/data/backend";
import type { OverlayMode, Shortcuts } from "@/data/types";

/**
 * Thin wrappers over native capabilities. Each degrades gracefully in a plain
 * browser so the UI can be developed and previewed without the desktop shell.
 */

async function core() {
  return import("@tauri-apps/api/core");
}

export const native = isTauri();

export async function invokeSafe<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await core();
  return invoke<T>(cmd, args);
}

export async function signalReady() {
  if (native) await invokeSafe("main_ready").catch(() => {});
}

// ---------------------------------------------------------------- window controls

export async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function minimizeWindow() {
  if (native) (await currentWindow()).minimize();
}
export async function toggleMaximize() {
  if (native) (await currentWindow()).toggleMaximize();
}
export async function closeWindow() {
  if (native) (await currentWindow()).close();
}
export async function quitApp() {
  if (native) await invokeSafe("app_quit");
}

// ---------------------------------------------------------------- overlay

export interface OverlayState {
  visible: boolean;
  clickThrough: boolean;
  pinned: boolean;
}

export async function setOverlayVisible(visible: boolean) {
  if (native) await invokeSafe("overlay_show", { visible });
}
export async function toggleOverlay() {
  if (native) await invokeSafe("overlay_toggle");
}
export async function setClickThrough(enabled: boolean) {
  if (native) await invokeSafe("overlay_set_click_through", { enabled });
}
export async function setPinned(pinned: boolean) {
  if (native) await invokeSafe("overlay_set_pinned", { pinned });
}
export async function getOverlayState(): Promise<OverlayState> {
  if (!native) return { visible: false, clickThrough: false, pinned: true };
  return invokeSafe<OverlayState>("overlay_state");
}

export async function onOverlayState(cb: (s: OverlayState) => void): Promise<() => void> {
  return listenTo<OverlayState>("nexus://overlay-state", cb);
}

export async function listenTo<T>(event: string, cb: (p: T) => void): Promise<() => void> {
  if (!native) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

export async function resizeOverlay(mode: OverlayMode, size: { w: number; h: number }) {
  if (!native) return;
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  const w = await currentWindow();
  await w.setSize(new LogicalSize(size.w, size.h));
  void mode;
}

// ---------------------------------------------------------------- performance

export interface PerfSnapshot {
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  /** Memory in use as a share of installed memory, 0–100. */
  ramPercent: number;
  gpu: number | null;
  gpuName: string | null;
  vramUsed: number | null;
  vramTotal: number | null;
  fps: number | null;
  fpsApp: string | null;
  fpsStatus: "ok" | "idle" | "off" | "no_permission" | "unsupported";
  gpuTemp: number | null;
  cpuTemp: number | null;
}

// ---------------------------------------------------------------- activity monitor

export interface ActivitySnapshot {
  /** False where system-wide activity can't be read (anything but the Windows desktop app). */
  supported: boolean;
  away: boolean;
  since: number | null;
  idleSeconds: number | null;
  locked: boolean;
}

/** Current state of the native activity monitor; null in a plain browser. */
export async function activityState(): Promise<ActivitySnapshot | null> {
  if (!native) return null;
  return invokeSafe<ActivitySnapshot>("activity_state").catch(() => null);
}

/** Tell the monitor how long without input counts as away. */
export async function activityConfigure(idleSeconds: number) {
  if (native) await invokeSafe("activity_configure", { idleSeconds: Math.round(idleSeconds) }).catch(() => {});
}

// ---------------------------------------------------------------- idle detection

let lastLocalInput = Date.now();
if (typeof window !== "undefined") {
  for (const ev of ["mousemove", "mousedown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(ev, () => (lastLocalInput = Date.now()), { passive: true, capture: true });
  }
}

/**
 * Seconds since the last keyboard/mouse input anywhere in Windows. In a plain
 * browser only input inside this page can be seen, so it's an approximation.
 */
export async function idleSeconds(): Promise<number> {
  if (native) {
    const v = await invokeSafe<number | null>("idle_seconds").catch(() => null);
    if (v != null) return v;
  }
  return Math.floor((Date.now() - lastLocalInput) / 1000);
}

/**
 * Live system stats (desktop app only; null in a plain browser).
 * `fps`: true measures the foreground app's frame rate, false stops measuring
 * it, null leaves it alone (for windows that don't show FPS).
 */
export async function perfSnapshot(fps: boolean | null): Promise<PerfSnapshot | null> {
  if (!native) return null;
  return invokeSafe<PerfSnapshot>("perf_snapshot", { fps });
}

export async function perfStop() {
  if (native) await invokeSafe("perf_stop").catch(() => {});
}

// ---------------------------------------------------------------- auto typer

export interface TyperStatus {
  state: "idle" | "countdown" | "waiting" | "typing" | "paused" | "done" | "stopped" | "error";
  secondsLeft: number | null;
  /** 0–1 share of planned keystrokes already sent. */
  progress: number;
  locked: boolean;
  message: string | null;
}

export async function typerStart(job: { events: { t: number; down: boolean; key: string }[]; countdown: number; lock: boolean }) {
  return invokeSafe<void>("typer_start", { job });
}
/** Claim (or give back) the global start/stop shortcut. Returns shortcuts that could not be registered. */
export async function typerShortcut(enabled: boolean): Promise<string[]> {
  if (!native) return [];
  return invokeSafe<string[]>("typer_shortcut", { enabled }).catch(() => []);
}
export async function typerStop() {
  if (native) await invokeSafe("typer_stop").catch(() => {});
}
export async function typerStatus(): Promise<TyperStatus | null> {
  if (!native) return null;
  return invokeSafe<TyperStatus>("typer_status").catch(() => null);
}

// ---------------------------------------------------------------- shortcuts / autostart

export async function applyShortcuts(shortcuts: Shortcuts): Promise<string[]> {
  if (!native) return [];
  return invokeSafe<string[]>("shortcuts_apply", { shortcuts });
}

export async function getAutostart(): Promise<boolean> {
  if (!native) return false;
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setAutostart(on: boolean) {
  if (!native) return;
  const m = await import("@tauri-apps/plugin-autostart");
  if (on) await m.enable();
  else await m.disable();
}

// ---------------------------------------------------------------- notifications

export async function ensureNotificationPermission(): Promise<boolean> {
  if (native) {
    const n = await import("@tauri-apps/plugin-notification");
    if (await n.isPermissionGranted()) return true;
    return (await n.requestPermission()) === "granted";
  }
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

export async function testNotification() {
  if (native) {
    const n = await import("@tauri-apps/plugin-notification");
    n.sendNotification({ title: "NEXUS reminders are working", body: "You'll see reminders like this even when NEXUS is minimized." });
  } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification("NEXUS reminders are working");
  }
}

/** Short synthesized chime (no audio files needed). */
export function playChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const notes = [880, 1318.5];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t0 = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.65);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {
    /* audio unavailable */
  }
}

// ---------------------------------------------------------------- files / backup

export async function pickSavePath(defaultName: string, ext: string, label: string): Promise<string | null> {
  if (!native) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name: label, extensions: [ext] }] });
}

export async function pickOpenPath(ext: string, label: string): Promise<string | null> {
  if (!native) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ multiple: false, filters: [{ name: label, extensions: [ext] }] });
  return typeof r === "string" ? r : null;
}

export async function relaunch() {
  if (!native) return location.reload();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

export interface DataInfo {
  dbPath: string;
  dataDir: string;
  backupsDir: string;
  schemaVersion: number;
  backups: string[];
}

export async function dataInfo(): Promise<DataInfo | null> {
  if (!native) return null;
  return invokeSafe<DataInfo>("data_info");
}

// ---------------------------------------------------------------- AI

export async function aiHasKey(): Promise<boolean> {
  if (!native) return false;
  return invokeSafe<boolean>("ai_has_key");
}
export async function aiSetKey(key: string) {
  return invokeSafe("ai_set_key", { key });
}
export async function aiClearKey() {
  return invokeSafe("ai_clear_key");
}
export async function aiRequest<T>(kind: "breakdown" | "plan" | "interpret", prompt: string, context: unknown): Promise<T> {
  if (!native) throw new Error("The AI assistant runs in the desktop app (it keeps your API key out of the web UI).");
  return invokeSafe<T>("ai_request", { req: { kind, prompt, context } });
}
