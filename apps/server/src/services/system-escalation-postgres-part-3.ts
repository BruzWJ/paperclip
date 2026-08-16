import { companies, systemEscalationIdentities, taskCreatorEdgeReceivability, tasks } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import {
  allocateCanonicalTaskIdentityInTx,
  persistCanonicalTaskAggregateInTx,
} from "./canonical-task-aggregate.js";
import {
  type EdgeRow,
  type EnsureSystemEscalationInput,
  type SystemEscalationTransactionResult,
  type TerminalizeCreatorEdgeInput,
  PostgresSystemEscalationConflict,
  appendAffectedCrossLink,
  deterministicUuid,
  escalationRequest,
  escalationTitle,
  requireSelectedAgentRevision,
  resolveSystemEscalationOwnerInTransaction,
  sourceAuthor,
  stableSessionId,
  terminalReason,
  validateTriggeringRun,
  withEscalationWorkspaceReservationErrors,
} from "./system-escalation-postgres-part-1.js";
import { appendEscalationNudge, loadLockedAffectedScope } from "./system-escalation-postgres-part-2.js";
import { admitTaskExecutionInTransaction } from "./task-execution-initial-start-admission.js";
import { type TaskSessionAdmissionService } from "./task-session/admission.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

/**
 * Canonical PostgreSQL constructor. Callers that already own a transaction
 * use this function so edge terminalization, identity claim, task creation,
 * cross-link, and owner ref commit together.
 */
