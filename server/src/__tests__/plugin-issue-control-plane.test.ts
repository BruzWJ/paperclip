import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Issue } from "@paperclipai/shared";
import type { OrdinaryIssueRuntime } from "../services/ordinary-issue-runtime.js";
import { createPluginIssueControlPlane } from "../services/plugin-issue-control-plane.js";

describe("plugin issue control plane", () => {
  it("derives create and update idempotency from installation, method, and host RPC identity", async () => {
    const stop = new Error("stop after ordinary-runtime input");
    const create = vi.fn().mockRejectedValue(stop);
    const commitCreatorFormUpdate = vi.fn().mockRejectedValue(stop);
    const reassign = vi.fn().mockRejectedValue(stop);
    const ordinaryIssues = {
      create,
      commitCreatorFormUpdate,
      reassign,
    } as unknown as OrdinaryIssueRuntime;
    const controlPlane = createPluginIssueControlPlane({} as Db, ordinaryIssues);
    const operationContext = {
      companyId: "00000000-0000-4000-8000-000000000001",
      pluginInstallationId: "00000000-0000-4000-8000-000000000002",
      pluginKey: "example.plugin",
    };

    const createInput = {
      ...operationContext,
      request: "Create exact work",
      ownerAgentId: "00000000-0000-4000-8000-000000000003",
      callbackKey: "creator",
      callbackVersion: "1",
      callbackRegistrationActive: true as const,
    };
    for (const hostRpcOperationId of ["create-op-1", "create-op-1", "create-op-2"]) {
      await expect(
        controlPlane.create({ ...createInput, hostRpcOperationId }),
      ).rejects.toBe(stop);
    }
    const createKeys = create.mock.calls.map(
      ([input]) => input.idempotencyKey,
    );
    expect(createKeys[0]).toBe(createKeys[1]);
    expect(createKeys[2]).not.toBe(createKeys[0]);
    expect(createKeys[0]).toBe(
      "plugin-issue-rpc:00000000-0000-4000-8000-000000000002:issues.create:create-op-1",
    );

    const messageInput = {
      ...operationContext,
      issueId: "00000000-0000-4000-8000-000000000004",
      hostRpcOperationId: "message-op-1",
      input: { kind: "message" as const, message: "One message" },
    };
    await expect(controlPlane.update(messageInput)).rejects.toBe(stop);
    await expect(controlPlane.update(messageInput)).rejects.toBe(stop);
    expect(
      commitCreatorFormUpdate.mock.calls[0]?.[2].gatewayInvocationId,
    ).toBe(
      commitCreatorFormUpdate.mock.calls[1]?.[2].gatewayInvocationId,
    );
    expect(
      commitCreatorFormUpdate.mock.calls[0]?.[2].gatewayInvocationId,
    ).toBe(
      "plugin-issue-rpc:00000000-0000-4000-8000-000000000002:issues.update:message-op-1",
    );

    await expect(controlPlane.update({
      ...operationContext,
      issueId: "00000000-0000-4000-8000-000000000004",
      hostRpcOperationId: "reassign-op-1",
      input: {
        kind: "reassign",
        ownerAgentId: "00000000-0000-4000-8000-000000000005",
      },
    })).rejects.toBe(stop);
    expect(reassign.mock.calls[0]?.[0].idempotencyKey).toBe(
      "plugin-issue-rpc:00000000-0000-4000-8000-000000000002:issues.update:reassign-op-1",
    );
  });

  it("returns the withdrawal result recorded for the host RPC operation", async () => {
    const recordedIssue = {
      id: "00000000-0000-4000-8000-000000000001",
      companyId: "00000000-0000-4000-8000-000000000002",
      lifecycleStatus: "cancelled",
      boardPresentationStatus: "cancelled",
      ownershipEpoch: 2,
      disposition: { message: "Withdraw this issue." },
      updatedAt: new Date("2026-07-25T12:00:00.000Z"),
    } as Issue;
    const preparePluginWithdrawal = vi.fn().mockResolvedValue({
      operationId: "rpc-operation-1",
    });
    const withdrawPluginIssue = vi.fn().mockResolvedValue({
      operationId: "rpc-operation-1",
      issue: recordedIssue,
      retried: true,
    });
    const ordinaryIssues = {
      preparePluginWithdrawal,
      withdrawPluginIssue,
    } as unknown as OrdinaryIssueRuntime;
    const controlPlane = createPluginIssueControlPlane({} as Db, ordinaryIssues);

    const result = await controlPlane.withdraw({
      companyId: recordedIssue.companyId,
      issueId: recordedIssue.id,
      message: "Withdraw this issue.",
      hostRpcOperationId: "rpc-operation-1",
      pluginInstallationId: "00000000-0000-4000-8000-000000000003",
      pluginKey: "example.plugin",
    });

    expect(result).toEqual({
      operationId: "rpc-operation-1",
      issue: recordedIssue,
      retried: true,
    });
    expect(result.issue).toBe(recordedIssue);
    expect(preparePluginWithdrawal).toHaveBeenCalledWith({
      companyId: recordedIssue.companyId,
      issueId: recordedIssue.id,
      message: "Withdraw this issue.",
      operationId: "rpc-operation-1",
      pluginInstallationId: "00000000-0000-4000-8000-000000000003",
      pluginKey: "example.plugin",
    });
    expect(withdrawPluginIssue).toHaveBeenCalledWith({
      companyId: recordedIssue.companyId,
      operationId: "rpc-operation-1",
      pluginInstallationId: "00000000-0000-4000-8000-000000000003",
      pluginKey: "example.plugin",
    });
  });
});
