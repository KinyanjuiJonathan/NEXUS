/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import pkg from "./package.json";

const host = process.env.TAURI_DEV_HOST;
// Which build this is: the commit it was made from (set by CI) and the day it was built.
const commit = (process.env.GITHUB_SHA ?? "").slice(0, 7) || "local";
const builtOn = new Date().toISOString().slice(0, 10);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __APP_BUILD__: JSON.stringify(commit), __APP_BUILT_ON__: JSON.stringify(builtOn) },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
