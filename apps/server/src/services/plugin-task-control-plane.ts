import { tasks, type Db } from "@paperclipai/db";
import { isCanonicalUuid, type Task } from "@paperclipai/shared";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import type { PluginTaskControlPlane } from "./plugin-host-services.js";
import type { OrdinaryTaskRuntime } from "./ordinary-task-runtime.js";
import { taskService } from "./tasks.js";

function requireCanonicalUuid(value: string, label: string): void {
  if (!isCanonicalUuid(value)) {
    throw new Error(`${label} must be an exact canonical UUID`);
  }
}

function requireExactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be exact and non-empty`);
  }
}

function exactTaskListWindow(
  value: number | undefined,
  field: "limit" | "offset",
) {
  if (value === undefined) return field === "limit" ? 100 : 0;
  const minimum = field === "limit" ? 1 : 0;
  const maximum = field === "limit" ? 100 : Number.MAX_SAFE_INTEGER - 100;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${field} must be an exact integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requirePluginTaskContext(params: {
  companyId: string;
  pluginInstallationId: string;
  pluginKey: string;
}): void {
  requireCanonicalUuid(params.companyId, "companyId");
  requireCanonicalUuid(params.pluginInstallationId, "pluginInstallationId");
  requireExactIdentity(params.pluginKey, "pluginKey");
}

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
  requireCanonicalUuid(params.pluginInstallationId, "pluginInstallationId");
  const { hostRpcOperationId } = params;
  if (
    hostRpcOperationId.length === 0 ||
    hostRpcOperationId !== hostRpcOperationId.trim()
  ) {
    throw new Error("Host RPC operation identity must be exact and non-empty");
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
      requirePluginTaskContext(params);
      if (params.projectId !== undefined) {
        requireCanonicalUuid(params.projectId, "projectId");
      }
      if (params.ownerAgentId !== undefined) {
        requireCanonicalUuid(params.ownerAgentId, "ownerAgentId");
      }
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
      const offset = exactTaskListWindow(params.offset, "offset");
      const limit = exactTaskListWindow(params.limit, "limit");
      const ids = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(limit)
        .offset(offset);
      const rows = await Promise.all(
        ids.map(({ id }) => taskReads.getById(id)),
      );
      return rows.filter(
        (task): task is NonNullable<typeof task> => task !== null,
      ) as Task[];
    },

    async get(params) {
      requirePluginTaskContext(params);
      requireCanonicalUuid(params.taskId, "taskId");
      const task = await taskReads.getById(params.taskId);
      return task?.companyId === params.companyId ? (task as Task) : null;
    },

    async create(params) {
      requirePluginTaskContext(params);
      requireCanonicalUuid(params.ownerAgentId, "ownerAgentId");
      requireExactIdentity(params.callbackKey, "callbackKey");
      requireExactIdentity(params.callbackVersion, "callbackVersion");
      if (params.projectId !== undefined) {
        requireCanonicalUuid(params.projectId, "projectId");
      }
      if (params.goalId !== undefined) {
        requireCanonicalUuid(params.goalId, "goalId");
      }
      if (params.parentId !== undefined) {
        requireCanonicalUuid(params.parentId, "parentId");
      }
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
          "critical" | "high" | "medium" | "low" | undefined,
      });
      return requireTask(
        await taskReads.getById(created.task.id),
        "Created plugin task could not be read",
      );
    },

    async update(params) {
      requirePluginTaskContext(params);
      requireCanonicalUuid(params.taskId, "taskId");
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

      requireCanonicalUuid(params.input.ownerAgentId, "ownerAgentId");
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
      requirePluginTaskContext(params);
      requireCanonicalUuid(params.taskId, "taskId");
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
