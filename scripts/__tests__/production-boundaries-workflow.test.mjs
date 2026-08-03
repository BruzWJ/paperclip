import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PRODUCTION_BOUNDARY_COMMANDS,
  PRODUCTION_BOUNDARY_GATES,
  PRODUCTION_BOUNDARY_SELF_TESTS,
  PRODUCTION_BOUNDARY_STEPS,
} from "../run-production-boundaries.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
function readRepoFile(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function jobBlock(workflow, jobName) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `workflow is missing job ${jobName}`);
  const next = lines.findIndex(
    (line, index) =>
      index > start && /^  [a-zA-Z_][a-zA-Z0-9_-]*:$/.test(line),
  );
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

function directNeeds(workflow, jobName) {
  const match = jobBlock(workflow, jobName).match(
    /^    needs:\s*\[([^\]]*)\]\s*$/m,
  );
  assert.ok(match, `${jobName} must declare an inline needs list`);
  return match[1]
    .split(",")
    .map((dependency) => dependency.trim())
    .filter(Boolean);
}

function workflowJobNames(workflow) {
  const lines = workflow.split("\n");
  const jobs = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobs, -1, "workflow is missing jobs");
  const jobLines = lines
    .slice(jobs + 1)
    .filter((line) => /^  \S/.test(line));
  assert.ok(
    jobLines.every((line) =>
      /^  [a-zA-Z_][a-zA-Z0-9_-]*:$/.test(line),
    ),
    "workflow jobs must use reviewable block-style identifiers",
  );
  return jobLines.map((line) => line.trim().slice(0, -1));
}

function occurrenceCount(source, literal) {
  return source.split(literal).length - 1;
}

function assertDirectDependencies(workflow, jobName, dependencies) {
  const needs = directNeeds(workflow, jobName);
  for (const dependency of dependencies) {
    assert.ok(
      needs.includes(dependency),
      `${jobName} must directly require ${dependency}`,
    );
  }
}

function foldedJobField(workflow, jobName, fieldName) {
  const lines = jobBlock(workflow, jobName).split("\n");
  const start = lines.findIndex((line) => line === `    ${fieldName}: >-`);
  assert.notEqual(start, -1, `${jobName} must declare folded field ${fieldName}`);
  const value = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("      ")) break;
    value.push(line.trim());
  }
  return value.join("\n");
}

function assertStandaloneBoundaryContract({
  workflow,
  jobNames,
  consumerJob,
  sourceRef,
  installCommand,
}) {
  assert.deepEqual(workflowJobNames(workflow), jobNames);
  assert.equal(
    occurrenceCount(workflow, "pnpm run check:production-boundaries"),
    1,
    "standalone workflow must invoke the complete boundary runner exactly once",
  );
  assertDirectDependencies(workflow, consumerJob, ["production_boundaries"]);

  const boundary = jobBlock(workflow, "production_boundaries");
  const consumer = jobBlock(workflow, consumerJob);
  assert.equal(
    occurrenceCount(boundary, `ref: ${sourceRef}`),
    1,
    "boundary job must check out the consumer source ref exactly once",
  );
  assert.equal(
    occurrenceCount(consumer, `ref: ${sourceRef}`),
    1,
    "consumer job must check out the same source ref exactly once",
  );
  assert.match(boundary, /repository: anomalyco\/opencode/);
  assert.match(
    boundary,
    /ref: 2b2aacc93975330f9fd045d4306f698b0c6a8f8f/,
  );
  assert.match(boundary, new RegExp(`run: ${installCommand}`));
  assert.match(
    boundary,
    /OPENCODE_SESSION_DONOR: \$\{\{ github\.workspace \}\}\/reference\/opencode/,
  );
  assert.doesNotMatch(boundary, /working-directory:/);
  for (const command of PRODUCTION_BOUNDARY_COMMANDS) {
    assert.equal(
      occurrenceCount(workflow, command),
      0,
      `${command} must not be duplicated outside the canonical runner`,
    );
  }
}

