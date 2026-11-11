import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";

const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: "com.livepresence.desktop",
    extendInfo: {
      NSCameraUsageDescription: "Live Presence uses the camera only when you turn it on.",
      NSMicrophoneUsageDescription: "Live Presence does not capture microphone audio.",
    },
  },
  makers: [],
  plugins: [
    new VitePlugin({
      hotRestart: true,
      build: [
        { entry: "src/main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};

export default config;
