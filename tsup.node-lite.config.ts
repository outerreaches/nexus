import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["examples/nexus-node/reference-node-lite.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  sourcemap: true,
  splitting: false,
  outDir: "dist/node-lite",
  define: {
    __NEXUS_LITE_BUNDLE__: "true",
  },
  minify: true,
});
