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

/**
 * These owners prove that Paperclip has one ACPX runtime execution path while
 * ACPX supplies all locally available agent metadata at runtime.
 */
const REQUIRED_OWNERS = [
  "apps/server/src/adapters/acpx-catalog.ts",
  "apps/server/src/adapters/registry.ts",
  "apps/server/src/services/environment-run-orchestrator.ts",
  "apps/server/src/services/environment-execution-target.ts",
  "apps/server/src/services/issue-execution-attempt-executor.ts",
  "apps/server/src/services/issue-execution-postgres.ts",
  "apps/server/src/services/issue-execution-provider-configuration.ts",
  "apps/server/src/index.ts",
  "packages/adapter-utils/package.json",
  "packages/adapter-utils/src/types.ts",
  "packages/adapter-utils/src/server-adapter-contract.ts",
  "packages/adapter-utils/src/acp-subprocess/agent-registry.ts",
  "packages/adapter-utils/src/acp-subprocess/acpx-discovery.ts",
  "packages/adapter-utils/src/acp-subprocess/acpx-runtime-execution.ts",
  "packages/adapter-utils/src/acp-subprocess/acpx-runtime-invocation.ts",
  "packages/adapter-utils/src/acp-subprocess/acpx-runtime-readiness.ts",
  "packages/adapter-utils/src/acp-subprocess/contract.ts",
  "packages/adapter-utils/src/acp-subprocess/events.ts",
  "packages/adapter-utils/src/acp-subprocess/run-tools.ts",
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

/** Dependency versions are implementation pins, never an agent catalog. */
const EXACT_ADAPTER_DEPENDENCIES = Object.freeze({
  "@agentclientprotocol/sdk": "1.3.0",
  acpx: "0.13.0",
});

const STATIC_AGENT_CATALOG_MARKERS = [
  "APPROVED_ACP_LAUNCHES",
  "BUILTIN_ADAPTER_CATALOG",
  "resolveApprovedAcpLaunch",
  "listApprovedAcpLaunchNames",
] as const;

/**
 * The legacy raw ACP subprocess bridge may remain private fixture support in
 * adapter-utils, but production server code must never import or invoke it.
 * ACPX is the only runtime owner for live Paperclip attempts.
 */
const RAW_ACP_INVOCATION_SYMBOLS = [
  "executeAcpSubprocessPrompt",
  "prepareAcpExecutionTargetSubprocess",
  "spawnPreparedAcpSubprocess",
  "createInitializeOnlyClient",
  "PaperclipAcpClient",
  "AcpSubprocess",
  "AcpSubprocessLaunch",
  "AcpSubprocessStarter",
  "AcpSubprocessHostLaunch",
  "resolveAcpRegistryLaunch",
  "sameAcpRegistryLaunch",
  "AcpRegistryLaunch",
] as const;

const RAW_ACP_INVOCATION_MODULE =
  /["'][^"']*acp-subprocess\/(?:agent-registry|client|execution-target|process)(?:\.js)?["']/;

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

function productionRawInvocationImport(
  path: string,
  source: string,
): string | null {
  if (!path.startsWith("apps/server/src/") || isTestOrFixturePath(path)) {
    return null;
  }
  if (RAW_ACP_INVOCATION_MODULE.test(source)) {
    return "legacy raw ACP subprocess module import";
  }
  for (const symbol of RAW_ACP_INVOCATION_SYMBOLS) {
    const importExpression = new RegExp(
      `\\bimport\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s+from\\s+["'][^"']+["']`,
      "s",
    );
    if (importExpression.test(source)) {
      return `legacy raw ACP invocation import ${symbol}`;
    }
  }
  return null;
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
    for (const marker of STATIC_AGENT_CATALOG_MARKERS) {
      if (source.includes(marker)) {
        add(path, `Paperclip-owned static agent catalog seam remains: ${marker}`);
      }
    }
    const rawInvocationImport = productionRawInvocationImport(path, source);
    if (rawInvocationImport) {
      add(path, `production ACPX runtime boundary forbids ${rawInvocationImport}`);
    }
    if (path.startsWith("apps/server/src/") && source.includes("resolveAcpRegistryLaunch")) {
      add(path, "production ACPX runtime boundary must not resolve a launch argv");
    }
  }

  const registryPath = "packages/adapter-utils/src/acp-subprocess/agent-registry.ts";
  requireMarkers({
    path: registryPath,
    source: required(registryPath),
    markers: [
      "createAgentRegistry",
      "listAcpRegistryAgentNames",
      "assertAcpRegistryAgentName",
      "candidateRegistry.list()",
    ],
    add,
    contract: "dynamic ACPX registry bridge",
  });

  const discoveryPath = "packages/adapter-utils/src/acp-subprocess/acpx-discovery.ts";
  requireMarkers({
    path: discoveryPath,
    source: required(discoveryPath),
    markers: [
      "listAcpxAgentNames",
      "probeAcpxAgent",
      "createAcpRuntime",
      "ensureSession",
      "configOptions",
    ],
    add,
    contract: "local ACPX compatibility probe",
  });

  const catalogPath = "apps/server/src/adapters/acpx-catalog.ts";
  requireMarkers({
    path: catalogPath,
    source: required(catalogPath),
    markers: [
      "discoverLocalAcpxAdapterCatalog",
      "acpxDiscoveryToServerAdapter",
      "listAcpRegistryAgentNames",
      "probeAcpxAgent",
      "configOptions",
      "limits: null",
    ],
    add,
    contract: "ACPX-supplied dynamic adapter catalog",
  });

  const adapterRegistryPath = "apps/server/src/adapters/registry.ts";
  requireMarkers({
    path: adapterRegistryPath,
    source: required(adapterRegistryPath),
    markers: [
      "discoverLocalAcpxAdapterCatalog",
      "refreshAcpxAdapters",
      "assertAcpRegistryAgentName",
      "registerServerAdapter",
      "exclusively by ACPX",
    ],
    add,
    contract: "dynamic ACPX adapter registry",
  });

  const typesPath = "packages/adapter-utils/src/types.ts";
  requireMarkers({
    path: typesPath,
    source: required(typesPath),
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
    const selectedFrontend = dependencies &&
      typeof dependencies === "object" &&
      !Array.isArray(dependencies)
      ? Object.keys(dependencies).find(
          (name) =>
            name.startsWith("@agentclientprotocol/") &&
            name !== "@agentclientprotocol/sdk",
        )
      : undefined;
    if (selectedFrontend) {
      add(
        adapterManifestPath,
        `adapter-utils must not bundle a Paperclip-selected ACP frontend: ${selectedFrontend}`,
      );
    }
  }

  const executorPath =
    "apps/server/src/services/issue-execution-attempt-executor.ts";
  const executor = required(executorPath);
  requireMarkers({
    path: executorPath,
    source: executor,
    markers: [
      "executeAcpxRuntimePrompt",
      "executeAcpxOneShotPrompt",
      "prepareAcpxRuntimeInvocation",
      "createPaperclipRunToolsMcpServer",
      "sessionCorrelations.resolveStart",
      'promptKind: "base" | "steering"',
      "recordSubprocessTeardown",
    ],
    add,
    contract: "canonical ACPX attempt executor",
  });
  if (count(executor, /executeAcpxRuntimePrompt/g) < 2) {
    add(
      executorPath,
      "canonical ACPX attempt executor must export and use the common runtime lifecycle",
    );
  }
  if (count(executor, /executeAcpxOneShotPrompt/g) < 2) {
    add(
      executorPath,
      "canonical ACPX attempt executor must invoke ACPX one-shot prompt execution",
    );
  }

  requireMarkers({
    path: "packages/adapter-utils/src/acp-subprocess/acpx-runtime-execution.ts",
    source: required(
      "packages/adapter-utils/src/acp-subprocess/acpx-runtime-execution.ts",
    ),
    markers: [
      "executeAcpxOneShotPrompt",
      "createAcpRuntime",
      "createRuntimeStore",
      "ensureSession",
      "startTurn",
      "await runtime.setConfigOption?.({",
      "cancel",
      "close",
      "assertAcpRegistryAgentName",
    ],
    add,
    contract: "disposable ACPX one-shot execution bridge",
  });
  requireMarkers({
    path: "packages/adapter-utils/src/acp-subprocess/acpx-runtime-invocation.ts",
    source: required(
      "packages/adapter-utils/src/acp-subprocess/acpx-runtime-invocation.ts",
    ),
    markers: [
      "prepareAcpxRuntimeInvocation",
      "requireLocalTarget",
      "materializeAdapterExecutionTargetTextFiles",
      "operator_native",
    ],
    add,
    contract: "ACPX-only local invocation preparation",
  });
  requireMarkers({
    path: "packages/adapter-utils/src/acp-subprocess/acpx-runtime-readiness.ts",
    source: required(
      "packages/adapter-utils/src/acp-subprocess/acpx-runtime-readiness.ts",
    ),
    markers: [
      "probeAcpxRuntimeReadiness",
      "createAcpRuntime",
      "createRuntimeStore",
      "ensureSession",
      "getStatus",
      "await runtime.setConfigOption!({",
      "close",
    ],
    add,
    contract: "disposable ACPX readiness bridge",
  });

  const providerConfigurationPath =
    "apps/server/src/services/issue-execution-provider-configuration.ts";
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
    "apps/server/src/services/issue-execution-postgres.ts";
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
    "apps/server/src/services/environment-run-orchestrator.ts";
  requireMarkers({
    path: orchestratorPath,
    source: required(orchestratorPath),
    markers: ["acquireExecutionTargetForRun", "environmentRuntime"],
    add,
    contract: "existing environment orchestrator",
  });
  const targetPath =
    "apps/server/src/services/environment-execution-target.ts";
  requireMarkers({
    path: targetPath,
    source: required(targetPath),
    markers: ["AdapterExecutionTarget", "EnvironmentDriver"],
    add,
    contract: "existing environment execution target",
  });

  const assemblyPath = "apps/server/src/index.ts";
  requireMarkers({
    path: assemblyPath,
    source: required(assemblyPath),
    markers: [
      "environmentRuntimeService",
      "environmentRunOrchestrator",
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
  console.log("Dynamic ACPX server/worker topology check passed.");
}
