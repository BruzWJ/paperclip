import { describe, expect, it, vi } from "vitest";
import type { AgentAdapterAcpConfiguration } from "@paperclipai/shared";
import {
  TaskExecutionTargetAcquisitionRejected,
  createTaskExecutionTargetAcquirer,
} from "../services/task-execution-provider-configuration.js";

const fixtureAgent = "fixture-agent";
const configuration: AgentAdapterAcpConfiguration = {
  contractVersion: "acpx-runtime/v1",
  launchProfile: { registryName: fixtureAgent },
  sessionConfigSelections: [{ configId: "model", value: "model-1" }],
  model: {
    value: "model-1",
    label: "Model",
  },
};

function acquisitionInput(
  acpConfiguration: AgentAdapterAcpConfiguration = configuration,
) {
  return {
    companyId: "company-1",
    taskId: "task-1",
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

describe("canonical task-execution target acquisition", () => {
  it("passes only the exact local workspace and run facts", async () => {
    const releaseExecutionTarget = vi.fn(async () => {});
    const acquireExecutionTargetForRun = vi.fn(async () => ({
      lease: { id: "local-lease-1" },
      executionTarget: {
        kind: "local" as const,
        leaseId: "local-lease-1",
      },
      releaseExecutionTarget,
    }));
    const acquirer = createTaskExecutionTargetAcquirer({
      localExecutionOrchestrator: { acquireExecutionTargetForRun },
    });

    const acquired = await acquirer.acquire(acquisitionInput());

    expect(acquireExecutionTargetForRun).toHaveBeenCalledWith({
      companyId: "company-1",
      taskId: "task-1",
      agentId: "agent-1",
      runId: "run-1",
      executionWorkspaceBindingId: "workspace-1",
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
  it("fails and releases a target whose returned lease is inconsistent", async () => {
    const releaseExecutionTarget = vi.fn(async () => {});
    const acquirer = createTaskExecutionTargetAcquirer({
      localExecutionOrchestrator: {
        async acquireExecutionTargetForRun() {
          return {
            lease: { id: "local-lease-1" },
            executionTarget: {
              kind: "local",
              leaseId: "different-local-lease",
            },
            releaseExecutionTarget,
          };
        },
      },
    });

    await expect(acquirer.acquire(acquisitionInput())).rejects.toBeInstanceOf(
      TaskExecutionTargetAcquisitionRejected,
    );
    expect(releaseExecutionTarget).toHaveBeenCalledWith(true);
  });
});
