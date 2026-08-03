import { defineConfig } from "vitest/config";

export default defineConfig({
  envDir: false,
  test: {
    environment: "node",
    // These suites exercise real subprocesses, process groups, sockets, and
    // short lifecycle deadlines. Keep files isolated and sequential so their
    // operating-system resources cannot contend with one another.
    fileParallelism: false,
    include: ["src/**/*.test.ts"],
  },
});
