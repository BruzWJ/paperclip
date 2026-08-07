import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  defaultSuiteWeight,
  loadShardDurations,
  partitionGeneralServerSuites,
} from "../general-server-shard.mjs";
import {
  buildProjectVitestInvocation,
  buildIsolatedVitestEnv,
  isSerializedServerTest,
  prepareStandaloneVitestProjects,
} from "../run-vitest-stable.mjs";
import { discoverVitestProjectManifest } from "../vitest-project-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const watchScript = path.join(repoRoot, "scripts", "run-vitest-watch.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "general-server-shard-durations.json");

function dryRun(args) {
  const result = spawnSync(process.execPath, [script, ...args, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result;
}

function dryRunJson(args) {
  const result = dryRun(args);
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const SHARD_COUNT = 3;
const REQUIRED_ADDED_PROJECT_PATHS = [
  "packages/teams-catalog",
  "packages/plugins/examples/plugin-authoring-smoke-example",
  "packages/plugins/examples/plugin-orchestration-smoke-example",
];
const RAW_CENSUS_ROOTS = ["apps", "packages"];
const RAW_CENSUS_IGNORED_DIRECTORIES = new Set([
  ".git",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const RAW_VITEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const SERIALIZED_FAMILY_PATTERNS = [
  /(?:^|\/)issue-execution(?:-|\/)/,
  /(?:^|\/)issue-session(?:-|\/)/,
  /(?:^|\/)[^/]*liveness[^/]*\.test\.ts$/,
  /(?:^|\/)[^/]*(?:prompt|acp)[^/]*\.test\.ts$/,
  /(?:^|\/)[^/]*postgres[^/]*\.test\.ts$/,
];

test("the stable runner cannot inherit application or libpq database credentials", () => {
  const retiredTestDatabaseUrl = ["PAPERCLIP", "TEST", "DATABASE", "URL"].join("_");
  const env = buildIsolatedVitestEnv(
    {
      DATABASE_URL: "postgres://production.invalid/paperclip",
      PAPERCLIP_DATABASE_URL: "postgres://development.invalid/paperclip",
      [retiredTestDatabaseUrl]: "postgres://retired.invalid/paperclip",
      PGHOST: "production.invalid",
      PGPASSWORD: "do-not-inherit",
      POSTGRES_PASSWORD: "do-not-inherit",
      PAPERCLIP_CONFIG: "/tmp/production-paperclip-config.json",
      NODE_OPTIONS: "--require dotenv/config",
      NODE_PATH: "/tmp/production-node-modules",
      NPM_CONFIG_NODE_OPTIONS: "--require dotenv/config",
      npm_config_node_options: "--require dotenv/config",
      DOTENV_CONFIG_PATH: "/tmp/production.env",
      DOTENV_CONFIG_OVERRIDE: "true",
      DOTENV_KEY: "dotenv://production-key",
      NODE_CONFIG_DIR: "/tmp/production-config",
      NODE_CONFIG_ENV: "production",
      CONFIG_PATH: "/tmp/production-config.json",
      ENV_FILE: "/tmp/production.env",
      ENV_FILE_PATH: "/tmp/production.env",
      ENV_PATH: "/tmp/production.env",
      KEEP_ME: "must-not-cross-the-test-boundary",
    },
    "/tmp/paperclip-zero-db-contract",
    "vitest-zero-db-contract",
  );

  assert.equal(env.KEEP_ME, undefined);
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.PAPERCLIP_INSTANCE_ID, "vitest-zero-db-contract");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PAPERCLIP_DATABASE_URL, undefined);
  assert.equal(env[retiredTestDatabaseUrl], undefined);
  assert.equal(env.PGHOST, undefined);
  assert.equal(env.PGPASSWORD, undefined);
  assert.equal(env.POSTGRES_PASSWORD, undefined);
  assert.equal(env.PAPERCLIP_CONFIG, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NPM_CONFIG_NODE_OPTIONS, undefined);
  assert.equal(env.npm_config_node_options, undefined);
  assert.equal(env.DOTENV_CONFIG_PATH, undefined);
  assert.equal(env.DOTENV_CONFIG_OVERRIDE, undefined);
  assert.equal(env.DOTENV_KEY, undefined);
  assert.equal(env.NODE_CONFIG_DIR, undefined);
  assert.equal(env.NODE_CONFIG_ENV, undefined);
  assert.equal(env.CONFIG_PATH, undefined);
  assert.equal(env.ENV_FILE, undefined);
  assert.equal(env.ENV_FILE_PATH, undefined);
  assert.equal(env.ENV_PATH, undefined);
});

test("the stable runner disables inherited Node and dotenv preload hooks", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-preload-"));
  try {
    const preloadPath = path.join(fixtureRoot, "reload-database.cjs");
    writeFileSync(
      preloadPath,
      [
        'process.env.DATABASE_URL = "postgres://rehydrated.invalid/paperclip";',
        'process.env.PAPERCLIP_TEST_PRELOAD_RAN = "true";',
      ].join("\n"),
    );
    const env = buildIsolatedVitestEnv(
      {
        ...process.env,
        NODE_OPTIONS: `--require ${preloadPath}`,
        DOTENV_CONFIG_PATH: path.join(fixtureRoot, ".env"),
      },
      fixtureRoot,
      "vitest-preload-contract",
    );
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({ databaseUrl: process.env.DATABASE_URL, preloadRan: process.env.PAPERCLIP_TEST_PRELOAD_RAN }))",
      ],
      { env, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("watch mode uses the same zero-database environment builder", () => {
  const source = readFileSync(watchScript, "utf8");
  assert.match(source, /buildIsolatedVitestEnv\(process\.env/);
  assert.match(source, /prepareStandaloneVitestProjects\(repoRoot, projects\)/);
  assert.doesNotMatch(source, /env:\s*process\.env/);
});

test("standalone plugin projects use isolated pnpm installation and SDK linking", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-standalone-"));
  const project = {
    name: "@paperclipai/plugin-standalone-fixture",
    path: "packages/plugins/standalone-fixture",
    requiresStandaloneInstall: true,
  };
  const spawned = [];
  const linked = [];
  try {
    mkdirSync(path.join(fixtureRoot, project.path), { recursive: true });
    prepareStandaloneVitestProjects(fixtureRoot, [project], {
      spawn(command, args, options) {
        spawned.push({ command, args, cwd: options.cwd });
        return { status: 0 };
      },
      linkSdk(projectRoot) {
        linked.push(projectRoot);
      },
    });

    assert.deepEqual(spawned, [{
      command: "pnpm",
      args: ["install", "--ignore-workspace", "--no-lockfile"],
      cwd: path.join(fixtureRoot, project.path),
    }]);
    assert.deepEqual(linked, [path.join(fixtureRoot, project.path)]);
    assert.deepEqual(buildProjectVitestInvocation(fixtureRoot, project), {
      cwd: path.join(fixtureRoot, project.path),
      args: ["--config", "vitest.config.ts"],
    });

    mkdirSync(path.join(fixtureRoot, project.path, "node_modules", ".bin"), {
      recursive: true,
    });
    writeFileSync(
      path.join(
        fixtureRoot,
        project.path,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "vitest.cmd" : "vitest",
      ),
      "",
    );
    spawned.length = 0;
    prepareStandaloneVitestProjects(fixtureRoot, [project], {
      spawn() {
        throw new Error("ready standalone project must not reinstall");
      },
      linkSdk() {},
    });
    assert.deepEqual(spawned, []);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(absolute) : [absolute];
  });
}

// Deliberately independent from the manifest's package/config discovery. This
// raw walk is the oracle that catches a filtered manifest silently omitting a
// new directory, package, or suite.
function rawVitestFileCensus() {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isFile() && RAW_VITEST_FILE_PATTERN.test(entry.name)) {
        files.push(path.relative(repoRoot, absolute).split(path.sep).join("/"));
      } else if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !RAW_CENSUS_IGNORED_DIRECTORIES.has(entry.name)
      ) {
        visit(absolute);
      }
    }
  }
  for (const root of RAW_CENSUS_ROOTS) visit(path.join(repoRoot, root));
  return files.sort((left, right) => left.localeCompare(right));
}

