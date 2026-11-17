import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { bootstrapStore } from "./store";
import { isTauri } from "./data/backend";

const App = lazy(() => import("./App"));
const OverlayApp = lazy(() => import("./overlay/OverlayApp"));

async function detectWindow(): Promise<"main" | "overlay"> {
  if (isTauri()) {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return getCurrentWebviewWindow().label === "overlay" ? "overlay" : "main";
  }
  return new URLSearchParams(location.search).get("window") === "overlay" ? "overlay" : "main";
}

async function boot() {
  const kind = await detectWindow();
  if (kind === "overlay") document.documentElement.classList.add("overlay");
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
