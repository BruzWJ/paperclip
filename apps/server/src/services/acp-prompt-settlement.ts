import { createHash } from "node:crypto";
import type { AcpPromptSettlement } from "@paperclipai/adapter-utils/acpx-runtime";
import {
  acpPromptAccounting,
  agentAdapterConfigRevisions,
  agentRuntimeState,
  companies,
  costEvents,
  taskExecutionAttempts,
  taskExecutionPromptCapabilities,
  taskExecutionPromptSegments,
  taskExecutionRunRefs,
  taskExecutionSessions,
  type Db,
} from "@paperclipai/db";
import {
  addMoneyAmounts,
  agentAdapterAcpConfigurationSchema,
  canonicalizeMoneyAmount,
  TaskSession,
  parseBudgetCurrency,
  settleAcpPromptCost,
  type AcpCostCursor,
  type AcpCostSettlement,
  type BudgetCurrency,
  type TaskExecutionPromptOutcome,
  type TaskExecutionRunStatus,
} from "@paperclipai/shared";
import { and, eq, isNull } from "drizzle-orm";
import {
  budgetService,
  type BudgetEnforcementScope,
} from "./budgets.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";
import { publishTaskSessionEventInTx } from "./task-session/publication.js";
import { lockTaskExecutionRunInTransaction } from "./task-execution-run-service.js";

const TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

export class AcpPromptSettlementRejected extends Error {
  readonly code = "acp_prompt_settlement_rejected";

  constructor(message: string) {
    super(message);
    this.name = "AcpPromptSettlementRejected";
  }
}

interface AcpPromptSettlementCommonIdentity {
  readonly companyId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly adapterConfigRevisionId: string;
}

export type AcpProductivePromptSettlementIdentity =
  | (AcpPromptSettlementCommonIdentity & {
      readonly runKind: "productive" | "consult";
      readonly promptKind: "base";
      readonly refId: string;
      readonly runOrdinal: number;
      readonly segmentOrdinal: 0;
    })
  | (AcpPromptSettlementCommonIdentity & {
      readonly runKind: "productive" | "consult";
      readonly promptKind: "steering";
      readonly refId: string;
      readonly runOrdinal: number;
      readonly segmentOrdinal: number;
    });

export type AcpPromptSettlementIdentity =
  AcpProductivePromptSettlementIdentity;

/**
 * The fixed durable accounting bridge for one already-materialized assistant.
 * The event id/sequence and assistant id must have been reserved in this same
 * transaction before calling the settlement owner.
 */
export interface AcpPromptStepEndedPublication {
  readonly eventId: string;
  readonly eventSeq: number;
  readonly assistantMessageId: string;
  readonly snapshot?: string;
  readonly files?: readonly string[];
}

export interface SettleAcpPromptInTransactionInput {
  readonly identity: AcpPromptSettlementIdentity;
  readonly settlement: AcpPromptSettlement;
  readonly promptSettlementReferenceId: string;
  readonly terminalUsageReference: string;
  readonly terminalStopReference: string;
  readonly stepEnded: AcpPromptStepEndedPublication;
  readonly settledAt: Date;
}

export interface SettledAcpPromptResult {
  readonly promptSettlementReferenceId: string;
  readonly accountingId: string;
  readonly costEventId: string;
  readonly budgetCurrency: BudgetCurrency;
  /**
   * The model identifier only when ACPX exposed a portable selected model.
   * ACP does not require every frontend to publish this metadata.
   */
  readonly selectedModelId: string | null;
  readonly contextTokenLimit: number;
  readonly cost: AcpCostSettlement;
  readonly stepEndedEventId: string;
  /** Enforce only after the caller's outer settlement transaction commits. */
  readonly budgetSuspensionScopes: readonly BudgetEnforcementScope[];
}

type ProductivePromptOwner = {
  readonly attemptId: string | null;
  readonly capabilityConnectionId: string | null;
  readonly capabilityGeneration: number | null;
  readonly promptTransmissionPhase: string;
  readonly protocolSettlementState: string | null;
  readonly settlementVersion: number;
};

type AcpPromptAccountingModel = {
  readonly value: string;
} | null;