function requiredSerializedFamilies(files) {
  return files.filter((file) =>
    SERIALIZED_FAMILY_PATTERNS.some((pattern) => pattern.test(file)),
  );
}

function assertSerializedFamilyCoverage(allFiles, serializedFiles) {
  const serialized = new Set(serializedFiles);
  const missing = requiredSerializedFamilies(allFiles).filter(
    (file) => !serialized.has(file),
  );
  assert.deepEqual(
    missing,
    [],
    `canonical serialized suites fell into the general lane: ${missing.join(", ")}`,
  );
}

function assertProjectCoverage(expectedPaths, actualPaths) {
  const actual = new Set(actualPaths);
  const missing = expectedPaths.filter((projectPath) => !actual.has(projectPath));
  assert.deepEqual(
    missing,
    [],
    `stable runner omitted test-bearing projects: ${missing.join(", ")}`,
  );
}

test("the general-server shards form a complete, non-overlapping partition", () => {
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const total = shards[0].generalServerSuiteCount;
  assert.ok(total > 0, "expected a non-empty general-server suite set");

  const seen = new Set();
  let selectedTotal = 0;
  for (const shard of shards) {
    assert.equal(shard.generalServerSuiteCount, total, "suite count must be stable across shards");
    for (const file of shard.selectedGeneralServerSuites) {
      assert.ok(!seen.has(file), `suite assigned to more than one shard: ${file}`);
      seen.add(file);
      selectedTotal += 1;
    }
  }

  // Every suite runs exactly once: union covers the whole set with no overlap.
  assert.equal(selectedTotal, total, "every suite must be selected exactly once");
  assert.equal(seen.size, total, "union of shards must cover the whole suite set");
});

