import { useSyncExternalStore } from "react";

/**
 * One shared, second-aligned clock for the whole window. Components read the
 * current time via `useNow()`; nothing accumulates ticks, so every countdown is
 * recomputed from timestamps. The ticker stops while the window is hidden
 * (minimised overlay / tray) to keep CPU usage near zero, and re-syncs
 * immediately on resume (e.g. after Windows sleep).
 */

let now = Date.now();
const listeners = new Set<() => void>();
let handle: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (handle != null || !listeners.size) return;
  if (typeof document !== "undefined" && document.hidden) return;
  const delay = 1000 - (Date.now() % 1000) + 5;
  handle = setTimeout(() => {
    handle = null;
    now = Date.now();
    listeners.forEach((l) => l());
    schedule();
  }, delay);
}

function resync() {
  if (handle != null) {
    clearTimeout(handle);
    handle = null;
  }
  now = Date.now();
  listeners.forEach((l) => l());
  schedule();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", resync);
  window.addEventListener("focus", resync);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  schedule();
  return () => {
    listeners.delete(cb);
    if (!listeners.size && handle != null) {
      clearTimeout(handle);
      handle = null;
    }
  };
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}

export function onTick(cb: () => void): () => void {
  return subscribe(cb);
}

export function currentNow(): number {
  return now;
}
