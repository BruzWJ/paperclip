import {
  agentAdapterConfigRevisions,
  agents,
  companies,
  executionWorkspaces,
  taskConsultExecutions,
  taskExecutionAuthorities,
  taskExecutionHistoryViews,
  taskExecutionRefs,
  taskExecutionWorkspaceBindings,
  taskSessionContextEpochs,
  taskSessions,
  tasks,
} from "@paperclipai/db";

import { and, eq, sql } from "drizzle-orm";

import { evaluateAgentInvokability } from "../agent-invokability.js";
import { lifecycleAcceptsExecution, terminalExecutionRef } from "../task-execution-terminal-eligibility.js";

import { type TaskSessionDbTransaction } from "./event-store.js";

import { TaskSessionLifecycleConflict } from "./store.js";

import {
  lockActiveTaskExecutionRunsForRefInTransaction,
  readTaskExecutionRun,
} from "../task-execution-run-service.js";
import {
  type ActiveExecution,
  type PendingCandidate,
  type ValidatedExecutionScope,
  sameNullableValue,
} from "./input-part-1.js";

export async function validateActiveExecution(
  transaction: TaskSessionDbTransaction,
  scope: ValidatedExecutionScope,
): Promise<ActiveExecution> {
  await transaction.execute(sql`
    SELECT id
    FROM companies
    WHERE id = ${scope.companyId}
    FOR UPDATE
  `);
  const refs = await transaction
    .select()
    .from(taskExecutionRefs)
    .where(eq(taskExecutionRefs.id, scope.activeRefId))
    .limit(1)
    .for("update");
  const ref = refs[0];
  if (
    !ref ||
    ref.companyId !== scope.companyId ||
    ref.taskId !== scope.taskId ||
    ref.sessionId !== scope.sessionId ||
    ref.ownershipEpoch !== scope.ownershipEpoch ||
    ref.executionLineageId !== scope.executionLineageId ||
    ref.adapterConfigRevisionId !== scope.adapterConfigRevisionId ||
    ref.historyViewId !== scope.historyViewId ||
    ref.contextEpoch !== scope.contextGeneration ||
    ref.disposition !== "active"
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session input processing requires its exact eligible execution ref",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  const activeMembershipRows = await lockActiveTaskExecutionRunsForRefInTransaction(transaction, {
    companyId: scope.companyId,
    taskId: scope.taskId,
    sessionId: scope.sessionId,
    refId: scope.activeRefId,
  });
  const activeMembership = activeMembershipRows[0] ?? null;
  if (
    activeMembershipRows.length > 1 ||
    (scope.runId === null
      ? activeMembership !== null && ref.promotedSeq === null
      : !activeMembership ||
        activeMembership.runId !== scope.runId ||
        activeMembership.status !== "running" ||
        activeMembership.currentAttemptId === null ||
        activeMembership.currentLeaseId === null)
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session input processing requires its exact canonical run membership",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  const [
    companyRows,
    taskRows,
    sessionRows,
    viewRows,
    runRows,
    contextRows,
    revisionRows,
    companyAgentRows,
    workspaceRows,
  ] = await Promise.all([
    transaction.select().from(companies).where(eq(companies.id, scope.companyId)).limit(1),
    transaction
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, scope.companyId), eq(tasks.id, scope.taskId)))
      .limit(1),
    transaction
      .select()
      .from(taskSessions)
      .where(
        and(
          eq(taskSessions.companyId, scope.companyId),
          eq(taskSessions.taskId, scope.taskId),
          eq(taskSessions.id, scope.sessionId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(taskExecutionHistoryViews)
      .where(eq(taskExecutionHistoryViews.id, scope.historyViewId))
      .limit(1),
    scope.runId === null
      ? Promise.resolve([])
      : readTaskExecutionRun(transaction, {
          companyId: scope.companyId,
          taskId: scope.taskId,
          runId: scope.runId,
        }).then((run) => (run ? [run] : [])),
    transaction
      .select()
      .from(taskSessionContextEpochs)
      .where(eq(taskSessionContextEpochs.sessionId, scope.sessionId))
      .limit(1),
    transaction
      .select()
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.companyId, scope.companyId),
          eq(agentAdapterConfigRevisions.agentId, ref.targetAgentId),
          eq(agentAdapterConfigRevisions.id, scope.adapterConfigRevisionId),
        ),
      )
      .limit(1),
    transaction
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        reportsTo: agents.reportsTo,
        status: agents.status,
        currentAdapterConfigRevisionId: agents.currentAdapterConfigRevisionId,
      })
      .from(agents)
      .where(eq(agents.companyId, scope.companyId)),
    transaction
      .select({
        binding: taskExecutionWorkspaceBindings,
        workspace: executionWorkspaces,
      })
      .from(taskExecutionWorkspaceBindings)
      .innerJoin(
        executionWorkspaces,
        and(
          eq(executionWorkspaces.id, taskExecutionWorkspaceBindings.executionWorkspaceId),
          eq(executionWorkspaces.companyId, taskExecutionWorkspaceBindings.companyId),
        ),
      )
      .where(
        and(
          eq(taskExecutionWorkspaceBindings.companyId, scope.companyId),
          eq(taskExecutionWorkspaceBindings.taskId, scope.taskId),
          eq(taskExecutionWorkspaceBindings.sessionId, scope.sessionId),
          eq(taskExecutionWorkspaceBindings.ownershipEpoch, scope.ownershipEpoch),
        ),
      )
      .limit(1),
  ]);
  const company = companyRows[0];
  const task = taskRows[0];
  const session = sessionRows[0];
  const view = viewRows[0];
  const run = runRows[0];
  const context = contextRows[0];
  const revision = revisionRows[0];
  const target = companyAgentRows.find((agent) => agent.id === ref.targetAgentId);
  const invokability = evaluateAgentInvokability(target, companyAgentRows);
  const workspace = workspaceRows[0];
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null ||
    !task ||
    task.hiddenAt !== null ||
    !lifecycleAcceptsExecution({
      lifecycleStatus: task.lifecycleStatus,
      terminalEligible: terminalExecutionRef({
        sourceKind: ref.sourceKind,
        messageKind: ref.messageKind,
        mode: ref.mode,
      }),
    }) ||
    task.ownershipEpoch !== scope.ownershipEpoch ||
    !session ||
    session.integrityState !== "ready" ||
    session.refAdmittableAt === null ||
    session.timeArchived !== null ||
    session.purgeFencedAt !== null ||
    !view ||
    view.companyId !== scope.companyId ||
    view.taskId !== scope.taskId ||
    view.sessionId !== scope.sessionId ||
    view.refId !== ref.id ||
    view.executionLineageId !== scope.executionLineageId ||
    view.contextEpoch !== scope.contextGeneration ||
    view.sourceHighWaterSeq !== ref.admissionHighWaterSeq ||
    !["empty", "current"].includes(view.state) ||
    (scope.runId !== null &&
      (!run ||
        run.companyId !== scope.companyId ||
        run.targetAgentId !== ref.targetAgentId ||
        run.kind !== "productive" ||
        run.status !== "running")) ||
    !context ||
    context.companyId !== scope.companyId ||
    context.taskId !== scope.taskId ||
    context.generation !== scope.contextGeneration ||
    !revision ||
    !invokability.invokable ||
    !workspace ||
    !workspace.binding.absoluteCwd.startsWith("/")
  ) {
    throw new TaskSessionLifecycleConflict(
      "Task Session input processing lost its live company, task, session, view, run, revision, workspace, or context scope",
      { refId: scope.activeRefId, runId: scope.runId },
    );
  }

  if (ref.mode === "owner") {
    if (
      ref.taskExecutionAuthorityId === null ||
      ref.consultExecutionId !== null ||
      task.ownerKind !== "agent" ||
      task.ownerAgentId !== ref.targetAgentId
    ) {
      throw new TaskSessionLifecycleConflict(
        "Task Session owner input scope no longer matches the current owner",
        { refId: ref.id },
      );
    }
    const authorities = await transaction
      .select({ id: taskExecutionAuthorities.id })
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.companyId, scope.companyId),
          eq(taskExecutionAuthorities.taskId, scope.taskId),
          eq(taskExecutionAuthorities.sessionId, scope.sessionId),
          eq(taskExecutionAuthorities.ownershipEpoch, scope.ownershipEpoch),
          eq(taskExecutionAuthorities.agentId, ref.targetAgentId),
          eq(taskExecutionAuthorities.id, ref.taskExecutionAuthorityId),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .limit(1);
    if (!authorities[0]) {
      throw new TaskSessionLifecycleConflict("Task Session input owner authority is revoked or stale", {
        refId: ref.id,
      });
    }
  } else if (ref.mode === "consult") {
    if (
      ref.taskExecutionAuthorityId !== null ||
      ref.consultExecutionId === null ||
      ref.consultCallerRefId === null ||
      ref.consultChainToken === null
    ) {
      throw new TaskSessionLifecycleConflict("Task Session consult input scope is incomplete", {
        refId: ref.id,
      });
    }
    const consults = await transaction
      .select({ id: taskConsultExecutions.id })
      .from(taskConsultExecutions)
      .where(
        and(
          eq(taskConsultExecutions.companyId, scope.companyId),
          eq(taskConsultExecutions.taskId, scope.taskId),
          eq(taskConsultExecutions.sessionId, scope.sessionId),
          eq(taskConsultExecutions.id, ref.consultExecutionId),
          eq(taskConsultExecutions.ownershipEpoch, scope.ownershipEpoch),
          eq(taskConsultExecutions.targetAgentId, ref.targetAgentId),
          eq(taskConsultExecutions.adapterConfigRevisionId, scope.adapterConfigRevisionId),
          eq(taskConsultExecutions.sourceRefId, ref.consultCallerRefId),
          eq(taskConsultExecutions.chainToken, ref.consultChainToken),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .limit(1);
    if (!consults[0]) {
      throw new TaskSessionLifecycleConflict("Task Session consult input binding is closed or stale", {
        refId: ref.id,
      });
    }
  } else {
    throw new TaskSessionLifecycleConflict("Task Session input execution mode is invalid", {
      refId: ref.id,
      mode: ref.mode,
    });
  }

  return { ref, view, runId: scope.runId };
}

export function sameOwnerCarryLineage(active: ActiveExecution, candidate: PendingCandidate): boolean {
  const { ref: activeRef, view: activeView } = active;
  const { ref, view } = candidate;
  return (
    activeRef.mode === "owner" &&
    ref.mode === "owner" &&
    activeRef.taskExecutionAuthorityId !== null &&
    activeRef.taskExecutionAuthorityId === ref.taskExecutionAuthorityId &&
    activeRef.companyId === ref.companyId &&
    activeRef.taskId === ref.taskId &&
    activeRef.sessionId === ref.sessionId &&
    activeRef.ownershipEpoch === ref.ownershipEpoch &&
    activeRef.targetAgentId === ref.targetAgentId &&
    activeRef.adapterConfigRevisionId === ref.adapterConfigRevisionId &&
    activeRef.contextEpoch === ref.contextEpoch &&
    activeRef.executionLineageId === ref.executionLineageId &&
    sameNullableValue(activeRef.counterpartTaskId, ref.counterpartTaskId) &&
    sameNullableValue(activeRef.counterpartAuthorityId, ref.counterpartAuthorityId) &&
    sameNullableValue(activeRef.counterpartOwnershipEpoch, ref.counterpartOwnershipEpoch) &&
    activeView.effectiveDialSnapshot?.carry_context === true &&
    view.effectiveDialSnapshot?.carry_context === true &&
    activeView.effectiveDialDigest === view.effectiveDialDigest
  );
}

export function candidateMatchesScope(
  active: ActiveExecution,
  candidate: PendingCandidate,
  candidateHasActiveRun: boolean,
): boolean {
  const { inbox, disposition, ref, view } = candidate;
  const sameRef = ref.id === active.ref.id;
  const leaseable = sameRef ? candidateHasActiveRun === (active.runId !== null) : !candidateHasActiveRun;
  return (
    disposition.state === "active" &&
    disposition.sourceRefId === ref.id &&
    inbox.companyId === active.ref.companyId &&
    inbox.taskId === active.ref.taskId &&
    inbox.sessionId === active.ref.sessionId &&
    inbox.promotedSeq === null &&
    ref.inputId === inbox.id &&
    ref.admittedSeq === inbox.admittedSeq &&
    ref.promotedSeq === null &&
    ref.disposition === "active" &&
    leaseable &&
    view.id === ref.historyViewId &&
    view.companyId === inbox.companyId &&
    view.taskId === inbox.taskId &&
    view.sessionId === inbox.sessionId &&
    view.refId === ref.id &&
    view.executionLineageId === ref.executionLineageId &&
    view.contextEpoch === ref.contextEpoch &&
    view.sourceHighWaterSeq === ref.admissionHighWaterSeq &&
    view.sourceMessageId === inbox.id &&
    view.sourceInputId === inbox.id &&
    view.sourceAdmittedSeq === inbox.admittedSeq &&
    view.sourcePromotedSeq === null &&
    ["empty", "current"].includes(view.state) &&
    (sameRef || sameOwnerCarryLineage(active, candidate))
  );
}
