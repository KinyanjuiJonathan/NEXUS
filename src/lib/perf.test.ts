import { describe, expect, it } from "vitest";
import type { PerfSnapshot } from "@/lib/platform";
import { DEFAULT_THRESHOLDS, LEVEL_COLOR, availableMetrics, formatMetric, graphPaths, levelGradientStops, metricRange, metricValue, pushSample, thresholdsFor, usageLevel, type UsageLevel } from "./perf";

const snap = (over: Partial<PerfSnapshot> = {}): PerfSnapshot => ({
  cpu: 37.4, ramUsed: 12 * 1024 ** 3, ramTotal: 32 * 1024 ** 3, ramPercent: 37.5, gpu: 55, gpuName: "GPU", vramUsed: 2 * 1024 ** 3, vramTotal: 8 * 1024 ** 3,
  fps: 120, fpsApp: "game.exe", fpsStatus: "ok", gpuTemp: 61, cpuTemp: 48, ...over,
});

describe("performance metrics", () => {
  it("reads each metric from a snapshot", () => {
    const s = snap();
    expect(metricValue(s, "cpu")).toBe(37.4);
    expect(metricValue(s, "ram")).toBe(37.5);
    expect(metricValue(s, "gpu")).toBe(55);
    expect(metricValue(s, "vram")).toBe(25);
    expect(metricValue(s, "fps")).toBe(120);
    expect(metricValue(s, "temp")).toBe(61);
    expect(metricValue(snap({ gpuTemp: null }), "temp")).toBe(48);
    expect(metricValue(snap({ fpsStatus: "no_permission" }), "fps")).toBeNull();
    expect(metricValue(snap({ vramTotal: null }), "vram")).toBeNull();
    expect(metricValue(null, "cpu")).toBeNull();
  });

  it("shows RAM as a percentage of installed memory", () => {
    expect(formatMetric(metricValue(snap(), "ram"), "ram")).toBe("38%");
    expect(formatMetric(metricValue(snap({ ramUsed: 31.9 * 1024 ** 3, ramPercent: 99.7 }), "ram"), "ram")).toBe("100%");
  });

  it("offers only the metrics this PC reports", () => {
    expect(availableMetrics(snap(), true, true)).toEqual(["cpu", "ram", "gpu", "vram", "fps", "temp"]);
    expect(availableMetrics(snap({ gpu: null, vramUsed: null, gpuTemp: null, cpuTemp: null }), false, true)).toEqual(["cpu", "ram"]);
    expect(availableMetrics(snap(), false, false)).toEqual(["cpu", "ram", "gpu", "vram"]);
    expect(availableMetrics(null, true, true)).toEqual(["cpu", "ram"]);
  });

  it("formats values with the right unit", () => {
    expect(formatMetric(41.6, "cpu")).toBe("42%");
    expect(formatMetric(143.7, "fps")).toBe("144");
    expect(formatMetric(60, "temp", "C")).toBe("60°C");
    expect(formatMetric(60, "temp", "F")).toBe("140°F");
    expect(formatMetric(null, "gpu")).toBe("—");
  });

  it("keeps percentages on a fixed 0–100 scale and lets FPS grow", () => {
    expect(metricRange("cpu", [1, 2, 3])).toEqual({ min: 0, max: 100 });
    expect(metricRange("fps", [30, 45])).toEqual({ min: 0, max: 60 });
    expect(metricRange("fps", [144, null, 160])).toEqual({ min: 0, max: 210 });
    expect(metricRange("temp", [])).toEqual({ min: 20, max: 100 });
  });
});