test("production-boundary manifest is consolidated behind one package command", () => {
  assert.equal(PRODUCTION_BOUNDARY_GATES.length, 29);
  assert.equal(PRODUCTION_BOUNDARY_SELF_TESTS.length, 28);
  assert.equal(PRODUCTION_BOUNDARY_COMMANDS.length, 57);
  assert.equal(PRODUCTION_BOUNDARY_COMMANDS[0], "check:opencode-session-donor");
  assert.deepEqual(
    PRODUCTION_BOUNDARY_SELF_TESTS.slice(0, 6),
    [
      "test:opencode-session-donor-gate",
      "test:native-correlation-boundary-gate",
      "test:server-worker-topology-gate",
      "test:database-substrate-gate",
      "test:zero-database-tests-gate",
      "test:issue-comment-projector-writers-gate",
    ],
  );
  assert.equal(
    new Set(PRODUCTION_BOUNDARY_COMMANDS).size,
    PRODUCTION_BOUNDARY_COMMANDS.length,
    "every mandatory command must appear exactly once",
  );
  const packageJson = JSON.parse(readRepoFile("package.json"));
  assert.equal(
    packageJson.scripts["check:production-boundaries"],
    "node scripts/run-production-boundaries.mjs",
  );
  assert.deepEqual(
    PRODUCTION_BOUNDARY_STEPS.map(({ name }) => name),
    PRODUCTION_BOUNDARY_COMMANDS,
  );
  for (const command of PRODUCTION_BOUNDARY_COMMANDS) {
    assert.equal(
      packageJson.scripts[command],
      undefined,
      `${command} is internal to the aggregate runner and must not bloat package.json`,
    );
  }
  for (const boundary of PRODUCTION_BOUNDARY_STEPS) {
    assert.equal(boundary.executable, process.execPath);
    assert.ok(boundary.args.length > 0, `${boundary.name} must have a direct command`);
  }

  const paperclipSessionStructure = readRepoFile(
    "scripts/check-paperclip-session-structure.mjs",
  );
  assert.doesNotMatch(
    paperclipSessionStructure,
    /check-opencode-session-donor\.test\.ts/,
    "the donor self-test must have only the production-boundary manifest owner",
  );
  assert.doesNotMatch(
    paperclipSessionStructure,
    /check-issue-comment-projector-writers\.test\.mjs/,
    "the comment projector self-test must have only the production-boundary manifest owner",
  );

  const subsetAttempt = spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, "scripts/run-production-boundaries.mjs"),
      "--only",
      "check:skill-channel-boundary",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.notEqual(subsetAttempt.status, 0);
  assert.match(
    subsetAttempt.stderr,
    /Production-boundary verification is atomic and does not accept a subset selector/,
  );
});

test("PR and release verification each invoke the atomic boundary runner exactly once", () => {
  const pr = readRepoFile(".github/workflows/pr.yml");
  const release = readRepoFile(".github/workflows/release-verify.yml");

  assert.deepEqual(workflowJobNames(pr), [
    "policy",
    "typecheck_release_registry",
    "production_boundaries",
    "general_tests",
    "verify",
    "build",
    "verify_serialized_server",
    "token_gates",
    "canary_dry_run",
    "e2e_shards",
    "e2e_multiuser_authenticated",
    "e2e",
  ]);
  assert.deepEqual(workflowJobNames(release), [
    "production_boundaries",
    "typecheck",
    "general_tests",
    "serialized_tests",
    "build",
    "token_gates",
    "verify",
  ]);

  for (const workflow of [pr, release]) {
    assert.equal(
      occurrenceCount(workflow, "pnpm run check:production-boundaries"),
      1,
      "workflow must invoke the complete boundary runner exactly once",
    );
    const boundary = jobBlock(workflow, "production_boundaries");
    assert.match(boundary, /repository: anomalyco\/opencode/);
    assert.match(
      boundary,
      /ref: 2b2aacc93975330f9fd045d4306f698b0c6a8f8f/,
    );
    assert.match(
      boundary,
      /OPENCODE_SESSION_DONOR: \$\{\{ github\.workspace \}\}\/reference\/opencode/,
    );
    assert.doesNotMatch(boundary, /working-directory:/);
    for (const command of PRODUCTION_BOUNDARY_COMMANDS) {
      assert.equal(
        occurrenceCount(workflow, command),
        0,
        `${command} must not be duplicated outside the canonical runner`,
      );
    }
  }
});