export async function ensureSystemEscalationInTransaction(
  tx: TaskSessionDbTransaction,
  sessions: TaskSessionAdmissionService,
  input: EnsureSystemEscalationInput,
  clock: () => Date = () => new Date(),
): Promise<SystemEscalationTransactionResult> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:system-escalation:${input.affectedTaskId}:${input.affectedOwnershipEpoch}`}, 0))`,
  );
  const { affected, edge, affectedSession } = await loadLockedAffectedScope(tx, input);
  await validateTriggeringRun(tx, input.companyId, input.triggeringRunId);

  const existingIdentity = await tx
    .select()
    .from(systemEscalationIdentities)
    .where(
      and(
        eq(systemEscalationIdentities.companyId, input.companyId),
        eq(systemEscalationIdentities.affectedTaskId, input.affectedTaskId),
        eq(systemEscalationIdentities.affectedOwnershipEpoch, input.affectedOwnershipEpoch),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (existingIdentity) {
    const escalationTask = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, existingIdentity.escalationTaskId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!escalationTask) {
      throw new PostgresSystemEscalationConflict(
        "Historical escalation identity lost its escalation task",
        "escalation_task_missing",
      );
    }
    await appendAffectedCrossLink(
      sessions,
      tx,
      input,
      affected,
      affectedSession.id,
      existingIdentity,
      escalationTask,
    );
    const initialCausalSourceId =
      typeof existingIdentity.immutableSource.initialCausalSourceId === "string"
        ? existingIdentity.immutableSource.initialCausalSourceId
        : null;
    const dispatchRefId =
      initialCausalSourceId === input.causalSourceId
        ? null
        : await appendEscalationNudge(sessions, tx, input, existingIdentity, escalationTask);
    return {
      identity: existingIdentity,
      task: escalationTask,
      owner:
        escalationTask.ownerKind === "agent" && escalationTask.ownerAgentId
          ? { kind: "agent", agentId: escalationTask.ownerAgentId }
          : escalationTask.ownerKind === "user" && escalationTask.ownerUserId
            ? { kind: "user", userId: escalationTask.ownerUserId }
            : { kind: "board" },
      dispatchRefId,
      created: false,
    };
  }

  const owner = await resolveSystemEscalationOwnerInTransaction(tx, affected);
  const selectedAgent =
    owner.kind === "agent" ? await requireSelectedAgentRevision(tx, input.companyId, owner.agentId) : null;
  const now = clock();
  const company = await tx
    .select()
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !company ||
    company.status !== "active" ||
    company.sessionIntegrityState !== "ready" ||
    company.hardDeleteFencedAt !== null
  ) {
    throw new PostgresSystemEscalationConflict("Company Session lifecycle is not ready", "company_not_ready");
  }

  const identityId = deterministicUuid(
    "system-escalation-identity",
    `${input.companyId}:${input.affectedTaskId}:${input.affectedOwnershipEpoch}`,
  );
  const escalationTaskId = deterministicUuid("system-escalation-task", identityId);
  const sessionId = stableSessionId(`system-escalation:${identityId}`);
  const request = escalationRequest(affected, input.systemSource, terminalReason(edge.terminalReason));
  const title = escalationTitle(affected);
  const { taskNumber, identifier } = await allocateCanonicalTaskIdentityInTx(tx, input.companyId, now);

  const authorityId = selectedAgent
    ? deterministicUuid("system-escalation-authority", `${escalationTaskId}:${selectedAgent.owner.id}`)
    : null;
  const aggregate = await withEscalationWorkspaceReservationErrors(() =>
    persistCanonicalTaskAggregateInTx(tx, {
      task: {
        id: escalationTaskId,
        companyId: input.companyId,
        parentId: null,
        projectId: null,
        goalId: null,
        title,
        request,
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        disposition: null,
        priority: "medium",
        ownerKind: owner.kind,
        ownerAgentId: owner.kind === "agent" ? owner.agentId : null,
        ownerUserId: owner.kind === "user" ? owner.userId : null,
        ownerAssignmentSource: null,
        ownershipEpoch: 1,
        creatorKind: "system",
        creatorSystemSourceKind: input.systemSource,
        creatorSystemSourceId: `system-escalation:${identityId}`,
        escalatedFromAffectedTaskId: affected.id,
        escalatedFromTriggeringRunId: input.triggeringRunId,
        escalatedFromReason: edge.terminalReason,
        affectedOwnershipEpoch: input.affectedOwnershipEpoch,
        taskNumber,
        identifier,
        originKind: "system_escalation",
        originId: affected.id,
        originFingerprint: `${affected.id}:${input.affectedOwnershipEpoch}`,
        requestDepth: 0,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: sessionId,
        parentSessionId: null,
        now,
      },
      workspaceReservation: {
        provenance: {
          agentId: null,
          userId: owner.kind === "user" ? owner.userId : null,
        },
      },
      authority:
        selectedAgent && authorityId
          ? {
              id: authorityId,
              agentId: selectedAgent.owner.id,
              auditAdapterConfigRevisionId: selectedAgent.revision.id,
              createdAt: now,
            }
          : null,
    }),
  );
  const escalationTask = aggregate.task;

  const identity = await tx
    .insert(systemEscalationIdentities)
    .values({
      id: identityId,
      companyId: input.companyId,
      affectedTaskId: affected.id,
      affectedOwnershipEpoch: input.affectedOwnershipEpoch,
      escalationTaskId: escalationTask.id,
      systemSource: input.systemSource,
      triggeringRunId: input.triggeringRunId,
      terminalCreatorEdgeId: edge.id,
      immutableSource: {
        contract: "system-escalation/v1",
        reason: edge.terminalReason,
        terminalCreatorEdgeId: edge.id,
        terminalSourceKind: edge.terminalSourceKind,
        terminalSourceId: edge.terminalSourceId,
        systemSource: input.systemSource,
        triggeringRunId: input.triggeringRunId,
        initialCausalSourceId: input.causalSourceId,
      },
      createdAt: now,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!identity) {
    throw new PostgresSystemEscalationConflict(
      "System escalation identity was not claimed",
      "escalation_identity_missing",
    );
  }

  let dispatchRefId: string | null = null;
  if (selectedAgent && authorityId) {
    const admitted = await admitTaskExecutionInTransaction({
      sessionAdmission: sessions,
      transaction: tx,
      work: {
        companyId: input.companyId,
        taskId: escalationTask.id,
        sessionId,
        ownershipEpoch: 1,
        targetAgentId: selectedAgent.owner.id,
        taskExecutionAuthorityId: authorityId,
        consultExecutionId: null,
        adapterConfigRevisionId: selectedAgent.revision.id,
        contextEpoch: 0,
        mode: "owner",
        sourceKind: "task_request",
        actor: {
          kind: "system",
          sourceKind: input.systemSource,
          sourceId: identity.id,
        },
        immutableSourceKey: identity.id,
        sourceRecordId: escalationTask.id,
        exactText: escalationTask.request!,
        comment: {
          author: sourceAuthor(input.systemSource),
          producingRun: null,
          body: escalationTask.request!,
        },
        idempotencyKey: identity.id,
      },
    });
    dispatchRefId = admitted.ref?.id ?? null;
    if (!dispatchRefId) {
      throw new PostgresSystemEscalationConflict(
        "Agent-owned escalation did not persist its owner execution ref",
        "escalation_ref_missing",
      );
    }
  } else {
    await sessions.appendNonDispatchControlNotice(
      {
        companyId: input.companyId,
        taskId: escalationTask.id,
        sessionId,
        sourceKind: "system_escalation_request",
        immutableSourceKey: identity.id,
        sourceRecordId: escalationTask.id,
        exactText: escalationTask.request!,
        comment: {
          author: sourceAuthor(input.systemSource),
          producingRun: null,
          body: escalationTask.request!,
        },
        allowTerminal: false,
      },
      tx,
    );
  }

  await appendAffectedCrossLink(sessions, tx, input, affected, affectedSession.id, identity, escalationTask);
  return {
    identity,
    task: escalationTask,
    owner,
    dispatchRefId,
    created: true,
  };
}

