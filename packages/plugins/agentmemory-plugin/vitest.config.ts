import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
