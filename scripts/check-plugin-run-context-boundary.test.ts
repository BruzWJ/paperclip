import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { pluginRunContextBoundaryViolations } from "./check-plugin-run-context-boundary.ts";

const roots = new Set<string>();

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paperclip-plugin-context-gate-"));
  roots.add(root);
  write(
    root,
    "packages/db/schema/run_interface_foundation.ts",
    [
      "export const pluginRunContexts = pgTable(",
      '  "plugin_run_contexts",',
      "  {",
      "    capabilityConnectionId: uuid(),",
      "    capabilityGeneration: integer(),",
      "    runInterfaceToolCallId: uuid(),",
      "    pluginInstallationId: uuid(),",
      '    handleHash: text("handle_hash").primaryKey(),',
      "    firstUsedAt: timestamp(),",
      "    createdAt: timestamp(),",
      "  },",
      "  (table) => [",
      "    plugin_run_contexts_capability_generation_fk,",
      "    plugin_run_contexts_exact_tool_call_fk,",
      "  ],",
      ");",
      "/**",
      " * Durable provider-call identity ledger",
      " */",
      "const runInterfaceToolCalls = {};",
      "",
    ].join("\n"),
  );
  write(root, COMPILER_PATH, 'pluginDescriptors; source: "plugin"; pluginInstallationId; pluginToolName\n');
  write(
    root,
    RUNTIME_TOOL_GATEWAY_PATH,
    "createRuntimePluginToolPort; options.pluginTools.execute({ runInterfaceToolCallId: claim.id, mintPluginRunContext, pluginInstallationId }); const worker = workerManager.getWorker(input.pluginInstallationId); if (worker?.status !== \"running\" || worker.manifestIdentity !== input.pluginManifestIdentity) throw new Error(); const runContextHandle = await input.mintPluginRunContext(); await worker.call(\"executeTool\", { toolName: input.toolName, parameters: input.arguments, pluginRunContextHandle: runContextHandle });\n",
  );
  write(root, GATEWAY_PATH, "randomPluginRunContextHandle(); createPluginRunContext({ handleHash: sha256(handle) }); resolvePluginRunContext();\n");
  write(root, GATEWAY_REPOSITORY_PATH, ".insert(pluginRunContexts); resolvePluginRunContextHash; pluginInstallationId; runInterfaceToolCallId;\n");
  write(root, INDEX_PATH, "createRuntimePluginToolPort( pluginWorkerManager ); pluginTools: promptCapabilityPluginTools;\n");
  write(
    root,
    "packages/plugins/sdk/src/protocol.ts",
    [
      "export interface ExecuteToolParams {",
      "  toolName: string;",
      "  parameters: unknown;",
      "  runContextHandle: string;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/types.ts",
    [
      "export interface PluginToolRunContext {",
      "  readonly handle: string;",
      "  readonly tasks: unknown;",
      "}",
      "/**",
      " * Result returned from a plugin tool handler.",
      " */",
      "export interface ToolResult {}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/worker-rpc-host.ts",
    [
      "async function handleExecuteTool(params: any) {",
      "  const runContext: PluginToolRunContext = Object.freeze({",
      "    handle: params.runContextHandle,",
      "    tasks: {",
      '      a: () => callHost("run.tasks.listCompanyTasks", {}),',
      '      b: () => callHost("run.tasks.listSubTasks", {}),',
      '      c: () => callHost("run.tasks.readTaskComments", {}),',
      '      d: () => callHost("run.tasks.readTaskAgentRun", {}),',
      "    },",
      "  });",
      "  return runContext;",
      "}",
      "  function methodNotImplemented() {}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/host-client-factory.ts",
    [
      "const INSTALLATION_TASK_CONTROL_PLANE_METHODS = new Set();",
      "function requireExactRunContextHandle(params: any, context: any) {",
      "  if (context?.invalidInvocationScope) throw new Error();",
      "  const supplied = params.runContextHandle;",
      "  const active = context.invocationScope.pluginRunContextHandle;",
      "  if (supplied !== active) throw new Error();",
      "}",
      "function requireRunTaskContextBoundary() {}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/plugin-host-services.ts",
    [
      "export interface PluginRunTaskContextReader {}",
      "const pluginRunTaskContextReader = true;",
      "pluginRunTaskContextReader.listCompanyTasks({});",
      "pluginRunTaskContextReader.listSubTasks({});",
      "pluginRunTaskContextReader.readTaskComments({});",
      "pluginRunTaskContextReader.readTaskAgentRun({});",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/run-interface-runtime.ts",
    "gateway.resolvePluginRunContext( ); retrieval.listCompanyTasks; retrieval.listSubTasks; retrieval.readTaskComments; retrieval.readTaskAgentRun;\n",
  );
  return root;
}

const COMPILER_PATH = "apps/server/src/services/runtime-interface-compiler.ts";
const RUNTIME_TOOL_GATEWAY_PATH = "apps/server/src/services/runtime-tool-gateway.ts";
const GATEWAY_PATH = "apps/server/src/services/prompt-capability-gateway.ts";
const GATEWAY_REPOSITORY_PATH = "apps/server/src/services/prompt-capability-gateway-postgres.ts";
const INDEX_PATH = "apps/server/src/index.ts";

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

test("accepts the hash-only exact plugin run-context graph", () => {
  assert.deepEqual(pluginRunContextBoundaryViolations(fixtureRoot()), []);
});

test("requires execution through the exact compiled worker handle", () => {
  const root = fixtureRoot();
  const path = RUNTIME_TOOL_GATEWAY_PATH;
  const source = readFileSync(join(root, path), "utf8");
  write(root, path, source.replace("await worker.call(", "await workerManager.call("));
  assert.ok(
    pluginRunContextBoundaryViolations(root).some((entry) =>
      entry.includes("exact resolved worker instead of generic manager dispatch"),
    ),
  );
});

test("requires the compiled worker manifest identity check", () => {
  const root = fixtureRoot();
  const path = RUNTIME_TOOL_GATEWAY_PATH;
  const source = readFileSync(join(root, path), "utf8");
  write(
    root,
    path,
    source.replace("worker.manifestIdentity !== input.pluginManifestIdentity", "false"),
  );
  assert.ok(
    pluginRunContextBoundaryViolations(root).some((entry) =>
      entry.includes("worker.manifestIdentity !== input.pluginManifestIdentity"),
    ),
  );
});

for (const field of [
  "companyId",
  "taskId",
  "sessionId",
  "runId",
  "agentId",
] as const) {
  test(`rejects duplicated schema coordinate ${field}`, () => {
    const root = fixtureRoot();
    const path = "packages/db/schema/run_interface_foundation.ts";
    const source = readFileSync(join(root, path), "utf8");
    write(root, path, source.replace("    handleHash:", `    ${field}: uuid(),\n    handleHash:`));
    const violations = pluginRunContextBoundaryViolations(root);
    assert.ok(violations.some((entry) => entry.includes(field)));
  });
}

test("rejects a plaintext persisted handle", () => {
  const root = fixtureRoot();
  const path = "packages/db/schema/run_interface_foundation.ts";
  const source = readFileSync(join(root, path), "utf8");
  write(root, path, source.replace("    handleHash:", "    handle: text(),\n    handleHash:"));
  assert.ok(
    pluginRunContextBoundaryViolations(root).some((entry) =>
      entry.includes("plaintext credential"),
    ),
  );
});

for (const field of ["companyId", "runId", "executionContext"] as const) {
  test(`rejects raw ExecuteToolParams field ${field}`, () => {
    const root = fixtureRoot();
    const path = "packages/plugins/sdk/src/protocol.ts";
    const source = readFileSync(join(root, path), "utf8");
    write(root, path, source.replace("  toolName:", `  ${field}: string;\n  toolName:`));
    assert.ok(
      pluginRunContextBoundaryViolations(root).some((entry) =>
        entry.includes("ExecuteToolParams fields is not exact"),
      ),
    );
  });
}

for (const field of ["companyId", "taskId", "runId", "sessionId"] as const) {
  test(`rejects raw frozen-facade field ${field}`, () => {
    const root = fixtureRoot();
    const path = "packages/plugins/sdk/src/types.ts";
    const source = readFileSync(join(root, path), "utf8");
    write(root, path, source.replace("  readonly handle:", `  readonly ${field}: string;\n  readonly handle:`));
    assert.ok(
      pluginRunContextBoundaryViolations(root).some((entry) =>
        entry.includes("PluginToolRunContext fields is not exact"),
      ),
    );
  });
}

test("rejects ordinary tasks.* access from a run facade", () => {
  const root = fixtureRoot();
  const path = "packages/plugins/sdk/src/worker-rpc-host.ts";
  const source = readFileSync(join(root, path), "utf8");
  write(root, path, source.replace('callHost("run.tasks.listCompanyTasks"', 'callHost("tasks.list"'));
  assert.ok(
    pluginRunContextBoundaryViolations(root).some((entry) =>
      entry.includes("ordinary tasks.*"),
    ),
  );
});

test("rejects run task reads without exact handle validation", () => {
  const root = fixtureRoot();
  const path = "packages/plugins/sdk/src/host-client-factory.ts";
  const source = readFileSync(join(root, path), "utf8");
  write(root, path, source.replace("  if (supplied !== active) throw new Error();", "  return;"));
  assert.ok(
    pluginRunContextBoundaryViolations(root).some((entry) =>
      entry.includes("does not validate the exact active opaque handle"),
    ),
  );
});

test("rejects plugin-key substitution for installation identity", () => {
  const root = fixtureRoot();
  write(
    root,
    GATEWAY_PATH,
    `${readFileSync(join(root, GATEWAY_PATH), "utf8")}\nconst pluginInstallationId = pluginKey;\n`,
  );
  assert.ok(
    pluginRunContextBoundaryViolations(root).some((entry) =>
      entry.includes("plugin key can substitute"),
    ),
  );
});
