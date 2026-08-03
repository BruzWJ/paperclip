import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
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
      /^  [a-zA-Z_][a-zA-Z0-9_-]*:$/.test(line)
    ),
    "workflow jobs must use reviewable block-style identifiers",
  );
  return jobLines.map((line) => line.trim().slice(0, -1));
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

test("release workflow delegates stable and canary verification to the reusable workflow", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  assert.deepEqual(workflowJobNames(releaseWorkflow), [
    "resolve_stable_ref",
    "verify_canary",
    "publish_canary",
    "smoke_canary",
    "complete_canary",
    "verify_stable",
    "preview_stable",
    "publish_stable",
    "smoke_stable",
    "complete_stable",
  ]);
  assert.match(
    releaseWorkflow,
    /resolve_stable_ref:\n\s+if: github\.event_name == 'workflow_dispatch'[\s\S]*?source_sha: \$\{\{ steps\.resolve\.outputs\.source_sha \}\}[\s\S]*?ref: \$\{\{ inputs\.source_ref \}\}[\s\S]*?source_sha=\$\(git rev-parse HEAD\)/,
  );
  assert.match(
    releaseWorkflow,
    /verify_canary:\n\s+if: github\.event_name == 'push'\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /publish_canary:[\s\S]*?needs: verify_canary[\s\S]*?fetch-depth: 0\n\s+ref: \$\{\{ github\.sha \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /verify_stable:\n\s+if: github\.event_name == 'workflow_dispatch'\n\s+needs: resolve_stable_ref\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ needs\.resolve_stable_ref\.outputs\.source_sha \}\}/,
  );
  assert.doesNotMatch(
    releaseWorkflow,
    /(?:preview_stable|publish_stable):[\s\S]*?ref: \$\{\{ inputs\.source_ref \}\}/,
  );
  for (const job of ["preview_stable", "publish_stable"]) {
    assert.match(
      releaseWorkflow,
      new RegExp(
        `${job}:[\\s\\S]*?needs: \\[resolve_stable_ref, verify_stable\\][\\s\\S]*?ref: \\$\\{\\{ needs\\.resolve_stable_ref\\.outputs\\.source_sha \\}\\}`,
      ),
    );
  }
  assert.doesNotMatch(releaseWorkflow, /verify_(?:canary|stable):[\s\S]*?pnpm test:run(?:\n|$)/);
});

