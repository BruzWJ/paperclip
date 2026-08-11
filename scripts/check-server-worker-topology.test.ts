import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scanServerWorkerTopology,
  type ServerWorkerTopologyFile,
} from "./check-server-worker-topology.ts";

function canonicalFiles(): ServerWorkerTopologyFile[] {
  const sources: Record<string, string> = {
    "apps/server/src/services/local-execution-orchestrator.ts": `
      export function localExecutionOrchestrator() {
        localRunLeaseService();
        return { acquireExecutionTargetForRun() {} };
      }
    `,
    "apps/server/src/services/issue-execution-attempt-executor.ts": `
      import { executeAcpxOneShotPrompt } from "acpx";
      import { prepareAcpxRuntimeInvocation } from "acpx-invocation";
      const execute = executeAcpxOneShotPrompt;
      prepareAcpxRuntimeInvocation();
      createPaperclipRunToolsMcpServer();
      sessionCorrelations.resolveResume();
      type Prompt = { promptKind: "base" | "steering" };
    `,
    "apps/server/src/services/issue-execution-provider-configuration.ts": `
      interface IssueExecutionTargetAcquirer {}
      const target = localExecutionOrchestrator;
      acquireExecutionTargetForRun();
      releaseExecutionTarget();
    `,
    "apps/server/src/services/issue-execution-postgres.ts": `
      export function createPostgresIssueExecutionProductionRuntime(options) {
        const target = { localExecutionOrchestrator: options.localExecutionOrchestrator };
        let cancellation = createIssueExecutionCancellationService({});
        cancellation = createIssueExecutionCancellationService({});
        return { target, cancellation };
      }
    `,
    "apps/server/src/index.ts": `
      localExecutionOrchestrator();
      createPostgresIssueExecutionProductionRuntime();
    `,
    "packages/adapter-utils/src/types.ts": `
      export interface ServerAdapterModule {
        readonly type: string;
        readonly definition: AcpxAdapterDefinition;
      }
    `,
    "packages/adapter-utils/src/server-adapter-contract.ts": "export const validate = true;",
  };
  return Object.entries(sources).map(([path, source]) => ({ path, source }));
}

describe("server/worker topology gate", () => {
  it("accepts the canonical server/worker graph", () => {
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
    files.push({
      path: "apps/server/src/adapters/registry-compat.ts",
      source: "export function registerServerAdapter() {}",
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
    assert.ok(
      violations.some((entry) => entry.message.includes("registerServerAdapter")),
    );
  });

  it("rejects recreating raw provider-process utility owners or helpers", () => {
    const files = canonicalFiles();
    files.push({
      path: "packages/adapter-utils/src/server-utils.ts",
      source: "export async function runChildProcess() {}",
    });
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("raw provider-process utility owner")),
    );
    assert.ok(
      violations.some((entry) => entry.message.includes("runChildProcess")),
    );
  });

  it("rejects bypassing the common ACPX lifecycle or request-scoped tools", () => {
    const files = canonicalFiles().map((file) =>
      file.path === "apps/server/src/services/issue-execution-attempt-executor.ts"
        ? {
            ...file,
            source: file.source
              .replaceAll("executeAcpxOneShotPrompt", "runCli")
              .replace("createPaperclipRunToolsMcpServer();", ""),
          }
        : file,
    );
    const violations = scanServerWorkerTopology(files);
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("executeAcpxOneShotPrompt")),
    );
    assert.ok(
      violations.some((entry) =>
        entry.message.includes("createPaperclipRunToolsMcpServer")),
    );
  });

  it("rejects a deferred connected-machine runtime seam", () => {
    const files = canonicalFiles().map((file) => {
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