function reject(message: string): never {
  throw new AcpPromptSettlementRejected(message);
}

/**
 * ACP reports terminal context occupancy for every settled prompt, but model
 * metadata is an optional ACPX extension. The observed terminal occupancy
 * window is the sole canonical accounting limit.
 */
export function resolveAcpPromptAccountingModel(
  model: AcpPromptAccountingModel,
  occupancySize: number,
): {
  readonly selectedModelId: string | null;
  readonly contextTokenLimit: number;
} {
  const selectedModelId = model?.value ?? null;
  return {
    selectedModelId,
    contextTokenLimit: occupancySize,
  };
}

function requireCanonicalReference(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value !== value.trim()
  ) {
    reject(`${label} must be a nonempty canonical string of at most 500 characters`);
  }
  return value;
}

function assertSettlementInput(input: SettleAcpPromptInTransactionInput): void {
  const identity = input.identity;
  if (
    !Number.isSafeInteger(identity.runOrdinal) ||
    identity.runOrdinal < 0
  ) {
    reject("ACP prompt run ordinal must be a nonnegative safe integer");
  }
  if (
    identity.promptKind === "base" &&
    identity.segmentOrdinal !== 0
  ) {
    reject("ACP base prompt must use segment ordinal zero");
  }
  if (
    identity.promptKind === "steering" &&
    (!Number.isSafeInteger(identity.segmentOrdinal) || identity.segmentOrdinal <= 0)
  ) {
    reject("ACP steering prompt must use a positive safe segment ordinal");
  }
  if (input.settlement.kind !== "protocol_settled") {
    reject("Only a protocol-settled ACP prompt may enter accounting");
  }
  const occupancy = input.settlement.occupancy;
  if (
    !Number.isSafeInteger(occupancy.used) ||
    occupancy.used < 0 ||
    !Number.isSafeInteger(occupancy.size) ||
    occupancy.size <= 0 ||
    occupancy.used > occupancy.size
  ) {
    reject("ACP prompt terminal occupancy is invalid");
  }
  if (!TERMINAL_STOP_REASONS.has(input.settlement.stopReason)) {
    reject("ACP prompt terminal stop reason is invalid");
  }
  requireCanonicalReference(
    input.promptSettlementReferenceId,
    "ACP prompt settlement reference",
  );
  requireCanonicalReference(
    input.terminalUsageReference,
    "ACP terminal usage reference",
  );
  requireCanonicalReference(
    input.terminalStopReference,
    "ACP terminal stop reference",
  );
  if (
    !(input.settledAt instanceof Date) ||
    !Number.isFinite(input.settledAt.getTime()) ||
    input.settledAt.getTime() < 0
  ) {
    reject("ACP prompt settlement timestamp is invalid");
  }
  if (
    typeof input.stepEnded.eventId !== "string" ||
    !input.stepEnded.eventId.startsWith("evt_")
  ) {
    reject("ACP Step.Ended event id is invalid");
  }
  if (
    !Number.isSafeInteger(input.stepEnded.eventSeq) ||
    input.stepEnded.eventSeq < 0
  ) {
    reject("ACP Step.Ended event sequence is invalid");
  }
  requireCanonicalReference(
    input.stepEnded.assistantMessageId,
    "ACP Step.Ended assistant message id",
  );
}

function outcomeForStopReason(
  stopReason: AcpPromptSettlement["stopReason"],
): TaskExecutionPromptOutcome {
  if (stopReason === "refusal") return "refused";
  if (stopReason === "cancelled") return "cancelled";
  return "succeeded";
}

function cursorFromRow(row: {
  readonly costCursorState: "unanchored" | "known" | "unavailable";
  readonly costCursorAmount: string | null;
  readonly costCursorCurrency: string | null;
}): AcpCostCursor {
  if (row.costCursorState === "unanchored") {
    if (row.costCursorAmount !== null || row.costCursorCurrency !== null) {
      reject("Unanchored ACP cost cursor contains a value");
    }
    return { state: "unanchored" };
  }
  if (row.costCursorState === "unavailable") {
    if (row.costCursorAmount !== null || row.costCursorCurrency !== null) {
      reject("Unavailable ACP cost cursor contains a value");
    }
    return { state: "unavailable" };
  }
  if (row.costCursorAmount === null || row.costCursorCurrency === null) {
    reject("Known ACP cost cursor is incomplete");
  }
  return {
    state: "known",
    amount: canonicalizeMoneyAmount(row.costCursorAmount),
    currency: parseBudgetCurrency(row.costCursorCurrency),
  };
}