test("a serialized suite never leaks into the general-server shards", () => {
  const general = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  const serialized = dryRunJson(["--mode", "serialized"]);
  const serializedSet = new Set(serialized.selectedSerializedSuites);
  for (const file of general.selectedGeneralServerSuites) {
    assert.ok(
      !serializedSet.has(file),
      `serialized suite must stay out of general-server: ${file}`,
    );
  }
});

test("execution, Session, liveness, prompt/ACP, and PostgreSQL suites are structurally serialized", () => {
  const allServerTests = walkFiles(path.join(repoRoot, "apps", "server", "src"))
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .filter((file) => file.endsWith(".test.ts"))
    .sort();
  const serialized = dryRunJson(["--mode", "serialized"])
    .selectedSerializedSuites;
  const required = requiredSerializedFamilies(allServerTests);
  assert.ok(required.length >= 30, "expected the canonical serialized domain families");
  assertSerializedFamilyCoverage(allServerTests, serialized);
  for (const file of required) {
    assert.equal(
      isSerializedServerTest(file),
      true,
      `canonical classifier rejected ${file}`,
    );
  }

  const representatives = [
    "apps/server/src/services/issue-execution-run-service.test.ts",
    "apps/server/src/services/issue-session/publication.test.ts",
    "apps/server/src/services/issue-liveness-reconciliation.test.ts",
    "apps/server/src/services/acp-prompt-settlement.test.ts",
    "apps/server/src/services/prompt-capability-gateway.test.ts",
    "apps/server/src/__tests__/ordinary-issue-runtime-postgres.test.ts",
  ];
  for (const removed of representatives) {
    assert.throws(
      () =>
        assertSerializedFamilyCoverage(
          allServerTests,
          serialized.filter((file) => file !== removed),
        ),
      new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `coverage mutation must detect removal of ${removed}`,
    );
  }
});

