import { useEffect, useRef, useSyncExternalStore } from "react";
import type { PerfMetric } from "@/data/types";
import { native, perfSnapshot, perfStop, type PerfSnapshot } from "@/lib/platform";

/** Samples kept for the graph: one minute, plus two that slide in and out of view. */
export const GRAPH_POINTS = 60;
export const HISTORY_LIMIT = GRAPH_POINTS + 2;
export const SAMPLE_MS = 1000;

export const METRIC_LABEL: Record<PerfMetric, string> = { cpu: "CPU", ram: "RAM", gpu: "GPU", vram: "VRAM", fps: "FPS", temp: "TEMP" };

/** The value a metric contributes to the graph (percent, frames per second or °C). */
export function metricValue(s: PerfSnapshot | null | undefined, metric: PerfMetric): number | null {
  if (!s) return null;
  switch (metric) {
    case "cpu":
      return s.cpu;
    case "ram":
      return s.ramTotal ? s.ramPercent ?? (s.ramUsed / s.ramTotal) * 100 : null;
    case "gpu":
      return s.gpu;
    case "vram":
      return s.vramUsed != null && s.vramTotal ? (s.vramUsed / s.vramTotal) * 100 : null;
    case "fps":
      return s.fpsStatus === "ok" ? s.fps : null;
    case "temp":
      return s.gpuTemp ?? s.cpuTemp;
  }
}

/** Metrics this PC can actually report right now. */
export function availableMetrics(s: PerfSnapshot | null, showFps: boolean, showTemp: boolean): PerfMetric[] {
  const out: PerfMetric[] = ["cpu", "ram"];
  if (!s) return out;
  if (s.gpu != null) out.push("gpu");
  if (s.vramUsed != null && s.vramTotal) out.push("vram");
  if (showFps && s.fpsStatus !== "unsupported") out.push("fps");
  if (showTemp && (s.gpuTemp != null || s.cpuTemp != null)) out.push("temp");
  return out;
}

/** Vertical range for a metric's graph. Percentages are always 0–100. */
export function metricRange(metric: PerfMetric, values: (number | null)[]): { min: number; max: number } {
  if (metric === "fps") {
    const top = Math.max(0, ...values.map((v) => v ?? 0));
    return { min: 0, max: Math.max(60, Math.ceil((top * 1.15) / 30) * 30) };
  }
  if (metric === "temp") return { min: 20, max: 100 };
  return { min: 0, max: 100 };
}

export function formatMetric(v: number | null | undefined, metric: PerfMetric, unit: "C" | "F" = "C"): string {
  if (v == null) return "—";
  if (metric === "fps") return `${Math.round(v)}`;
  if (metric === "temp") return unit === "F" ? `${Math.round((v * 9) / 5 + 32)}°F` : `${Math.round(v)}°C`;
  return `${Math.round(v)}%`;
}

// ------------------------------------------------------------------ usage levels (green / yellow / red)

