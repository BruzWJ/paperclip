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
  "server/src",
  "packages/adapter-utils/src",
  "packages/adapters",
] as const;

const REQUIRED_OWNERS = [
  "server/src/adapters/builtin-adapter-catalog.ts",
  "server/src/adapters/builtin-adapter-types.ts",
  "server/src/adapters/codex.ts",
  "server/src/adapters/registry.ts",
  "server/src/services/environment-run-orchestrator.ts",
  "server/src/services/environment-execution-target.ts",
  "server/src/services/issue-execution-attempt-executor.ts",
  "server/src/services/issue-execution-postgres.ts",
  "server/src/services/issue-execution-provider-configuration.ts",
  "server/src/index.ts",
  "packages/adapter-utils/package.json",
  "packages/adapter-utils/src/types.ts",
  "packages/adapter-utils/src/server-adapter-contract.ts",
  "packages/adapter-utils/src/acp-subprocess/agent-registry.ts",
  "packages/adapter-utils/src/acp-subprocess/client.ts",
  "packages/adapter-utils/src/acp-subprocess/contract.ts",
  "packages/adapter-utils/src/acp-subprocess/events.ts",
  "packages/adapter-utils/src/acp-subprocess/execution-target.ts",
  "packages/adapter-utils/src/acp-subprocess/process.ts",
  "packages/adapter-utils/src/acp-subprocess/run-tools.ts",
] as const;

