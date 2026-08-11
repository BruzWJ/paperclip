import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SOURCE_ROOTS = [
  "apps/server/src",
  "packages/adapter-utils/src",
  "packages/adapters",
] as const;

/** These owners prove that Paperclip has one server/worker execution path. */
const REQUIRED_OWNERS = [
  "apps/server/src/services/local-execution-orchestrator.ts",
  "apps/server/src/services/issue-execution-attempt-executor.ts",
  "apps/server/src/services/issue-execution-postgres.ts",
  "apps/server/src/services/issue-execution-provider-configuration.ts",
  "apps/server/src/index.ts",
  "packages/adapter-utils/src/types.ts",
  "packages/adapter-utils/src/server-adapter-contract.ts",
] as const;

const RETIRED_AI_PATHS = [
  "packages/adapter-utils/src/issue-execution.ts",
  "packages/adapter-utils/src/provider-cli.ts",
  "packages/adapter-utils/src/provider-cli-adapter.ts",
  "packages/adapter-utils/src/session-provider-event.ts",
  "apps/server/src/services/agent-execution/session-runner/stateless.ts",
  "apps/server/src/services/agent-execution/session-runner/provider-turn.ts",
  "apps/server/src/services/agent-execution/session-runner/to-provider-messages.ts",
  "apps/server/src/services/agent-execution/session-runner/native-events.ts",
  "apps/server/src/services/agent-execution/session-runner/output.ts",
] as const;

/** ACPX owns provider launch and process confinement; these former raw owners
 * must not be recreated beside the public runtime bridge. */
const RETIRED_RAW_EXECUTION_UTILITY_PATHS = [
  "packages/adapter-utils/src/execution-target.ts",
  "packages/adapter-utils/src/server-utils.ts",
  "packages/adapter-utils/src/local-process-sandbox.ts",
] as const;

const RETIRED_RAW_EXECUTION_UTILITY_SYMBOLS = [
  "AdapterExecutionTarget",
  "LocalProcessSandboxOptions",
  "buildLocalProcessSandboxSpawnTarget",
  "runChildProcess",
  "runAdapterExecutionTargetProcess",
  "runAdapterExecutionTargetShellCommand",
  "resolveAdapterExecutionTargetExecutable",
  "sanitizeInheritedProviderChildEnv",
] as const;

/** Paperclip must not retain an independent catalog of agent names or models. */
const RETIRED_STATIC_AGENT_CATALOG_PATHS = [
  "apps/server/src/adapters/builtin-adapter-catalog.ts",
  "apps/server/src/adapters/builtin-adapter-types.ts",
  "apps/server/src/adapters/codex.ts",
] as const;

const RETIRED_AI_SYMBOLS = [
  "ProviderInvocation",
  "AdapterExecutionRequest",
  "SessionProviderEvent",
  "streamStatelessTurn",
  "stateless-history",
  "native-turn",
  "providerInputKind",
  "providerInputTransport",
  "createProviderCliAdapter",
  "executeProviderCli",
] as const;

const DEFERRED_MACHINE_RUNTIME_SYMBOLS = [
  "createConnectedMachineRuntime",
  "createMachineEnrollment",
  "machineTargetedEventBus",
  "runtimeWebSocketProtocol",
  "runtimeDevicePairing",
] as const;

const RETIRED_PAPERCLIP_CATALOG_MARKERS = [
  "APPROVED_ACP_LAUNCHES",
  "BUILTIN_ADAPTER_CATALOG",
  "resolveApprovedAcpLaunch",
  "listApprovedAcpLaunchNames",
  "RegisterServerAdapterOptions",
  "registerServerAdapter",
  "unregisterServerAdapter",
  "waitForExternalAdapters",
  "listServerAdapterImplementations",
  "listEnabledServerAdapters",
  "setOverridePaused",
  "isOverridePaused",
  "getPausedOverrides",
  "findActiveServerAdapter",
  "findSelectableServerAdapter(",
  "requireServerAdapter",
] as const;

export interface ServerWorkerTopologyFile {
  readonly path: string;
  readonly source: string;
}

export interface ServerWorkerTopologyViolation {
  readonly path: string;
  readonly message: string;
}

function normalizePath(value: string): string {
  return value.split("\\").join("/");
}

function isTestOrFixturePath(value: string): boolean {
  const path = normalizePath(value);
  return path.includes("/__tests__/") ||
    path.includes("/fixtures/") ||
    /\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(path);
}

function count(source: string, expression: RegExp): number {
  return [...source.matchAll(expression)].length;
}

function requireMarkers(input: {
  readonly path: string;
  readonly source: string;
  readonly markers: readonly string[];
  readonly add: (path: string, message: string) => void;
  readonly contract: string;
}): void {
  for (const marker of input.markers) {
    if (!input.source.includes(marker)) {
      input.add(
        input.path,
        `${input.contract} is missing ${JSON.stringify(marker)}`,
      );
    }
  }
}

/**
 * Static topology gate for the one common worker path. It deliberately does
 * not enumerate agents, models, frontends, or provider configuration: ACPX
 * owns that catalog and the local ACP probe decides what is selectable.
 */
