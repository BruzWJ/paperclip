import {
  agents,
  companies,
  taskExecutionAuthorities,
  taskExecutionLanes,
  taskSessions,
  tasks,
} from "@paperclipai/db";
import { type AgentVisibleTaskStatus } from "@paperclipai/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
export { canonicalJson } from "./canonical-json.js";
import {
  RuntimeTaskActionConflict,
  RuntimeTaskActionDenied,
  lockAgentCounterpartTarget,
  lockTaskSessionState,
  lockTaskUpdateTarget,
  type AgentCounterpartTarget,
  type AgentRunCapability,
  type TaskRow,
  type TaskUpdateTarget,
} from "./runtime-task-action-port-shared-part-1.js";
import {
  activeTaskTreePauseHoldExistsSql,
  lockTaskTreeExecutionGate,
} from "./task-execution-lifecycle-gate.js";
import { lockTaskExecutionRunIfPresentInTransaction } from "./task-execution-run-service-part-3-section-1.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

export type TaskMentionRecipient =
  { kind: "agent"; target: AgentCounterpartTarget } | { kind: "board"; target: TaskUpdateTarget };

export async function lockTaskMentionRecipient(
  tx: TaskSessionDbTransaction,
  companyId: string,
  taskId: string,
): Promise<TaskMentionRecipient> {
  const sessionState = await lockTaskSessionState(tx, companyId, taskId);
  if (!sessionState || sessionState.session.integrityState !== "ready") {
    throw new RuntimeTaskActionConflict("Mention target has no receivable canonical Session");
  }
  const target = {
    taskId,
    sessionId: sessionState.session.id,
    ownershipEpoch: sessionState.task.ownershipEpoch,
  };
  if (sessionState.task.ownerKind !== "agent" || !sessionState.task.ownerAgentId) {
    return { kind: "board", target };
  }
  const authority = await tx
    .select()
    .from(taskExecutionAuthorities)
    .where(
      and(
        eq(taskExecutionAuthorities.companyId, companyId),
        eq(taskExecutionAuthorities.taskId, taskId),
        eq(taskExecutionAuthorities.ownershipEpoch, sessionState.task.ownershipEpoch),
        eq(taskExecutionAuthorities.agentId, sessionState.task.ownerAgentId),
        eq(taskExecutionAuthorities.state, "current"),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!authority || authority.sessionId !== sessionState.session.id) {
    throw new RuntimeTaskActionConflict("Mention target agent has no current task authority");
  }
  return {
    kind: "agent",
    target: {
      ...target,
      agentId: authority.agentId,
      authorityId: authority.id,
      adapterConfigRevisionId: authority.auditAdapterConfigRevisionId,
      contextGeneration: sessionState.contextGeneration,
    },
  };
}

export async function lockOwnerUpdateRecipient(
  tx: TaskSessionDbTransaction,
  companyId: string,
  task: TaskRow,
  creatorEdge: {
    endpointKind: string;
    endpointId: string | null;
  },
): Promise<TaskMentionRecipient> {
  if (task.parentId) {
    return lockTaskMentionRecipient(tx, companyId, task.parentId);
  }

  const sameTask = await lockTaskUpdateTarget(tx, companyId, task.id);
  if (creatorEdge.endpointKind === "agent-execution" && creatorEdge.endpointId) {
    try {
      return {
        kind: "agent",
        target: await lockAgentCounterpartTarget(tx, companyId, creatorEdge.endpointId),
      };
    } catch (error) {
      if (!(error instanceof RuntimeTaskActionConflict)) throw error;
    }
  }
  return { kind: "board", target: sameTask };
}

export { deterministicUuid } from "./deterministic-uuid.js";

export function stableSessionId(key: string): string {
  return `ses_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

export function runtimeInvocationKey(
  kind: "create" | "assign" | "owner-update" | "creator-update" | "mention" | "mention-board" | "list-agents",
  capabilityIdentity: string,
  invocationId: string,
): string {
  return `runtime:${kind}:${capabilityIdentity}:${invocationId}`;
}

export function grantMap(rows: readonly { key: string }[]): Record<string, true> {
  return Object.fromEntries(rows.map((row) => [row.key, true]));
}

export function terminalStatus(status: AgentVisibleTaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

export function boardPresentationStatusFor(
  status: AgentVisibleTaskStatus,
): "in_progress" | "blocked" | "done" | "cancelled" {
  if (status === "open") return "in_progress";
  return status;
}

export function assertLifecycleTransition(
  current: AgentVisibleTaskStatus | null,
  requested: AgentVisibleTaskStatus,
): asserts current is AgentVisibleTaskStatus {
  if (current === "done" || current === "cancelled") {
    throw new RuntimeTaskActionConflict("A terminal task rejects later owner updates");
  }
  const legal =
    (current === "open" && (requested === "blocked" || requested === "done" || requested === "cancelled")) ||
    (current === "blocked" && (requested === "open" || requested === "done" || requested === "cancelled"));
  if (!legal) {
    throw new RuntimeTaskActionConflict("Task lifecycle transition is invalid");
  }
}

export function assertTaskNonterminal(task: TaskRow): asserts task is TaskRow & {
  lifecycleStatus: "open" | "blocked";
} {
  if (task.lifecycleStatus !== "open" && task.lifecycleStatus !== "blocked") {
    throw new RuntimeTaskActionConflict("The target task is not open or blocked");
  }
}

export async function lockRuntimeActionHierarchy(
  tx: TaskSessionDbTransaction,
  capability: AgentRunCapability,
  now: Date,
  options: { readonly additionalLaneTargetAgentId?: string },
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${capability.companyId}, 0))`);
  const companyRows = await tx
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, capability.companyId))
    .limit(2)
    .for("update");
  if (companyRows.length !== 1) {
    throw new RuntimeTaskActionDenied("Company Session lifecycle is not ready", "company_inactive");
  }
  await lockTaskTreeExecutionGate(tx, capability.companyId, capability.taskId);
  const taskRows = await tx
    .select({
      id: tasks.id,
      lifecycleStatus: tasks.lifecycleStatus,
      executionPaused: activeTaskTreePauseHoldExistsSql(tasks.companyId, tasks.id),
    })
    .from(tasks)
    .where(and(eq(tasks.companyId, capability.companyId), eq(tasks.id, capability.taskId)))
    .limit(2)
    .for("update");
  if (taskRows.length !== 1) {
    throw new RuntimeTaskActionDenied("Task ownership epoch has changed", "ownership_epoch_changed");
  }
  const task = taskRows[0]!;
  if (!["open", "blocked"].includes(task.lifecycleStatus)) {
    throw new RuntimeTaskActionDenied("Task lifecycle is terminal", "task_lifecycle_terminal");
  }
  if (task.executionPaused) {
    throw new RuntimeTaskActionDenied("Task execution is paused", "task_execution_paused");
  }
  const sessionRows = await tx
    .select({ id: taskSessions.id })
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.companyId, capability.companyId),
        eq(taskSessions.taskId, capability.taskId),
        eq(taskSessions.id, capability.sessionId),
      ),
    )
    .limit(2)
    .for("update");
  if (sessionRows.length !== 1) {
    throw new RuntimeTaskActionDenied("Task Session is not ready", "task_session_invalid");
  }
  const companyAgents = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.companyId, capability.companyId))
    .orderBy(asc(agents.id))
    .for("update");
  const laneTargetAgentIds = [
    ...new Set([
      capability.targetAgentId,
      ...(options.additionalLaneTargetAgentId ? [options.additionalLaneTargetAgentId] : []),
    ]),
  ].sort();
  const knownAgentIds = new Set(companyAgents.map((agent) => agent.id));
  if (laneTargetAgentIds.some((agentId) => !knownAgentIds.has(agentId))) {
    throw new RuntimeTaskActionDenied(
      "Mention target is no longer in the current reach catalog",
      "mention_catalog_changed",
    );
  }
  for (const targetAgentId of laneTargetAgentIds) {
    await tx
      .insert(taskExecutionLanes)
      .values({
        companyId: capability.companyId,
        taskId: capability.taskId,
        ownershipEpoch: capability.ownershipEpoch,
        targetAgentId,
        nextOrdinal: 0,
        activeOrdinal: null,
        activeLeaseGeneration: null,
        activeLeaseId: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          taskExecutionLanes.companyId,
          taskExecutionLanes.taskId,
          taskExecutionLanes.ownershipEpoch,
          taskExecutionLanes.targetAgentId,
        ],
      });
  }
  for (const targetAgentId of laneTargetAgentIds) {
    const laneRows = await tx
      .select({ targetAgentId: taskExecutionLanes.targetAgentId })
      .from(taskExecutionLanes)
      .where(
        and(
          eq(taskExecutionLanes.companyId, capability.companyId),
          eq(taskExecutionLanes.taskId, capability.taskId),
          eq(taskExecutionLanes.ownershipEpoch, capability.ownershipEpoch),
          eq(taskExecutionLanes.targetAgentId, targetAgentId),
        ),
      )
      .limit(2)
      .for("update");
    if (laneRows.length !== 1) {
      throw new RuntimeTaskActionConflict("Runtime action lost its exact target-agent execution lane");
    }
  }
}

export async function lockRuntimeActionRun(
  tx: TaskSessionDbTransaction,
  capability: AgentRunCapability,
): Promise<void> {
  const run = await lockTaskExecutionRunIfPresentInTransaction(tx, {
    companyId: capability.companyId,
    taskId: capability.taskId,
    runId: capability.runId,
  });
  if (
    !run ||
    run.status !== "running" ||
    run.sessionId !== capability.sessionId ||
    run.ownershipEpoch !== capability.ownershipEpoch ||
    run.targetAgentId !== capability.targetAgentId ||
    run.executionMode !== capability.executionMode ||
    run.taskExecutionAuthorityId !== capability.taskExecutionAuthorityId ||
    run.consultExecutionId !== capability.consultExecutionId ||
    run.adapterConfigRevisionId !== capability.adapterConfigIdentity ||
    run.executionWorkspaceBindingId !== capability.workspaceIdentity ||
    run.currentAttemptId !== capability.attemptId ||
    run.currentLeaseId !== capability.leaseId ||
    run.cancellationIntentId !== null ||
    run.terminalFinalizationId !== null
  ) {
    throw new RuntimeTaskActionDenied("Run is no longer active in this execution scope", "run_scope_changed");
  }
}