test("PR verification and browser lanes cannot bypass boundaries or the zero-database contract", () => {
  const pr = readRepoFile(".github/workflows/pr.yml");

  for (const jobName of [
    "typecheck_release_registry",
    "general_tests",
    "build",
    "verify_serialized_server",
    "e2e_shards",
    "e2e_multiuser_authenticated",
  ]) {
    assertDirectDependencies(pr, jobName, ["production_boundaries"]);
  }
  for (const jobName of ["e2e_shards", "e2e_multiuser_authenticated"]) {
    assertDirectDependencies(pr, jobName, [
      "verify_serialized_server",
      "build",
      "token_gates",
    ]);
  }
  assertDirectDependencies(pr, "verify", [
    "production_boundaries",
    "verify_serialized_server",
    "token_gates",
  ]);
  assertDirectDependencies(pr, "token_gates", [
    "production_boundaries",
    "typecheck_release_registry",
    "general_tests",
    "verify_serialized_server",
    "build",
  ]);

  const serialized = jobBlock(pr, "verify_serialized_server");
  assert.doesNotMatch(serialized, /services:\n\s+postgres:/);
  assert.doesNotMatch(serialized, /(?:TEST|E2E)_DATABASE_URL:/);
  assert.match(serialized, /shard_index: 0[\s\S]*?shard_index: 3/);

  const e2eShards = jobBlock(pr, "e2e_shards");
  assert.doesNotMatch(e2eShards, /(?:TEST|E2E)_DATABASE_URL:/);
  assert.doesNotMatch(e2eShards, /^\s+DATABASE_URL:/m);
  assert.equal(occurrenceCount(pr, "pnpm run check:token-gates"), 1);
});

test("release verification reuses the complete boundary and token contract", () => {
  const release = readRepoFile(".github/workflows/release-verify.yml");

  for (const jobName of ["typecheck", "general_tests", "serialized_tests", "build"]) {
    assertDirectDependencies(release, jobName, ["production_boundaries"]);
  }
  assertDirectDependencies(release, "token_gates", [
    "production_boundaries",
    "typecheck",
    "general_tests",
    "serialized_tests",
    "build",
  ]);
  assertDirectDependencies(release, "verify", [
    "production_boundaries",
    "typecheck",
    "general_tests",
    "serialized_tests",
    "build",
    "token_gates",
  ]);
  const serialized = jobBlock(release, "serialized_tests");
  assert.doesNotMatch(serialized, /services:\n\s+postgres:/);
  assert.doesNotMatch(serialized, /(?:TEST|E2E)_DATABASE_URL:/);
  assert.equal(occurrenceCount(release, "pnpm run check:token-gates"), 1);
});

test("standalone E2E, release smoke, and Storybook visual require their own atomic boundary job", () => {
  const standaloneE2e = readRepoFile(".github/workflows/e2e.yml");
  const releaseSmoke = readRepoFile(".github/workflows/release-smoke.yml");
  const storybookVisual = readRepoFile(".github/workflows/storybook-visual.yml");

  assertStandaloneBoundaryContract({
    workflow: standaloneE2e,
    jobNames: ["production_boundaries", "e2e"],
    consumerJob: "e2e",
    sourceRef: "${{ github.sha }}",
    installCommand: "pnpm install --frozen-lockfile",
  });
  assertStandaloneBoundaryContract({
    workflow: releaseSmoke,
    jobNames: ["production_boundaries", "smoke"],
    consumerJob: "smoke",
    sourceRef: "${{ inputs.ref }}",
    installCommand: "pnpm install --no-frozen-lockfile",
  });
  assertStandaloneBoundaryContract({
    workflow: storybookVisual,
    jobNames: ["production_boundaries", "visual"],
    consumerJob: "visual",
    sourceRef: "${{ github.sha }}",
    installCommand: "pnpm install --frozen-lockfile",
  });
  assert.equal(
    foldedJobField(storybookVisual, "production_boundaries", "if"),
    foldedJobField(storybookVisual, "visual", "if"),
    "Storybook boundaries must use the visual lane's label/dispatch predicate",
  );
});

