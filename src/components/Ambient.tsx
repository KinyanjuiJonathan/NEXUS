import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { useNexus } from "@/store";
import { useUI, type View } from "@/store/ui";
import { ambientMove, canStartAmbient, nextAmbientView, type AmbientMove } from "@/lib/ambient";

export interface AmbientState {
  active: boolean;
  /** Counts the page changes, so each one can come in differently. */
  step: number;
}

const editable = (el: Element | null) => !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

/**
 * Ambient mode. After the set time without mouse or keyboard, the app moves
 * from page to page by itself. Any real input ends it and returns to the page
 * the user was on. It never starts with a dialog open, while a field has the
 * cursor, in a hidden window, or from a private page.
 */
export function useAmbient(): AmbientState {
  const cfg = useNexus((s) => s.settings.ambient);
  const preview = useUI((s) => s.ambientPreview);
  const [state, setState] = useState<AmbientState>({ active: false, step: 0 });
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const r = useRef({ last: Date.now(), home: null as View | null, active: false, switched: 0, step: 0, grace: 0, x: -1, y: -1 }).current;

  const advance = () => {
    r.step++;
    r.switched = Date.now();
    useUI.getState().setView(nextAmbientView(cfgRef.current, useUI.getState().view));
    setState({ active: true, step: r.step });
  };
  const start = () => {
    r.active = true;
    r.home = useUI.getState().view;
    advance();
  };
  const stop = (restore: boolean) => {
    if (!r.active) return;
    r.active = false;
    const home = r.home;
    r.home = null;
    setState({ active: false, step: r.step });
    if (restore && home) useUI.getState().setView(home);
  };

  useEffect(() => {
    const input = () => {
      r.last = Date.now();
      if (r.active && Date.now() > r.grace) stop(true);
    };
    // A page changing under a still pointer fires move events too: only real movement counts.
    const move = (e: PointerEvent) => {
      const moved = r.x < 0 || Math.abs(e.screenX - r.x) + Math.abs(e.screenY - r.y) > 4;
      r.x = e.screenX;
      r.y = e.screenY;
      if (moved) input();
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointermove", move, opts);
    for (const t of ["pointerdown", "keydown", "wheel", "touchstart"] as const) window.addEventListener(t, input, opts);
    const iv = setInterval(() => {
      const now = Date.now();
      const busy = !!document.querySelector("[role=dialog]") || editable(document.activeElement);
      const c = cfgRef.current;
      if (!r.active) {
        if (canStartAmbient(c, { view: useUI.getState().view, idleMs: now - r.last, busy, hidden: document.hidden })) start();
      } else if (busy || document.hidden || !c.enabled) stop(true);
      else if (now - r.switched >= c.everySec * 1000) advance();
    }, 1000);
    return () => {
      window.removeEventListener("pointermove", move, opts);
      for (const t of ["pointerdown", "keydown", "wheel", "touchstart"] as const) window.removeEventListener(t, input, opts);
      clearInterval(iv);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // "Preview" in Settings: start now, and let the click that asked for it finish first.
  useEffect(() => {
    if (!preview) return;
    r.grace = Date.now() + 1200;
    if (!r.active) start();
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

type Pose = { opacity: number; x?: number; y?: number; scale?: number; rotateX?: number; filter?: string };
const IN: Record<AmbientMove, Pose> = {
  rise: { opacity: 0, y: 48, filter: "blur(8px)" },
  drift: { opacity: 0, x: 80, filter: "blur(6px)" },
  zoom: { opacity: 0, scale: 0.93, filter: "blur(10px)" },
  tilt: { opacity: 0, y: 26, rotateX: 9, scale: 0.97 },
  fade: { opacity: 0, scale: 1.03, filter: "blur(12px)" },
};
const OUT: Record<AmbientMove, Pose> = {
  rise: { opacity: 0, y: -36, filter: "blur(8px)" },
  drift: { opacity: 0, x: -80, filter: "blur(6px)" },
  zoom: { opacity: 0, scale: 1.05, filter: "blur(10px)" },
  tilt: { opacity: 0, y: -20, rotateX: -7, scale: 0.98 },
  fade: { opacity: 0, scale: 0.98, filter: "blur(12px)" },
};

/** How a page comes in and goes out: quick and plain normally, slow and varied in ambient mode. */
export function pageMotion(a: AmbientState) {
  if (!a.active) return { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 }, transition: { duration: 0.18 } };
  const m = ambientMove(a.step);
  return {
    initial: IN[m],
    animate: { opacity: 1, x: 0, y: 0, scale: 1, rotateX: 0, filter: "blur(0px)" },
    exit: OUT[m],
    transition: { duration: 0.95, ease: [0.22, 0.8, 0.2, 1] as [number, number, number, number] },
  };
}

/** The moving light behind the pages and the note that says how to return. */
export function AmbientLayer({ state }: { state: AmbientState }) {
  const everySec = useNexus((s) => s.settings.ambient.everySec);
  return (
    <AnimatePresence>
      {state.active && (
        <>
          <motion.div key="aurora" className="ambient-aurora" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 1.6 }} aria-hidden>
            <i /><i /><i />
          </motion.div>
          <motion.div key="note" role="status" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 14 }} transition={{ duration: 0.5 }} className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 pointer-events-none glass rounded-full pl-3 pr-4 h-9 flex items-center gap-2 text-xs text-fg-2 overflow-hidden shadow-[0_10px_40px_rgba(0,0,0,0.5)]">
            <Sparkles size={13} className="text-accent" />
            Ambient view · move the mouse or press a key to return
            <span key={state.step} className="ambient-bar absolute left-0 bottom-0 h-[2px] w-full bg-gradient-to-r from-cyan-400 to-violet-500" style={{ animationDuration: `${everySec}s` }} />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