test("published canary and stable bytes must pass artifact-only release validation", () => {
  const releaseWorkflow = readWorkflow("release.yml");
  const smokeWorkflow = readWorkflow("release-smoke.yml");

  assert.match(
    jobBlock(releaseWorkflow, "publish_canary"),
    /outputs:\n\s+published_version: \$\{\{ steps\.published_version\.outputs\.version \}\}[\s\S]*?echo "version=\$\{tag#canary\/v\}" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    jobBlock(releaseWorkflow, "smoke_canary"),
    /needs: publish_canary[\s\S]*?uses: \.\/\.github\/workflows\/release-smoke\.yml[\s\S]*?ref: \$\{\{ github\.sha \}\}[\s\S]*?paperclip_version: \$\{\{ needs\.publish_canary\.outputs\.published_version \}\}/,
  );
  assert.match(
    jobBlock(releaseWorkflow, "complete_canary"),
    /needs: \[verify_canary, publish_canary, smoke_canary\][\s\S]*?SMOKE_RESULT: \$\{\{ needs\.smoke_canary\.result \}\}[\s\S]*?test "\$SMOKE_RESULT" = "success"/,
  );

  assert.match(
    jobBlock(releaseWorkflow, "publish_stable"),
    /outputs:\n\s+published_version: \$\{\{ steps\.published_version\.outputs\.version \}\}[\s\S]*?echo "version=\$\{tag#v\}" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    jobBlock(releaseWorkflow, "smoke_stable"),
    /needs: \[resolve_stable_ref, publish_stable\][\s\S]*?uses: \.\/\.github\/workflows\/release-smoke\.yml[\s\S]*?ref: \$\{\{ needs\.resolve_stable_ref\.outputs\.source_sha \}\}[\s\S]*?paperclip_version: \$\{\{ needs\.publish_stable\.outputs\.published_version \}\}/,
  );
  assert.match(
    jobBlock(releaseWorkflow, "complete_stable"),
    /needs: \[resolve_stable_ref, verify_stable, publish_stable, smoke_stable\][\s\S]*?SMOKE_RESULT: \$\{\{ needs\.smoke_stable\.result \}\}[\s\S]*?test "\$SMOKE_RESULT" = "success"/,
  );

  assert.match(smokeWorkflow, /workflow_call:[\s\S]*?ref:\n\s+required: true/);
  assert.match(
    jobBlock(smokeWorkflow, "smoke"),
    /uses: actions\/checkout@v7\n\s+with:\n\s+ref: \$\{\{ inputs\.ref \}\}/,
  );
  const smokeJob = jobBlock(smokeWorkflow, "smoke");
  assert.match(
    smokeJob,
    /name: Inspect the published package without starting Paperclip[\s\S]*?npm pack[\s\S]*?paperclip-package-files\.txt/,
  );
  assert.match(
    smokeJob,
    /name: Build and inspect the canonical container artifact[\s\S]*?docker build[\s\S]*?-f Dockerfile \\[\s\S]*?docker image inspect/,
  );
  assert.match(
    smokeJob,
    /name: Verify source package and release contracts[\s\S]*?pnpm build[\s\S]*?pnpm run test:release-registry[\s\S]*?pnpm run test:release-smoke/,
  );
  assert.doesNotMatch(
    smokeJob,
    /services:\n\s+postgres:|DATABASE_URL:/,
  );
  assert.doesNotMatch(
    smokeJob,
    /path: \|[\s\S]*?release-smoke-public-(?:signup|session)/,
  );
  assert.doesNotMatch(
    smokeJob,
    /docker-onboard-smoke|Dockerfile\.onboard-smoke|\bdocker\s+(?:run|compose|start|exec)\b|\bplaywright\b|\/api\/(?:auth|health|companies)\b/i,
  );

  const releaseSmokeRunner = readRepoFile("scripts/run-release-smoke.mjs");
  const artifactContract = readRepoFile("tests/release-smoke/artifact-contract.test.mjs");
  assert.match(
    releaseSmokeRunner,
    /tests\/release-smoke\/artifact-contract\.test\.mjs/,
  );
  assert.match(
    releaseSmokeRunner,
    /server-startup-feedback-export\.test\.ts[\s\S]*?mocked server client lifecycle/,
  );
  assert.match(
    artifactContract,
    /built runtime configuration fails before startup when no external target exists[\s\S]*?An external PostgreSQL connection is required/,
  );
});

test("release workflow job manifest rejects an unverified publisher", () => {
  const releaseWorkflow = readWorkflow("release.yml");
  const mutated = `${releaseWorkflow}
  publish-hidden:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish
`;
  assert.notDeepEqual(
    workflowJobNames(mutated),
    workflowJobNames(releaseWorkflow),
  );
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(
    verifyWorkflow,
    /VERIFIED_REF: \$\{\{ inputs\.ref \}\}[\s\S]*?\^\[0-9a-f\]\{40\}\$/,
  );
  assert.match(verifyWorkflow, /node \.\/scripts\/release-package-map\.mjs check/);
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);

  for (const group of ["general-server", "general-workspaces-a", "general-workspaces-b"]) {
    assert.match(verifyWorkflow, new RegExp(`group: ${group}`));
  }

  for (const shardIndex of [0, 1, 2]) {
    assert.match(
      verifyWorkflow,
      new RegExp(`group: general-server[\\s\\S]*?shard_index: ${shardIndex}[\\s\\S]*?shard_count: 3`),
    );
  }

  for (const shardIndex of [0, 1, 2, 3]) {
    assert.match(verifyWorkflow, new RegExp(`shard_index: ${shardIndex}[\\s\\S]*?shard_count: 4`));
  }

  assert.match(verifyWorkflow, /pnpm test:run:general -- --group/);
  assert.match(verifyWorkflow, /pnpm test:run:serialized -- --shard-index/);
});
