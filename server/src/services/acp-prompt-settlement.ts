import { createHash } from "node:crypto";
import type { AcpPromptSettlement } from "@paperclipai/adapter-utils/acp-subprocess";
import {
  acpPromptAccounting,
  agentAdapterConfigRevisions,
  agentRuntimeState,
  companies,
  costEvents,
  issueExecutionAttempts,
  issueExecutionPromptCapabilities,
  issueExecutionPromptSegments,
  issueExecutionRunRefs,
  issueExecutionSessions,
  issueSessionCompactionControls,
  type Db,
} from "@paperclipai/db";
import {
  addMoneyAmounts,
  agentAdapterAcpConfigurationSchema,
  canonicalizeMoneyAmount,
  IssueSession,
  parseBudgetCurrency,
  settleAcpPromptCost,
  type AcpCostCursor,
  type AcpCostSettlement,
  type BudgetCurrency,
  type IssueExecutionPromptOutcome,
  type IssueExecutionRunStatus,
} from "@paperclipai/shared";
import { and, eq, isNull } from "drizzle-orm";
import {
  budgetService,
  type BudgetEnforcementScope,
} from "./budgets.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import { publishIssueSessionEventInTx } from "./issue-session/publication.js";
import {
  persistedSessionCompactionModelSchema,
} from "./issue-session-compaction-contract.js";
import { lockIssueExecutionRunInTransaction } from "./issue-execution-run-service.js";

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
  readonly issueId: string;
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

export type AcpCompactionPromptSettlementIdentity =
  AcpPromptSettlementCommonIdentity & {
    readonly runKind: "compaction";
    readonly promptKind: "compaction";
    readonly compactionControlId: string;
  };

export type AcpPromptSettlementIdentity =
  | AcpProductivePromptSettlementIdentity
  | AcpCompactionPromptSettlementIdentity;

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
  readonly sourceAssistantErrorKind?: "aborted" | "other";
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
  readonly selectedModelId: string;
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

function reject(message: string): never {
  throw new AcpPromptSettlementRejected(message);
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
    identity.promptKind !== "compaction" &&
    (!Number.isSafeInteger(identity.runOrdinal) || identity.runOrdinal < 0)
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
): IssueExecutionPromptOutcome {
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
        issueId: input.identity.issueId,
        sessionId: input.identity.sessionId,
        runId: input.identity.runId,
        runKind: input.identity.runKind,
        promptKind: input.identity.promptKind,
        refId:
          input.identity.promptKind === "compaction"
            ? null
            : input.identity.refId,
        runOrdinal:
          input.identity.promptKind === "compaction"
            ? null
            : input.identity.runOrdinal,
        segmentOrdinal:
          input.identity.promptKind === "compaction"
            ? null
            : input.identity.segmentOrdinal,
        compactionControlId:
          input.identity.promptKind === "compaction"
            ? input.identity.compactionControlId
            : null,
        promptSettlementReferenceId: input.promptSettlementReferenceId,
        accountingId: input.accountingId,
        costEventId: input.costEventId,
        eventId: input.eventId,
      }),
    )
    .digest("hex");
}

