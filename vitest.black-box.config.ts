import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 180_000,
    include: ["tests/black-box/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
