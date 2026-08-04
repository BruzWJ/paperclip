import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scanServerWorkerTopology,
  type ServerWorkerTopologyFile,
} from "./check-server-worker-topology.ts";

function canonicalFiles(): ServerWorkerTopologyFile[] {
  const sources: Record<string, string> = {
    "apps/server/src/adapters/acpx-catalog.ts": `
      import { listAcpRegistryAgentNames, probeAcpxAgent } from "acpx";
      export function acpxDiscoveryToServerAdapter(value) {
        return { definition: { configOptions: [], limits: null } };
      }
      export async function discoverLocalAcpxAdapterCatalog() {
        return [listAcpRegistryAgentNames, probeAcpxAgent, acpxDiscoveryToServerAdapter];
      }
    `,
    "apps/server/src/adapters/registry.ts": `
      import { assertAcpRegistryAgentName } from "acp";
      import { discoverLocalAcpxAdapterCatalog } from "./acpx-catalog.js";
      export async function refreshAcpxAdapters() { return discoverLocalAcpxAdapterCatalog(); }
      export function registerServerAdapter() { throw new Error("supplied exclusively by ACPX"); }
      assertAcpRegistryAgentName("from-acpx");
    `,
    "apps/server/src/services/environment-run-orchestrator.ts": `
      export function acquireExecutionTargetForRun(environmentRuntime) {}
    `,
    "apps/server/src/services/environment-execution-target.ts": `
      type Target = AdapterExecutionTarget;
      type Driver = EnvironmentDriver;
    `,
    "apps/server/src/services/issue-execution-attempt-executor.ts": `
      import { executeAcpxOneShotPrompt } from "acpx";
      import { prepareAcpxRuntimeInvocation } from "acpx-invocation";
      export async function executeAcpxRuntimePrompt() {
        return executeAcpxOneShotPrompt();
      }
      const execute = executeAcpxRuntimePrompt;
      prepareAcpxRuntimeInvocation();
      createPaperclipRunToolsMcpServer();
      sessionCorrelations.resolveStart();
      type Prompt = { promptKind: "base" | "steering" };
      repository.recordSubprocessTeardown();
    `,
    "apps/server/src/services/issue-execution-provider-configuration.ts": `
      interface IssueExecutionTargetAcquirer {}
      const selector = executionTargetSelector;
      acquireExecutionTargetForRun();
      releaseExecutionTarget();
    `,
    "apps/server/src/services/issue-execution-postgres.ts": `
      export function createPostgresIssueExecutionProductionRuntime(options) {
        const target = { environmentOrchestrator: options.environmentOrchestrator };
        let cancellation = createIssueExecutionCancellationService({});
        cancellation = createIssueExecutionCancellationService({});
        return { target, cancellation };
      }
    `,
    "apps/server/src/index.ts": `
      environmentRuntimeService();
      environmentRunOrchestrator();
      createPostgresIssueExecutionProductionRuntime();
    `,
    "packages/adapter-utils/package.json": JSON.stringify({
      dependencies: {
        "@agentclientprotocol/sdk": "1.3.0",
        acpx: "0.13.0",
      },
      bundleDependencies: ["@agentclientprotocol/sdk", "acpx"],
    }),
    "packages/adapter-utils/src/types.ts": `
      export interface ServerAdapterModule {
        readonly type: string;
        readonly definition: AcpSubprocessAdapterDefinition;
      }
    `,
    "packages/adapter-utils/src/server-adapter-contract.ts": "export const validate = true;",
    "packages/adapter-utils/src/acp-subprocess/agent-registry.ts": `
      import { createAgentRegistry } from "acpx/runtime";
      const candidateRegistry = createAgentRegistry();
      export function listAcpRegistryAgentNames() { return candidateRegistry.list(); }
      export function assertAcpRegistryAgentName(registryName) {
        if (!candidateRegistry.list().includes(registryName)) throw new Error();
        return registryName;
      }
    `,
    "packages/adapter-utils/src/acp-subprocess/acpx-discovery.ts": `
      import { createAcpRuntime } from "acpx/runtime";
      export function listAcpxAgentNames() { return []; }
      export async function probeAcpxAgent() {
        const runtime = createAcpRuntime();
        return runtime.ensureSession({ configOptions: [] });
      }
    `,
    "packages/adapter-utils/src/acp-subprocess/acpx-runtime-execution.ts": `
      import { createAcpRuntime, createRuntimeStore } from "acpx/runtime";
      export async function executeAcpxOneShotPrompt() {
        const runtime = createAcpRuntime(createRuntimeStore());
        await runtime.ensureSession();
        await runtime.setConfigOption?.({
        await runtime.startTurn();
        await runtime.cancel();
        await runtime.close();
        return assertAcpRegistryAgentName();
      }
    `,
    "packages/adapter-utils/src/acp-subprocess/acpx-runtime-invocation.ts": `
      export async function prepareAcpxRuntimeInvocation() {
        requireLocalTarget();
        await materializeAdapterExecutionTargetTextFiles();
        return "operator_native";
      }
    `,
    "packages/adapter-utils/src/acp-subprocess/acpx-runtime-readiness.ts": `
      import { createAcpRuntime, createRuntimeStore } from "acpx/runtime";
      export async function probeAcpxRuntimeReadiness() {
        const runtime = createAcpRuntime(createRuntimeStore());
        await runtime.ensureSession();
        await runtime.getStatus();
        await runtime.setConfigOption!({
        await runtime.close();
      }
    `,
    "packages/adapter-utils/src/acp-subprocess/contract.ts": "export const contract = true;",
    "packages/adapter-utils/src/acp-subprocess/events.ts": "export const events = true;",
    "packages/adapter-utils/src/acp-subprocess/run-tools.ts": "export const tools = true;",
  };
  return Object.entries(sources).map(([path, source]) => ({ path, source }));
}

