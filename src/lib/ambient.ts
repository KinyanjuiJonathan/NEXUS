import type { View } from "@/store/ui";

/** Ambient mode: after a while without input, NEXUS drifts between its overview pages like a live wallpaper. */
export interface AmbientSettings {
  enabled: boolean;
  /** Minutes without mouse or keyboard before it starts. */
  idleMin: number;
  /** Seconds on each page. */
  everySec: number;
  pages: View[];
}

export const AMBIENT_PAGES: { view: View; label: string }[] = [
  { view: "dashboard", label: "Dashboard" },
  { view: "calendar", label: "Calendar" },
  { view: "tasks", label: "Tasks" },
  { view: "clocks", label: "World Clocks" },
  { view: "insights", label: "Insights" },
  { view: "focus", label: "Focus & Timers" },
];

export const DEFAULT_AMBIENT: AmbientSettings = { enabled: true, idleMin: 3, everySec: 30, pages: ["dashboard", "calendar", "tasks", "clocks", "insights"] };

/** Pages it never starts from: private, or in the middle of something. */
const NEVER_FROM: View[] = ["accounts", "typer", "assistant", "settings"];

export function normalizeAmbient(raw: Partial<AmbientSettings> | undefined | null): AmbientSettings {
  const allowed = new Set(AMBIENT_PAGES.map((p) => p.view));
  const pages = (raw?.pages ?? DEFAULT_AMBIENT.pages).filter((v) => allowed.has(v));
  return {
    enabled: raw?.enabled ?? DEFAULT_AMBIENT.enabled,
    idleMin: Math.min(240, Math.max(1, Math.round(Number(raw?.idleMin) || DEFAULT_AMBIENT.idleMin))),
    everySec: Math.min(3600, Math.max(10, Math.round(Number(raw?.everySec) || DEFAULT_AMBIENT.everySec))),
    pages: pages.length ? pages : [...DEFAULT_AMBIENT.pages],
  };
}

/** May ambient mode begin now? Not from a private or busy page, with a dialog open, or while typing somewhere. */
export function canStartAmbient(a: AmbientSettings, o: { view: View; idleMs: number; busy: boolean; hidden: boolean }): boolean {
  return a.enabled && a.pages.length > 1 && !o.busy && !o.hidden && !NEVER_FROM.includes(o.view) && o.idleMs >= a.idleMin * 60_000;
}

/** The page after `current` in the tour (the first page when `current` is not part of it). */
export function nextAmbientView(a: AmbientSettings, current: View): View {
  const i = a.pages.indexOf(current);
  return a.pages[(i + 1) % a.pages.length];
}

/** A different entrance for each change of page, in a fixed rotation so it never feels random or repeats twice running. */
export const AMBIENT_MOVES = ["rise", "drift", "zoom", "tilt", "fade"] as const;
export type AmbientMove = (typeof AMBIENT_MOVES)[number];
export const ambientMove = (step: number): AmbientMove => AMBIENT_MOVES[((step % AMBIENT_MOVES.length) + AMBIENT_MOVES.length) % AMBIENT_MOVES.length];
