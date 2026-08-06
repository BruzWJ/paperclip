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
  write(root, EXECUTOR_PATH, "createRuntimePluginToolPort; options.pluginTools.execute({ runInterfaceToolCallId: claim.id, mintPluginRunContext, pluginInstallationId }); workerManager.call(installation, \"executeTool\", { toolName: input.toolName, pluginRunContextHandle: runContextHandle });\n");
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
      "export interface PluginExternalObjectUrlCandidate {}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/types.ts",
    [
      "export interface PluginToolRunContext {",
      "  readonly handle: string;",
      "  readonly issues: unknown;",
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
      "    issues: {",
      '      a: () => callHost("run.issues.listCompanyIssues", {}),',
      '      b: () => callHost("run.issues.listSubIssues", {}),',
      '      c: () => callHost("run.issues.readIssueComments", {}),',
      '      d: () => callHost("run.issues.readIssueAgentRun", {}),',
      "    },",
      "  });",
      "  return runContext;",
      "}",
      "async function handleDetectExternalObjects() {}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/plugins/sdk/src/host-client-factory.ts",
    [
      "const INSTALLATION_ISSUE_CONTROL_PLANE_METHODS = new Set();",
      "function requireExactRunContextHandle(params: any, context: any) {",
      "  if (context?.invalidInvocationScope) throw new Error();",
      "  const supplied = params.runContextHandle;",
      "  const active = context.invocationScope.pluginRunContextHandle;",
      "  if (supplied !== active) throw new Error();",
      "}",
      "function requireRunIssueContextBoundary() {}",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/plugin-host-services.ts",
    [
      "export interface PluginRunIssueContextReader {}",
      "const pluginRunIssueContextReader = true;",
      "pluginRunIssueContextReader.listCompanyIssues({});",
      "pluginRunIssueContextReader.listSubIssues({});",
      "pluginRunIssueContextReader.readIssueComments({});",
      "pluginRunIssueContextReader.readIssueAgentRun({});",
      "",
    ].join("\n"),
  );
  write(
    root,
    "apps/server/src/services/run-interface-runtime.ts",
    "gateway.resolvePluginRunContext( ); retrieval.listCompanyIssues; retrieval.listSubIssues; retrieval.readIssueComments; retrieval.readIssueAgentRun;\n",
  );
  return root;
}

const COMPILER_PATH = "apps/server/src/services/runtime-interface-compiler.ts";
const EXECUTOR_PATH = "apps/server/src/services/runtime-tool-executor.ts";
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

for (const field of [
  "companyId",
  "issueId",
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

for (const field of ["companyId", "issueId", "runId", "sessionId"] as const) {
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

test("rejects ordinary issues.* access from a run facade", () => {
  const root = fixtureRoot();
  const path = "packages/plugins/sdk/src/worker-rpc-host.ts";
  const source = readFileSync(join(root, path), "utf8");
  write(root, path, source.replace('callHost("run.issues.listCompanyIssues"', 'callHost("issues.list"'));
  assert.ok(
    pluginRunContextBoundaryViolations(root).some((entry) =>
      entry.includes("ordinary issues.*"),
    ),
  );
});

test("rejects run issue reads without exact handle validation", () => {
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