describe("graph history", () => {
  it("keeps only the newest samples", () => {
    let h: number[] = [];
    for (let i = 0; i < 10; i++) h = pushSample(h, i, 4);
    expect(h).toEqual([6, 7, 8, 9]);
    expect(pushSample([1], 2, 4)).toEqual([1, 2]);
  });

  it("draws the newest value on the right edge", () => {
    const { line, area } = graphPaths([0, 50, 100], { min: 0, max: 100 }, 100, 40, 10);
    expect(line).toBe("M80 40L90 20L100 0");
    expect(area).toBe("M80 40L90 20L100 0L100 40L80 40Z");
  });

  it("leaves gaps where a value is missing and clamps out-of-range values", () => {
    const { line, area } = graphPaths([10, null, 250, -5], { min: 0, max: 100 }, 100, 40, 10);
    expect(line).toBe("M70 36M90 0L100 40");
    expect(area).toBe("M70 36L70 40L70 40ZM90 0L100 40L100 40L90 40Z");
    expect(graphPaths([], { min: 0, max: 100 }, 100, 40, 10)).toEqual({ line: "", area: "" });
  });
});

describe("usage levels", () => {
  it("is green below 60%, yellow from 60% and red from 80% by default", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ elevated: 60, high: 80 });
    expect([0, 35, 59.9].map((v) => usageLevel(v))).toEqual(["normal", "normal", "normal"]);
    expect([60, 70, 79.9].map((v) => usageLevel(v))).toEqual(["elevated", "elevated", "elevated"]);
    expect([80, 95, 100].map((v) => usageLevel(v))).toEqual(["high", "high", "high"]);
    expect(usageLevel(null)).toBe("normal");
    expect(LEVEL_COLOR).toEqual({ normal: "#22c55e", elevated: "#eab308", high: "#ef4444" });
  });

  it("follows custom thresholds", () => {
    const t = { elevated: 40, high: 70 };
    expect([39, 40, 69, 70].map((v) => usageLevel(v, t))).toEqual(["normal", "elevated", "elevated", "high"]);
  });

  it("does not flicker when usage hovers around a threshold", () => {
    const run = (values: number[]) => {
      let level: UsageLevel | null = null;
      return values.map((v) => (level = usageLevel(v, DEFAULT_THRESHOLDS, level)));
    };
    // wobbling around 60%: turns yellow once and stays
    expect(run([58, 60.5, 59.2, 60.1, 58.4, 61, 57.5])).toEqual(["normal", "elevated", "elevated", "elevated", "elevated", "elevated", "elevated"]);
    // a real drop clears it
    expect(run([62, 56.9])).toEqual(["elevated", "normal"]);
    // around 80%
    expect(run([79, 81, 78, 80.2, 77.5, 76.9, 50])).toEqual(["elevated", "high", "high", "high", "high", "elevated", "normal"]);
    // rising is always immediate, even two levels at once
    expect(run([10, 95, 10])).toEqual(["normal", "high", "normal"]);
  });

  it("colours each height of the graph by its level, blending at the thresholds", () => {
    const stops = levelGradientStops(DEFAULT_THRESHOLDS);
    expect(stops[0]).toEqual({ offset: 0, color: "#ef4444" }); // top of the graph = 100%
    expect(stops[stops.length - 1]).toEqual({ offset: 1, color: "#22c55e" }); // bottom = 0%
    const offsets = stops.map((s) => s.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    const colorAt = (pct: number) => {
      const o = 1 - pct / 100;
      const i = stops.findIndex((s) => s.offset >= o);
      return stops[i].color === stops[Math.max(0, i - 1)].color ? stops[i].color : "blend";
    };
    expect([30, 70, 90].map(colorAt)).toEqual(["#22c55e", "#eab308", "#ef4444"]);
    expect([60, 80].map(colorAt)).toEqual(["blend", "blend"]);
  });

  it("applies to CPU now and is ready for other metrics", () => {
    expect(thresholdsFor("cpu", { cpu: { elevated: 50, high: 75 } })).toEqual({ elevated: 50, high: 75 });
    expect(thresholdsFor("cpu", undefined)).toEqual(DEFAULT_THRESHOLDS);
    for (const m of ["ram", "gpu", "vram"] as const) expect(thresholdsFor(m, { cpu: { elevated: 50, high: 75 } })).toEqual({ elevated: 50, high: 75 });
    expect(thresholdsFor("temp", { cpu: DEFAULT_THRESHOLDS })).toBeNull();
    expect(thresholdsFor("fps", { cpu: DEFAULT_THRESHOLDS })).toBeNull();
  });
});
