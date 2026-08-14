import {
  acpPromptAccounting,
  agentAdapterConfigRevisions,
  companies,
  costEvents,
  taskExecutionAttempts,
  taskExecutionSessions,
  type Db,
} from "@paperclipai/db";
import {
  agentAdapterAcpConfigurationSchema,
  TaskSession,
  parseBudgetCurrency,
  settleAcpPromptCost,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { budgetService } from "./budgets.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { publishTaskSessionEventInTx } from "./task-session/publication.js";
import { lockTaskExecutionRunInTransaction } from "./task-execution-run-service.js";
import * as settlementModule from "./acp-prompt-settlement-contracts.js";
import {
  lockProductiveCostCursor,
  lockProductivePromptOwner,
  settlePromptOwner,
  updateRuntimeState,
} from "./acp-prompt-settlement-locking.js";

/**
 * Sole same-transaction writer for a protocol-settled ACP prompt's stable
 * accounting, cost transition, cursor/runtime aggregates, Step.Ended.3, and
 * productive/steering settlement owner. Incomplete and not-sent
 * paths are intentionally outside this API and must never call it.
 */
export async function settleAcpPromptInTransaction(
  transaction: TaskSessionDbTransaction,
  input: settlementModule.SettleAcpPromptInTransactionInput,
): Promise<settlementModule.SettledAcpPromptResult> {
  settlementModule.assertSettlementInput(input);
  const { identity, settlement } = input;

  const run = await lockTaskExecutionRunInTransaction(transaction, identity);
  if (
    run.kind !== identity.runKind ||
    run.status !== "running" ||
    run.sessionId !== identity.sessionId ||
    run.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
    run.currentAttemptId !== identity.attemptId ||
    run.targetAgentId !== identity.agentId
  ) {
    settlementModule.reject("ACP prompt run is not the current exact running envelope");
  }

  const revision = await transaction
    .select({
      agentId: agentAdapterConfigRevisions.agentId,
      acpConfiguration: agentAdapterConfigRevisions.acpConfiguration,
    })
    .from(agentAdapterConfigRevisions)
    .where(
      and(
        eq(agentAdapterConfigRevisions.id, identity.adapterConfigRevisionId),
        eq(agentAdapterConfigRevisions.companyId, identity.companyId),
        eq(agentAdapterConfigRevisions.agentId, identity.agentId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!revision) {
    settlementModule.reject("ACP prompt immutable adapter revision is missing");
  }
  const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(revision.acpConfiguration);
  const attempt = await transaction
    .select({ id: taskExecutionAttempts.id })
    .from(taskExecutionAttempts)
    .where(
      and(
        eq(taskExecutionAttempts.id, identity.attemptId),
        eq(taskExecutionAttempts.companyId, identity.companyId),
        eq(taskExecutionAttempts.taskId, identity.taskId),
        eq(taskExecutionAttempts.sessionId, identity.sessionId),
        eq(taskExecutionAttempts.runId, identity.runId),
        eq(taskExecutionAttempts.runKind, identity.runKind),
        eq(taskExecutionAttempts.promptKind, identity.promptKind),
        eq(taskExecutionAttempts.state, "running"),
        eq(taskExecutionAttempts.refId, identity.refId),
        eq(taskExecutionAttempts.refOrdinal, identity.runOrdinal),
        eq(taskExecutionAttempts.segmentOrdinal, identity.segmentOrdinal),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!attempt) settlementModule.reject("ACP prompt attempt is not the exact running attempt");

  // ACP's terminal occupancy is the only canonical context-window observation
  // when a frontend does not expose portable model-limit metadata. Persisting
  // it as the accounting limit preserves the database occupancy invariant
  // without fabricating a catalog limit.
  const { selectedModelId, contextTokenLimit } = settlementModule.resolveAcpPromptAccountingModel(
    acpConfiguration.model,
    settlement.occupancy.size,
  );
  const owner = await lockProductivePromptOwner(transaction, identity);
  const productiveCursor = await lockProductiveCostCursor(transaction, identity, owner, run);
  const cursorBefore = productiveCursor.cursorBefore;

  const company = await transaction
    .select({ budgetCurrency: companies.budgetCurrency })
    .from(companies)
    .where(eq(companies.id, identity.companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!company) settlementModule.reject("ACP prompt company is missing");
  const budgetCurrency = parseBudgetCurrency(company.budgetCurrency);
  const cost = settleAcpPromptCost({
    budgetCurrency,
    cursorBefore,
    observation: settlement.occupancy.cost,
  });
  const before = settlementModule.auditCursorColumns(cursorBefore);
  const after =
    cost.cursorAfter.state === "known"
      ? {
          state: "known" as const,
          amount: cost.cursorAfter.amount,
          currency: cost.cursorAfter.currency,
        }
      : { state: "unavailable" as const, amount: null, currency: null };

  const accounting = await transaction
    .insert(acpPromptAccounting)
    .values({
      companyId: identity.companyId,
      taskId: identity.taskId,
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      runId: identity.runId,
      runKind: identity.runKind,
      promptKind: identity.promptKind,
      refId: identity.refId,
      runOrdinal: identity.runOrdinal,
      segmentOrdinal: identity.segmentOrdinal,
      attemptId: identity.attemptId,
      adapterConfigRevisionId: identity.adapterConfigRevisionId,
      selectedModelId,
      contextTokenLimit,
      contextUsedTokens: settlement.occupancy.used,
      contextWindowTokens: settlement.occupancy.size,
      promptSettlementReferenceId: input.promptSettlementReferenceId,
      terminalUsageReference: input.terminalUsageReference,
      terminalStopReference: input.terminalStopReference,
      settledAt: input.settledAt,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!accounting) settlementModule.reject("ACP prompt accounting insert failed");

  const costEvent = await transaction
    .insert(costEvents)
    .values({
      accountingId: accounting.id,
      companyId: identity.companyId,
      taskId: identity.taskId,
      agentId: identity.agentId,
      runId: identity.runId,
      runKind: identity.runKind,
      promptKind: identity.promptKind,
      refId: identity.refId,
      runOrdinal: identity.runOrdinal,
      segmentOrdinal: identity.segmentOrdinal,
      budgetCurrency,
      kind: cost.kind,
      unavailableReason: cost.unavailableReason,
      observedCumulativeAmount: cost.observedCumulativeAmount,
      observedCurrency: cost.observedCurrency,
      knownDeltaAmount: cost.knownDeltaAmount,
      cursorBeforeState: before.state,
      cursorBeforeAmount: before.amount,
      cursorBeforeCurrency: before.currency,
      cursorAfterState: after.state,
      cursorAfterAmount: after.amount,
      cursorAfterCurrency: after.currency,
      occurredAt: input.settledAt,
    })
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!costEvent) settlementModule.reject("ACP prompt cost-event insert failed");

  const budgetSuspensionScopes = await budgetService(
    transaction as unknown as Db,
  ).evaluateCostEventInTransaction(costEvent);

  const cursorUpdated = await transaction
    .update(taskExecutionSessions)
    .set({
      lastProtocolSettledRunId: identity.runId,
      lastProtocolSettledRefId: identity.refId,
      lastProtocolSettledRefOrdinal: identity.runOrdinal,
      lastProtocolSettledSegmentOrdinal: identity.segmentOrdinal,
      ...settlementModule.costCursorColumns(cost.cursorAfter),
    })
    .where(
      and(
        eq(taskExecutionSessions.id, productiveCursor.correlationId),
        eq(taskExecutionSessions.companyId, identity.companyId),
        eq(taskExecutionSessions.taskId, identity.taskId),
      ),
    )
    .returning({ id: taskExecutionSessions.id });
  if (!cursorUpdated[0]) settlementModule.reject("ACP prompt cost cursor update lost its owner");

  await updateRuntimeState(transaction, {
    identity,
    runStatus: run.status,
    contextUsedTokens: settlement.occupancy.used,
    contextWindowTokens: settlement.occupancy.size,
    cost,
    settledAt: input.settledAt,
  });

  const immutableSourceKey = [
    "acp_prompt_settlement",
    identity.runId,
    identity.promptKind,
    `${identity.refId}:${identity.runOrdinal}:${identity.segmentOrdinal}`,
    input.promptSettlementReferenceId,
  ].join(":");
  const projectedCost = settlementModule.donorStepCost(cost);
  const stepEndedData = {
    timestamp: input.settledAt.getTime(),
    sessionID: identity.sessionId,
    assistantMessageID: input.stepEnded.assistantMessageId,
    finish: settlement.stopReason,
    ...(projectedCost === null ? {} : { cost: projectedCost }),
    ...(input.stepEnded.snapshot === undefined ? {} : { snapshot: input.stepEnded.snapshot }),
    ...(input.stepEnded.files === undefined ? {} : { files: [...input.stepEnded.files] }),
  };
  await publishTaskSessionEventInTx(transaction, {
    event: {
      id: input.stepEnded.eventId,
      sessionId: identity.sessionId,
      seq: input.stepEnded.eventSeq,
      type: TaskSession.Event.Step.Ended.type,
      data: stepEndedData,
    },
    envelope: {
      companyId: identity.companyId,
      taskId: identity.taskId,
      runId: identity.runId,
      ownershipEpoch: run.ownershipEpoch,
      agentId: identity.agentId,
      adapterConfigRevisionId: identity.adapterConfigRevisionId,
      sourceKind: "acp_prompt_settlement",
      sourceId: input.promptSettlementReferenceId,
      immutableSourceKey,
      sourceRecordId: accounting.id,
      sourceIdentityDigest: settlementModule.sourceIdentityDigest({
        identity,
        promptSettlementReferenceId: input.promptSettlementReferenceId,
        accountingId: accounting.id,
        costEventId: costEvent.id,
        eventId: input.stepEnded.eventId,
      }),
      createdAt: input.settledAt,
    },
  });

  await settlePromptOwner(transaction, {
    identity,
    outcome: settlementModule.outcomeForStopReason(settlement.stopReason),
    promptSettlementReferenceId: input.promptSettlementReferenceId,
    accountingId: accounting.id,
    costEventId: costEvent.id,
    terminalSessionMessageId: input.stepEnded.assistantMessageId,
    settledAt: input.settledAt,
  });

  return {
    promptSettlementReferenceId: input.promptSettlementReferenceId,
    accountingId: accounting.id,
    costEventId: costEvent.id,
    budgetCurrency,
    selectedModelId,
    contextTokenLimit,
    cost,
    stepEndedEventId: input.stepEnded.eventId,
    budgetSuspensionScopes,
  };
}
