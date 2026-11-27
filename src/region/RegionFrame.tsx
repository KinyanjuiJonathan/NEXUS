import { useEffect, useRef, useState } from "react";
import { closeRegion, listenTo, showMainWindow } from "@/lib/platform";

type Edge = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

/** The frame's own window (only inside the desktop app). */
const win = async () => (await import("@tauri-apps/api/window")).getCurrentWindow();
const primary = (e: React.MouseEvent) => e.button === 0;

/**
 * The reading region on the screen: a thin frame with a small bar above it.
 *
 * Drag the bar to move it, drag an edge or corner to resize it, right-click
 * inside it to capture the text it shows, and press × to close it. The inside
 * is empty and lets the mouse through, so the window underneath can be
 * scrolled and used as usual. The frame is drawn in a margin around the
 * region, never over it, so it is not read as text.
 */
export default function RegionFrame() {
  const [note, setNote] = useState<{ text: string; tone: "ok" | "idle" | "bad" } | null>(null);
  const [flash, setFlash] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let off: (() => void) | undefined;
    void listenTo<string>("nexus://frame", (n) => {
      const [kind, count] = n.split(":");
      const lines = Number(count) || 0;
      setNote(
        kind === "found"
          ? { text: `+${lines} line${lines === 1 ? "" : "s"} captured`, tone: "ok" }
          : kind === "none"
            ? { text: "Nothing new here", tone: "idle" }
            : kind === "empty"
              ? { text: "No text found", tone: "idle" }
              : { text: "Could not read", tone: "bad" },
      );
      if (kind === "found") setFlash((f) => f + 1);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setNote(null), 2600);
    }).then((u) => (off = u));
    return () => {
      off?.();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const move = (e: React.MouseEvent) => primary(e) && void win().then((w) => w.startDragging()).catch(() => {});
  const resize = (edge: Edge) => (e: React.MouseEvent) => {
    if (!primary(e)) return;
    e.stopPropagation();
    void win().then((w) => w.startResizeDragging(edge)).catch(() => {});
  };
  const handle = (edge: Edge, cls: string) => <div className={`frame-h ${cls}`} onMouseDown={resize(edge)} aria-hidden />;

  return (
    <div className="frame-root" onContextMenu={(e) => e.preventDefault()}>
      <div className={`frame-bar${note?.tone === "ok" ? " frame-ok" : ""}`} onMouseDown={move} title="Drag to move the reading region">
        <span className="frame-grip" aria-hidden>⠿</span>
        <span className="frame-text">{note ? note.text : "Right-click inside to capture"}</span>
        <button type="button" className="frame-app" onMouseDown={(e) => e.stopPropagation()} onClick={() => void showMainWindow()} title="Show NEXUS, with the text captured so far">NEXUS</button>
        <button type="button" className="frame-x" onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeRegion()} title="Close the reading region" aria-label="Close the reading region">×</button>
      </div>
      <div key={flash} className={`frame-box${flash ? " frame-flash" : ""}`} />
      {handle("North", "frame-n")}
      {handle("South", "frame-s")}
      {handle("West", "frame-w")}
      {handle("East", "frame-e")}
      {handle("NorthWest", "frame-nw")}
      {handle("NorthEast", "frame-ne")}
      {handle("SouthWest", "frame-sw")}
      {handle("SouthEast", "frame-se")}
    </div>
  );
}
