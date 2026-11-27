import { useEffect, useRef, useState } from "react";
import { regionDone } from "@/lib/platform";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The full-screen window for marking a part of the screen: drag a rectangle,
 * release to confirm, Esc to cancel. The window is transparent, so what is
 * underneath stays visible; everything outside the rectangle is dimmed.
 */
export default function RegionPicker() {
  const [rect, setRect] = useState<Rect | null>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const done = useRef(false);

  const finish = (r: Rect | null) => {
    if (done.current) return;
    done.current = true;
    void regionDone(r).catch(() => window.close());
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && finish(null);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const box = (e: React.PointerEvent): Rect => {
    const a = from.current!;
    return { x: Math.min(a.x, e.clientX), y: Math.min(a.y, e.clientY), w: Math.abs(e.clientX - a.x), h: Math.abs(e.clientY - a.y) };
  };

  return (
    <div
      className="fixed inset-0 select-none"
      style={{ cursor: "crosshair", background: rect ? "transparent" : "rgba(4, 8, 18, 0.35)" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return finish(null);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        from.current = { x: e.clientX, y: e.clientY };
        setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
      }}
      onPointerMove={(e) => from.current && setRect(box(e))}
      onPointerUp={(e) => {
        if (!from.current) return;
        const r = box(e);
        from.current = null;
        // a click without a drag is not a selection
        if (r.w < 12 || r.h < 12) return setRect(null);
        finish(r);
      }}
    >
      {rect && (
        <div
          className="absolute rounded-sm"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxShadow: "0 0 0 9999px rgba(4, 8, 18, 0.5), 0 0 0 2px #22d3ee, 0 0 24px rgba(34, 211, 238, 0.6)" }}
        >
          <span className="absolute -top-6 left-0 rounded bg-[#22d3ee] text-[#04121a] text-[11px] font-semibold px-1.5 py-0.5 tabular-nums whitespace-nowrap">
            {Math.round(rect.w)} × {Math.round(rect.h)}
          </span>
        </div>
      )}
      {!rect && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 rounded-xl px-4 py-2.5 text-sm text-white" style={{ background: "rgba(7, 10, 18, 0.9)", border: "1px solid rgba(34, 211, 238, 0.5)", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" }}>
          <b>Mark the reading region:</b> press where it starts, drag to the opposite corner, and let go. <span style={{ opacity: 0.7 }}>Esc or right-click cancels.</span>
        </div>
      )}
    </div>
  );
}