test("the project manifest assigns the independent raw Vitest census exactly once", () => {
  const dry = dryRunJson([
    "--mode",
    "general",
    "--group",
    "general-workspaces-b",
  ]);
  const actualPaths = dry.testProjects.map((project) => project.path);
  assertProjectCoverage(REQUIRED_ADDED_PROJECT_PATHS, actualPaths);
  assert.deepEqual(dry.serializedWorkspaceProjects, ["@paperclipai/db"]);
  assert.ok(
    !dry.generalWorkspacesBProjects.includes("@paperclipai/db"),
    "database project must run in the serialized lane only",
  );

  const rawFiles = rawVitestFileCensus();
  const assignedFiles = dry.testFileAssignments
    .map((assignment) => assignment.file)
    .sort((left, right) => left.localeCompare(right));
  assert.ok(rawFiles.length > 0, "expected a non-empty app-wide Vitest census");
  assert.equal(
    new Set(assignedFiles).size,
    assignedFiles.length,
    "a Vitest suite was assigned to more than one project/lane",
  );
  assert.deepEqual(
    assignedFiles,
    rawFiles,
    "the canonical manifest must cover every raw first-party Vitest suite",
  );

  const laneProjectNames = [
    "@paperclipai/server",
    ...dry.generalWorkspacesAProjects,
    ...dry.generalWorkspacesBProjects,
    ...dry.serializedWorkspaceProjects,
  ];
  assert.equal(new Set(laneProjectNames).size, dry.testProjects.length);
  assert.deepEqual(
    laneProjectNames.slice().sort(),
    dry.testProjects.map((project) => project.name).sort(),
    "every discovered project must belong to exactly one runner lane",
  );

  for (const removed of REQUIRED_ADDED_PROJECT_PATHS) {
    assert.throws(
      () =>
        assertProjectCoverage(
          REQUIRED_ADDED_PROJECT_PATHS,
          actualPaths.filter((projectPath) => projectPath !== removed),
        ),
      new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `coverage mutation must detect removal of ${removed}`,
    );
  }

  const removedSandboxSuite = sandboxAssignments[0].file;
  assert.notDeepEqual(
    dry.testFileAssignments
      .filter((assignment) => assignment.file !== removedSandboxSuite)
      .map((assignment) => assignment.file)
      .sort(),
    rawFiles,
    "raw census must detect a removed sandbox-provider assignment",
  );
});

