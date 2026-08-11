import { tasks, type Db } from "@paperclipai/db";
import type { Task } from "@paperclipai/shared";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import type { PluginTaskControlPlane } from "./plugin-host-services.js";
import type { OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import { taskService } from "./tasks.js";

function requireTask(
  task: Awaited<ReturnType<ReturnType<typeof taskService>["getById"]>>,
  message: string,
): Task {
  if (!task) throw new Error(message);
  return task as Task;
}

function pluginTaskRpcIdempotencyKey(
  method: "tasks.create" | "tasks.update",
  params: {
    pluginInstallationId: string;
    hostRpcOperationId: string;
  },
): string {
  const hostRpcOperationId = params.hostRpcOperationId.trim();
  if (!hostRpcOperationId) {
    throw new Error("Host RPC operation identity is required");
  }
  return [
    "plugin-task-rpc",
    params.pluginInstallationId,
    method,
    hostRpcOperationId,
  ].join(":");
}

/**
 * Installation-bound implementation of the retained plugin task control
 * plane. Reads are company-scoped. Mutations additionally prove immutable
 * plugin creator identity inside OrdinaryTaskRuntime.
 */
export function createPluginTaskControlPlane(
  db: Db,
  ordinaryTasks: OrdinaryTaskRuntime,
): PluginTaskControlPlane {
  const taskReads = taskService(db);

  return {
    async list(params) {
      const conditions: SQL[] = [
        eq(tasks.companyId, params.companyId),
        isNull(tasks.hiddenAt),
      ];
      if (params.projectId) {
        conditions.push(eq(tasks.projectId, params.projectId));
      }
      if (params.ownerAgentId) {
        conditions.push(eq(tasks.ownerAgentId, params.ownerAgentId));
      }
      if (params.status) {
        conditions.push(eq(tasks.lifecycleStatus, params.status));
      }
      const offset = Math.max(0, Math.floor(params.offset ?? 0));
      const limit = Math.max(1, Math.min(1_000, Math.floor(params.limit ?? 500)));
      const ids = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(limit)
        .offset(offset);
      const rows = await Promise.all(ids.map(({ id }) => taskReads.getById(id)));
      return rows.filter((task): task is NonNullable<typeof task> => task !== null) as Task[];
    },

    async get(params) {
      const task = await taskReads.getById(params.taskId);
      return task?.companyId === params.companyId ? task as Task : null;
    },

    async create(params) {
      const created = await ordinaryTasks.create({
        companyId: params.companyId,
        request: params.request,
        ownerAgentId: params.ownerAgentId,
        creator: {
          kind: "plugin",
          pluginInstallationId: params.pluginInstallationId,
          pluginKey: params.pluginKey,
          callbackKey: params.callbackKey,
          callbackVersion: params.callbackVersion,
          callbackRegistrationActive: params.callbackRegistrationActive,
        },
        idempotencyKey: pluginTaskRpcIdempotencyKey("tasks.create", params),
        sourceKind: "task_request",
        title: params.title,
        projectId: params.projectId,
        goalId: params.goalId,
        parentId: params.parentId,
        priority: params.priority as
          | "critical"
          | "high"
          | "medium"
          | "low"
          | undefined,
      });
      return requireTask(
        await taskReads.getById(created.task.id),
        "Created plugin task could not be read",
      );
    },

    async update(params) {
      if (params.input.kind === "message") {
        const updated = await ordinaryTasks.commitCreatorFormUpdate(
          params.taskId,
          params.input.message,
          {
            kind: "plugin",
            companyId: params.companyId,
            pluginInstallationId: params.pluginInstallationId,
            pluginKey: params.pluginKey,
            gatewayInvocationId: pluginTaskRpcIdempotencyKey(
              "tasks.update",
              params,
            ),
          },
        );
        return requireTask(
          await taskReads.getById(updated.update.taskId),
          "Updated plugin task could not be read",
        );
      }

      const reassigned = await ordinaryTasks.reassign({
        companyId: params.companyId,
        taskId: params.taskId,
        ownerAgentId: params.input.ownerAgentId,
        idempotencyKey: pluginTaskRpcIdempotencyKey("tasks.update", params),
        creator: {
          kind: "plugin",
          pluginInstallationId: params.pluginInstallationId,
          pluginKey: params.pluginKey,
        },
      });
      return requireTask(
        await taskReads.getById(reassigned.task.id),
        "Reassigned plugin task could not be read",
      );
    },

    async withdraw(params) {
      await ordinaryTasks.preparePluginWithdrawal({
        companyId: params.companyId,
        taskId: params.taskId,
        message: params.message,
        operationId: params.hostRpcOperationId,
        pluginInstallationId: params.pluginInstallationId,
        pluginKey: params.pluginKey,
      });
      const result = await ordinaryTasks.withdrawPluginTask({
        companyId: params.companyId,
        operationId: params.hostRpcOperationId,
        pluginInstallationId: params.pluginInstallationId,
        pluginKey: params.pluginKey,
      });
      return {
        operationId: result.operationId,
        task: result.task as Task,
        retried: result.retried,
      };
    },
  };
}
