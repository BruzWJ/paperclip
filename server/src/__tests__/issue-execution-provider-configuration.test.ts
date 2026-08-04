import { describe, expect, it, vi } from "vitest";
import type { AgentAdapterAcpConfiguration } from "@paperclipai/shared";
import {
  IssueExecutionTargetAcquisitionRejected,
  createIssueExecutionTargetAcquirer,
} from "../services/issue-execution-provider-configuration.js";

const environmentId = "00000000-0000-4000-8000-000000000001";
const targetDigest = "a".repeat(64);
const fixtureAgent = "fixture-agent";
const configuration: AgentAdapterAcpConfiguration = {
  contractVersion: "acpx-runtime/v1",
  launchProfile: { registryName: fixtureAgent },
  sessionConfigSelections: [{ configId: "model", value: "model-1" }],
  model: {
    id: "model",
    label: "Model",
    value: "model-1",
    limits: {
      contextTokenLimit: 200_000,
      outputTokenLimit: 16_000,
    },
  },
  executionTargetSelector: {
    defaultEnvironmentId: environmentId,
    executionTargetDriver: "local",
    executionTargetDigest: targetDigest,
  },
  workspaceSelector: { kind: "issue_execution_workspace" },
  companySkillPins: [],
  skillChannel: "operator_native",
};

function acquisitionInput(
  acpConfiguration: AgentAdapterAcpConfiguration = configuration,
) {
  return {
    companyId: "company-1",
    issueId: "issue-1",
    runId: "run-1",
    targetAgentId: "agent-1",
    adapterConfigRevisionId: "revision-1",
    executionWorkspaceBindingId: "workspace-1",
    acpConfiguration,
    hostCwd: "/host/workspace",
    localWorkspaceCwd: "/host/workspace",
    targetAdditionalDirectories: ["/host/authorized"],
  };
}

describe("canonical issue-execution target acquisition", () => {
  it("passes only immutable selector/workspace/run facts to the existing topology", async () => {
    const releaseExecutionTarget = vi.fn(async () => {});
    const acquireExecutionTargetForRun = vi.fn(async () => ({
      environment: { id: environmentId },
      lease: { id: "environment-lease-1" },
      leaseContext: {},
      executionTarget: {
        kind: "local" as const,
        environmentId,
        leaseId: "environment-lease-1",
      },
      releaseExecutionTarget,
    }));
    const acquirer = createIssueExecutionTargetAcquirer({
      environmentOrchestrator: { acquireExecutionTargetForRun },
    });

    const acquired = await acquirer.acquire(acquisitionInput());

    expect(acquireExecutionTargetForRun).toHaveBeenCalledWith({
      companyId: "company-1",
      environmentId,
      executionTargetDriver: "local",
      executionTargetDigest: targetDigest,
      issueId: "issue-1",
      agentId: "agent-1",
      runId: "run-1",
      executionWorkspaceBindingId: "workspace-1",
      adapterType: fixtureAgent,
      allowedDrivers: ["local"],
    });
    expect(acquired).toMatchObject({
      adapterConfigRevisionId: "revision-1",
      hostCwd: "/host/workspace",
      targetCwd: "/host/workspace",
      targetAdditionalDirectories: ["/host/authorized"],
    });
    await acquired.release();
    expect(releaseExecutionTarget).toHaveBeenCalledWith(false);
  });

  it("preserves the target-provided remote cwd without a local substitution", async () => {
    const remoteConfiguration: AgentAdapterAcpConfiguration = {
      ...configuration,
      executionTargetSelector: {
        ...configuration.executionTargetSelector,
        executionTargetDriver: "ssh",
      },
    };
    const acquirer = createIssueExecutionTargetAcquirer({
      environmentOrchestrator: {
        async acquireExecutionTargetForRun() {
          return {
            environment: { id: environmentId },
            lease: { id: "environment-lease-1" },
            leaseContext: {},
            executionTarget: {
              kind: "remote",
              transport: "ssh",
              environmentId,
              leaseId: "environment-lease-1",
              remoteCwd: "/remote/workspace",
              spec: {
                host: "example.test",
                port: 22,
                username: "operator",
                remoteCwd: "/remote/workspace",
              },
            },
            async releaseExecutionTarget() {},
          };
        },
      },
    });

    const acquired = await acquirer.acquire(
      acquisitionInput(remoteConfiguration),
    );

    expect(acquired.targetCwd).toBe("/remote/workspace");
    expect(acquired.executionTarget).toMatchObject({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/remote/workspace",
    });
  });

  it("fails and releases a target whose returned identity crossed the revision", async () => {
    const releaseExecutionTarget = vi.fn(async () => {});
    const acquirer = createIssueExecutionTargetAcquirer({
      environmentOrchestrator: {
        async acquireExecutionTargetForRun() {
          return {
            environment: { id: environmentId },
            lease: { id: "environment-lease-1" },
            leaseContext: {},
            executionTarget: {
              kind: "local",
              environmentId: "different-environment",
              leaseId: "environment-lease-1",
            },
            releaseExecutionTarget,
          };
        },
      },
    });

    await expect(acquirer.acquire(acquisitionInput())).rejects.toBeInstanceOf(
      IssueExecutionTargetAcquisitionRejected,
    );
    expect(releaseExecutionTarget).toHaveBeenCalledWith(true);
  });
});