async function lockProductivePromptOwner(
  transaction: IssueSessionDbTransaction,
  identity: AcpProductivePromptSettlementIdentity,
): Promise<ProductivePromptOwner> {
  const owner = identity.promptKind === "base"
    ? await transaction
        .select({
          attemptId: issueExecutionRunRefs.attemptId,
          capabilityConnectionId: issueExecutionRunRefs.capabilityConnectionId,
          capabilityGeneration: issueExecutionRunRefs.capabilityGeneration,
          promptTransmissionPhase: issueExecutionRunRefs.promptTransmissionPhase,
          protocolSettlementState: issueExecutionRunRefs.protocolSettlementState,
          settlementVersion: issueExecutionRunRefs.settlementVersion,
        })
        .from(issueExecutionRunRefs)
        .where(
          and(
            eq(issueExecutionRunRefs.companyId, identity.companyId),
            eq(issueExecutionRunRefs.issueId, identity.issueId),
            eq(issueExecutionRunRefs.sessionId, identity.sessionId),
            eq(issueExecutionRunRefs.runId, identity.runId),
            eq(issueExecutionRunRefs.refId, identity.refId),
            eq(issueExecutionRunRefs.refOrdinal, identity.runOrdinal),
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null)
    : await transaction
        .select({
          attemptId: issueExecutionPromptSegments.attemptId,
          capabilityConnectionId:
            issueExecutionPromptSegments.capabilityConnectionId,
          capabilityGeneration: issueExecutionPromptSegments.capabilityGeneration,
          promptTransmissionPhase:
            issueExecutionPromptSegments.promptTransmissionPhase,
          protocolSettlementState:
            issueExecutionPromptSegments.protocolSettlementState,
          settlementVersion: issueExecutionPromptSegments.settlementVersion,
        })
        .from(issueExecutionPromptSegments)
        .where(
          and(
            eq(issueExecutionPromptSegments.companyId, identity.companyId),
            eq(issueExecutionPromptSegments.issueId, identity.issueId),
            eq(issueExecutionPromptSegments.sessionId, identity.sessionId),
            eq(issueExecutionPromptSegments.runId, identity.runId),
            eq(issueExecutionPromptSegments.refId, identity.refId),
            eq(issueExecutionPromptSegments.refOrdinal, identity.runOrdinal),
            eq(
              issueExecutionPromptSegments.segmentOrdinal,
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

async function lockCompactionPromptOwner(
  transaction: IssueSessionDbTransaction,
  identity: AcpCompactionPromptSettlementIdentity,
): Promise<unknown> {
  const owner = await transaction
    .select({
      promptTransmissionPhase:
        issueSessionCompactionControls.promptTransmissionPhase,
      protocolSettlementState:
        issueSessionCompactionControls.protocolSettlementState,
      promptSettlementReferenceId:
        issueSessionCompactionControls.promptSettlementReferenceId,
      accountingId: issueSessionCompactionControls.accountingId,
      costEventId: issueSessionCompactionControls.costEventId,
      settlementVersion: issueSessionCompactionControls.settlementVersion,
      modelSnapshot: issueSessionCompactionControls.modelSnapshot,
    })
    .from(issueSessionCompactionControls)
    .where(
      and(
        eq(issueSessionCompactionControls.id, identity.compactionControlId),
        eq(issueSessionCompactionControls.companyId, identity.companyId),
        eq(issueSessionCompactionControls.issueId, identity.issueId),
        eq(issueSessionCompactionControls.sessionId, identity.sessionId),
        eq(issueSessionCompactionControls.kind, "recovery-prompt"),
        eq(issueSessionCompactionControls.disposition, "active"),
        eq(issueSessionCompactionControls.compactionRunId, identity.runId),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (
    !owner ||
    owner.promptTransmissionPhase !== "transmitted" ||
    owner.protocolSettlementState !== null ||
    owner.promptSettlementReferenceId !== null ||
    owner.accountingId !== null ||
    owner.costEventId !== null ||
    owner.settlementVersion !== 0
  ) {
    reject("ACP compaction prompt control is not the current transmitted prompt");
  }
  return owner.modelSnapshot;
}

/**
 * Compaction is the one prompt branch whose immutable selected model may
 * intentionally differ from the productive adapter revision. Its locked
 * recovery-prompt snapshot therefore owns accounting attribution and the
 * occupancy-size fence; productive/steering remain revision-derived.
 */
export function resolveAcpPromptSettlementModel(input: {
  readonly promptKind: "base" | "steering" | "compaction";
  readonly revisionModelId: string;
  readonly revisionContextTokenLimit: number;
  readonly compactionModelSnapshot?: unknown;
}): { readonly selectedModelId: string; readonly contextTokenLimit: number } {
  if (input.promptKind !== "compaction") {
    return {
      selectedModelId: input.revisionModelId,
      contextTokenLimit: input.revisionContextTokenLimit,
    };
  }
  const model = persistedSessionCompactionModelSchema.safeParse(
    input.compactionModelSnapshot,
  );
  if (!model.success) {
    reject("ACP compaction prompt control lost its immutable model snapshot");
  }
  return {
    selectedModelId: model.data.targetModelId,
    contextTokenLimit: model.data.contextTokenLimit,
  };
}

async function lockProductiveCostCursor(
  transaction: IssueSessionDbTransaction,
  identity: AcpProductivePromptSettlementIdentity,
  owner: ProductivePromptOwner,
  run: {
    readonly ownershipEpoch: number;
    readonly executionWorkspaceBindingId: string;
    readonly executionMode: "owner" | "consult" | null;
  },
): Promise<{
  readonly correlationId: string;
  readonly cursorBefore: AcpCostCursor;
}> {
  const capability = await transaction
    .select({
      targetSessionCorrelationId: issueExecutionPromptCapabilities.targetSessionCorrelationId,
      state: issueExecutionPromptCapabilities.state,
    })
    .from(issueExecutionPromptCapabilities)
    .where(
      and(
        eq(
          issueExecutionPromptCapabilities.capabilityConnectionId,
          owner.capabilityConnectionId!,
        ),
        eq(
          issueExecutionPromptCapabilities.capabilityGeneration,
          owner.capabilityGeneration!,
        ),
        eq(issueExecutionPromptCapabilities.companyId, identity.companyId),
        eq(issueExecutionPromptCapabilities.issueId, identity.issueId),
        eq(issueExecutionPromptCapabilities.runId, identity.runId),
        eq(issueExecutionPromptCapabilities.refId, identity.refId),
        eq(issueExecutionPromptCapabilities.refOrdinal, identity.runOrdinal),
        eq(
          issueExecutionPromptCapabilities.segmentOrdinal,
          identity.segmentOrdinal,
        ),
        eq(issueExecutionPromptCapabilities.attemptId, identity.attemptId),
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
    .from(issueExecutionSessions)
    .where(
      and(
        eq(issueExecutionSessions.id, capability.targetSessionCorrelationId),
        eq(issueExecutionSessions.companyId, identity.companyId),
        eq(issueExecutionSessions.issueId, identity.issueId),
        eq(issueExecutionSessions.ownershipEpoch, run.ownershipEpoch),
        eq(issueExecutionSessions.targetAgentId, identity.agentId),
        eq(
          issueExecutionSessions.adapterConfigIdentity,
          identity.adapterConfigRevisionId,
        ),
        eq(
          issueExecutionSessions.workspaceIdentity,
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
  transaction: IssueSessionDbTransaction,
  input: {
    readonly identity: AcpPromptSettlementIdentity;
    readonly runStatus: IssueExecutionRunStatus;
    readonly adapterType: string;
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
      adapterType: input.adapterType,
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
    adapterType: input.adapterType,
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
  transaction: IssueSessionDbTransaction,
  input: {
    readonly identity: AcpPromptSettlementIdentity;
    readonly outcome: IssueExecutionPromptOutcome;
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
      .update(issueExecutionRunRefs)
      .set({
        ...values,
        outcome: input.outcome,
        outcomeReferenceId: input.promptSettlementReferenceId,
      })
      .where(
        and(
          eq(issueExecutionRunRefs.companyId, input.identity.companyId),
          eq(issueExecutionRunRefs.issueId, input.identity.issueId),
          eq(issueExecutionRunRefs.sessionId, input.identity.sessionId),
          eq(issueExecutionRunRefs.runId, input.identity.runId),
          eq(issueExecutionRunRefs.refId, input.identity.refId),
          eq(issueExecutionRunRefs.refOrdinal, input.identity.runOrdinal),
          eq(issueExecutionRunRefs.attemptId, input.identity.attemptId),
          eq(issueExecutionRunRefs.promptTransmissionPhase, "transmitted"),
          isNull(issueExecutionRunRefs.protocolSettlementState),
          eq(issueExecutionRunRefs.settlementVersion, 0),
        ),
      )
      .returning({ runId: issueExecutionRunRefs.runId });
    if (!rows[0]) reject("ACP base prompt settlement lost its current owner");
    return;
  }
  if (input.identity.promptKind === "steering") {
    const rows = await transaction
      .update(issueExecutionPromptSegments)
      .set({
        ...values,
        steeringState: "protocol_settled",
        outcome: input.outcome,
        outcomeReferenceId: input.promptSettlementReferenceId,
        terminalSessionMessageId: input.terminalSessionMessageId,
      })
      .where(
        and(
          eq(issueExecutionPromptSegments.companyId, input.identity.companyId),
          eq(issueExecutionPromptSegments.issueId, input.identity.issueId),
          eq(issueExecutionPromptSegments.sessionId, input.identity.sessionId),
          eq(issueExecutionPromptSegments.runId, input.identity.runId),
          eq(issueExecutionPromptSegments.refId, input.identity.refId),
          eq(issueExecutionPromptSegments.refOrdinal, input.identity.runOrdinal),
          eq(
            issueExecutionPromptSegments.segmentOrdinal,
            input.identity.segmentOrdinal,
          ),
          eq(issueExecutionPromptSegments.attemptId, input.identity.attemptId),
          eq(
            issueExecutionPromptSegments.promptTransmissionPhase,
            "transmitted",
          ),
          isNull(issueExecutionPromptSegments.protocolSettlementState),
          eq(issueExecutionPromptSegments.settlementVersion, 0),
        ),
      )
      .returning({ runId: issueExecutionPromptSegments.runId });
    if (!rows[0]) reject("ACP steering prompt settlement lost its current owner");
    return;
  }
  const rows = await transaction
    .update(issueSessionCompactionControls)
    .set({
      ...values,
      promptSettlementReferenceId: input.promptSettlementReferenceId,
    })
    .where(
      and(
        eq(issueSessionCompactionControls.id, input.identity.compactionControlId),
        eq(issueSessionCompactionControls.companyId, input.identity.companyId),
        eq(issueSessionCompactionControls.issueId, input.identity.issueId),
        eq(issueSessionCompactionControls.sessionId, input.identity.sessionId),
        eq(issueSessionCompactionControls.kind, "recovery-prompt"),
        eq(issueSessionCompactionControls.disposition, "active"),
        eq(issueSessionCompactionControls.compactionRunId, input.identity.runId),
        eq(issueSessionCompactionControls.promptTransmissionPhase, "transmitted"),
        isNull(issueSessionCompactionControls.protocolSettlementState),
        eq(issueSessionCompactionControls.settlementVersion, 0),
      ),
    )
    .returning({ id: issueSessionCompactionControls.id });
  if (!rows[0]) reject("ACP compaction prompt settlement lost its current control");
}

/**
 * Sole same-transaction writer for a protocol-settled ACP prompt's stable
 * accounting, cost transition, cursor/runtime aggregates, Step.Ended.3, and
 * productive/steering/compaction settlement owner. Incomplete and not-sent
 * paths are intentionally outside this API and must never call it.
 */
export async function settleAcpPromptInTransaction(
  transaction: IssueSessionDbTransaction,
  input: SettleAcpPromptInTransactionInput,
): Promise<SettledAcpPromptResult> {
  assertSettlementInput(input);
  const { identity, settlement } = input;

  const run = await lockIssueExecutionRunInTransaction(transaction, identity);
  if (
    run.kind !== identity.runKind ||
    run.status !== "running" ||
    run.sessionId !== identity.sessionId ||
    run.adapterConfigRevisionId !== identity.adapterConfigRevisionId ||
    run.currentAttemptId !== identity.attemptId ||
    (identity.runKind === "compaction"
      ? run.targetAgentId !== null
      : run.targetAgentId !== identity.agentId)
  ) {
    reject("ACP prompt run is not the current exact running envelope");
  }

  const revision = await transaction
    .select({
      agentId: agentAdapterConfigRevisions.agentId,
      adapterType: agentAdapterConfigRevisions.adapterType,
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
  if (!revision || revision.adapterType.trim().length === 0) {
    reject("ACP prompt immutable adapter revision is missing");
  }
  const acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
    revision.acpConfiguration,
  );
  const attempt = await transaction
    .select({ id: issueExecutionAttempts.id })
    .from(issueExecutionAttempts)
    .where(
      and(
        eq(issueExecutionAttempts.id, identity.attemptId),
        eq(issueExecutionAttempts.companyId, identity.companyId),
        eq(issueExecutionAttempts.issueId, identity.issueId),
        eq(issueExecutionAttempts.sessionId, identity.sessionId),
        eq(issueExecutionAttempts.runId, identity.runId),
        eq(issueExecutionAttempts.runKind, identity.runKind),
        eq(issueExecutionAttempts.promptKind, identity.promptKind),
        eq(issueExecutionAttempts.state, "running"),
        identity.promptKind === "compaction"
          ? and(
              isNull(issueExecutionAttempts.refId),
              isNull(issueExecutionAttempts.refOrdinal),
              isNull(issueExecutionAttempts.segmentOrdinal),
              eq(
                issueExecutionAttempts.compactionControlId,
                identity.compactionControlId,
              ),
            )
          : and(
              eq(issueExecutionAttempts.refId, identity.refId),
              eq(issueExecutionAttempts.refOrdinal, identity.runOrdinal),
              eq(
                issueExecutionAttempts.segmentOrdinal,
                identity.segmentOrdinal,
              ),
              isNull(issueExecutionAttempts.compactionControlId),
            ),
      ),
    )
    .limit(1)
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!attempt) reject("ACP prompt attempt is not the exact running attempt");

  const compactionModelSnapshot = identity.promptKind === "compaction"
    ? await lockCompactionPromptOwner(transaction, identity)
    : undefined;
  const { selectedModelId, contextTokenLimit } =
    resolveAcpPromptSettlementModel({
      promptKind: identity.promptKind,
      revisionModelId: acpConfiguration.model.id,
      revisionContextTokenLimit:
        acpConfiguration.model.limits.contextTokenLimit,
      ...(compactionModelSnapshot === undefined
        ? {}
        : { compactionModelSnapshot }),
    });
  if (settlement.occupancy.size !== contextTokenLimit) {
    reject("ACP terminal occupancy size differs from the immutable prompt model");
  }
  const owner = identity.promptKind === "compaction"
    ? null
    : await lockProductivePromptOwner(transaction, identity);
  const productiveCursor = identity.promptKind === "compaction"
    ? null
    : await lockProductiveCostCursor(transaction, identity, owner!, run);
  const cursorBefore: AcpCostCursor = productiveCursor?.cursorBefore ?? {
    state: "unanchored",
  };

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
      issueId: identity.issueId,
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      runId: identity.runId,
      runKind: identity.runKind,
      promptKind: identity.promptKind,
      refId: identity.promptKind === "compaction" ? null : identity.refId,
      runOrdinal:
        identity.promptKind === "compaction" ? null : identity.runOrdinal,
      segmentOrdinal:
        identity.promptKind === "compaction" ? null : identity.segmentOrdinal,
      compactionControlId:
        identity.promptKind === "compaction"
          ? identity.compactionControlId
          : null,
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
      issueId: identity.issueId,
      agentId: identity.agentId,
      runId: identity.runId,
      runKind: identity.runKind,
      promptKind: identity.promptKind,
      refId: identity.promptKind === "compaction" ? null : identity.refId,
      runOrdinal:
        identity.promptKind === "compaction" ? null : identity.runOrdinal,
      segmentOrdinal:
        identity.promptKind === "compaction" ? null : identity.segmentOrdinal,
      compactionControlId:
        identity.promptKind === "compaction"
          ? identity.compactionControlId
          : null,
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

  if (productiveCursor) {
    if (identity.promptKind === "compaction") {
      reject("Compaction prompt unexpectedly acquired a productive cost cursor");
    }
    const cursorUpdated = await transaction
      .update(issueExecutionSessions)
      .set({
        lastProtocolSettledRunId: identity.runId,
        lastProtocolSettledRefId: identity.refId,
        lastProtocolSettledRefOrdinal: identity.runOrdinal,
        lastProtocolSettledSegmentOrdinal: identity.segmentOrdinal,
        ...costCursorColumns(cost.cursorAfter),
      })
      .where(
        and(
          eq(issueExecutionSessions.id, productiveCursor.correlationId),
          eq(issueExecutionSessions.companyId, identity.companyId),
          eq(issueExecutionSessions.issueId, identity.issueId),
        ),
      )
      .returning({ id: issueExecutionSessions.id });
    if (!cursorUpdated[0]) reject("ACP prompt cost cursor update lost its owner");
  }

  await updateRuntimeState(transaction, {
    identity,
    runStatus: run.status,
    adapterType: revision.adapterType,
    contextUsedTokens: settlement.occupancy.used,
    contextWindowTokens: settlement.occupancy.size,
    cost,
    settledAt: input.settledAt,
  });

  const immutableSourceKey = [
    "acp_prompt_settlement",
    identity.runId,
    identity.promptKind,
    identity.promptKind === "compaction"
      ? identity.compactionControlId
      : `${identity.refId}:${identity.runOrdinal}:${identity.segmentOrdinal}`,
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
  await publishIssueSessionEventInTx(transaction, {
    event: {
      id: input.stepEnded.eventId,
      sessionId: identity.sessionId,
      seq: input.stepEnded.eventSeq,
      type: IssueSession.Event.Step.Ended.type,
      data: stepEndedData,
    },
    envelope: {
      companyId: identity.companyId,
      issueId: identity.issueId,
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
    companions: {
      assistantSource: {
        assistantMessageId: input.stepEnded.assistantMessageId,
        sourceTotalTokens: settlement.occupancy.used,
        ...(input.stepEnded.sourceAssistantErrorKind === undefined
          ? {}
          : {
              sourceAssistantErrorKind:
                input.stepEnded.sourceAssistantErrorKind,
            }),
        createdAt: input.settledAt,
      },
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