export async function terminalizeCreatorEdgeInTransaction(
  tx: TaskSessionDbTransaction,
  sessions: TaskSessionAdmissionService,
  input: TerminalizeCreatorEdgeInput,
  clock: () => Date = () => new Date(),
): Promise<{
  edge: EdgeRow;
  escalation: SystemEscalationTransactionResult | null;
}> {
  const affected = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.companyId, input.companyId), eq(tasks.id, input.taskId)))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!affected || affected.ownershipEpoch !== input.ownershipEpoch) {
    throw new PostgresSystemEscalationConflict(
      "Creator edge no longer belongs to the current task epoch",
      "creator_edge_epoch_stale",
    );
  }
  if (
    affected.lifecycleStatus !== "open" &&
    affected.lifecycleStatus !== "blocked" &&
    affected.lifecycleStatus !== "done" &&
    affected.lifecycleStatus !== "cancelled"
  ) {
    throw new PostgresSystemEscalationConflict(
      "Creator-edge terminalization requires a canonical task lifecycle status",
      "creator_edge_task_status_invalid",
    );
  }
  const current = await tx
    .select()
    .from(taskCreatorEdgeReceivability)
    .where(
      and(
        eq(taskCreatorEdgeReceivability.id, input.creatorEdgeId),
        eq(taskCreatorEdgeReceivability.companyId, input.companyId),
        eq(taskCreatorEdgeReceivability.taskId, input.taskId),
        eq(taskCreatorEdgeReceivability.ownershipEpoch, input.ownershipEpoch),
      ),
    )
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!current) {
    throw new PostgresSystemEscalationConflict(
      "Creator edge does not belong to this task epoch",
      "creator_edge_scope_stale",
    );
  }
  if (current.endpointKind === "user/board" || current.endpointKind === "system") {
    throw new PostgresSystemEscalationConflict(
      "User, board, and system creator edges are permanently inbox-receivable",
      "creator_edge_not_terminalizable",
    );
  }

  const now = clock();
  const taskIsNonterminal = affected.lifecycleStatus === "open" || affected.lifecycleStatus === "blocked";
  let edge = current;
  if (edge.state === "terminal") {
    if (edge.terminalReason !== input.reason) {
      throw new PostgresSystemEscalationConflict(
        "Creator-edge terminal reason is immutable",
        "creator_edge_terminal_reason_conflict",
      );
    }
  } else if (taskIsNonterminal) {
    edge = (await tx
      .update(taskCreatorEdgeReceivability)
      .set({
        state: "terminal",
        terminalReason: input.reason,
        terminalSourceKind: input.sourceKind,
        terminalSourceId: input.sourceId,
        terminalAudit: input.audit ?? {},
        endpointTombstone: input.endpointTombstone ?? null,
        terminalizedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskCreatorEdgeReceivability.id, current.id),
          eq(taskCreatorEdgeReceivability.state, "receivable"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null)) as EdgeRow;
    if (!edge) {
      throw new PostgresSystemEscalationConflict(
        "Creator-edge terminalization lost its compare-and-set race",
        "creator_edge_terminalization_conflict",
      );
    }
  }

  const escalation = taskIsNonterminal
    ? await ensureSystemEscalationInTransaction(
        tx,
        sessions,
        {
          companyId: input.companyId,
          affectedTaskId: input.taskId,
          affectedOwnershipEpoch: input.ownershipEpoch,
          terminalCreatorEdgeId: edge.id,
          systemSource: input.systemSource,
          triggeringRunId: input.triggeringRunId,
          causalSourceId: input.sourceId,
        },
        clock,
      )
    : null;
  return { edge, escalation };
}
