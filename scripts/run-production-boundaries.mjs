#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_RUNNER = resolve(REPO_ROOT, "packages/cli/node_modules/tsx/dist/cli.mjs");
const EXTERNAL_DATABASE_GATE_PATH = [
  "scripts/check-no-",
  ["embed", "ded"].join(""),
  "-",
  ["post", "gres"].join(""),
  ".ts",
].join("");

function step(name, args) {
  return Object.freeze({ name, executable: process.execPath, args: Object.freeze(args) });
}

function nodeScript(name, relativePath) {
  return step(name, [resolve(REPO_ROOT, relativePath)]);
}

function nodeTest(name, ...relativePaths) {
  return step(name, ["--test", ...relativePaths.map((path) => resolve(REPO_ROOT, path))]);
}

function tsxScript(name, relativePath) {
  return step(name, [TSX_RUNNER, resolve(REPO_ROOT, relativePath)]);
}

function tsxTest(name, ...relativePaths) {
  return step(name, [
    TSX_RUNNER,
    "--test",
    ...relativePaths.map((path) => resolve(REPO_ROOT, path)),
  ]);
}

export const PRODUCTION_BOUNDARY_GATE_STEPS = Object.freeze([
  tsxScript("check:opencode-session-donor", "scripts/check-opencode-session-donor.ts"),
  tsxScript("check:native-correlation-boundary", "scripts/check-native-correlation-boundary.ts"),
  tsxScript("check:no-embedded-postgres", EXTERNAL_DATABASE_GATE_PATH),
  nodeScript("check:zero-database-tests", "scripts/check-zero-database-tests.mjs"),
  tsxScript("check:server-worker-topology", "scripts/check-server-worker-topology.ts"),
  nodeScript(
    "check:issue-comment-projector-writers",
    "scripts/check-issue-comment-projector-writers.mjs",
  ),
  tsxScript("check:issue-vocabulary", "scripts/check-issue-vocabulary.ts"),
  nodeScript("check:paperclip-session-structure", "scripts/check-paperclip-session-structure.mjs"),
  tsxScript(
    "check:issue-session-durable-writers",
    "scripts/check-issue-session-durable-writers.ts",
  ),
  nodeScript("check:canonical-issue-writers", "scripts/check-canonical-issue-writers.mjs"),
  tsxScript(
    "check:issue-execution-run-service-boundary",
    "scripts/check-issue-execution-run-service-boundary.ts",
  ),
  tsxScript("check:cross-issue-memory-removal", "scripts/check-cross-issue-memory-removal.ts"),
  tsxScript("check:plugin-run-context-boundary", "scripts/check-plugin-run-context-boundary.ts"),
  tsxScript("check:gateway-credential-boundary", "scripts/check-gateway-credential-boundary.ts"),
  tsxScript("check:plugin-managed-agent-boundary", "scripts/check-plugin-managed-agent-boundary.ts"),
  tsxScript("check:retained-board-gate-boundary", "scripts/check-retained-board-gate-boundary.ts"),
  tsxScript("check:invocation-surface-removal", "scripts/check-invocation-surface-removal.ts"),
  tsxScript("check:interaction-producer-removal", "scripts/check-interaction-producer-removal.ts"),
  tsxScript("check:skill-channel-boundary", "scripts/check-skill-channel-boundary.ts"),
  tsxScript(
    "check:runtime-interface-compiler-boundary",
    "scripts/check-runtime-interface-compiler-boundary.ts",
  ),
  tsxScript("check:provider-identity-boundary", "scripts/check-provider-identity-boundary.ts"),
  tsxScript("check:outcome-mirror-removal", "scripts/check-outcome-mirror-removal.ts"),
  tsxScript("check:ai-cost-currency-cutover", "scripts/check-ai-cost-currency-cutover.ts"),
  tsxScript("check:ai-accounting-boundary", "scripts/check-ai-accounting-boundary.ts"),
  tsxScript(
    "check:legacy-execution-surface-removal",
    "scripts/check-legacy-execution-surface-removal.ts",
  ),
  tsxScript("check:run-progress-comment-contract", "scripts/check-run-progress-comment-contract.ts"),
  tsxScript("check:issue-liveness-boundary", "scripts/check-issue-liveness-boundary.ts"),
  tsxScript("check:acp-registry-admission", "scripts/check-acp-registry-admission.ts"),
  tsxScript("check:canonical-human-auth", "scripts/check-canonical-human-auth.ts"),
]);

