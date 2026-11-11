import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react({})],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
      "/auth": { target: "http://localhost:3000" },
      "/presence": { target: "http://localhost:3000" },
      "/webrtc": { target: "http://localhost:3000" },
      "/devices": { target: "http://localhost:3000" },
    },
  },
});
