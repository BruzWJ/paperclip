import {
  agentAdapterConfigRevisions,
  agents,
  taskConsultExecutions,
  taskExecutionAuthorities,
  taskExecutionLanes,
  taskSessionContextEpochs,
} from "@paperclipai/db";
import { type TaskSessionEventType } from "@paperclipai/shared/task-session";
import { and, eq, lt, sql } from "drizzle-orm";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import { terminalExecutionRef } from "../task-execution-terminal-eligibility.js";
import type * as admissionCore from "./admission-part-1.js";
import { assertCanonicalScope, assertCounterpart, assertWorkspaceBinding } from "./admission-part-4.js";
import { previousOwnershipEpochForDispatchSource } from "./admission-part-2.js";
import { type TaskSessionDbTransaction } from "./event-store.js";
import { publishTaskSessionEventInTx, type PublishTaskSessionEventInput } from "./publication.js";
import { TaskSessionInvariantError, TaskSessionLifecycleConflict } from "./store.js";

export async function assertDispatchScope(
  transaction: TaskSessionDbTransaction,
  input: admissionCore.DispatchingExecutionSourceInput,
  messageKind: "user" | "synthetic",
): Promise<admissionCore.ValidatedDispatchScope> {
  const terminalEligible = terminalExecutionRef({
    sourceKind: input.sourceKind,
    messageKind,
    mode: input.mode,
  });
  const { task } = await assertCanonicalScope(transaction, input, {
    allowTerminal: terminalEligible,
  });
  if (
    !Number.isInteger(input.ownershipEpoch) ||
    input.ownershipEpoch <= 0 ||
    task.ownershipEpoch !== input.ownershipEpoch
  ) {
    throw new TaskSessionLifecycleConflict("Task execution epoch or Session context epoch is stale", {
      taskId: input.taskId,
      ownershipEpoch: input.ownershipEpoch,
      contextEpoch: input.contextEpoch,
    });
  }

  const [companyAgentRows, revisionRows, contextRows] = await Promise.all([
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
      .where(eq(agents.companyId, input.companyId)),
    transaction
      .select({ id: agentAdapterConfigRevisions.id })
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.companyId, input.companyId),
          eq(agentAdapterConfigRevisions.agentId, input.targetAgentId),
          eq(agentAdapterConfigRevisions.id, input.adapterConfigRevisionId),
        ),
      )
      .limit(1),
    transaction
      .select()
      .from(taskSessionContextEpochs)
      .where(
        and(
          eq(taskSessionContextEpochs.companyId, input.companyId),
          eq(taskSessionContextEpochs.taskId, input.taskId),
          eq(taskSessionContextEpochs.sessionId, input.sessionId),
          eq(taskSessionContextEpochs.generation, input.contextEpoch),
        ),
      )
      .limit(1),
  ]);
  const target = companyAgentRows.find((row) => row.id === input.targetAgentId);
  const invokability = evaluateAgentInvokability(target, companyAgentRows);
  if (!invokability.invokable) {
    throw new TaskSessionLifecycleConflict("Target agent is not invokable", {
      targetAgentId: input.targetAgentId,
      ...invokability.details,
    });
  }
  if (!revisionRows[0] || target?.currentAdapterConfigRevisionId !== input.adapterConfigRevisionId) {
    throw new TaskSessionLifecycleConflict(
      "Target adapter configuration revision is missing or no longer current",
      {
        targetAgentId: input.targetAgentId,
        adapterConfigRevisionId: input.adapterConfigRevisionId,
      },
    );
  }
  if (!contextRows[0]) {
    throw new TaskSessionLifecycleConflict("Session context epoch binding is missing", {
      sessionId: input.sessionId,
      contextEpoch: input.contextEpoch,
    });
  }

  if (input.mode === "owner") {
    if (
      input.taskExecutionAuthorityId === null ||
      input.consultExecutionId !== null ||
      task.ownerKind !== "agent" ||
      task.ownerAgentId !== input.targetAgentId ||
      input.consultCallerRefId != null ||
      input.consultChainToken != null
    ) {
      throw new TaskSessionLifecycleConflict("Owner execution scope does not match the current task owner", {
        taskId: input.taskId,
        targetAgentId: input.targetAgentId,
      });
    }
    const authorityRows = await transaction
      .select()
      .from(taskExecutionAuthorities)
      .where(
        and(
          eq(taskExecutionAuthorities.companyId, input.companyId),
          eq(taskExecutionAuthorities.taskId, input.taskId),
          eq(taskExecutionAuthorities.sessionId, input.sessionId),
          eq(taskExecutionAuthorities.ownershipEpoch, input.ownershipEpoch),
          eq(taskExecutionAuthorities.agentId, input.targetAgentId),
          eq(taskExecutionAuthorities.id, input.taskExecutionAuthorityId),
          eq(taskExecutionAuthorities.state, "current"),
        ),
      )
      .limit(1);
    if (!authorityRows[0]) {
      throw new TaskSessionLifecycleConflict("Task execution authority is missing, revoked, or stale", {
        taskExecutionAuthorityId: input.taskExecutionAuthorityId,
      });
    }
  } else if (input.mode === "consult") {
    if (
      input.taskExecutionAuthorityId !== null ||
      input.consultExecutionId === null ||
      input.consultCallerRefId == null ||
      input.consultChainToken == null
    ) {
      throw new TaskSessionLifecycleConflict("Consult execution scope is incomplete", {
        taskId: input.taskId,
      });
    }
    const consultRows = await transaction
      .select()
      .from(taskConsultExecutions)
      .where(
        and(
          eq(taskConsultExecutions.companyId, input.companyId),
          eq(taskConsultExecutions.taskId, input.taskId),
          eq(taskConsultExecutions.sessionId, input.sessionId),
          eq(taskConsultExecutions.id, input.consultExecutionId),
          eq(taskConsultExecutions.ownershipEpoch, input.ownershipEpoch),
          eq(taskConsultExecutions.targetAgentId, input.targetAgentId),
          eq(taskConsultExecutions.adapterConfigRevisionId, input.adapterConfigRevisionId),
          eq(taskConsultExecutions.sourceRefId, input.consultCallerRefId),
          eq(taskConsultExecutions.chainToken, input.consultChainToken),
          eq(taskConsultExecutions.state, "active"),
        ),
      )
      .limit(1);
    if (!consultRows[0]) {
      throw new TaskSessionLifecycleConflict("Consult execution binding is missing, closed, or stale", {
        consultExecutionId: input.consultExecutionId,
      });
    }
  } else {
    throw new TaskSessionLifecycleConflict("Task execution mode must be owner or consult", {
      mode: input.mode,
    });
  }

  await Promise.all([assertWorkspaceBinding(transaction, input), assertCounterpart(transaction, input)]);
  return {
    contextEpochBaselineSeq: contextRows[0].baselineSeq ?? -1,
  };
}

