import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Task } from "@paperclipai/shared";
import type { OrdinaryTaskRuntime } from "../services/ordinary-task-runtime.js";
import { createPluginTaskControlPlane } from "../services/plugin-task-control-plane.js";

describe("plugin task control plane", () => {
  it("rejects noninteger or out-of-range task list windows", async () => {
    const controlPlane = createPluginTaskControlPlane(
      {} as Db,
      {} as OrdinaryTaskRuntime,
    );
    const context = {
      companyId: "00000000-0000-4000-8000-000000000001",
      pluginInstallationId: "00000000-0000-4000-8000-000000000002",
      pluginKey: "example.plugin",
    };
    for (const input of [
      { limit: 1.5 },
      { limit: 101 },
      { offset: -1 },
      { offset: 1.5 },
    ]) {
      await expect(controlPlane.list({ ...context, ...input })).rejects.toThrow(
        /must be an exact integer/,
      );
    }
  });

  it("derives create and update idempotency from installation, method, and host RPC identity", async () => {
    const stop = new Error("stop after ordinary-runtime input");
    const create = vi.fn().mockRejectedValue(stop);
    const commitCreatorFormUpdate = vi.fn().mockRejectedValue(stop);
    const reassign = vi.fn().mockRejectedValue(stop);
    const ordinaryTasks = {
      create,
      commitCreatorFormUpdate,
      reassign,
    } as unknown as OrdinaryTaskRuntime;
    const controlPlane = createPluginTaskControlPlane({} as Db, ordinaryTasks);
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
    for (const hostRpcOperationId of [
      "create-op-1",
      "create-op-1",
      "create-op-2",
    ]) {
      await expect(
        controlPlane.create({ ...createInput, hostRpcOperationId }),
      ).rejects.toBe(stop);
    }
    const createKeys = create.mock.calls.map(([input]) => input.idempotencyKey);
    expect(createKeys[0]).toBe(createKeys[1]);
    expect(createKeys[2]).not.toBe(createKeys[0]);
    expect(createKeys[0]).toBe(
      "plugin-task-rpc:00000000-0000-4000-8000-000000000002:tasks.create:create-op-1",
    );

    const messageInput = {
      ...operationContext,
      taskId: "00000000-0000-4000-8000-000000000004",
      hostRpcOperationId: "message-op-1",
      input: { kind: "message" as const, message: "One message" },
    };
    await expect(controlPlane.update(messageInput)).rejects.toBe(stop);
    await expect(controlPlane.update(messageInput)).rejects.toBe(stop);
    expect(commitCreatorFormUpdate.mock.calls[0]?.[2].gatewayInvocationId).toBe(
      commitCreatorFormUpdate.mock.calls[1]?.[2].gatewayInvocationId,
    );
    expect(commitCreatorFormUpdate.mock.calls[0]?.[2].gatewayInvocationId).toBe(
      "plugin-task-rpc:00000000-0000-4000-8000-000000000002:tasks.update:message-op-1",
    );

    await expect(
      controlPlane.update({
        ...operationContext,
        taskId: "00000000-0000-4000-8000-000000000004",
        hostRpcOperationId: "reassign-op-1",
        input: {
          kind: "reassign",
          ownerAgentId: "00000000-0000-4000-8000-000000000005",
        },
      }),
    ).rejects.toBe(stop);
    expect(reassign.mock.calls[0]?.[0].idempotencyKey).toBe(
      "plugin-task-rpc:00000000-0000-4000-8000-000000000002:tasks.update:reassign-op-1",
    );

    await expect(
      controlPlane.create({
        ...createInput,
        hostRpcOperationId: " create-op-1 ",
      }),
    ).rejects.toThrow(
      "Host RPC operation identity must be exact and non-empty",
    );
  });

  it("returns the withdrawal result recorded for the host RPC operation", async () => {
    const recordedTask = {
      id: "00000000-0000-4000-8000-000000000001",
      companyId: "00000000-0000-4000-8000-000000000002",
      lifecycleStatus: "cancelled",
      boardPresentationStatus: "cancelled",
      ownershipEpoch: 2,
      disposition: { message: "Withdraw this task." },
      updatedAt: new Date("2026-07-25T12:00:00.000Z"),
    } as Task;
    const preparePluginWithdrawal = vi.fn().mockResolvedValue({
      operationId: "rpc-operation-1",
    });
    const withdrawPluginTask = vi.fn().mockResolvedValue({
      operationId: "rpc-operation-1",
      task: recordedTask,
      retried: true,
    });
    const ordinaryTasks = {
      preparePluginWithdrawal,
      withdrawPluginTask,
    } as unknown as OrdinaryTaskRuntime;
    const controlPlane = createPluginTaskControlPlane({} as Db, ordinaryTasks);

    const result = await controlPlane.withdraw({
      companyId: recordedTask.companyId,
      taskId: recordedTask.id,
      message: "Withdraw this task.",
      hostRpcOperationId: "rpc-operation-1",
      pluginInstallationId: "00000000-0000-4000-8000-000000000003",
      pluginKey: "example.plugin",
    });

    expect(result).toEqual({
      operationId: "rpc-operation-1",
      task: recordedTask,
      retried: true,
    });
    expect(result.task).toBe(recordedTask);
    expect(preparePluginWithdrawal).toHaveBeenCalledWith({
      companyId: recordedTask.companyId,
      taskId: recordedTask.id,
      message: "Withdraw this task.",
      operationId: "rpc-operation-1",
      pluginInstallationId: "00000000-0000-4000-8000-000000000003",
      pluginKey: "example.plugin",
    });
    expect(withdrawPluginTask).toHaveBeenCalledWith({
      companyId: recordedTask.companyId,
      operationId: "rpc-operation-1",
      pluginInstallationId: "00000000-0000-4000-8000-000000000003",
      pluginKey: "example.plugin",
    });
  });
});
