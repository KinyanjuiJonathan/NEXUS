import { useEffect, useState } from "react";
import { getOverlayState, onOverlayState, type OverlayState } from "@/lib/platform";

/** Live state of the floating overlay window (visible / click-through / pinned). */
export function useOverlayState(): OverlayState {
  const [state, setState] = useState<OverlayState>({ visible: false, clickThrough: false, pinned: true });
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void getOverlayState().then((s) => alive && setState(s)).catch(() => {});
    void onOverlayState(setState).then((u) => (alive ? (off = u) : u()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return state;
}