export function scanServerWorkerTopology(
  inputFiles: readonly ServerWorkerTopologyFile[],
): ServerWorkerTopologyViolation[] {
  const files = new Map(
    inputFiles.map((file) => [normalizePath(file.path), file.source]),
  );
  const violations: ServerWorkerTopologyViolation[] = [];
  const add = (path: string, message: string) => {
    violations.push({ path, message });
  };
  const required = (path: string): string => {
    const source = files.get(path);
    if (source === undefined) {
      add(path, "required canonical server/worker owner is missing");
      return "";
    }
    return source;
  };

  for (const path of REQUIRED_OWNERS) required(path);
  for (const path of RETIRED_AI_PATHS) {
    if (files.has(path)) {
      add(path, "retired alternate AI execution owner still exists");
    }
  }
  for (const path of RETIRED_RAW_EXECUTION_UTILITY_PATHS) {
    if (files.has(path)) {
      add(path, "retired raw provider-process utility owner still exists");
    }
  }
  for (const path of RETIRED_STATIC_AGENT_CATALOG_PATHS) {
    if (files.has(path)) {
      add(path, "retired Paperclip-owned agent catalog remains");
    }
  }

  for (const [path, source] of files) {
    if (isTestOrFixturePath(path)) continue;
    for (const symbol of RETIRED_AI_SYMBOLS) {
      if (source.includes(symbol)) {
        add(path, `retired alternate AI execution seam remains: ${symbol}`);
      }
    }
    for (const symbol of DEFERRED_MACHINE_RUNTIME_SYMBOLS) {
      if (source.includes(symbol)) {
        add(path, `deferred connected-machine runtime seam remains: ${symbol}`);
      }
    }
    for (const marker of RETIRED_PAPERCLIP_CATALOG_MARKERS) {
      if (source.includes(marker)) {
        add(path, `retired Paperclip adapter catalog seam remains: ${marker}`);
      }
    }
    for (const symbol of RETIRED_RAW_EXECUTION_UTILITY_SYMBOLS) {
      if (new RegExp(`\\b${symbol}\\b`).test(source)) {
        add(path, `retired raw provider-process utility remains: ${symbol}`);
      }
    }
  }

  const typesPath = "packages/adapter-utils/src/types.ts";
  requireMarkers({
    path: typesPath,
    source: required(typesPath),
    markers: [
      "export interface ServerAdapterModule",
      "readonly type: string",
      "readonly definition: AcpxAdapterDefinition",
    ],
    add,
    contract: "closed declarative adapter ABI",
  });

  const executorPath =
    "apps/server/src/services/issue-execution-attempt-executor.ts";
  const executor = required(executorPath);
  requireMarkers({
    path: executorPath,
    source: executor,
    markers: [
      "executeAcpxOneShotPrompt",
      "prepareAcpxRuntimeInvocation",
      "createPaperclipRunToolsMcpServer",
      "sessionCorrelations.resolveResume",
      'promptKind: "base" | "steering"',
    ],
    add,
    contract: "canonical ACPX attempt executor",
  });
  if (count(executor, /executeAcpxOneShotPrompt/g) < 2) {
    add(
      executorPath,
      "canonical ACPX attempt executor must invoke ACPX one-shot prompt execution",
    );
  }

  const providerConfigurationPath =
    "apps/server/src/services/issue-execution-provider-configuration.ts";
  requireMarkers({
    path: providerConfigurationPath,
    source: required(providerConfigurationPath),
    markers: [
      "IssueExecutionTargetAcquirer",
      "acquireExecutionTargetForRun",
      "localExecutionOrchestrator",
      "releaseExecutionTarget",
    ],
    add,
    contract: "existing worker execution-target bridge",
  });

  const productionRuntimePath =
    "apps/server/src/services/issue-execution-postgres.ts";
  requireMarkers({
    path: productionRuntimePath,
    source: required(productionRuntimePath),
    markers: [
      "export function createPostgresIssueExecutionProductionRuntime",
      "createIssueExecutionCancellationService",
      "localExecutionOrchestrator: options.localExecutionOrchestrator",
      "cancellation = createIssueExecutionCancellationService({",
    ],
    add,
    contract: "canonical productive and consult runtime assembly",
  });

  const orchestratorPath =
    "apps/server/src/services/local-execution-orchestrator.ts";
  requireMarkers({
    path: orchestratorPath,
    source: required(orchestratorPath),
    markers: [
      "localExecutionOrchestrator",
      "acquireExecutionTargetForRun",
      "localRunLeaseService",
    ],
    add,
    contract: "invariant local execution orchestrator",
  });
  const assemblyPath = "apps/server/src/index.ts";
  requireMarkers({
    path: assemblyPath,
    source: required(assemblyPath),
    markers: [
      "localExecutionOrchestrator",
      "createPostgresIssueExecutionProductionRuntime",
    ],
    add,
    contract: "server plus worker production assembly",
  });

  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.message.localeCompare(right.message),
  );
}

function walk(
  root: string,
  repositoryRoot: string,
  files: ServerWorkerTopologyFile[],
): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") {
        walk(absolute, repositoryRoot, files);
      }
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    files.push({
      path: normalizePath(relative(repositoryRoot, absolute)),
      source: readFileSync(absolute, "utf8"),
    });
  }
}

export function listServerWorkerTopologyFiles(
  repositoryRoot = REPOSITORY_ROOT,
): ServerWorkerTopologyFile[] {
  const files: ServerWorkerTopologyFile[] = [];
  for (const root of SOURCE_ROOTS) {
    walk(resolve(repositoryRoot, root), repositoryRoot, files);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertServerWorkerTopology(
  repositoryRoot = REPOSITORY_ROOT,
): void {
  const violations = scanServerWorkerTopology(
    listServerWorkerTopologyFiles(repositoryRoot),
  );
  if (violations.length === 0) return;
  throw new Error(
    "Canonical server/worker ACP topology check failed:\n" +
      violations
        .map((violation) => `${violation.path}: ${violation.message}`)
        .join("\n"),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  assertServerWorkerTopology();
  console.log("Dynamic ACPX server/worker topology check passed.");
}
