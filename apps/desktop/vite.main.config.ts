import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  build: {
    lib: {
      entry: resolve(__dirname, "src/main.ts"),
      formats: ["cjs"],
    },
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "main.js" },
    },
  },
});