export const PRODUCTION_BOUNDARY_SELF_TEST_STEPS = Object.freeze([
  tsxTest("test:opencode-session-donor-gate", "scripts/check-opencode-session-donor.test.ts"),
  tsxTest(
    "test:native-correlation-boundary-gate",
    "scripts/check-native-correlation-boundary.test.ts",
  ),
  tsxTest("test:server-worker-topology-gate", "scripts/check-server-worker-topology.test.ts"),
  nodeTest("test:database-substrate-gate", "scripts/database-substrate-gate.test.mjs"),
  nodeTest("test:zero-database-tests-gate", "scripts/check-zero-database-tests.test.mjs"),
  nodeTest(
    "test:issue-comment-projector-writers-gate",
    "scripts/check-issue-comment-projector-writers.test.mjs",
  ),
  tsxTest("test:issue-vocabulary", "scripts/check-issue-vocabulary.test.ts"),
  tsxTest("test:issue-session-durable-writers", "scripts/check-issue-session-durable-writers.test.ts"),
  tsxTest("test:canonical-human-auth", "scripts/check-canonical-human-auth.test.ts"),
  nodeTest("test:canonical-issue-writers", "scripts/check-canonical-issue-writers.test.mjs"),
  tsxTest(
    "test:issue-execution-run-service-boundary",
    "scripts/check-issue-execution-run-service-boundary.test.ts",
  ),
  tsxTest("test:cross-issue-memory-removal", "scripts/check-cross-issue-memory-removal.test.ts"),
  tsxTest("test:plugin-run-context-boundary", "scripts/check-plugin-run-context-boundary.test.ts"),
  tsxTest("test:gateway-credential-boundary", "scripts/check-gateway-credential-boundary.test.ts"),
  tsxTest("test:plugin-managed-agent-boundary", "scripts/check-plugin-managed-agent-boundary.test.ts"),
  tsxTest("test:retained-board-gate-boundary", "scripts/check-retained-board-gate-boundary.test.ts"),
  tsxTest("test:invocation-surface-removal", "scripts/check-invocation-surface-removal.test.ts"),
  tsxTest("test:interaction-producer-removal", "scripts/check-interaction-producer-removal.test.ts"),
  tsxTest("test:skill-channel-boundary", "scripts/check-skill-channel-boundary.test.ts"),
  tsxTest(
    "test:runtime-interface-compiler-boundary",
    "scripts/check-runtime-interface-compiler-boundary.test.ts",
  ),
  tsxTest("test:provider-identity-boundary-gate", "scripts/check-provider-identity-boundary.test.ts"),
  tsxTest("test:outcome-mirror-removal-gate", "scripts/check-outcome-mirror-removal.test.ts"),
  tsxTest("test:ai-cost-currency-cutover-gate", "scripts/check-ai-cost-currency-cutover.test.ts"),
  tsxTest("test:ai-accounting-boundary-gate", "scripts/check-ai-accounting-boundary.test.ts"),
  tsxTest(
    "test:legacy-execution-surface-removal",
    "scripts/check-legacy-execution-surface-removal.test.ts",
  ),
  tsxTest("test:run-progress-comment-contract-gate", "scripts/check-run-progress-comment-contract.test.ts"),
  tsxTest("test:issue-liveness-boundary-gate", "scripts/check-issue-liveness-boundary.test.ts"),
  tsxTest("test:acp-registry-admission-gate", "scripts/check-acp-registry-admission.test.ts"),
]);

export const PRODUCTION_BOUNDARY_STEPS = Object.freeze([
  ...PRODUCTION_BOUNDARY_GATE_STEPS,
  ...PRODUCTION_BOUNDARY_SELF_TEST_STEPS,
]);
export const PRODUCTION_BOUNDARY_GATES = Object.freeze(
  PRODUCTION_BOUNDARY_GATE_STEPS.map(({ name }) => name),
);
export const PRODUCTION_BOUNDARY_SELF_TESTS = Object.freeze(
  PRODUCTION_BOUNDARY_SELF_TEST_STEPS.map(({ name }) => name),
);
export const PRODUCTION_BOUNDARY_COMMANDS = Object.freeze(
  PRODUCTION_BOUNDARY_STEPS.map(({ name }) => name),
);

function assertCanonicalManifest() {
  if (PRODUCTION_BOUNDARY_COMMANDS[0] !== "check:opencode-session-donor") {
    throw new Error("The pinned Session donor gate must remain the first production boundary");
  }
  const unique = new Set(PRODUCTION_BOUNDARY_COMMANDS);
  if (unique.size !== PRODUCTION_BOUNDARY_COMMANDS.length) {
    throw new Error("Each production boundary command must appear exactly once");
  }
  for (const boundary of PRODUCTION_BOUNDARY_STEPS) {
    if (boundary.executable !== process.execPath || boundary.args.length === 0) {
      throw new Error(`Production boundary ${boundary.name} has no direct command`);
    }
  }
}

function runBoundaryStep(boundary) {
  const result = spawnSync(boundary.executable, boundary.args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function main() {
  if (process.argv.length > 2) {
    throw new Error(
      "Production-boundary verification is atomic and does not accept a subset selector",
    );
  }
  assertCanonicalManifest();
  for (const boundary of PRODUCTION_BOUNDARY_STEPS) {
    console.log(`\n==> ${boundary.name}`);
    runBoundaryStep(boundary);
  }
  console.log("\nAll production boundary gates and gate self-tests passed.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