const RETIRED_AI_PATHS = [
  "packages/adapter-utils/src/issue-execution.ts",
  "packages/adapter-utils/src/provider-cli.ts",
  "packages/adapter-utils/src/provider-cli-adapter.ts",
  "packages/adapter-utils/src/session-provider-event.ts",
  "server/src/services/agent-execution/session-runner/stateless.ts",
  "server/src/services/agent-execution/session-runner/provider-turn.ts",
  "server/src/services/agent-execution/session-runner/to-provider-messages.ts",
  "server/src/services/agent-execution/session-runner/native-events.ts",
  "server/src/services/agent-execution/session-runner/output.ts",
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

const EXACT_ADAPTER_DEPENDENCIES = Object.freeze({
  "@agentclientprotocol/codex-acp": "1.1.7",
  "@agentclientprotocol/sdk": "1.3.0",
  acpx: "0.13.0",
});

export const CANONICAL_BUILT_IN_ADAPTERS = Object.freeze([
  Object.freeze({
    type: "codex",
    packageName: "@paperclipai/server",
    source: "server/src/adapters/codex.ts",
    contractVersion: "acp-subprocess/v1",
  }),
]);

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

function parseManifest(
  path: string,
  source: string,
  add: (path: string, message: string) => void,
): Record<string, unknown> | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      add(path, "package manifest must be a JSON object");
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    add(path, "package manifest is not valid JSON");
    return null;
  }
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
 * Static P10/P11 cutover gate. It intentionally proves the one production
 * graph rather than maintaining an inventory of removed provider backends.
 * The ACP registry admission gate separately audits SDK wire details and the
 * exact ACPX launch catalog.
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
  }

  const catalogPath = "server/src/adapters/builtin-adapter-catalog.ts";
  const catalog = required(catalogPath);
  const catalogTypes = [...catalog.matchAll(/adapterType\s*:\s*["']([^"']+)["']/g)]
    .map((match) => match[1]!);
  if (
    catalogTypes.length !== 1 ||
    catalogTypes[0] !== CANONICAL_BUILT_IN_ADAPTERS[0]!.type
  ) {
    add(
      catalogPath,
      "built-in adapter catalog must contain exactly the canonical codex ACP adapter",
    );
  }
  requireMarkers({
    path: catalogPath,
    source: catalog,
    markers: [
      'import { codexAdapter } from "./codex.js"',
      "validateServerAdapterModule",
      "adapterType !==",
      "adapter.type",
    ],
    add,
    contract: "built-in adapter catalog",
  });

  const builtinTypesPath = "server/src/adapters/builtin-adapter-types.ts";
  requireMarkers({
    path: builtinTypesPath,
    source: required(builtinTypesPath),
    markers: ["BUILTIN_ADAPTER_CATALOG", "entry.adapterType"],
    add,
    contract: "built-in adapter type derivation",
  });

  const codexPath = "server/src/adapters/codex.ts";
  const codex = required(codexPath);
  requireMarkers({
    path: codexPath,
    source: codex,
    markers: [
      'resolveApprovedAcpLaunch("codex")',
      'type: "codex"',
      'version: "acp-subprocess/v1"',
      "sessionScopedMcpReplacement: true",
      "cliNativeAuthentication: true",
      "definition:",
    ],
    add,
    contract: "canonical codex descriptor",
  });

  const registryPath = "server/src/adapters/registry.ts";
  requireMarkers({
    path: registryPath,
    source: required(registryPath),
    markers: [
      "BUILTIN_ADAPTER_CATALOG",
      "validateServerAdapterModule",
      "resolveApprovedAcpLaunch",
      "RegisteredServerAdapterImplementation",
      "adapterImplementationIdentityKey",
      "registerImplementation",
    ],
    add,
    contract: "immutable adapter registry",
  });

  const typesPath = "packages/adapter-utils/src/types.ts";
  const adapterTypes = required(typesPath);
  requireMarkers({
    path: typesPath,
    source: adapterTypes,
    markers: [
      "export interface ServerAdapterModule",
      "readonly type: string",
      "readonly definition: AcpSubprocessAdapterDefinition",
    ],
    add,
    contract: "closed declarative adapter ABI",
  });

  const adapterManifestPath = "packages/adapter-utils/package.json";
  const adapterManifest = parseManifest(
    adapterManifestPath,
    required(adapterManifestPath),
    add,
  );
  if (adapterManifest) {
    const dependencies = adapterManifest.dependencies;
    const bundled = adapterManifest.bundleDependencies;
    for (const [name, version] of Object.entries(EXACT_ADAPTER_DEPENDENCIES)) {
      if (
        !dependencies ||
        typeof dependencies !== "object" ||
        Array.isArray(dependencies) ||
        (dependencies as Record<string, unknown>)[name] !== version
      ) {
        add(adapterManifestPath, `${name} must be pinned exactly to ${version}`);
      }
      if (!Array.isArray(bundled) || !bundled.includes(name)) {
        add(adapterManifestPath, `${name} must ship with adapter-utils`);
      }
    }
  }

  const executorPath =
    "server/src/services/issue-execution-attempt-executor.ts";
  const executor = required(executorPath);
  requireMarkers({
    path: executorPath,
    source: executor,
    markers: [
      "executeAcpSubprocessPrompt",
      "prepareAcpExecutionTargetSubprocess",
      "createPaperclipRunToolsMcpServer",
      "resolveApprovedAcpLaunch",
      "sessionCorrelations.resolveStart",
      "recovery.prepareReplacementPrompt",
      'promptKind: "base" | "steering"',
      "recordSubprocessTeardown",
    ],
    add,
    contract: "canonical ACP attempt executor",
  });
  if (count(executor, /executeAcpSubprocessPrompt/g) < 2) {
    add(
      executorPath,
      "canonical ACP attempt executor must import and use the common SDK lifecycle",
    );
  }

  const providerConfigurationPath =
    "server/src/services/issue-execution-provider-configuration.ts";
  requireMarkers({
    path: providerConfigurationPath,
    source: required(providerConfigurationPath),
    markers: [
      "IssueExecutionTargetAcquirer",
      "acquireExecutionTargetForRun",
      "executionTargetSelector",
      "releaseExecutionTarget",
    ],
    add,
    contract: "existing worker execution-target bridge",
  });

  const productionRuntimePath =
    "server/src/services/issue-execution-postgres.ts";
  requireMarkers({
    path: productionRuntimePath,
    source: required(productionRuntimePath),
    markers: [
      "export function createPostgresIssueExecutionProductionRuntime",
      "createIssueExecutionCancellationService",
      "environmentOrchestrator: options.environmentOrchestrator",
      "cancellation = createIssueExecutionCancellationService({",
    ],
    add,
    contract: "canonical productive and consult runtime assembly",
  });

  const orchestratorPath =
    "server/src/services/environment-run-orchestrator.ts";
  requireMarkers({
    path: orchestratorPath,
    source: required(orchestratorPath),
    markers: ["acquireExecutionTargetForRun", "environmentRuntime"],
    add,
    contract: "existing environment orchestrator",
  });
  const targetPath =
    "server/src/services/environment-execution-target.ts";
  requireMarkers({
    path: targetPath,
    source: required(targetPath),
    markers: ["AdapterExecutionTarget", "EnvironmentDriver"],
    add,
    contract: "existing environment execution target",
  });

  const assemblyPath = "server/src/index.ts";
  requireMarkers({
    path: assemblyPath,
    source: required(assemblyPath),
    markers: [
      "environmentRuntimeService",
      "environmentRunOrchestrator",
      "createPostgresSessionCompactionProvider",
      "createPostgresIssueExecutionProductionRuntime",
    ],
    add,
    contract: "server plus worker production assembly",
  });

  return violations.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.message.localeCompare(right.message));
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
  for (const path of ["packages/adapter-utils/package.json"] as const) {
    const absolute = resolve(repositoryRoot, path);
    if (existsSync(absolute)) {
      files.push({ path, source: readFileSync(absolute, "utf8") });
    }
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
  console.log("Canonical server/worker ACP topology check passed.");
}
