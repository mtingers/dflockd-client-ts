import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/client.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
});
