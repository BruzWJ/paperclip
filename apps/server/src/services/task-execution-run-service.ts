import {
  agentAdapterConfigRevisions,
  agents,
  taskExecutionRuns,
  taskExecutionWorkspaceBindings,
  type Db,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  type TaskExecutionRunIdentity,
  type TaskExecutionRuntimeReadinessBinding,
  TaskExecutionRunInvariantViolation,
  assertRunIdentity,
} from "./task-execution-run-service-part-1-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export async function readTaskExecutionRuntimeReadinessBinding(
  database: Db | TaskSessionDbTransaction,
  input: TaskExecutionRunIdentity,
): Promise<TaskExecutionRuntimeReadinessBinding | null> {
  assertRunIdentity(input);
  const rows = await database
    .select({
      companyId: taskExecutionRuns.companyId,
      taskId: taskExecutionRuns.taskId,
      runId: taskExecutionRuns.id,
      runKind: taskExecutionRuns.kind,
      runStatus: taskExecutionRuns.status,
      targetAgentId: taskExecutionRuns.targetAgentId,
      adapterConfigRevisionId: taskExecutionRuns.adapterConfigRevisionId,
      executionWorkspaceBindingId: taskExecutionRuns.executionWorkspaceBindingId,
      currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
      revisionId: agentAdapterConfigRevisions.id,
      acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
      bindingId: taskExecutionWorkspaceBindings.id,
      bindingAbsoluteCwd: taskExecutionWorkspaceBindings.absoluteCwd,
    })
    .from(taskExecutionRuns)
    .leftJoin(
      agents,
      and(eq(agents.companyId, taskExecutionRuns.companyId), eq(agents.id, taskExecutionRuns.targetAgentId)),
    )
    .leftJoin(
      agentAdapterConfigRevisions,
      and(
        eq(agentAdapterConfigRevisions.companyId, taskExecutionRuns.companyId),
        eq(agentAdapterConfigRevisions.agentId, taskExecutionRuns.targetAgentId),
        eq(agentAdapterConfigRevisions.id, taskExecutionRuns.adapterConfigRevisionId),
      ),
    )
    .leftJoin(
      taskExecutionWorkspaceBindings,
      and(
        eq(taskExecutionWorkspaceBindings.companyId, taskExecutionRuns.companyId),
        eq(taskExecutionWorkspaceBindings.taskId, taskExecutionRuns.taskId),
        eq(taskExecutionWorkspaceBindings.sessionId, taskExecutionRuns.sessionId),
        eq(taskExecutionWorkspaceBindings.ownershipEpoch, taskExecutionRuns.ownershipEpoch),
        eq(taskExecutionWorkspaceBindings.id, taskExecutionRuns.executionWorkspaceBindingId),
      ),
    )
    .where(
      and(
        eq(taskExecutionRuns.companyId, input.companyId),
        eq(taskExecutionRuns.taskId, input.taskId),
        eq(taskExecutionRuns.id, input.runId),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    throw new TaskExecutionRunInvariantViolation("runtime-readiness run identity resolved more than once");
  }
  const row = rows[0];
  if (!row) return null;
  if (!row.revisionId || !row.executionWorkspaceBindingId) {
    throw new TaskExecutionRunInvariantViolation(
      "task-execution run violates the persisted runtime-readiness scope invariant",
    );
  }
  return Object.freeze({
    companyId: row.companyId,
    taskId: row.taskId,
    runId: row.runId,
    runKind: row.runKind,
    runStatus: row.runStatus,
    agentId: row.targetAgentId,
    currentAdapterConfigRevisionId: row.currentAdapterConfigRevisionId,
    adapterConfigRevisionId: row.adapterConfigRevisionId,
    executionWorkspaceBindingId: row.executionWorkspaceBindingId,
    absoluteCwd: row.bindingId === row.executionWorkspaceBindingId ? row.bindingAbsoluteCwd : null,
    acpConfiguration: row.acpConfiguration,
  });
}
export * from "./task-execution-run-service-part-1-section-1.js";
export * from "./task-execution-run-service-part-10.js";
export * from "./task-execution-run-service-part-11.js";
export * from "./task-execution-run-service-part-2-section-1.js";
export * from "./task-execution-run-service-part-3-section-1.js";
export * from "./task-execution-run-service-part-4-section-1.js";
export * from "./task-execution-run-service-part-5-section-1.js";
export * from "./task-execution-run-service-part-5-section-2.js";
export * from "./task-execution-run-service-part-6-section-1.js";

export * from "./task-execution-run-service-part-7.js";
export * from "./task-execution-run-service-part-8.js";
