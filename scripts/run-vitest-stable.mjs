import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShardDurations, selectGeneralServerShard } from "./general-server-shard.mjs";
import { linkSdkInto } from "./link-plugin-dev-sdk.mjs";
import {
  discoverVitestProjectManifest,
  generalServerLane,
  generalWorkspacesALane,
  generalWorkspacesBLane,
  serializedWorkspaceLane,
} from "./vitest-project-manifest.mjs";

const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const serializedDomainTestPatterns = Object.freeze([
  /(?:^|\/)task-execution(?:-|\/)/,
  /(?:^|\/)task-session(?:-|\/)/,
  /(?:^|\/)[^/]*liveness[^/]*\.test\.ts$/,
  /(?:^|\/)[^/]*(?:prompt|acp)[^/]*\.test\.ts$/,
  /(?:^|\/)[^/]*postgres[^/]*\.test\.ts$/,
]);
const serializedIsolationSuites = new Set([
  "apps/server/src/__tests__/approval-routes-idempotency.test.ts",
  "apps/server/src/__tests__/assets.test.ts",
  "apps/server/src/__tests__/authz-company-access.test.ts",
  "apps/server/src/__tests__/company-portability.test.ts",
  "apps/server/src/__tests__/costs-service.test.ts",
  "apps/server/src/__tests__/express5-auth-wildcard.test.ts",
  "apps/server/src/__tests__/health-dev-server-access.test.ts",
  "apps/server/src/__tests__/health.test.ts",
  "apps/server/src/__tests__/invite-accept-existing-member.test.ts",
  "apps/server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "apps/server/src/__tests__/invite-accept-replay.test.ts",
  "apps/server/src/__tests__/invite-expiry.test.ts",
  "apps/server/src/__tests__/invite-join-manager.test.ts",
  "apps/server/src/__tests__/invite-onboarding-text.test.ts",
  "apps/server/src/__tests__/tasks-service.test.ts",
  "apps/server/src/__tests__/project-routes-env.test.ts",
  "apps/server/src/__tests__/redaction.test.ts",
  "apps/server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalGroupNames = [generalServerGroupName, generalWorkspacesAGroupName, generalWorkspacesBGroupName];
const databaseEnvironmentKeyPattern =
  /(?:^|_)DATABASE(?:_|$)|^(?:PG|POSTGRES(?:QL)?_)/;
const inheritedTestEnvironmentKeys = new Set([
  "CI",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "RUNNER_ARCH",
  "RUNNER_OS",
  "SHELL",
  "SYSTEMROOT",
  "TERM",
  "TZ",
  "USER",
  "USERNAME",
  "WINDIR",
]);
const serializedServerVitestArgs = [
  "--no-file-parallelism",
  "--maxWorkers=1",
];

export function buildIsolatedVitestEnv(baseEnvironment, testRoot, instanceId) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    const normalizedKey = key.toUpperCase();
    if (
      value !== undefined &&
      (inheritedTestEnvironmentKeys.has(normalizedKey) || normalizedKey.startsWith("LC_"))
    ) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    HOME: path.join(testRoot, "home"),
    NODE_ENV: "test",
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    PAPERCLIP_INSTANCE_ID: instanceId,
    TEMP: path.join(testRoot, "t"),
    TMP: path.join(testRoot, "t"),
    TMPDIR: path.join(testRoot, "t"),
  });
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (databaseEnvironmentKeyPattern.test(normalizedKey)) {
      delete env[key];
    }
  }
  return env;
}

export function isSerializedServerTest(file) {
  if (!file.startsWith("apps/server/src/") || !file.endsWith(".test.ts")) return false;
  return (
    routeTestPattern.test(file) ||
    serializedIsolationSuites.has(file) ||
    serializedDomainTestPatterns.some((pattern) => pattern.test(file))
  );
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  const shardAllowed =
    mode === serializedModeName ||
    (mode === generalModeName && group === generalServerGroupName);
  if (!shardAllowed && shardIndex !== null) {
    fail(
      "--shard-index/--shard-count are only valid with --mode serialized or --mode general --group general-server.",
    );
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !generalGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${generalGroupNames.join(", ")}.`);
  }

  if (shardIndex !== null) {
    if (shardIndex >= shardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${shardIndex} of ${shardCount}.`);
    }
  }

  if (mode === serializedModeName) {
    return {
      mode,
      shardIndex: shardIndex ?? 0,
      shardCount: shardCount ?? 1,
      group: null,
      dryRun,
    };
  }

  return {
    mode,
    shardIndex,
    shardCount,
    group,
    dryRun,
  };
}

function selectSerializedSuites(serializedTests, shardIndex, shardCount) {
  return serializedTests.filter((_, index) => index % shardCount === shardIndex);
}