test("normal E2E, authenticated multiuser E2E, and release smoke stay distinct", () => {
  const pr = readRepoFile(".github/workflows/pr.yml");
  const standaloneE2e = readRepoFile(".github/workflows/e2e.yml");
  const playwrightConfig = readRepoFile("tests/e2e/playwright.config.ts");
  const releaseSmoke = readRepoFile(".github/workflows/release-smoke.yml");

  assert.equal(occurrenceCount(pr, "pnpm run test:e2e -- $specs"), 1);
  assert.equal(
    occurrenceCount(pr, "pnpm run test:e2e:multiuser-authenticated"),
    1,
  );
  assertDirectDependencies(pr, "e2e", [
    "e2e_shards",
    "e2e_multiuser_authenticated",
  ]);
  assert.doesNotMatch(jobBlock(pr, "e2e_multiuser_authenticated"), /services:\n\s+postgres:/);

  const standaloneE2eJob = jobBlock(standaloneE2e, "e2e");
  assert.doesNotMatch(standaloneE2eJob, /(?:TEST|E2E)_DATABASE_URL:/);
  assert.doesNotMatch(standaloneE2eJob, /^\s+DATABASE_URL:/m);
  assert.doesNotMatch(playwrightConfig, /(?:TEST|E2E)_DATABASE_URL/);
  assert.doesNotMatch(playwrightConfig, /process\.env\.DATABASE_URL/);

  assert.match(releaseSmoke, /workflow_call:/);
  assert.equal(occurrenceCount(releaseSmoke, "npm pack"), 1);
  assert.equal(occurrenceCount(releaseSmoke, "pnpm run test:release-smoke"), 1);
  assert.doesNotMatch(releaseSmoke, /test:e2e(?::multiuser-authenticated)?/);
  assert.doesNotMatch(jobBlock(releaseSmoke, "smoke"), /services:\n\s+postgres:/);
  assert.doesNotMatch(jobBlock(releaseSmoke, "smoke"), /^\s+DATABASE_URL:/m);
});

test("contract rejects a workflow that bypasses the atomic boundary owner", () => {
  const pr = readRepoFile(".github/workflows/pr.yml");
  const mutated = pr.replace(
    "needs: [policy, production_boundaries]",
    "needs: [policy]",
  );
  assert.notEqual(mutated, pr);
  assert.throws(
    () => assertDirectDependencies(mutated, "typecheck_release_registry", ["production_boundaries"]),
    /must directly require production_boundaries/,
  );
});

test("standalone workflow contract rejects prerequisite or atomic-runner removal", () => {
  const fixtures = [
    {
      workflow: readRepoFile(".github/workflows/e2e.yml"),
      jobNames: ["production_boundaries", "e2e"],
      consumerJob: "e2e",
      sourceRef: "${{ github.sha }}",
      installCommand: "pnpm install --frozen-lockfile",
    },
    {
      workflow: readRepoFile(".github/workflows/release-smoke.yml"),
      jobNames: ["production_boundaries", "smoke"],
      consumerJob: "smoke",
      sourceRef: "${{ inputs.ref }}",
      installCommand: "pnpm install --no-frozen-lockfile",
    },
    {
      workflow: readRepoFile(".github/workflows/storybook-visual.yml"),
      jobNames: ["production_boundaries", "visual"],
      consumerJob: "visual",
      sourceRef: "${{ github.sha }}",
      installCommand: "pnpm install --frozen-lockfile",
    },
  ];

  for (const fixture of fixtures) {
    const { workflow, consumerJob } = fixture;
    const withoutDependency = workflow.replace(
      "needs: [production_boundaries]",
      "needs: []",
    );
    assert.notEqual(withoutDependency, workflow);
    assert.throws(
      () =>
        assertDirectDependencies(withoutDependency, consumerJob, [
          "production_boundaries",
        ]),
      /must directly require production_boundaries/,
    );

    const withoutAtomicRunner = workflow.replace(
      "pnpm run check:production-boundaries",
      "node scripts/check-zero-database-tests.mjs",
    );
    assert.notEqual(withoutAtomicRunner, workflow);
    assert.throws(
      () =>
        assertStandaloneBoundaryContract({
          ...fixture,
          workflow: withoutAtomicRunner,
        }),
      /complete boundary runner exactly once/,
    );
  }
});
