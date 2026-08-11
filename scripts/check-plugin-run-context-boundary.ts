import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertNoGateViolations,
  listRepositoryTextFiles,
  requireFileTokens,
} from "./static-removal-gate-utils.ts";

const SCHEMA = "packages/db/schema/run_interface_foundation.ts";
const COMPILER = "apps/server/src/services/runtime-interface-compiler.ts";
const RUNTIME_TOOL_GATEWAY = "apps/server/src/services/runtime-tool-gateway.ts";
const GATEWAY = "apps/server/src/services/prompt-capability-gateway.ts";
const GATEWAY_REPOSITORY =
  "apps/server/src/services/prompt-capability-gateway-postgres.ts";
const INDEX = "apps/server/src/index.ts";
const SDK_PROTOCOL = "packages/plugins/sdk/src/protocol.ts";
const SDK_TYPES = "packages/plugins/sdk/src/types.ts";
const SDK_WORKER = "packages/plugins/sdk/src/worker-rpc-host.ts";
const SDK_HOST_CLIENT = "packages/plugins/sdk/src/host-client-factory.ts";
const HOST_SERVICES = "apps/server/src/services/plugin-host-services.ts";
const RUN_RUNTIME = "apps/server/src/services/run-interface-runtime.ts";

const PLUGIN_CONTEXT_COLUMNS = new Set([
  "capabilityConnectionId",
  "capabilityGeneration",
  "runInterfaceToolCallId",
  "pluginInstallationId",
  "handleHash",
  "firstUsedAt",
  "createdAt",
]);

const EXECUTE_TOOL_FIELDS = new Set([
  "toolName",
  "parameters",
  "runContextHandle",
]);

const FACADE_FIELDS = new Set(["handle", "tasks"]);

const RAW_RUN_IDENTITY_FIELDS = [
  "companyId",
  "taskId",
  "sessionId",
  "runId",
  "agentId",
  "targetAgentId",
  "ownershipEpoch",
  "executionScopeId",
  "adapterConfigRevisionId",
  "executionWorkspaceBindingId",
] as const;

function read(repositoryRoot: string, path: string): string | null {
  const absolute = resolve(repositoryRoot, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
}

function between(
  source: string,
  start: string,
  end: string,
): string | null {
  const startOffset = source.indexOf(start);
  if (startOffset < 0) return null;
  const endOffset = source.indexOf(end, startOffset + start.length);
  return endOffset < 0
    ? source.slice(startOffset)
    : source.slice(startOffset, endOffset);
}

function interfaceFields(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z][A-Za-z0-9]*)(?:\?|):/gm)]
      .map((match) => match[1]!),
  );
}

function objectColumnFields(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)]
      .map((match) => match[1]!),
  );
}

function exactSetViolation(
  path: string,
  label: string,
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): string | null {
  const missing = [...expected].filter((entry) => !actual.has(entry));
  const extra = [...actual].filter((entry) => !expected.has(entry));
  if (missing.length === 0 && extra.length === 0) return null;
  return `${path}: ${label} is not exact (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`;
}

/**
 * Verifies the one opaque plugin-context flow from a compiled direct plugin
 * tool to the capability-authenticated retrieval service. No run identity is
 * copied into the plugin payload/facade and no plaintext handle is persisted.
 */