function runVitest(repoRoot, args, label) {
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const testRoot = mkdtempSync(path.join(tempRootParent, `pcvt-${process.pid}-${invocationIndex}-`));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = buildIsolatedVitestEnv(
    process.env,
    testRoot,
    `vt-${process.pid}-${invocationIndex}`,
  );
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[test:run] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensurePluginBuildDependencies(repoRoot) {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "ensure-plugin-build-deps.mjs")],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function standaloneDependenciesReady(repoRoot, project) {
  return existsSync(
    path.join(
      repoRoot,
      project.path,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "vitest.cmd" : "vitest",
    ),
  );
}

/**
 * Packages intentionally excluded from the pnpm workspace keep their own
 * dependency graph. Prepare those graphs only when their lane is actually
 * going to execute, using the same isolated install and SDK-link mechanics as
 * the standalone release builder.
 */
export function prepareStandaloneVitestProjects(
  repoRoot,
  projects,
  {
    spawn = spawnSync,
    linkSdk = linkSdkInto,
  } = {},
) {
  for (const project of projects) {
    if (!project.requiresStandaloneInstall) continue;
    const projectRoot = path.join(repoRoot, project.path);
    if (!standaloneDependenciesReady(repoRoot, project)) {
      console.log(`\n[test:run] preparing standalone project ${project.name}`);
      const install = spawn(
        "pnpm",
        ["install", "--ignore-workspace", "--no-lockfile"],
        {
          cwd: projectRoot,
          env: process.env,
          stdio: "inherit",
        },
      );
      if (install.error) {
        throw new Error(
          `Failed to prepare standalone Vitest project ${project.name}: ${install.error.message}`,
        );
      }
      if (install.status !== 0) {
        throw new Error(
          `Failed to prepare standalone Vitest project ${project.name} (exit ${install.status ?? "unknown"})`,
        );
      }
    }

    if (project.path.startsWith("packages/plugins/")) {
      linkSdk(projectRoot);
    }
  }
}

function runGeneralSuites(context) {
  for (const groupName of generalGroupNames) {
    runGeneralGroup(context, groupName);
  }
}

export function buildProjectVitestInvocation(repoRoot, project) {
  return project.requiresStandaloneInstall
    ? {
        cwd: path.join(repoRoot, project.path),
        args: ["--config", "vitest.config.ts"],
      }
    : {
        cwd: repoRoot,
        args: ["--project", project.name],
      };
}

function runProjectGroup(repoRoot, projects, groupName) {
  prepareStandaloneVitestProjects(repoRoot, projects);
  for (const project of projects) {
    const invocation = buildProjectVitestInvocation(repoRoot, project);
    runVitest(
      invocation.cwd,
      invocation.args,
      `${groupName} ${project.requiresStandaloneInstall ? "standalone " : ""}project ${project.name}`,
    );
  }
}