export function buildRef(
  input: admissionCore.DispatchExecutionScope & {
    sourceKind: admissionCore.RefRow["sourceKind"];
    sourceRecordId: string;
    exactText: string;
    idempotencyKey: string;
    previousOwnershipEpoch?: number | null;
  },
  ids: admissionCore.StableIdentity,
  messageKind: admissionCore.RefRow["messageKind"],
  inputId: string | null,
  laneOrdinal: number,
) {
  return {
    id: ids.refId,
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    ownershipEpoch: input.ownershipEpoch,
    previousOwnershipEpoch: previousOwnershipEpochForDispatchSource(input),
    executionScopeId: input.executionScopeId ?? ids.executionScopeId,
    executionLineageId: input.executionLineageId ?? ids.executionLineageId,
    mode: input.mode,
    sourceKind: input.sourceKind,
    sourceId: ids.sourceId,
    sourceRecordId: input.sourceRecordId,
    messageKind,
    sourceMessageId: ids.messageId,
    exactMessage: input.exactText,
    deliveryIdempotencyKey: input.idempotencyKey,
    targetAgentId: input.targetAgentId,
    laneOrdinal,
    taskExecutionAuthorityId: input.taskExecutionAuthorityId,
    consultExecutionId: input.consultExecutionId,
    adapterConfigRevisionId: input.adapterConfigRevisionId,
    contextEpoch: input.contextEpoch,
    historyViewId: ids.historyViewId,
    inputId,
    counterpartTaskId: input.counterpartTaskId ?? null,
    counterpartAuthorityId: input.counterpartAuthorityId ?? null,
    counterpartOwnershipEpoch: input.counterpartOwnershipEpoch ?? null,
    consultCallerRefId: input.consultCallerRefId ?? null,
    consultChainToken: input.consultChainToken ?? null,
    disposition: "active" as const,
    invalidationReason: null,
  };
}

