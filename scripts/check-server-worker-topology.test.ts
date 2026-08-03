import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scanServerWorkerTopology,
  type ServerWorkerTopologyFile,
} from "./check-server-worker-topology.ts";

function canonicalFiles(): ServerWorkerTopologyFile[] {
  const sources: Record<string, string> = {
    "server/src/adapters/builtin-adapter-catalog.ts": `
      import { codexAdapter } from "./codex.js";
      validateServerAdapterModule(codexAdapter);
      const entry = { adapterType: "codex", adapter: codexAdapter };
      if (entry.adapterType !== entry.adapter.type) throw new Error();
    `,
    "server/src/adapters/builtin-adapter-types.ts": `
      const values = BUILTIN_ADAPTER_CATALOG.map((entry) => entry.adapterType);
    `,
    "server/src/adapters/codex.ts": `
      const launch = resolveApprovedAcpLaunch("codex");
      export const adapter = {
        type: "codex",
        definition: {
          version: "acp-subprocess/v1",
          readiness: {
            sessionScopedMcpReplacement: true,
            cliNativeAuthentication: true,
          },
        },
      };
    `,
    "server/src/adapters/registry.ts": `
      import { BUILTIN_ADAPTER_CATALOG } from "./builtin-adapter-catalog.js";
      interface RegisteredServerAdapterImplementation {}
      validateServerAdapterModule(adapter);
      resolveApprovedAcpLaunch(name);
      adapterImplementationIdentityKey(identity);
      registerImplementation(adapter, identity);
    `,
    "server/src/services/environment-run-orchestrator.ts": `
      export function acquireExecutionTargetForRun(environmentRuntime) {}
    `,
    "server/src/services/environment-execution-target.ts": `
      type Target = AdapterExecutionTarget;
      type Driver = EnvironmentDriver;
    `,
    "server/src/services/issue-execution-attempt-executor.ts": `
      import { executeAcpSubprocessPrompt } from "acp";
      prepareAcpExecutionTargetSubprocess();
      createPaperclipRunToolsMcpServer();
      resolveApprovedAcpLaunch();
      sessionCorrelations.resolveStart();
      type Prompt = { promptKind: "base" | "steering" };
      repository.recordSubprocessTeardown();
      executeAcpSubprocessPrompt();
    `,
    "server/src/services/issue-execution-provider-configuration.ts": `
      interface IssueExecutionTargetAcquirer {}
      const selector = executionTargetSelector;
      acquireExecutionTargetForRun();
      releaseExecutionTarget();
    `,
    "server/src/services/issue-execution-postgres.ts": `
      export function createPostgresIssueExecutionProductionRuntime(options) {
        const target = { environmentOrchestrator: options.environmentOrchestrator };
        let cancellation = createIssueExecutionCancellationService({});
        cancellation = createIssueExecutionCancellationService({});
        return { target, cancellation };
      }
    `,
    "server/src/index.ts": `
      environmentRuntimeService();
      environmentRunOrchestrator();
      createPostgresIssueExecutionProductionRuntime();
    `,
    "packages/adapter-utils/package.json": JSON.stringify({
      dependencies: {
        "@agentclientprotocol/codex-acp": "1.1.7",
        "@agentclientprotocol/sdk": "1.3.0",
        acpx: "0.13.0",
      },
      bundleDependencies: [
        "@agentclientprotocol/codex-acp",
        "@agentclientprotocol/sdk",
        "acpx",
      ],
    }),
    "packages/adapter-utils/src/types.ts": `
      export interface ServerAdapterModule {
        readonly type: string;
        readonly definition: AcpSubprocessAdapterDefinition;
      }
    `,
    "packages/adapter-utils/src/server-adapter-contract.ts": "export const validate = true;",
    "packages/adapter-utils/src/acp-subprocess/agent-registry.ts": "export const registry = true;",
    "packages/adapter-utils/src/acp-subprocess/client.ts": "export const client = true;",
    "packages/adapter-utils/src/acp-subprocess/contract.ts": "export const contract = true;",
    "packages/adapter-utils/src/acp-subprocess/events.ts": "export const events = true;",
    "packages/adapter-utils/src/acp-subprocess/execution-target.ts": "export const target = true;",
    "packages/adapter-utils/src/acp-subprocess/process.ts": "export const process = true;",
    "packages/adapter-utils/src/acp-subprocess/run-tools.ts": "export const tools = true;",
  };
  return Object.entries(sources).map(([path, source]) => ({ path, source }));
}

describe("canonical server/worker ACP topology gate", () => {
  it("accepts the one declarative adapter and common ACP worker graph", () => {
    assert.deepEqual(scanServerWorkerTopology(canonicalFiles()), []);
  });

  it("rejects a second built-in AI backend and every retired invocation ABI", () => {
    const files = canonicalFiles().map((file) =>
      file.path === "server/src/adapters/builtin-adapter-catalog.ts"
        ? {
            ...file,
            source: `${file.source}\nconst legacy = { adapterType: "http" };`,
          }
        : file,
    );
    files.push({
      path: "packages/adapter-utils/src/issue-execution.ts",
      source: "export interface ProviderInvocation {}",
    });
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("exactly the canonical codex")),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("retired alternate AI execution owner")),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("ProviderInvocation")),
    );
  });

  it("rejects bypassing the common ACP lifecycle or request-scoped tools", () => {
    const files = canonicalFiles().map((file) =>
      file.path ===
          "server/src/services/issue-execution-attempt-executor.ts"
        ? {
            ...file,
            source: file.source
              .replaceAll("executeAcpSubprocessPrompt", "runCli")
              .replace("createPaperclipRunToolsMcpServer();", ""),
          }
        : file,
    );
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("executeAcpSubprocessPrompt")),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("createPaperclipRunToolsMcpServer")),
    );
  });

  it("rejects dependency drift and a deferred connected-machine runtime seam", () => {
    const files = canonicalFiles().map((file) => {
      if (file.path === "packages/adapter-utils/package.json") {
        const manifest = JSON.parse(file.source);
        manifest.dependencies.acpx = "^0.13.0";
        return { ...file, source: JSON.stringify(manifest) };
      }
      if (file.path === "server/src/index.ts") {
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
      file.path === "server/src/services/issue-execution-postgres.ts"
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