describe("dynamic ACPX server/worker topology gate", () => {
  it("accepts the ACPX-supplied catalog and common ACPX runtime graph", () => {
    assert.deepEqual(scanServerWorkerTopology(canonicalFiles()), []);
  });

  it("rejects a Paperclip-owned agent catalog and every retired invocation ABI", () => {
    const files = canonicalFiles();
    files.push({
      path: "apps/server/src/adapters/builtin-adapter-catalog.ts",
      source: "export const catalog = [];",
    });
    files.push({
      path: "packages/adapter-utils/src/issue-execution.ts",
      source: "export interface ProviderInvocation {}",
    });
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("retired Paperclip-owned agent catalog")),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("retired alternate AI execution owner")),
    );
    assert.ok(
      violations.some((entry) => entry.message.includes("ProviderInvocation")),
    );
  });

  it("rejects bypassing the common ACPX lifecycle or request-scoped tools", () => {
    const files = canonicalFiles().map((file) =>
      file.path === "apps/server/src/services/issue-execution-attempt-executor.ts"
        ? {
            ...file,
            source: file.source
              .replaceAll("executeAcpxRuntimePrompt", "runCli")
              .replace("createPaperclipRunToolsMcpServer();", ""),
          }
        : file,
    );
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("executeAcpxRuntimePrompt")),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("createPaperclipRunToolsMcpServer")),
    );
  });

  it("rejects importing a legacy raw ACP invocation in production server code", () => {
    const files = canonicalFiles().map((file) =>
      file.path === "apps/server/src/services/issue-execution-attempt-executor.ts"
        ? {
            ...file,
            source: `${file.source}\nimport { executeAcpSubprocessPrompt } from "@paperclipai/adapter-utils/acp-subprocess";`,
          }
        : file,
    );
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("production ACPX runtime boundary forbids")),
    );
  });

  it("rejects dependency drift and a deferred connected-machine runtime seam", () => {
    const files = canonicalFiles().map((file) => {
      if (file.path === "packages/adapter-utils/package.json") {
        const manifest = JSON.parse(file.source);
        manifest.dependencies.acpx = "^0.13.0";
        return { ...file, source: JSON.stringify(manifest) };
      }
      if (file.path === "apps/server/src/index.ts") {
        return {
          ...file,
          source: `${file.source}\ncreateConnectedMachineRuntime();`,
        };
      }
      return file;
    });
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) => entry.message.includes("pinned exactly")),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("deferred connected-machine runtime")),
    );
  });

  it("rejects moving canonical cancellation outside the production runtime factory", () => {
    const files = canonicalFiles().map((file) =>
      file.path === "apps/server/src/services/issue-execution-postgres.ts"
        ? {
            ...file,
            source: file.source.replaceAll(
              "createIssueExecutionCancellationService",
              "createCancellationElsewhere",
            ),
          }
        : file,
    );
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("createIssueExecutionCancellationService")),
    );
  });
});