export type UsageLevel = "normal" | "elevated" | "high";
export interface Thresholds {
  /** Percent from which usage is elevated (yellow). */
  elevated: number;
  /** Percent from which usage is high (red). */
  high: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { elevated: 60, high: 80 };
export const LEVEL_COLOR: Record<UsageLevel, string> = { normal: "#22c55e", elevated: "#eab308", high: "#ef4444" };
export const LEVEL_LABEL: Record<UsageLevel, string> = { normal: "Normal", elevated: "Elevated", high: "High" };
/** Usage must fall this far below a threshold before the colour steps back down. */
export const LEVEL_HYSTERESIS = 3;
const RANK: UsageLevel[] = ["normal", "elevated", "high"];

/**
 * Level for a usage percentage. Going up is immediate; going down needs the
 * value to drop `LEVEL_HYSTERESIS` points under the threshold, so a value
 * hovering around 60% or 80% does not flicker between colours.
 */
export function usageLevel(value: number | null | undefined, t: Thresholds = DEFAULT_THRESHOLDS, previous?: UsageLevel | null): UsageLevel {
  const v = value ?? 0;
  const raw = v >= t.high ? 2 : v >= t.elevated ? 1 : 0;
  if (previous == null) return RANK[raw];
  const prev = RANK.indexOf(previous);
  if (raw >= prev) return RANK[raw];
  const held = v >= t.high - LEVEL_HYSTERESIS ? 2 : v >= t.elevated - LEVEL_HYSTERESIS ? 1 : 0;
  return RANK[Math.min(prev, Math.max(raw, held))];
}

/** Usage metrics (CPU, RAM, GPU, VRAM) are coloured by level, all from the same thresholds. FPS and temperature keep their own colour. */
export function thresholdsFor(metric: PerfMetric, configured: { cpu: Thresholds } | undefined): Thresholds | null {
  return metric === "cpu" || metric === "ram" || metric === "gpu" || metric === "vram" ? configured?.cpu ?? DEFAULT_THRESHOLDS : null;
}

/**
 * Stops for a vertical gradient over a 0–100% graph (offset 0 = top = 100%):
 * each part of the line takes the colour of the level it sits in, so the
 * history shows when usage was normal, elevated or high. Colours blend over a
 * narrow band at each threshold instead of switching abruptly.
 */
export function levelGradientStops(t: Thresholds, blend = 2): { offset: number; color: string }[] {
  const at = (pct: number) => Math.min(1, Math.max(0, 1 - pct / 100));
  return [
    { offset: 0, color: LEVEL_COLOR.high },
    { offset: at(t.high + blend), color: LEVEL_COLOR.high },
    { offset: at(t.high - blend), color: LEVEL_COLOR.elevated },
    { offset: at(t.elevated + blend), color: LEVEL_COLOR.elevated },
    { offset: at(t.elevated - blend), color: LEVEL_COLOR.normal },
    { offset: 1, color: LEVEL_COLOR.normal },
  ];
}

/** Append a sample, keeping only the newest `limit`. */
export function pushSample<T>(history: readonly T[], sample: T, limit = HISTORY_LIMIT): T[] {
  const next = history.length >= limit ? history.slice(history.length - limit + 1) : history.slice();
  next.push(sample);
  return next;
}

/**
 * SVG path for a series drawn right-aligned in a `width` × `height` box: the
 * newest value sits on the right edge and each older one a `step` further left.
 * Missing values (null) leave a gap. Returns the line and the filled area below it.
 */
export function graphPaths(values: (number | null)[], range: { min: number; max: number }, width: number, height: number, step: number): { line: string; area: string } {
  const span = Math.max(1e-9, range.max - range.min);
  const y = (v: number) => +(height - ((Math.min(range.max, Math.max(range.min, v)) - range.min) / span) * height).toFixed(2);
  let line = "";
  let area = "";
  let runStart: number | null = null;
  let lastX = 0;
  values.forEach((v, i) => {
    const x = +(width - (values.length - 1 - i) * step).toFixed(2);
    if (v == null) {
      if (runStart != null) area += `L${lastX} ${height}L${runStart} ${height}Z`;
      runStart = null;
      return;
    }
    if (runStart == null) {
      line += `M${x} ${y(v)}`;
      area += `M${x} ${y(v)}`;
      runStart = x;
    } else {
      line += `L${x} ${y(v)}`;
      area += `L${x} ${y(v)}`;
    }
    lastX = x;
  });
  if (runStart != null) area += `L${lastX} ${height}L${runStart} ${height}Z`;
  return { line, area };
}

// ------------------------------------------------------------------ shared poller

interface PerfState {
  snap: PerfSnapshot | null;
  history: PerfSnapshot[];
}

let state: PerfState = { snap: null, history: [] };
const listeners = new Set<() => void>();
/** Each mounted consumer and whether it wants FPS (null = doesn't care). */
const consumers = new Map<symbol, boolean | null>();
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function publish(snap: PerfSnapshot) {
  state = { snap, history: pushSample(state.history, snap) };
  listeners.forEach((l) => l());
}

function wantFps(): boolean | null {
  const wants = [...consumers.values()];
  return wants.includes(true) ? true : wants.includes(false) ? false : null;
}

/** Browser dev server only (never in production builds): moving numbers so the layout can be designed. */
function previewSample(fps: boolean | null): PerfSnapshot {
  const t = Date.now() / 1000;
  const wave = (speed: number, phase: number) => (Math.sin(t * speed + phase) + Math.sin(t * speed * 2.3 + phase * 1.7) * 0.5 + 1.5) / 3;
  const ramTotal = 32 * 1024 ** 3;
  const ramUsed = ramTotal * (0.42 + wave(0.05, 1) * 0.12);
  return {
    cpu: 8 + wave(0.6, 0) * 55,
    ramUsed,
    ramTotal,
    ramPercent: (ramUsed / ramTotal) * 100,
    gpu: 20 + wave(0.4, 2) * 60,
    gpuName: "Preview GPU",
    vramUsed: (2.5 + wave(0.1, 3)) * 1024 ** 3,
    vramTotal: 8 * 1024 ** 3,
    fps: fps ? 90 + wave(0.8, 4) * 60 : null,
    fpsApp: "game.exe",
    fpsStatus: fps ? "ok" : "off",
    gpuTemp: 55 + wave(0.2, 5) * 20,
    cpuTemp: 50 + wave(0.3, 6) * 20,
  };
}

async function tick(gen: number) {
  if (gen !== generation) return;
  if (!document.hidden) {
    try {
      const fps = wantFps();
      const snap = native ? await perfSnapshot(fps) : previewSample(fps);
      if (gen === generation && snap) publish(snap);
    } catch {
      /* keep the last value */
    }
  }
  if (gen === generation) timer = setTimeout(() => void tick(gen), SAMPLE_MS);
}

function restart() {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  const canSample = native || import.meta.env.DEV;
  if (consumers.size && canSample) void tick(generation);
}

function join(id: symbol, fps: boolean | null) {
  const wasEmpty = consumers.size === 0;
  const before = wantFps();
  consumers.set(id, fps);
  if (wasEmpty || before !== wantFps()) restart();
}

function leave(id: symbol) {
  const fps = consumers.get(id);
  consumers.delete(id);
  if (consumers.size === 0) {
    restart();
    state = { snap: null, history: [] };
    listeners.forEach((l) => l());
    // Only a window that asked for FPS owns the FPS trace.
    if (fps != null) void perfStop();
  } else if (fps != null) restart();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Live system performance, sampled about once a second while `enabled` and the
 * window is visible. Every caller in a window shares one poller, and the native
 * side shares one sample between windows, so all displays agree.
 * `fps`: true/false to switch frame-rate measuring on/off (overlay), null to leave it alone.
 */
export function usePerf(enabled: boolean, fps: boolean | null = null): PerfSnapshot | null {
  useEffect(() => {
    if (!enabled) return;
    const id = Symbol("perf");
    join(id, fps);
    return () => leave(id);
  }, [enabled, fps]);
  const snap = useSyncExternalStore(subscribe, () => state.snap);
  return enabled ? snap : null;
}

/** The last minute of samples (oldest first); empty until `usePerf` is active somewhere in this window. */
export function usePerfHistory(): PerfSnapshot[] {
  return useSyncExternalStore(subscribe, () => state.history);
}

/** The level of a live value, remembered between renders so it changes with hysteresis. */
export function useUsageLevel(value: number | null | undefined, t: Thresholds | null): UsageLevel | null {
  const prev = useRef<UsageLevel | null>(null);
  if (!t || value == null) {
    prev.current = null;
    return null;
  }
  prev.current = usageLevel(value, t, prev.current);
  return prev.current;
}