function costCursorColumns(cursor: Exclude<AcpCostCursor, { state: "unanchored" }>) {
  return cursor.state === "known"
    ? {
        costCursorState: "known" as const,
        costCursorAmount: cursor.amount,
        costCursorCurrency: cursor.currency,
      }
    : {
        costCursorState: "unavailable" as const,
        costCursorAmount: null,
        costCursorCurrency: null,
      };
}

function auditCursorColumns(cursor: AcpCostCursor) {
  return cursor.state === "known"
    ? {
        state: cursor.state,
        amount: cursor.amount,
        currency: cursor.currency,
      }
    : { state: cursor.state, amount: null, currency: null };
}

function donorStepCost(cost: AcpCostSettlement): number | null {
  if (cost.kind !== "known") return null;
  // The adopted Session event codec intentionally retains its finite-number
  // cost field. MoneyAmount remains authoritative in cost_events; this value
  // is only the conditional donor projection required by Step.Ended.3.
  const projected = Number(cost.knownDeltaAmount);
  if (!Number.isFinite(projected) || projected < 0) {
    reject("Known ACP prompt cost cannot enter the finite Session projection");
  }
  return projected;
}

function sourceIdentityDigest(input: {
  readonly identity: AcpPromptSettlementIdentity;
  readonly promptSettlementReferenceId: string;
  readonly accountingId: string;
  readonly costEventId: string;
  readonly eventId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "acp_prompt_settlement",
        companyId: input.identity.companyId,
        taskId: input.identity.taskId,
        sessionId: input.identity.sessionId,
        runId: input.identity.runId,
        runKind: input.identity.runKind,
        promptKind: input.identity.promptKind,
        refId: input.identity.refId,
        runOrdinal: input.identity.runOrdinal,
        segmentOrdinal: input.identity.segmentOrdinal,
        promptSettlementReferenceId: input.promptSettlementReferenceId,
        accountingId: input.accountingId,
        costEventId: input.costEventId,
        eventId: input.eventId,
      }),
    )
    .digest("hex");
}