test("a new test-bearing package fails closed until it owns a Vitest project config", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-projects-"));
  try {
    const projectRoot = path.join(fixtureRoot, "packages", "new-project");
    mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({ name: "@paperclipai/new-project", type: "module" }),
    );
    writeFileSync(
      path.join(fixtureRoot, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writeFileSync(path.join(projectRoot, "src", "new.test.ts"), "export {};\n");
    assert.throws(
      () => discoverVitestProjectManifest(fixtureRoot),
      /has Vitest test files but no vitest\.config\.ts/,
    );

    writeFileSync(
      path.join(projectRoot, "vitest.config.ts"),
      "export default {};\n",
    );
    assert.deepEqual(discoverVitestProjectManifest(fixtureRoot).projects, [
      {
        name: "@paperclipai/new-project",
        path: "packages/new-project",
        lane: "general-workspaces-b",
        workspace: true,
        requiresStandaloneInstall: false,
        testFiles: ["packages/new-project/src/new.test.ts"],
      },
    ]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("root Vitest configuration uses the same discovered project manifest", () => {
  const source = readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
  const assertCanonicalWiring = (candidate) => {
    assert.match(candidate, /discoverVitestProjectManifest\(repositoryRoot\)/);
    assert.match(candidate, /projects:\s*projects\.map/);
  };
  assertCanonicalWiring(source);
  assert.throws(
    () =>
      assertCanonicalWiring(
        source.replace("discoverVitestProjectManifest(repositoryRoot)", "{ projects: [] }"),
      ),
    /discoverVitestProjectManifest/,
  );
});

test("shard flags are rejected for the parallel workspace groups", () => {
  const result = dryRun(["--mode", "general", "--group", "general-workspaces-a", "--shard-index", "0", "--shard-count", "3"]);
  assert.notEqual(result.status, 0, "workspace groups must not accept shard flags");
});

test("duration-aware partition balances skewed weights better than round-robin", () => {
  // Round-robin puts all three heavy suites on shard 0 (indexes 0, 3, 6).
  const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const durations = { a: 30000, d: 30000, g: 30000, b: 100, c: 100, e: 100, f: 100, h: 100, i: 100 };

  const shards = partitionGeneralServerSuites(files, 3, durations);
  const totals = shards.map((shard) => shard.totalWeight);
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  assert.ok(
    maxTotal - minTotal <= 200,
    `expected near-even shard weights, got ${totals.join(", ")}`,
  );
  assert.equal(
    shards.flatMap((shard) => shard.files).sort().join(","),
    files.join(","),
    "partition must cover every file exactly once",
  );
});

test("the partition is deterministic for identical inputs", () => {
  const files = Array.from({ length: 50 }, (_, index) => `suite-${index}.test.ts`);
  const durations = Object.fromEntries(files.map((file, index) => [file, (index * 37) % 5000]));

  const first = partitionGeneralServerSuites(files, 3, durations);
  const second = partitionGeneralServerSuites(files, 3, durations);
  assert.deepEqual(first, second, "same inputs must always produce the same partition");
});

test("suites missing from the manifest get the median weight", () => {
  assert.equal(defaultSuiteWeight({ a: 100, b: 300, c: 900 }), 300);
  assert.equal(defaultSuiteWeight({ a: 100, b: 300, c: 500, d: 900 }), 400);
  assert.equal(defaultSuiteWeight({}), 1000, "empty manifest falls back to a fixed weight");
});

test("a missing or malformed manifest degrades to uniform weights", () => {
  assert.deepEqual(loadShardDurations(path.join(repoRoot, "scripts", "no-such-manifest.json")), {});

  const files = ["a", "b", "c", "d"];
  const shards = partitionGeneralServerSuites(files, 2, {});
  assert.equal(shards[0].files.length + shards[1].files.length, files.length);
  assert.equal(Math.abs(shards[0].files.length - shards[1].files.length), 0);
});

test("the checked-in manifest loads and covers most of the current suite set", () => {
  const durations = loadShardDurations(durationsManifest);
  assert.ok(Object.keys(durations).length > 0, "manifest must parse to a non-empty duration map");

  const shard = dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", "0", "--shard-count", "1"]);
  const currentFiles = shard.selectedGeneralServerSuites;
  const known = currentFiles.filter((file) => durations[file] !== undefined).length;
  assert.ok(
    known / currentFiles.length >= 0.5,
    `manifest is stale: only ${known} of ${currentFiles.length} suites have recorded durations — regenerate it from a recent PR run (see the manifest's $comment)`,
  );
});

test("the real shard partition is duration-balanced", () => {
  const durations = loadShardDurations(durationsManifest);
  const fallback = defaultSuiteWeight(durations);
  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    dryRunJson(["--mode", "general", "--group", "general-server", "--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const totals = shards.map((shard) =>
    shard.selectedGeneralServerSuites.reduce((sum, file) => sum + (durations[file] ?? fallback), 0),
  );
  const maxTotal = Math.max(...totals);
  const minTotal = Math.min(...totals);
  // LPT keeps the spread within the heaviest single suite; use that as the bound.
  const heaviest = Math.max(...Object.values(durations));
  assert.ok(
    maxTotal - minTotal <= heaviest,
    `shard weight spread ${maxTotal - minTotal}ms exceeds heaviest suite ${heaviest}ms: ${totals.join(", ")}`,
  );
});
