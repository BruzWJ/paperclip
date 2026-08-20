import {
  agentRuntimeState,
  taskExecutionPromptCapabilities,
  taskExecutionRunRefs,
  taskExecutionSessions,
} from "@paperclipai/db";
import {
  addMoneyAmounts,
  canonicalizeMoneyAmount,
  type AcpCostCursor,
  type AcpCostSettlement,
  type TaskExecutionPromptOutcome,
  type TaskExecutionRunStatus,
} from "@paperclipai/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import {
  type AcpProductivePromptSettlementIdentity,
  type AcpPromptSettlementIdentity,
  cursorFromRow,
  type ProductivePromptOwner,
  reject,
} from "./acp-prompt-settlement-contracts.js";

export async function lockProductivePromptOwner(
  transaction: TaskSessionDbTransaction,
  identity: AcpProductivePromptSettlementIdentity,
): Promise<ProductivePromptOwner> {
  const owner = await transaction
    .select({
      attemptId: taskExecutionRunRefs.attemptId,
      capabilityConnectionId: taskExecutionRunRefs.capabilityConnectionId,
      capabilityGeneration: taskExecutionRunRefs.capabilityGeneration,
      promptTransmissionPhase: taskExecutionRunRefs.promptTransmissionPhase,
      protocolSettlementState: taskExecutionRunRefs.protocolSettlementState,
      settlementVersion: taskExecutionRunRefs.settlementVersion,
    })
    .from(taskExecutionRunRefs)
    .where(
      and(
        eq(taskExecutionRunRefs.companyId, identity.companyId),
        eq(taskExecutionRunRefs.taskId, identity.taskId),
        eq(taskExecutionRunRefs.sessionId, identity.sessionId),
        eq(taskExecutionRunRefs.runId, identity.runId),
        eq(taskExecutionRunRefs.refId, identity.refId),
        eq(taskExecutionRunRefs.refOrdinal, identity.runOrdinal),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !owner ||
    owner.attemptId !== identity.attemptId ||
    owner.promptTransmissionPhase !== "transmitted" ||
    owner.protocolSettlementState !== null ||
    owner.settlementVersion !== 0 ||
    owner.capabilityConnectionId === null ||
    owner.capabilityGeneration === null
  ) {
    reject("ACP productive prompt owner is not the current transmitted prompt");
  }
  return owner;
}

export async function lockProductiveCostCursor(
  transaction: TaskSessionDbTransaction,
  identity: AcpProductivePromptSettlementIdentity,
  owner: ProductivePromptOwner,
  run: {
    readonly ownershipEpoch: number;
    readonly executionWorkspaceBindingId: string;
    readonly executionMode: "owner" | "consult";
  },
): Promise<{
  readonly correlationId: string;
  readonly cursorBefore: AcpCostCursor;
}> {
  const capability = await transaction
    .select({
      targetSessionCorrelationId: taskExecutionPromptCapabilities.targetSessionCorrelationId,
      state: taskExecutionPromptCapabilities.state,
    })
    .from(taskExecutionPromptCapabilities)
    .where(
      and(
        eq(taskExecutionPromptCapabilities.capabilityConnectionId, owner.capabilityConnectionId!),
        eq(taskExecutionPromptCapabilities.capabilityGeneration, owner.capabilityGeneration!),
        eq(taskExecutionPromptCapabilities.companyId, identity.companyId),
        eq(taskExecutionPromptCapabilities.taskId, identity.taskId),
        eq(taskExecutionPromptCapabilities.runId, identity.runId),
        eq(taskExecutionPromptCapabilities.refId, identity.refId),
        eq(taskExecutionPromptCapabilities.refOrdinal, identity.runOrdinal),
        eq(taskExecutionPromptCapabilities.attemptId, identity.attemptId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!capability || capability.state !== "active" || capability.targetSessionCorrelationId === null) {
    reject("ACP productive prompt has no active exact native correlation");
  }

  const correlation = await transaction
    .select()
    .from(taskExecutionSessions)
    .where(
      and(
        eq(taskExecutionSessions.id, capability.targetSessionCorrelationId),
        eq(taskExecutionSessions.companyId, identity.companyId),
        eq(taskExecutionSessions.taskId, identity.taskId),
        eq(taskExecutionSessions.ownershipEpoch, run.ownershipEpoch),
        eq(taskExecutionSessions.targetAgentId, identity.agentId),
        eq(taskExecutionSessions.adapterConfigIdentity, identity.adapterConfigRevisionId),
        eq(taskExecutionSessions.workspaceIdentity, run.executionWorkspaceBindingId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!correlation) {
    reject("ACP productive prompt native correlation is missing");
  }
  if (correlation.state !== "eligible" || correlation.laneKind !== run.executionMode) {
    reject("ACP productive prompt native correlation is not current for this prompt");
  }
  return {
    correlationId: correlation.id,
    cursorBefore: cursorFromRow(correlation),
  };
}

export async function updateRuntimeState(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: AcpPromptSettlementIdentity;
    readonly runStatus: TaskExecutionRunStatus;
    readonly contextUsedTokens: number;
    readonly contextWindowTokens: number;
    readonly cost: AcpCostSettlement;
    readonly settledAt: Date;
  },
): Promise<void> {
  await transaction
    .insert(agentRuntimeState)
    .values({
      agentId: input.identity.agentId,
      companyId: input.identity.companyId,
    })
    .onConflictDoNothing({ target: agentRuntimeState.agentId });
  const existing = await transaction
    .select()
    .from(agentRuntimeState)
    .where(
      and(
        eq(agentRuntimeState.companyId, input.identity.companyId),
        eq(agentRuntimeState.agentId, input.identity.agentId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!existing) reject("Agent runtime accounting owner is missing");
  const currentKnown = canonicalizeMoneyAmount(existing.aggregateKnownCostAmount);
  const aggregateKnownCostAmount =
    input.cost.kind === "known" ? addMoneyAmounts(currentKnown, input.cost.knownDeltaAmount) : currentKnown;
  const currentUnpriced = existing.unpricedPromptCount;
  if (!Number.isSafeInteger(currentUnpriced) || currentUnpriced < 0) {
    reject("Agent runtime unpriced-prompt aggregate is invalid");
  }
  if (input.cost.kind === "unavailable" && currentUnpriced === Number.MAX_SAFE_INTEGER) {
    reject("Agent runtime unpriced-prompt aggregate is exhausted");
  }
  const unpricedPromptCount = currentUnpriced + (input.cost.kind === "unavailable" ? 1 : 0);
  const peakContextUsedTokens = Math.max(existing.peakContextUsedTokens, input.contextUsedTokens);
  const values = {
    companyId: input.identity.companyId,
    lastRunId: input.identity.runId,
    lastRunStatus: input.runStatus,
    lastContextUsedTokens: input.contextUsedTokens,
    lastContextWindowTokens: input.contextWindowTokens,
    peakContextUsedTokens,
    aggregateKnownCostAmount,
    unpricedPromptCount,
    updatedAt: input.settledAt,
  };
  const updated = await transaction
    .update(agentRuntimeState)
    .set(values)
    .where(
      and(
        eq(agentRuntimeState.companyId, input.identity.companyId),
        eq(agentRuntimeState.agentId, input.identity.agentId),
      ),
    )
    .returning({ agentId: agentRuntimeState.agentId });
  if (!updated[0]) reject("Agent runtime accounting update lost its owner");
}

export async function settlePromptOwner(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: AcpPromptSettlementIdentity;
    readonly outcome: TaskExecutionPromptOutcome;
    readonly promptSettlementReferenceId: string;
    readonly accountingId: string;
    readonly costEventId: string;
    readonly settledAt: Date;
  },
): Promise<void> {
  const values = {
    protocolSettlementState: "settled" as const,
    accountingId: input.accountingId,
    costEventId: input.costEventId,
    settlementVersion: 1,
    settledAt: input.settledAt,
  };
  const rows = await transaction
    .update(taskExecutionRunRefs)
    .set({
      ...values,
      outcome: input.outcome,
      outcomeReferenceId: input.promptSettlementReferenceId,
    })
    .where(
      and(
        eq(taskExecutionRunRefs.companyId, input.identity.companyId),
        eq(taskExecutionRunRefs.taskId, input.identity.taskId),
        eq(taskExecutionRunRefs.sessionId, input.identity.sessionId),
        eq(taskExecutionRunRefs.runId, input.identity.runId),
        eq(taskExecutionRunRefs.refId, input.identity.refId),
        eq(taskExecutionRunRefs.refOrdinal, input.identity.runOrdinal),
        eq(taskExecutionRunRefs.attemptId, input.identity.attemptId),
        eq(taskExecutionRunRefs.promptTransmissionPhase, "transmitted"),
        isNull(taskExecutionRunRefs.protocolSettlementState),
        eq(taskExecutionRunRefs.settlementVersion, 0),
      ),
    )
    .returning({ runId: taskExecutionRunRefs.runId });
  if (!rows[0]) reject("ACP prompt settlement lost its current owner");
}