export function pluginRunContextBoundaryViolations(
  repositoryRoot: string,
): string[] {
  const violations: string[] = [
    ...requireFileTokens(repositoryRoot, SCHEMA, [
      '"plugin_run_contexts"',
      "handleHash: text(\"handle_hash\").primaryKey()",
      "plugin_run_contexts_capability_generation_fk",
      "plugin_run_contexts_exact_tool_call_fk",
      "pluginInstallationId",
      "runInterfaceToolCallId",
    ]),
    ...requireFileTokens(repositoryRoot, COMPILER, [
      'source: "plugin"',
      "pluginInstallationId",
      "pluginToolName",
      "pluginDescriptors",
    ]),
    ...requireFileTokens(repositoryRoot, RUNTIME_TOOL_GATEWAY, [
      "options.pluginTools.execute({",
      "runInterfaceToolCallId: claim.id",
      "mintPluginRunContext",
      "pluginInstallationId",
      "createRuntimePluginToolPort",
      "workerManager.getWorker(input.pluginInstallationId)",
      'worker?.status !== "running"',
      "worker.manifestIdentity !== input.pluginManifestIdentity",
      "const runContextHandle = await input.mintPluginRunContext();",
      "await worker.call(",
      '"executeTool"',
      "toolName: input.toolName",
      "parameters: input.arguments",
      "pluginRunContextHandle: runContextHandle",
    ]),
    ...requireFileTokens(repositoryRoot, GATEWAY, [
      "randomPluginRunContextHandle",
      "createPluginRunContext({",
      "handleHash: sha256(handle)",
      "resolvePluginRunContext(",
    ]),
    ...requireFileTokens(repositoryRoot, GATEWAY_REPOSITORY, [
      ".insert(pluginRunContexts)",
      "resolvePluginRunContextHash",
      "pluginInstallationId",
      "runInterfaceToolCallId",
    ]),
    ...requireFileTokens(repositoryRoot, INDEX, [
      "createRuntimePluginToolPort(",
      "pluginWorkerManager",
      "pluginTools: promptCapabilityPluginTools",
    ]),
    ...requireFileTokens(repositoryRoot, SDK_WORKER, [
      "async function handleExecuteTool",
      "const runContext: PluginToolRunContext = Object.freeze({",
      'callHost("run.tasks.listCompanyTasks"',
      'callHost("run.tasks.listSubTasks"',
      'callHost("run.tasks.readTaskComments"',
      'callHost("run.tasks.readTaskAgentRun"',
    ]),
    ...requireFileTokens(repositoryRoot, SDK_HOST_CLIENT, [
      "requireExactRunContextHandle",
      "requireRunTaskContextBoundary",
      "INSTALLATION_TASK_CONTROL_PLANE_METHODS",
      "supplied !== active",
    ]),
    ...requireFileTokens(repositoryRoot, HOST_SERVICES, [
      "export interface PluginRunTaskContextReader",
      "pluginRunTaskContextReader",
      "pluginRunTaskContextReader.listCompanyTasks({",
      "pluginRunTaskContextReader.listSubTasks({",
      "pluginRunTaskContextReader.readTaskComments({",
      "pluginRunTaskContextReader.readTaskAgentRun({",
    ]),
    ...requireFileTokens(repositoryRoot, RUN_RUNTIME, [
      "gateway.resolvePluginRunContext(",
      "retrieval.listCompanyTasks",
      "retrieval.listSubTasks",
      "retrieval.readTaskComments",
      "retrieval.readTaskAgentRun",
    ]),
  ];

  const schema = read(repositoryRoot, SCHEMA);
  if (schema !== null) {
    const table = between(
      schema,
      "export const pluginRunContexts = pgTable(",
      "/**\n * Durable provider-call identity ledger",
    );
    if (table === null) {
      violations.push(`${SCHEMA}: plugin_run_contexts table block is missing`);
    } else {
      const objectStart = table.indexOf("  {");
      const objectEnd = table.indexOf("\n  },", objectStart);
      const columns =
        objectStart >= 0 && objectEnd > objectStart
          ? objectColumnFields(table.slice(objectStart, objectEnd))
          : new Set<string>();
      const exact = exactSetViolation(
        SCHEMA,
        "plugin_run_contexts columns",
        columns,
        PLUGIN_CONTEXT_COLUMNS,
      );
      if (exact) violations.push(exact);
      if (/\b(?:handle|bearer|token|secret):/.test(table)) {
        violations.push(
          `${SCHEMA}: plugin_run_contexts persists a plaintext credential`,
        );
      }
      for (const field of RAW_RUN_IDENTITY_FIELDS) {
        if (new RegExp(`\\b${field}:`).test(table)) {
          violations.push(
            `${SCHEMA}: plugin_run_contexts duplicates run coordinate ${field}`,
          );
        }
      }
    }
  }

  const protocol = read(repositoryRoot, SDK_PROTOCOL);
  if (protocol !== null) {
    const params = between(
      protocol,
      "export interface ExecuteToolParams",
      "\n}\n",
    );
    if (params === null) {
      violations.push(`${SDK_PROTOCOL}: ExecuteToolParams is missing`);
    } else {
      const exact = exactSetViolation(
        SDK_PROTOCOL,
        "ExecuteToolParams fields",
        interfaceFields(params),
        EXECUTE_TOOL_FIELDS,
      );
      if (exact) violations.push(exact);
    }
  }

  const types = read(repositoryRoot, SDK_TYPES);
  if (types !== null) {
    const facade = between(
      types,
      "export interface PluginToolRunContext",
      "/**\n * Result returned from a plugin tool handler.",
    );
    if (facade === null) {
      violations.push(`${SDK_TYPES}: PluginToolRunContext is missing`);
    } else {
      const exact = exactSetViolation(
        SDK_TYPES,
        "PluginToolRunContext fields",
        interfaceFields(facade),
        FACADE_FIELDS,
      );
      if (exact) violations.push(exact);
    }
  }

  for (const absolute of listRepositoryTextFiles(repositoryRoot, [
    "packages/db/schema",
  ])) {
    const source = readFileSync(absolute, "utf8");
    if (/\b(?:pluginRunContextHandle|run_context_handle)\b/.test(source)) {
      violations.push(
        `${absolute.slice(resolve(repositoryRoot).length + 1)}: database schema persists a plaintext plugin run-context handle`,
      );
    }
  }

  const worker = read(repositoryRoot, SDK_WORKER);
  if (worker !== null) {
    const handler = between(
      worker,
      "async function handleExecuteTool",
      "\n  function methodNotImplemented",
    );
    if (handler === null) {
      violations.push(`${SDK_WORKER}: execute-tool handler is missing`);
    } else if (/callHost\(["']tasks\./.test(handler)) {
      violations.push(
        `${SDK_WORKER}: plugin run context can call ordinary tasks.* services`,
      );
    }
  }

  const hostClient = read(repositoryRoot, SDK_HOST_CLIENT);
  if (hostClient !== null) {
    const exactValidator = between(
      hostClient,
      "function requireExactRunContextHandle",
      "function requireRunTaskContextBoundary",
    );
    if (
      exactValidator === null ||
      !exactValidator.includes("supplied !== active") ||
      !exactValidator.includes("invalidInvocationScope")
    ) {
      violations.push(
        `${SDK_HOST_CLIENT}: run.tasks.* does not validate the exact active opaque handle`,
      );
    }
  }

  const runtimeToolGateway = read(repositoryRoot, RUNTIME_TOOL_GATEWAY);
  if (runtimeToolGateway !== null && /\bworkerManager\.call\s*\(/.test(runtimeToolGateway)) {
    violations.push(
      `${RUNTIME_TOOL_GATEWAY}: plugin execution must bind the exact resolved worker instead of generic manager dispatch`,
    );
  }

  const gatewaySources = [GATEWAY, GATEWAY_REPOSITORY, RUN_RUNTIME]
    .map((path) => [path, read(repositoryRoot, path)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  for (const [path, source] of gatewaySources) {
    if (
      /pluginKey\s*[:=].*pluginInstallationId|pluginInstallationId\s*[:=].*pluginKey|pluginInstallationId\s*\?\?/.test(
        source,
      )
    ) {
      violations.push(
        `${path}: plugin key can substitute for immutable installation identity`,
      );
    }
  }

  return [...new Set(violations)].sort();
}

export function assertPluginRunContextBoundary(repositoryRoot: string): void {
  assertNoGateViolations(
    "Plugin run-context boundary check",
    pluginRunContextBoundaryViolations(repositoryRoot),
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    assertPluginRunContextBoundary(resolve(import.meta.dirname, ".."));
    console.log("Plugin run-context boundary check passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
