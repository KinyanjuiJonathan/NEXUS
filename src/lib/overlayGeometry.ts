import type { OverlayMode } from "@/data/types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Default logical size of each overlay mode. */
export const MODE_SIZES: Record<OverlayMode, { w: number; h: number }> = {
  mini: { w: 300, h: 64 },
  standard: { w: 360, h: 236 },
  expanded: { w: 400, h: 560 },
};

export const MIN_SIZE = { w: 220, h: 56 };

export function sizeForMode(mode: OverlayMode, saved?: Partial<Record<OverlayMode, { w: number; h: number }>>): { w: number; h: number } {
  const s = saved?.[mode];
  if (s && s.w >= MIN_SIZE.w && s.h >= MIN_SIZE.h && s.w <= 4000 && s.h <= 3000) return s;
  return MODE_SIZES[mode];
}

export function nextMode(mode: OverlayMode): OverlayMode {
  return mode === "mini" ? "standard" : mode === "standard" ? "expanded" : "mini";
}

function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Keep the overlay reachable across monitor changes (unplugged display,
 * resolution change, DPI change). If less than `minVisible` px² of the window
 * header is on any monitor, snap it to the top-right of the primary monitor.
 * Otherwise clamp it fully inside the monitor it mostly overlaps.
 */
export function ensureVisible(win: Rect, monitors: Rect[], primaryIndex = 0, margin = 16): Rect {
  if (!monitors.length) return win;
  const header: Rect = { x: win.x, y: win.y, w: win.w, h: Math.min(win.h, 40) };
  let best = -1;
  let bestArea = 0;
  monitors.forEach((m, i) => {
    const a = intersection(header, m);
    if (a > bestArea) {
      bestArea = a;
      best = i;
    }
  });
  const minVisible = Math.min(header.w * header.h * 0.3, 40 * 30);
  if (best < 0 || bestArea < minVisible) {
    const p = monitors[Math.min(Math.max(primaryIndex, 0), monitors.length - 1)];
    const w = Math.min(win.w, p.w - 2 * margin);
    const h = Math.min(win.h, p.h - 2 * margin);
    return { x: p.x + p.w - w - margin, y: p.y + margin, w, h };
  }
  const m = monitors[best];
  const w = Math.min(win.w, m.w);
  const h = Math.min(win.h, m.h);
  return {
    x: Math.min(Math.max(win.x, m.x), m.x + m.w - w),
    y: Math.min(Math.max(win.y, m.y), m.y + m.h - h),
    w,
    h,
  };
}

export function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return 0.86;
  return Math.min(1, Math.max(0.25, v));
}