export async function reserveTaskExecutionLaneOrdinalInTransaction(
  transaction: TaskSessionDbTransaction,
  input: Pick<
    admissionCore.DispatchExecutionScope,
    "companyId" | "taskId" | "ownershipEpoch" | "targetAgentId"
  >,
  now: Date,
): Promise<number> {
  const rows = await transaction
    .insert(taskExecutionLanes)
    .values({
      companyId: input.companyId,
      taskId: input.taskId,
      ownershipEpoch: input.ownershipEpoch,
      targetAgentId: input.targetAgentId,
      nextOrdinal: 1,
      activeOrdinal: null,
      activeLeaseGeneration: null,
      activeLeaseId: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        taskExecutionLanes.companyId,
        taskExecutionLanes.taskId,
        taskExecutionLanes.ownershipEpoch,
        taskExecutionLanes.targetAgentId,
      ],
      set: {
        nextOrdinal: sql`${taskExecutionLanes.nextOrdinal} + 1`,
        updatedAt: now,
      },
      setWhere: lt(taskExecutionLanes.nextOrdinal, Number.MAX_SAFE_INTEGER),
    })
    .returning({ nextOrdinal: taskExecutionLanes.nextOrdinal });
  const laneOrdinal = (rows[0]?.nextOrdinal ?? 0) - 1;
  if (!Number.isSafeInteger(laneOrdinal) || laneOrdinal < 0) {
    throw new TaskSessionInvariantError("Task execution lane did not reserve one canonical FIFO ordinal");
  }
  return laneOrdinal;
}

export function buildView(
  input: admissionCore.DispatchExecutionScope,
  ids: admissionCore.StableIdentity,
  contextEpochBaselineSeq: number,
  sourceInputId: string | null,
) {
  return {
    id: ids.historyViewId,
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    refId: ids.refId,
    executionLineageId: input.executionLineageId ?? ids.executionLineageId,
    state: "empty" as const,
    compositionDepth: "none" as const,
    contextEpoch: input.contextEpoch,
    contextEpochBaselineSeq,
    compositionPreparationId: null,
    compositionBytes: null,
    compositionHash: null,
    sourceMessageId: ids.messageId,
    sourceInputId,
    invalidationReason: null,
    invalidatedAt: null,
    finalizedAt: null,
  };
}

export function sourceEnvelope(
  input: {
    companyId: string;
    taskId: string;
    sessionId: string;
    sourceKind: string;
    immutableSourceKey: string;
    sourceRecordId: string;
  },
  ids: admissionCore.StableIdentity,
  identityDigest: string,
  eventTimestamp: Date,
  execution?: Pick<
    admissionCore.DispatchExecutionScope,
    "ownershipEpoch" | "targetAgentId" | "adapterConfigRevisionId"
  >,
  comment: admissionCore.TaskSessionProjectedCommentSource | null = null,
) {
  const producingRun =
    comment && comment.producingRun !== null
      ? {
          runId: comment.producingRun.runId,
          agentId: comment.author.agentId,
          adapterConfigRevisionId: comment.producingRun.adapterConfigRevisionId,
        }
      : null;
  return {
    id: ids.eventId,
    companyId: input.companyId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    runId: producingRun?.runId ?? null,
    ownershipEpoch: execution?.ownershipEpoch ?? null,
    agentId: producingRun?.agentId ?? execution?.targetAgentId ?? null,
    adapterConfigRevisionId:
      producingRun?.adapterConfigRevisionId ?? execution?.adapterConfigRevisionId ?? null,
    sourceKind: input.sourceKind,
    sourceId: ids.sourceId,
    immutableSourceKey: input.immutableSourceKey,
    sourceRecordId: input.sourceRecordId,
    sourceIdentityDigest: identityDigest,
    createdAt: eventTimestamp,
  };
}

export async function appendAdmissionEvent(
  transaction: TaskSessionDbTransaction,
  input: {
    envelope: ReturnType<typeof sourceEnvelope>;
    seq: number;
    type: TaskSessionEventType;
    data: Record<string, unknown>;
    projection?: PublishTaskSessionEventInput["projection"];
  },
): Promise<admissionCore.EventRow> {
  const { id: _eventId, sessionId: _sessionId, ...envelope } = input.envelope;
  const published = await publishTaskSessionEventInTx(transaction, {
    event: {
      id: input.envelope.id,
      sessionId: input.envelope.sessionId,
      seq: input.seq,
      type: input.type,
      data: input.data,
    },
    envelope,
    projection: input.projection,
  });
  return published.event;
}