async function lockProductivePromptOwner(
  transaction: TaskSessionDbTransaction,
  identity: AcpProductivePromptSettlementIdentity,
): Promise<ProductivePromptOwner> {
  const owner = identity.promptKind === "base"
    ? await transaction
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
        .then((rows) => rows[0] ?? null)
    : await transaction
        .select({
          attemptId: taskExecutionPromptSegments.attemptId,
          capabilityConnectionId:
            taskExecutionPromptSegments.capabilityConnectionId,
          capabilityGeneration: taskExecutionPromptSegments.capabilityGeneration,
          promptTransmissionPhase:
            taskExecutionPromptSegments.promptTransmissionPhase,
          protocolSettlementState:
            taskExecutionPromptSegments.protocolSettlementState,
          settlementVersion: taskExecutionPromptSegments.settlementVersion,
        })
        .from(taskExecutionPromptSegments)
        .where(
          and(
            eq(taskExecutionPromptSegments.companyId, identity.companyId),
            eq(taskExecutionPromptSegments.taskId, identity.taskId),
            eq(taskExecutionPromptSegments.sessionId, identity.sessionId),
            eq(taskExecutionPromptSegments.runId, identity.runId),
            eq(taskExecutionPromptSegments.refId, identity.refId),
            eq(taskExecutionPromptSegments.refOrdinal, identity.runOrdinal),
            eq(
              taskExecutionPromptSegments.segmentOrdinal,
              identity.segmentOrdinal,
            ),
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

async function lockProductiveCostCursor(
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
        eq(
          taskExecutionPromptCapabilities.capabilityConnectionId,
          owner.capabilityConnectionId!,
        ),
        eq(
          taskExecutionPromptCapabilities.capabilityGeneration,
          owner.capabilityGeneration!,
        ),
        eq(taskExecutionPromptCapabilities.companyId, identity.companyId),
        eq(taskExecutionPromptCapabilities.taskId, identity.taskId),
        eq(taskExecutionPromptCapabilities.runId, identity.runId),
        eq(taskExecutionPromptCapabilities.refId, identity.refId),
        eq(taskExecutionPromptCapabilities.refOrdinal, identity.runOrdinal),
        eq(
          taskExecutionPromptCapabilities.segmentOrdinal,
          identity.segmentOrdinal,
        ),
        eq(taskExecutionPromptCapabilities.attemptId, identity.attemptId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !capability ||
    capability.state !== "active" ||
    capability.targetSessionCorrelationId === null
  ) {
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
        eq(
          taskExecutionSessions.adapterConfigIdentity,
          identity.adapterConfigRevisionId,
        ),
        eq(
          taskExecutionSessions.workspaceIdentity,
          run.executionWorkspaceBindingId,
        ),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!correlation) {
    reject("ACP productive prompt native correlation is missing");
  }
  const eligibleCarry =
    correlation.purpose === "carry" &&
    correlation.state === "eligible" &&
    correlation.laneKind === run.executionMode;
  const currentSteering =
    correlation.purpose === "active_run_steering" &&
    correlation.state === "current" &&
    correlation.runId === identity.runId &&
    correlation.currentRefId === identity.refId &&
    correlation.currentRefOrdinal === identity.runOrdinal &&
    correlation.currentSegmentOrdinal === identity.segmentOrdinal;
  if (!eligibleCarry && !currentSteering) {
    reject("ACP productive prompt native correlation is not current for this prompt");
  }
  return {
    correlationId: correlation.id,
    cursorBefore: cursorFromRow(correlation),
  };
}

async function updateRuntimeState(
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
  const currentKnown = canonicalizeMoneyAmount(
    existing.aggregateKnownCostAmount,
  );
  const aggregateKnownCostAmount = input.cost.kind === "known"
    ? addMoneyAmounts(currentKnown, input.cost.knownDeltaAmount)
    : currentKnown;
  const currentUnpriced = existing.unpricedPromptCount;
  if (!Number.isSafeInteger(currentUnpriced) || currentUnpriced < 0) {
    reject("Agent runtime unpriced-prompt aggregate is invalid");
  }
  if (input.cost.kind === "unavailable" && currentUnpriced === Number.MAX_SAFE_INTEGER) {
    reject("Agent runtime unpriced-prompt aggregate is exhausted");
  }
  const unpricedPromptCount =
    currentUnpriced + (input.cost.kind === "unavailable" ? 1 : 0);
  const peakContextUsedTokens = Math.max(
    existing.peakContextUsedTokens,
    input.contextUsedTokens,
  );
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

async function settlePromptOwner(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: AcpPromptSettlementIdentity;
    readonly outcome: TaskExecutionPromptOutcome;
    readonly promptSettlementReferenceId: string;
    readonly accountingId: string;
    readonly costEventId: string;
    readonly terminalSessionMessageId: string;
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
  if (input.identity.promptKind === "base") {
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
    if (!rows[0]) reject("ACP base prompt settlement lost its current owner");
    return;
  }
  const rows = await transaction
    .update(taskExecutionPromptSegments)
    .set({
      ...values,
      steeringState: "protocol_settled",
      outcome: input.outcome,
      outcomeReferenceId: input.promptSettlementReferenceId,
      terminalSessionMessageId: input.terminalSessionMessageId,
    })
    .where(
      and(
        eq(taskExecutionPromptSegments.companyId, input.identity.companyId),
        eq(taskExecutionPromptSegments.taskId, input.identity.taskId),
        eq(taskExecutionPromptSegments.sessionId, input.identity.sessionId),
        eq(taskExecutionPromptSegments.runId, input.identity.runId),
        eq(taskExecutionPromptSegments.refId, input.identity.refId),
        eq(taskExecutionPromptSegments.refOrdinal, input.identity.runOrdinal),
        eq(
          taskExecutionPromptSegments.segmentOrdinal,
          input.identity.segmentOrdinal,
        ),
        eq(taskExecutionPromptSegments.attemptId, input.identity.attemptId),
        eq(
          taskExecutionPromptSegments.promptTransmissionPhase,
          "transmitted",
        ),
        isNull(taskExecutionPromptSegments.protocolSettlementState),
        eq(taskExecutionPromptSegments.settlementVersion, 0),
      ),
    )
    .returning({ runId: taskExecutionPromptSegments.runId });
  if (!rows[0]) reject("ACP steering prompt settlement lost its current owner");
}

/**
 * Sole same-transaction writer for a protocol-settled ACP prompt's stable
 * accounting, cost transition, cursor/runtime aggregates, Step.Ended.3, and
 * productive/steering settlement owner. Incomplete and not-sent
 * paths are intentionally outside this API and must never call it.
 */
export async function settleAcpPromptInTransaction(
  transaction: TaskSessionDbTransaction,
  input: SettleAcpPromptInTransactionInput,
): Promise<SettledAcpPromptResult> {
  assertSettlementInput(input);
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
    reject("ACP prompt run is not the current exact running envelope");
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
    reject("ACP prompt immutable adapter revision is missing");
  }
  const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
    revision.acpConfiguration,
  );
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
  if (!attempt) reject("ACP prompt attempt is not the exact running attempt");

  // ACP's terminal occupancy is the only canonical context-window observation
  // when a frontend does not expose portable model-limit metadata. Persisting
  // it as the accounting limit preserves the database occupancy invariant
  // without fabricating a catalog limit.
  const { selectedModelId, contextTokenLimit } = resolveAcpPromptAccountingModel(
    acpConfiguration.model,
    settlement.occupancy.size,
  );
  const owner = await lockProductivePromptOwner(transaction, identity);
  const productiveCursor = await lockProductiveCostCursor(
    transaction,
    identity,
    owner,
    run,
  );
  const cursorBefore = productiveCursor.cursorBefore;

  const company = await transaction
    .select({ budgetCurrency: companies.budgetCurrency })
    .from(companies)
    .where(eq(companies.id, identity.companyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!company) reject("ACP prompt company is missing");
  const budgetCurrency = parseBudgetCurrency(company.budgetCurrency);
  const cost = settleAcpPromptCost({
    budgetCurrency,
    cursorBefore,
    observation: settlement.occupancy.cost,
  });
  const before = auditCursorColumns(cursorBefore);
  const after = cost.cursorAfter.state === "known"
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
  if (!accounting) reject("ACP prompt accounting insert failed");

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
  if (!costEvent) reject("ACP prompt cost-event insert failed");

  const budgetSuspensionScopes =
    await budgetService(transaction as unknown as Db)
      .evaluateCostEventInTransaction(costEvent);

  const cursorUpdated = await transaction
    .update(taskExecutionSessions)
    .set({
      lastProtocolSettledRunId: identity.runId,
      lastProtocolSettledRefId: identity.refId,
      lastProtocolSettledRefOrdinal: identity.runOrdinal,
      lastProtocolSettledSegmentOrdinal: identity.segmentOrdinal,
      ...costCursorColumns(cost.cursorAfter),
    })
    .where(
      and(
        eq(taskExecutionSessions.id, productiveCursor.correlationId),
        eq(taskExecutionSessions.companyId, identity.companyId),
        eq(taskExecutionSessions.taskId, identity.taskId),
      ),
    )
    .returning({ id: taskExecutionSessions.id });
  if (!cursorUpdated[0]) reject("ACP prompt cost cursor update lost its owner");

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
  const projectedCost = donorStepCost(cost);
  const stepEndedData = {
    timestamp: input.settledAt.getTime(),
    sessionID: identity.sessionId,
    assistantMessageID: input.stepEnded.assistantMessageId,
    finish: settlement.stopReason,
    ...(projectedCost === null ? {} : { cost: projectedCost }),
    ...(input.stepEnded.snapshot === undefined
      ? {}
      : { snapshot: input.stepEnded.snapshot }),
    ...(input.stepEnded.files === undefined
      ? {}
      : { files: [...input.stepEnded.files] }),
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
      sourceIdentityDigest: sourceIdentityDigest({
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
    outcome: outcomeForStopReason(settlement.stopReason),
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
