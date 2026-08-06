#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIsolatedVitestEnv } from "./run-vitest-stable.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, label, env) {
  console.log(`\n[release-smoke] ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

const tempRoot = mkdtempSync(
  path.join(os.tmpdir(), `paperclip-release-smoke-${process.pid}-`),
);
const environment = buildIsolatedVitestEnv(
  process.env,
  tempRoot,
  `release-smoke-${process.pid}`,
);
mkdirSync(environment.HOME, { recursive: true });
mkdirSync(environment.PAPERCLIP_HOME, { recursive: true });
mkdirSync(environment.TMPDIR, { recursive: true });

try {
  run(
    process.execPath,
    ["--test", "tests/release-smoke/artifact-contract.test.mjs"],
    "built and packaged artifact contract",
    environment,
  );
  run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "@paperclipai/server",
      "apps/server/src/__tests__/server-startup.test.ts",
      "--no-file-parallelism",
      "--maxWorkers=1",
    ],
    "mocked server client lifecycle",
    environment,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
