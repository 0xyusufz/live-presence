import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react({})],
  build: {
    outDir: resolve(__dirname, ".vite/renderer/main_window"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    hmr: { host: "127.0.0.1", protocol: "ws", port: 5174 },
  },
});
