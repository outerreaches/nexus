import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/core/isolated-worker.ts", // Worker entry point for process-isolated agents
  ],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  dts: false,
});

