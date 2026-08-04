import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Some suites exercise real subprocess, filesystem, and loopback transport
    // boundaries. Keep enough time for deterministic setup and cleanup while
    // the suite remains single-worker and database-free.
    hookTimeout: 30000,
    teardownTimeout: 30000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
