#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildIsolatedVitestEnv,
  prepareStandaloneVitestProjects,
} from "./run-vitest-stable.mjs";
import { discoverVitestProjectManifest } from "./vitest-project-manifest.mjs";

const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
const testRoot = mkdtempSync(path.join(tempRootParent, `pcvw-${process.pid}-`));
const env = buildIsolatedVitestEnv(process.env, testRoot, `vw-${process.pid}`);
const repoRoot = path.resolve(import.meta.dirname, "..");

mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
mkdirSync(env.HOME, { recursive: true });
mkdirSync(env.TMPDIR, { recursive: true });

let result;
try {
  const { projects } = discoverVitestProjectManifest(repoRoot);
  prepareStandaloneVitestProjects(repoRoot, projects);
  result = spawnSync("pnpm", ["exec", "vitest", ...process.argv.slice(2)], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

if (result?.error) {
  console.error(`[test:watch] Failed to start Vitest: ${result.error.message}`);
  process.exitCode = 1;
} else if (result?.signal === "SIGINT") {
  process.exitCode = 130;
} else {
  process.exitCode = result?.status ?? 1;
}
