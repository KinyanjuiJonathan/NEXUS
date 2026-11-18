import { describe, expect, it } from "vitest";
import type { PerfSnapshot } from "@/lib/platform";
import { availableMetrics, formatMetric, graphPaths, metricRange, metricValue, pushSample } from "./perf";

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
