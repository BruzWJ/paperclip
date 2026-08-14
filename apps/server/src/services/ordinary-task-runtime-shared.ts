import { labels, projects, tasks } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { InvokableTaskOwnerRejected, resolveInvokableTaskOwnerInTransaction } from "./agent-invokability.js";
import {
  type OrdinaryTaskCreateInput,
  type OrdinaryTaskCreator,
  type TaskRow,
  OrdinaryTaskRuntimeRejected,
} from "./ordinary-task-runtime-shared-part-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

/**
 * The ordinary-task boundary preserves its public rejection shape while the
 * actual owner/revision predicate is shared with every catalog and owner
 * configuration surface.
 */
export async function resolveOrdinaryTaskOwner(
  tx: TaskSessionDbTransaction,
  companyId: string,
  ownerAgentId: string,
): Promise<Awaited<ReturnType<typeof resolveInvokableTaskOwnerInTransaction>>> {
  try {
    return await resolveInvokableTaskOwnerInTransaction(tx, {
      companyId,
      ownerAgentId,
    });
  } catch (error) {
    if (error instanceof InvokableTaskOwnerRejected) {
      throw new OrdinaryTaskRuntimeRejected(error.message, error.reason);
    }
    throw error;
  }
}

export async function assertCreateReferences(
  tx: TaskSessionDbTransaction,
  input: OrdinaryTaskCreateInput,
): Promise<void> {
  if (input.labelIds?.length) {
    const existingLabels = await tx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, input.companyId), inArray(labels.id, input.labelIds)));
    if (existingLabels.length !== input.labelIds.length) {
      throw new OrdinaryTaskRuntimeRejected(
        "One or more labels are invalid for this company",
        "labels_invalid",
      );
    }
  }
  if (input.parentId) {
    const parent = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.parentId)))
      .then((rows) => rows[0] ?? null);
    if (!parent) {
      throw new OrdinaryTaskRuntimeRejected("Parent task is not in this company", "parent_task_invalid");
    }
  }
  if (input.projectId) {
    const project = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)))
      .then((rows) => rows[0] ?? null);
    if (!project) {
      throw new OrdinaryTaskRuntimeRejected("Project is not in this company", "project_invalid");
    }
  }
}

export function sameCreator(task: TaskRow, creator: OrdinaryTaskCreator): boolean {
  if (creator.kind === "user/board") {
    return task.creatorKind === creator.kind && task.creatorUserId === creator.userId;
  }
  if (creator.kind === "plugin") {
    return (
      task.creatorKind === creator.kind &&
      task.creatorPluginInstallationId === creator.pluginInstallationId &&
      task.creatorPluginKey === creator.pluginKey &&
      task.creatorCallbackKey === creator.callbackKey &&
      task.creatorCallbackVersion === creator.callbackVersion
    );
  }
  return (
    task.creatorKind === creator.kind &&
    task.creatorRoutineId === creator.routineId &&
    task.creatorRoutineDispatchId === creator.routineDispatchId
  );
}
export * from "./ordinary-task-runtime-shared-part-1.js";
export * from "./ordinary-task-runtime-shared-part-2.js";
export * from "./ordinary-task-runtime-shared-part-3.js";
