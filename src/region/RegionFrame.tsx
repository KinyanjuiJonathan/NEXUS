import { useEffect, useState } from "react";
import { listenTo } from "@/lib/platform";

type Note = "reading" | "found" | "paused";

/**
 * The outline around the part of the screen NEXUS is reading. The window is
 * see-through and lets clicks through; the line is drawn in a margin outside
 * the region itself, so it is never read as text. It pulses while reading and
 * flashes green each time new text is taken.
 */
export default function RegionFrame() {
  const [note, setNote] = useState<Note>("reading");
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    let off: (() => void) | undefined;
    void listenTo<Note>("nexus://frame", (n) => {
      setNote(n);
      if (n === "found") setFlash((f) => f + 1);
    }).then((u) => (off = u));
    return () => off?.();
  }, []);
  const found = note === "found";
  return (
    <div className="frame-root">
      <div className={`frame-tab${found ? " frame-found" : ""}`}>
        <span className="frame-dot" />
        {found ? "NEXUS · new text taken" : "NEXUS · reading this area"}
      </div>
      <div key={flash} className={`frame-box${found ? " frame-found frame-flash" : ""}`} />
    </div>
  );
}