function runGeneralGroup(context, groupName, shardIndex = null, shardCount = null) {
  const {
    generalServerShardDurations,
    generalServerTestFiles,
    generalWorkspacesAProjects,
    generalWorkspacesBProjects,
    repoRoot,
    serializedServerTests,
  } = context;
  if (groupName === generalServerGroupName) {
    if (shardCount !== null && shardCount > 1) {
      const shardFiles = selectGeneralServerShard(
        generalServerTestFiles,
        shardIndex,
        shardCount,
        generalServerShardDurations,
      );
      console.log(
        `\n[test:run] general-server shard ${shardIndex + 1}/${shardCount} running ${shardFiles.length} of ${generalServerTestFiles.length} suites`,
      );
      if (shardFiles.length === 0) {
        return;
      }

      runVitest(
        repoRoot,
        [
          "--project",
          "@paperclipai/server",
          ...serializedServerVitestArgs,
          ...shardFiles,
        ],
        `${groupName} shard ${shardIndex + 1}/${shardCount}`,
      );
      return;
    }

    const excludeSerializedArgs = serializedServerTests.flatMap((file) => [
      "--exclude",
      file.serverPath,
    ]);
    runVitest(
      repoRoot,
      [
        "--project",
        "@paperclipai/server",
        ...serializedServerVitestArgs,
        ...excludeSerializedArgs,
      ],
      `${groupName} server suites excluding ${serializedServerTests.length} serialized suites`,
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    runProjectGroup(repoRoot, generalWorkspacesAProjects, groupName);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    runProjectGroup(repoRoot, generalWorkspacesBProjects, groupName);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

function runSerializedSuites(context, shardIndex, shardCount) {
  const { repoRoot, serializedServerTests, serializedWorkspaceProjects } = context;
  const shardTests = selectSerializedSuites(
    serializedServerTests,
    shardIndex,
    shardCount,
  );
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${serializedServerTests.length} server suites`,
  );

  if (shardIndex === 0) {
    runProjectGroup(repoRoot, serializedWorkspaceProjects, "serialized workspace");
  }

  for (const serializedTest of shardTests) {
    runVitest(
      repoRoot,
      [
        "--project",
        "@paperclipai/server",
        serializedTest.repoPath,
        "--pool=forks",
        "--isolate",
      ],
      serializedTest.repoPath,
    );
  }
}

export function main(argv = process.argv.slice(2)) {
  const repoRoot = process.cwd();
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const generalServerShardDurations = loadShardDurations(
    path.join(scriptsDir, "general-server-shard-durations.json"),
  );
  const serverRoot = path.join(repoRoot, "apps", "server");
  const { projects: testProjects } = discoverVitestProjectManifest(repoRoot);
  const serverProject = testProjects.find(
    (project) => project.path === "apps/server",
  );
  if (!serverProject) fail("The server Vitest project is missing");
  const serializedWorkspaceProjects = testProjects
    .filter((project) => project.lane === serializedWorkspaceLane);
  if (serializedWorkspaceProjects.length !== 1) {
    fail("The database Vitest project must exist exactly once");
  }
  const generalWorkspacesAProjects = testProjects
    .filter((project) => project.lane === generalWorkspacesALane);
  const generalWorkspacesBProjects = testProjects
    .filter((project) => project.lane === generalWorkspacesBLane);

  const allServerTestFiles = serverProject.testFiles;
  const serializedServerTests = allServerTestFiles
    .filter(isSerializedServerTest)
    .map((repoPath) => ({
      repoPath,
      serverPath: path.relative(serverRoot, path.join(repoRoot, repoPath)).split(path.sep).join("/"),
    }));
  // Every server suite belongs to exactly one lane. The general shard remains
  // duration-balanced; only the closed serialized path/metadata rule removes a
  // suite from it.
  const generalServerTestFiles = allServerTestFiles.filter(
    (repoPath) => !isSerializedServerTest(repoPath),
  );
  const testFileAssignments = testProjects.flatMap((project) =>
    project.testFiles.map((file) => ({
      file,
      project: project.name,
      lane:
        project.lane === generalServerLane && isSerializedServerTest(file)
          ? "serialized-server"
          : project.lane,
    })),
  );
  const context = {
    generalServerShardDurations,
    generalServerTestFiles,
    generalWorkspacesAProjects,
    generalWorkspacesBProjects,
    repoRoot,
    serializedServerTests,
    serializedWorkspaceProjects,
  };

  const options = parseCliOptions(argv);
  if (options.dryRun) {
    const selectedSerializedSuites =
      options.mode === serializedModeName
        ? selectSerializedSuites(
            serializedServerTests,
            options.shardIndex,
            options.shardCount,
          )
        : serializedServerTests;
    console.log(
      JSON.stringify(
        {
          mode: options.mode,
          shardIndex: options.shardIndex,
          shardCount: options.shardCount,
          group: options.group,
          availableGeneralGroups: generalGroupNames,
          testProjects: testProjects.map(({ name, path, lane, workspace, testFiles }) => ({
            name,
            path,
            lane,
            workspace,
            suiteCount: testFiles.length,
          })),
          testFileAssignments,
          generalWorkspacesAProjects: generalWorkspacesAProjects.map(
            (project) => project.name,
          ),
          generalWorkspacesBProjects: generalWorkspacesBProjects.map(
            (project) => project.name,
          ),
          serializedWorkspaceProjects: serializedWorkspaceProjects.map(
            (project) => project.name,
          ),
          selectedSerializedWorkspaceProjects:
            (options.mode === serializedModeName || options.mode === allModeName) &&
            (options.shardIndex ?? 0) === 0
              ? serializedWorkspaceProjects.map((project) => project.name)
              : [],
          serializedSuiteCount: serializedServerTests.length,
          selectedSerializedSuites: selectedSerializedSuites.map(
            (serializedTest) => serializedTest.repoPath,
          ),
          generalServerSuiteCount: generalServerTestFiles.length,
          selectedGeneralServerSuites:
            options.mode === generalModeName &&
            options.group === generalServerGroupName &&
            options.shardCount !== null
              ? selectGeneralServerShard(
                  generalServerTestFiles,
                  options.shardIndex,
                  options.shardCount,
                  generalServerShardDurations,
                )
              : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  ensurePluginBuildDependencies(repoRoot);

  if (options.mode === generalModeName || options.mode === allModeName) {
    if (options.group) {
      runGeneralGroup(context, options.group, options.shardIndex, options.shardCount);
    } else {
      runGeneralSuites(context);
    }
  }

  if (options.mode === serializedModeName || options.mode === allModeName) {
    runSerializedSuites(
      context,
      options.shardIndex ?? 0,
      options.shardCount ?? 1,
    );
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
