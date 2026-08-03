#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export const SESSION_STRUCTURE_COMMANDS = Object.freeze([
  Object.freeze([
    "cli/node_modules/tsx/dist/cli.mjs",
    "scripts/check-opencode-session-donor.ts",
  ]),
  Object.freeze([
    "scripts/check-issue-comment-projector-writers.mjs",
  ]),
  Object.freeze(["scripts/check-canonical-issue-writers.mjs"]),
]);

export function main() {
  for (const command of SESSION_STRUCTURE_COMMANDS) {
    run(command);
  }
  console.log("Paperclip Session structural checks passed.");
}

if (
  resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)
) {
  main();
}
