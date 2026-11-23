import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { bootstrapStore } from "./store";
import { isTauri } from "./data/backend";

const App = lazy(() => import("./App"));
const OverlayApp = lazy(() => import("./overlay/OverlayApp"));
const RegionPicker = lazy(() => import("./region/RegionPicker"));

async function detectWindow(): Promise<"main" | "overlay" | "region"> {
  // one picker window per monitor: region-0, region-1, …
  const named = (label: string | null) => (label === "overlay" ? "overlay" : label?.startsWith("region") ? "region" : "main");
  if (isTauri()) {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return named(getCurrentWebviewWindow().label);
  }
  return named(new URLSearchParams(location.search).get("window"));
}

async function boot() {
  const kind = await detectWindow();
  if (kind === "overlay") document.documentElement.classList.add("overlay");
  if (kind === "region") {
    // The region picker is a see-through sheet over the screen: no data, no app shell.
    document.documentElement.classList.add("overlay");
    createRoot(document.getElementById("root")!).render(
      <Suspense fallback={null}>
        <RegionPicker />
      </Suspense>,
    );
    return;
  }
  await bootstrapStore();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Suspense fallback={null}>{kind === "overlay" ? <OverlayApp /> : <App />}</Suspense>
    </StrictMode>,
  );
}

boot().catch((e) => {
  const root = document.getElementById("root")!;
  root.innerHTML = `<div style="padding:32px;font-family:Segoe UI,sans-serif;color:#e6edf7;background:#070a12;height:100%">
    <h2>NEXUS could not start</h2><p style="color:#fca5a5">${String(e?.message ?? e).replace(/</g, "&lt;")}</p>
    <p style="color:#7e8ba3">Your data has not been modified. See README → Troubleshooting.</p></div>`;
});
